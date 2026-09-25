"""How (and whether) the browser can flash a board with openFPGALoader (WebUSB)."""

import shlex
from dataclasses import dataclass, field

from fpgaweb.boards import Board

_FLASH_FLAGS = ("-f", "--write-flash")


@dataclass(frozen=True)
class FlashPlan:
    mode: str  # "browser" | "download"
    args: list[str] = field(default_factory=list)
    writes_flash: bool = False


_DOWNLOAD = FlashPlan("download", [], False)


def flash_plan(board: Board) -> FlashPlan:
    prog = board.programmer
    kind = prog["id"]
    extra = prog.get("extra-args", "").strip()
    usb = board.usb or {}

    if kind == "openfpgaloader":
        args = [
            a.replace("${VID}", usb.get("vid", "")).replace("${PID}", usb.get("pid", ""))
            for a in shlex.split(extra)
        ]
        return FlashPlan("browser", args, any(a in _FLASH_FLAGS for a in args))
    if kind == "iceprog":
        if extra:
            return _DOWNLOAD
        return FlashPlan("browser", ["-b", "ice40_generic"], True)
    if kind == "dfu":
        if not usb:
            return _DOWNLOAD
        return FlashPlan("browser", ["--dfu", "--vid", f"0x{usb['vid']}", "--pid", f"0x{usb['pid']}"], True)
    if kind == "fujprog":
        return FlashPlan("browser", ["-b", "ulx3s"], False)
    return _DOWNLOAD
