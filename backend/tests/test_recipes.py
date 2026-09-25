from pathlib import Path

import pytest

from fpgaweb.recipes import REPORT, plan_build

FILES = {"main.v": "", "inc.vh": "", "main_tb.v": "", "b.sv": "", "pins.xdc": "", "pins.pcf": "",
         "pins.lpf": "", "pins.cst": ""}


def names(plan):
    return [s.name for s in plan.steps]


def test_xilinx_plan(registry, settings):
    chipdb = Path("/cdb/xc7a35tcpg236.bin")
    p = plan_build(registry.get("basys3"), "main", {"main.v": "", "b.sv": "", "main_tb.v": "", "pins.xdc": ""},
                   settings, chipdb, lint=False)
    assert names(p) == ["synth", "pnr", "fasm2frames", "frames2bit"]
    synth = p.steps[0].argv
    assert synth[:3] == ["yosys", "-q", "-DSYNTHESIZE"]
    assert synth[3] == "-p"
    assert synth[4] == "synth_xilinx -arch xc7 -top main; write_json hw.json"
    assert synth[5:] == ["b.sv", "main.v"]  # sorted, testbench excluded
    pnr = p.steps[1].argv
    assert pnr[:4] == ["nextpnr-xilinx", "-q", "--chipdb", str(chipdb)]
    assert ["--xdc", "pins.xdc"] == pnr[4:6]
    assert "--report" in pnr and REPORT in pnr
    db = settings.prjxray_db / "artix7"
    assert p.steps[2].argv == ["fasm2frames", "--part", "xc7a35tcpg236-1", "--db-root", str(db), "hw.fasm"]
    assert p.steps[2].stdout_file == "hw.frames"
    assert p.steps[3].argv == ["xc7frames2bit", "--part_file", str(db / "xc7a35tcpg236-1" / "part.yaml"),
                               "--part_name", "xc7a35tcpg236-1", "--frm_file", "hw.frames",
                               "--output_file", "hw.bit"]
    assert p.output == "hw.bit"


def test_xilinx_requires_chipdb(registry, settings):
    with pytest.raises(ValueError, match="chipdb"):
        plan_build(registry.get("basys3"), "main", {"main.v": "", "p.xdc": ""}, settings, None, lint=False)


def test_ice40_plan(registry, settings):
    b = registry.get("icebreaker")
    p = plan_build(b, "top", {"main.v": "", "p.pcf": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    assert p.steps[0].argv[4] == "synth_ice40 -top top -json hw.json"
    pnr = p.steps[1].argv
    assert pnr[:3] == ["nextpnr-ice40", "-q", f"--{b.params['type']}"]
    assert ["--package", b.params["package"]] == pnr[3:5]
    assert pnr[-2:] == ["--pcf", "p.pcf"]
    assert p.steps[2].argv == ["icepack", "hw.asc", "hw.bin"]
    assert p.output == "hw.bin"


def test_ecp5_plan(registry, settings):
    b = registry.get("ulx3s-85f")
    p = plan_build(b, "top", {"main.v": "", "p.lpf": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    assert p.steps[0].argv[4] == "synth_ecp5 -top top -json hw.json"
    pnr = p.steps[1].argv
    assert pnr[:3] == ["nextpnr-ecp5", "-q", f"--{b.params['type']}"]
    assert "--timing-allow-fail" in pnr and ["--lpf", "p.lpf"] == pnr[-3:-1]
    assert p.steps[2].argv == ["ecppack", "--compress", "--db", str(settings.trellis_db), "hw.config", "hw.bit"]


def test_gowin_plan(registry, settings):
    b = registry.get("sipeed-tang-nano-9k")
    p = plan_build(b, "blinky", {"blinky.v": "", "blinky.cst": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    fam = b.params["yosys-family"]
    expected = "synth_gowin -top blinky" + (f" -family {fam}" if fam else "") + " -json hw.json"
    assert p.steps[0].argv[4] == expected
    pnr = p.steps[1].argv
    assert pnr[:4] == ["nextpnr-himbaechel", "-q", "--device", b.part_num]
    assert "cst=blinky.cst" in pnr
    assert p.steps[2].argv == ["gowin_pack", "-d", b.params["packer-device"], "-o", "hw.fs", "pnr.json"]
    assert p.output == "hw.fs"


def test_lint_step_first_with_vlt_waiver(registry, settings):
    p = plan_build(registry.get("icebreaker"), "top", {"main.v": "", "p.pcf": ""}, settings, None, lint=True)
    lint = p.steps[0]
    assert lint.name == "lint"
    assert lint.argv[0] == "verilator"
    assert "--lint-only" in lint.argv and "--top-module" in lint.argv
    assert "lint.vlt" in lint.argv and "main.v" in lint.argv
    assert str(settings.yosys_share / "ice40" / "cells_sim.v") in lint.argv
    assert f"-I{settings.yosys_share / 'ice40'}" in lint.argv
    assert f'lint_off -file "{settings.yosys_share}/*"' in p.extra_files["lint.vlt"]


def test_top_is_not_shell_interpreted(registry, settings):
    p = plan_build(registry.get("icebreaker"), "t_1", {"main.v": "", "p.pcf": ""}, settings, None, lint=False)
    assert all(isinstance(a, str) for s in p.steps for a in s.argv)


def test_adversarial_top_rejected(registry, settings):
    with pytest.raises(ValueError, match="invalid top module"):
        plan_build(registry.get("icebreaker"), "x; shell rm -rf /", {"main.v": "", "p.pcf": ""}, settings, None, lint=False)


def test_lint_xilinx(registry, settings):
    p = plan_build(registry.get("basys3"), "main", {"main.v": "", "p.xdc": ""}, settings, Path("/cdb/xc7a35tcpg236.bin"), lint=True)
    lint = p.steps[0]
    assert "-DAPIO_SIM=0" in lint.argv
    assert str(settings.yosys_share / "xilinx" / "cells_xtra.v") in lint.argv


def test_lint_ecp5(registry, settings):
    p = plan_build(registry.get("ulx3s-85f"), "top", {"main.v": "", "p.lpf": ""}, settings, None, lint=True)
    lint = p.steps[0]
    assert "-DAPIO_SIM=0" in lint.argv
    assert str(settings.yosys_share / "ecp5" / "cells_bb.v") in lint.argv
    # ecp5's cells_sim.v `includes sibling headers (common_sim.vh, cells_ff.vh, ...) by bare
    # name; verilator only resolves those against an explicit -I search path.
    assert f"-I{settings.yosys_share / 'ecp5'}" in lint.argv


def test_lint_gowin(registry, settings):
    p = plan_build(registry.get("sipeed-tang-nano-9k"), "top", {"main.v": "", "p.cst": ""}, settings, None, lint=True)
    lint = p.steps[0]
    assert "-DAPIO_SIM=0" in lint.argv
    assert str(settings.yosys_share / "gowin" / "cells_xtra_gw1n.v") in lint.argv
