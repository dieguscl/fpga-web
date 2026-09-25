"""Board registry backed by Apio's vendored board and FPGA definitions."""

import configparser
from dataclasses import dataclass
from pathlib import Path

from fpgaweb.jsonc import load_jsonc

ARCH_CONSTRAINT = {"xilinx": ".xdc", "ice40": ".pcf", "ecp5": ".lpf", "gowin": ".cst"}
ARCH_BITSTREAM = {"xilinx": ".bit", "ice40": ".bin", "ecp5": ".bit", "gowin": ".fs"}
CONSTRAINT_EXTS = frozenset(ARCH_CONSTRAINT.values())
TEMPLATE_EXTS = frozenset({".v", ".sv", ".vh", ".svh", ".hex", ".mem"}) | CONSTRAINT_EXTS

_COMMENT = {".xdc": "#", ".pcf": "#", ".lpf": "#", ".cst": "//"}

FALLBACK_TOP = "main"
FALLBACK_VERILOG = """\
module main (
    input  wire clk,
    output wire led
);
  reg [23:0] counter = 0;
  always @(posedge clk) counter <= counter + 1;
  assign led = counter[23];
endmodule
"""


@dataclass(frozen=True)
class Board:
    id: str
    description: str
    arch: str
    fpga_id: str
    part_num: str
    params: dict[str, str]
    programmer: dict
    usb: dict | None

    @property
    def constraint_ext(self) -> str:
        return ARCH_CONSTRAINT[self.arch]

    @property
    def bitstream_ext(self) -> str:
        return ARCH_BITSTREAM[self.arch]


@dataclass(frozen=True)
class Template:
    top: str
    files: dict[str, str]


class BoardRegistry:
    def __init__(self, data_dir: Path):
        apio = data_dir / "apio"
        self._examples = apio / "examples"
        boards = load_jsonc(apio / "boards.jsonc")
        fpgas = load_jsonc(apio / "fpgas.jsonc")
        self._boards: dict[str, Board] = {}
        for board_id, b in boards.items():
            fpga = fpgas[b["fpga-id"]]
            arch = fpga["arch"]
            self._boards[board_id] = Board(
                id=board_id,
                description=b["description"],
                arch=arch,
                fpga_id=b["fpga-id"],
                part_num=fpga["part-num"],
                params=dict(fpga[f"{arch}-params"]),
                programmer=dict(b["programmer"]),
                usb=dict(b["usb"]) if "usb" in b else None,
            )

    def get(self, board_id: str) -> Board:
        return self._boards[board_id]

    def all(self) -> list[Board]:
        return [self._boards[k] for k in sorted(self._boards)]

    def template(self, board_id: str) -> Template:
        board = self.get(board_id)
        example = self._examples / board_id
        if example.is_dir():
            ini = configparser.ConfigParser()
            ini.read(example / "apio.ini")
            top = ini.get("env:default", "top-module", fallback=FALLBACK_TOP)
            files = {
                p.name: p.read_text(encoding="utf-8")
                for p in sorted(example.iterdir())
                if p.is_file()
                and p.suffix in TEMPLATE_EXTS
                and not p.stem.endswith("_tb")
                and not p.name.startswith("apio_testing")
            }
            return Template(top=top, files=files)
        c = _COMMENT[board.constraint_ext]
        constraint = (
            f"{c} Pin constraints for {board.description}.\n"
            f"{c} Map the ports of module '{FALLBACK_TOP}' (clk, led) to your board's pins.\n"
        )
        return Template(
            top=FALLBACK_TOP,
            files={"main.v": FALLBACK_VERILOG, f"{board_id}{board.constraint_ext}": constraint},
        )
