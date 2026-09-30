"""Validate and normalise a build request's files before anything touches disk."""

import re

from fpgaweb.boards import CONSTRAINT_EXTS, Board

MAX_FILES = 50
MAX_TOTAL_BYTES = 1_000_000
DESIGN_EXTS = frozenset({".v", ".sv"})
ALLOWED_EXTS = DESIGN_EXTS | {".vh", ".svh", ".hex", ".mem"} | CONSTRAINT_EXTS

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")


class ValidationError(ValueError):
    pass


def _ext(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def _raw_ext(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:] if dot > 0 else ""


def is_testbench(name: str) -> bool:
    return _ext(name) in DESIGN_EXTS and name.rsplit(".", 1)[0].endswith("_tb")


# Characters that sneak in when code is copied from PDFs, Word or slides and
# make the tools fail with a bare "syntax error".
LOOKALIKES = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u2032": "'", "\u00b4": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2033": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00a0": " ", "\u200b": "",
}
_LOOKALIKE_RE = re.compile("[" + "".join(k for k in LOOKALIKES if len(k) == 1) + "]")
HDL_EXTS = DESIGN_EXTS | {".vh", ".svh"}


def _code_only(text: str) -> str:
    """Blank out comments and string literals (keeping newlines) so only code is checked."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(ch if ch == "\n" else " " for ch in text[i:j]))
            i = j
        elif c == '"':
            j = i + 1
            while j < n and text[j] not in '"\n':
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
            out.append(" " * (j - i))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def check_lookalikes(name: str, text: str) -> None:
    """Reject typographic quotes/dashes in HDL code with a message pointing at the line."""
    m = _LOOKALIKE_RE.search(_code_only(text))
    if not m:
        return
    ch = m.group()
    line = text.count("\n", 0, m.start()) + 1
    col = m.start() - (text.rfind("\n", 0, m.start()) + 1) + 1
    plain = LOOKALIKES[ch]
    what = {"'": "apostrophe ' (e.g. 4'b0000)", '"': 'double quote "', "-": "minus/hyphen -", " ": "space", "": "nothing (delete it)"}[plain]
    count = len(_LOOKALIKE_RE.findall(_code_only(text)))
    more = f" ({count} such characters in this file)" if count > 1 else ""
    raise ValidationError(
        f"{name}:{line}:{col}: typographic character {ch!r} (U+{ord(ch):04X}) must be a plain {what}{more}; "
        "this usually comes from copying code out of a PDF, Word or slides"
    )


def _normalise(text: str) -> str:
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _check_files(files: dict[str, str]) -> dict[str, str]:
    """Per-file checks shared by builds and simulations; returns normalised files."""
    if len(files) > MAX_FILES:
        raise ValidationError(f"a project can have at most {MAX_FILES} files")
    total = 0
    out: dict[str, str] = {}
    for name, text in files.items():
        if not NAME_RE.fullmatch(name):
            raise ValidationError(f"invalid file name: {name!r}")
        ext = _ext(name)
        if ext not in ALLOWED_EXTS:
            raise ValidationError(f"file extension not allowed: {name!r}")
        if _raw_ext(name) != ext:
            raise ValidationError(f"file extension must be lower-case: {name!r}")
        if "\x00" in text:
            raise ValidationError(f"{name} looks binary (contains NUL bytes)")
        try:
            total += len(text.encode("utf-8"))
        except UnicodeEncodeError:
            # A lone/unpaired surrogate (e.g. "\ud800") survives JSON
            # decoding into a Python str but can't be encoded as UTF-8.
            raise ValidationError(f"{name} is not valid UTF-8")
        out[name] = _normalise(text)
        if ext in HDL_EXTS:
            check_lookalikes(name, out[name])
    if total > MAX_TOTAL_BYTES:
        raise ValidationError("project is larger than 1 MB")
    return out


def validate_files(board: Board, top: str, files: dict[str, str]) -> dict[str, str]:
    if not MODULE_RE.fullmatch(top or ""):
        raise ValidationError("top module must be a valid Verilog identifier")
    out = _check_files(files)
    constraints = [n for n in out if _ext(n) in CONSTRAINT_EXTS]
    wrong = [n for n in constraints if _ext(n) != board.constraint_ext]
    if wrong:
        raise ValidationError(
            f"{board.id} uses {board.constraint_ext} constraint files, not {', '.join(wrong)}"
        )
    if len(constraints) != 1:
        raise ValidationError(f"project must contain exactly one {board.constraint_ext} file")
    if not any(_ext(n) in DESIGN_EXTS and not is_testbench(n) for n in out):
        raise ValidationError("project has no Verilog design source (.v or .sv)")
    return out


def validate_sim_files(testbench: str, files: dict[str, str]) -> dict[str, str]:
    """Simulation needs a testbench (*_tb.v / *_tb.sv) but no constraint file."""
    out = _check_files(files)
    if testbench not in out or not is_testbench(testbench):
        raise ValidationError("choose a testbench file (a .v/.sv file whose name ends in _tb)")
    return out


def validate_design_files(top: str, files: dict[str, str]) -> dict[str, str]:
    """Virtual board: design sources and a top module; constraints optional."""
    if not MODULE_RE.fullmatch(top or ""):
        raise ValidationError("top module must be a valid Verilog identifier")
    out = _check_files(files)
    if not any(_ext(n) in DESIGN_EXTS and not is_testbench(n) for n in out):
        raise ValidationError("project has no Verilog design source (.v or .sv)")
    return out
