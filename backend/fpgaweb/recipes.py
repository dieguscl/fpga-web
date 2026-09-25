"""Tool command plans per FPGA architecture (flags mirror Apio 1.6 scons plugins)."""

from dataclasses import dataclass, field
from pathlib import Path

from fpgaweb.boards import Board
from fpgaweb.config import Settings
from fpgaweb.validation import DESIGN_EXTS, MODULE_RE, is_testbench

REPORT = "report.json"


@dataclass(frozen=True)
class Step:
    name: str
    argv: list[str]
    stdout_file: str | None = None


@dataclass(frozen=True)
class BuildPlan:
    steps: list[Step]
    extra_files: dict[str, str] = field(default_factory=dict)
    output: str = ""


def _sources(files: dict[str, str]) -> list[str]:
    return sorted(n for n in files if Path(n).suffix.lower() in DESIGN_EXTS and not is_testbench(n))


def _constraint(board: Board, files: dict[str, str]) -> str:
    return next(n for n in files if n.lower().endswith(board.constraint_ext))


def _lint_libs(board: Board, s: Settings) -> list[str]:
    lib = s.yosys_share / board.arch
    extra = {"xilinx": ["cells_xtra.v"], "ecp5": ["cells_bb.v"]}.get(board.arch, [])
    # For gowin, add family-specific black-box file if part starts with known prefix
    if board.arch == "gowin":
        part_upper = board.part_num.upper()
        for prefix, family in [("GW1N", "gw1n"), ("GW2A", "gw2a"), ("GW5A", "gw5a")]:
            if part_upper.startswith(prefix):
                extra = [f"cells_xtra_{family}.v"]
                break
    return [str(lib / f) for f in ["cells_sim.v", *extra]]


def _lint(board: Board, top: str, srcs: list[str], s: Settings) -> tuple[Step, dict[str, str]]:
    vlt = f'`verilator_config\nlint_off -file "{s.yosys_share}/*"\n'
    argv = [
        "verilator", "--lint-only", "--quiet", "--bbox-unsup", "--timing",
        "-Wno-TIMESCALEMOD", "-Wno-MULTITOP", "-Wno-fatal", "-DSYNTHESIZE", "-DAPIO_SIM=0",
        "--top-module", top, "lint.vlt", *_lint_libs(board, s), *srcs,
    ]
    return Step("lint", argv), {"lint.vlt": vlt}


def plan_build(board: Board, top: str, files: dict[str, str], settings: Settings,
               chipdb: Path | None, lint: bool) -> BuildPlan:
    if not MODULE_RE.fullmatch(top):
        raise ValueError("invalid top module")
    s = settings
    p = board.params
    srcs = _sources(files)
    cons = _constraint(board, files)
    yosys = lambda script: Step("synth", ["yosys", "-q", "-DSYNTHESIZE", "-p", script, *srcs])  # noqa: E731

    if board.arch == "xilinx":
        if chipdb is None:
            raise ValueError("xilinx builds need a chipdb path")
        part, family = p["yosys-part"], p["yosys-family"]
        db = s.prjxray_db / family
        steps = [
            yosys(f"synth_xilinx -arch {p['yosys-arch']} -top {top}; write_json hw.json"),
            Step("pnr", ["nextpnr-xilinx", "-q", "--chipdb", str(chipdb), "--xdc", cons,
                         "--json", "hw.json", "--fasm", "hw.fasm", "--report", REPORT]),
            Step("fasm2frames", ["fasm2frames", "--part", part, "--db-root", str(db), "hw.fasm"],
                 stdout_file="hw.frames"),
            Step("frames2bit", ["xc7frames2bit", "--part_file", str(db / part / "part.yaml"),
                                "--part_name", part, "--frm_file", "hw.frames", "--output_file", "hw.bit"]),
        ]
        output = "hw.bit"
    elif board.arch == "ice40":
        steps = [
            yosys(f"synth_ice40 -top {top} -json hw.json"),
            Step("pnr", ["nextpnr-ice40", "-q", f"--{p['type']}", "--package", p["package"],
                         "--json", "hw.json", "--asc", "hw.asc", "--report", REPORT, "--pcf", cons]),
            Step("pack", ["icepack", "hw.asc", "hw.bin"]),
        ]
        output = "hw.bin"
    elif board.arch == "ecp5":
        steps = [
            yosys(f"synth_ecp5 -top {top} -json hw.json"),
            Step("pnr", ["nextpnr-ecp5", "-q", f"--{p['type']}", "--package", p["package"],
                         "--speed", p["speed"], "--json", "hw.json", "--textcfg", "hw.config",
                         "--report", REPORT, "--timing-allow-fail", "--lpf", cons, "--force"]),
            Step("pack", ["ecppack", "--compress", "--db", str(s.trellis_db), "hw.config", "hw.bit"]),
        ]
        output = "hw.bit"
    elif board.arch == "gowin":
        fam = f" -family {p['yosys-family']}" if p.get("yosys-family") else ""
        nfam = ["--vopt", f"family={p['nextpnr-family']}"] if p.get("nextpnr-family") else []
        steps = [
            yosys(f"synth_gowin -top {top}{fam} -json hw.json"),
            Step("pnr", ["nextpnr-himbaechel", "-q", "--device", board.part_num, "--json", "hw.json",
                         "--write", "pnr.json", "--report", REPORT, "--vopt", f"cst={cons}", *nfam]),
            Step("pack", ["gowin_pack", "-d", p["packer-device"], "-o", "hw.fs", "pnr.json"]),
        ]
        output = "hw.fs"
    else:
        raise ValueError(f"unsupported arch {board.arch}")

    extra: dict[str, str] = {}
    if lint:
        lint_step, extra = _lint(board, top, srcs, s)
        steps = [lint_step, *steps]
    return BuildPlan(steps=steps, extra_files=extra, output=output)
