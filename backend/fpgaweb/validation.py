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


def _normalise(text: str) -> str:
    if text.startswith("﻿"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


def validate_files(board: Board, top: str, files: dict[str, str]) -> dict[str, str]:
    if not MODULE_RE.fullmatch(top or ""):
        raise ValidationError("top module must be a valid Verilog identifier")
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
    if total > MAX_TOTAL_BYTES:
        raise ValidationError("project is larger than 1 MB")

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
