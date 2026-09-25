"""End-to-end builds with real toolchains. Run: source dev.env && FPGAWEB_INTEGRATION=1 pytest -m integration"""

import os

import pytest

from fpgaweb.boards import BoardRegistry
from fpgaweb.chipdb import ChipdbStore
from fpgaweb.config import from_env
from fpgaweb.jobs import JobManager
from fpgaweb.sandbox import run_step
from fpgaweb.validation import validate_files

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.environ.get("FPGAWEB_INTEGRATION") != "1", reason="set FPGAWEB_INTEGRATION=1"),
]


def check_bitstream(arch: str, data: bytes) -> None:
    assert len(data) > 1000
    if arch == "xilinx":
        assert b"\xaa\x99\x55\x66" in data[:1024]          # 7-series sync word
    elif arch == "ice40":
        assert b"\x7e\xaa\x99\x7e" in data[:64]            # iCE40 preamble
    elif arch == "ecp5":
        assert b"\xff\xff\xbd\xb3" in data[:1024]          # ECP5 preamble
    elif arch == "gowin":
        lines = [l for l in data.decode().splitlines() if l and not l.startswith("//")]
        assert lines and all(set(l) <= {"0", "1"} for l in lines)


@pytest.fixture
async def manager():
    s = from_env()
    m = JobManager(s, run_step=run_step, chipdb=ChipdbStore(s))
    await m.start()
    yield m
    await m.stop()


async def build(manager, board_id, files=None, top=None, lint=True):
    reg = BoardRegistry(from_env().data_dir)
    board = reg.get(board_id)
    t = reg.template(board_id)
    files = validate_files(board, top or t.top, files or t.files)
    job = manager.submit("test", board, top or t.top, files, lint)
    events = [ev async for _, ev in job.stream()]
    return board, job, events


@pytest.mark.parametrize("board_id", ["basys3", "icebreaker", "ulx3s-85f", "sipeed-tang-nano-9k"])
async def test_blinky_builds(manager, board_id):
    board, job, events = await build(manager, board_id)
    assert events[-1]["type"] == "done", [e for e in events if e["type"] in ("log", "error")][-30:]
    check_bitstream(board.arch, job.bitstream.read_bytes())
    assert events[-1]["summary"]["utilization"]


async def test_include_sibling_file(manager):
    reg = BoardRegistry(from_env().data_dir)
    t = reg.template("icebreaker")
    files = dict(t.files)
    files["defs.vh"] = "`define ONE 1'b1\n"
    main = next(n for n in files if n.endswith(".v"))
    files[main] = '`include "defs.vh"\n' + files[main]
    board, job, events = await build(manager, "icebreaker", files=files)
    assert events[-1]["type"] == "done"


async def test_include_outside_job_dir_fails(manager):
    reg = BoardRegistry(from_env().data_dir)
    t = reg.template("icebreaker")
    files = dict(t.files)
    main = next(n for n in files if n.endswith(".v"))
    files[main] = '`include "/etc/passwd"\n' + files[main]
    _, _, events = await build(manager, "icebreaker", files=files, lint=False)
    assert events[-1]["type"] == "error"
    assert not any("root:" in e.get("line", "") for e in events)


async def test_syntax_error_reports_file_and_line(manager):
    files = {"main.v": "module main(input clk, output led);\n  assign led = ;\nendmodule\n",
             "p.pcf": "set_io clk 35\nset_io led 11\n"}
    _, _, events = await build(manager, "icebreaker", files=files, top="main", lint=False)
    assert events[-1] == {"type": "error", "message": "synth failed (exit code 1)"}
    assert any("main.v:2" in e.get("line", "") for e in events)
