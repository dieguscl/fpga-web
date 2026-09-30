"""Validate and normalise a build request's files before anything touches disk."""

import json
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
# make the tools fail with a bare "syntax error"; they are converted, not rejected.
LOOKALIKES = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u2032": "'", "\u00b4": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2033": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00a0": " ", "\u200b": "",
}
_LOOKALIKE_TABLE = str.maketrans(LOOKALIKES)
HDL_EXTS = DESIGN_EXTS | {".vh", ".svh"}


def fix_lookalikes(text: str) -> str:
    """Convert typographic quotes/dashes to their ASCII forms (same as the editor's paste filter)."""
    return text.translate(_LOOKALIKE_TABLE)


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
            out[name] = fix_lookalikes(out[name])
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


SHARE_EXTS = ALLOWED_EXTS | {".circ"}


def validate_share(project: object, board_ids: set[str], max_bytes: int) -> dict:
    """A shareable project: name, known board, top and text files of project types only."""
    if not isinstance(project, dict):
        raise ValidationError("project must be an object")
    name, board, top, files = (project.get(k) for k in ("name", "board", "top", "files"))
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise ValidationError("invalid project name")
    if board not in board_ids:
        raise ValidationError("unknown board")
    if not isinstance(top, str) or len(top) > 128:
        raise ValidationError("invalid top module")
    if not isinstance(files, dict) or not files:
        raise ValidationError("project has no files")
    if len(files) > MAX_FILES:
        raise ValidationError(f"a project can have at most {MAX_FILES} files")
    total = 0
    for fname, text in files.items():
        if not isinstance(fname, str) or not NAME_RE.fullmatch(fname):
            raise ValidationError(f"invalid file name: {fname!r}")
        if _ext(fname) not in SHARE_EXTS or _raw_ext(fname) != _ext(fname):
            raise ValidationError(f"file type cannot be shared: {fname!r}")
        if not isinstance(text, str) or "\x00" in text:
            raise ValidationError(f"{fname} is not a text file")
        try:
            total += len(text.encode("utf-8"))
        except UnicodeEncodeError:
            raise ValidationError(f"{fname} is not valid UTF-8")
        if _ext(fname) == ".circ":
            try:
                json.loads(text)
            except ValueError:
                raise ValidationError(f"{fname} is not a valid circuit")
    if total > max_bytes:
        raise ValidationError(f"project is too large to share ({total // 1000} KB; limit {max_bytes // 1000} KB) - export a .zip instead")
    return {"name": name, "board": board, "top": top, "files": dict(files)}
