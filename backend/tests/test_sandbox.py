import asyncio
import dataclasses
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from fpgaweb.sandbox import run_step, sandbox_argv

PY = sys.executable


def _bwrap_works() -> bool:
    if not shutil.which("bwrap"):
        return False
    r = subprocess.run(["bwrap", "--unshare-all", "--ro-bind", "/", "/", "true"], capture_output=True)
    return r.returncode == 0


needs_bwrap = pytest.mark.skipif(not _bwrap_works(), reason="bubblewrap user namespaces unavailable")


async def collect(argv, cwd, settings, stdout_file=None):
    lines: list[str] = []
    res = await run_step(argv, cwd, settings, lines.append, stdout_file)
    return res, lines


async def test_captures_stdout_and_stderr(tmp_path, settings):
    res, lines = await collect([PY, "-c", "import sys;print('a');print('b',file=sys.stderr)"], tmp_path, settings)
    assert res.exit_code == 0 and res.killed is None
    assert lines == ["a", "b"] or sorted(lines) == ["a", "b"]


async def test_nonzero_exit(tmp_path, settings):
    res, _ = await collect([PY, "-c", "raise SystemExit(3)"], tmp_path, settings)
    assert res.exit_code == 3 and res.killed is None


async def test_wall_timeout_kills(tmp_path, settings):
    s = dataclasses.replace(settings, wall_s=1)
    res, _ = await collect([PY, "-c", "import time;time.sleep(30)"], tmp_path, s)
    assert res.killed == "timeout"


async def test_cpu_limit(tmp_path, settings):
    s = dataclasses.replace(settings, cpu_s=1, wall_s=30)
    res, _ = await collect([PY, "-c", "while True: pass"], tmp_path, s)
    assert res.killed == "cpu"


async def test_memory_limit(tmp_path, settings):
    s = dataclasses.replace(settings, mem_bytes=256 * 1024**2)
    res, _ = await collect([PY, "-c", "x = bytearray(1024**3)"], tmp_path, s)
    assert res.killed == "memory"


async def test_stdout_file_redirect(tmp_path, settings):
    res, lines = await collect([PY, "-c", "import sys;print('data');print('log',file=sys.stderr)"],
                               tmp_path, settings, stdout_file="out.txt")
    assert res.exit_code == 0
    assert (tmp_path / "out.txt").read_text() == "data\n"
    assert lines == ["log"]


async def test_long_line_and_bad_utf8(tmp_path, settings):
    res, lines = await collect([PY, "-c", "import sys;sys.stdout.buffer.write(b'x'*200000+b'\\xff\\n')"],
                               tmp_path, settings)
    assert res.exit_code == 0 and lines[0].endswith("�")


def test_bwrap_argv_shape(tmp_path, settings):
    s = dataclasses.replace(settings, sandbox="bwrap", ro_binds=("/opt/fpga",), tool_path="/opt/fpga/bin")
    a = sandbox_argv(["yosys", "-q"], tmp_path, s)
    assert a[0] == "bwrap" and "--unshare-all" in a and "--clearenv" in a
    assert a[a.index("--bind") + 1: a.index("--bind") + 3] == [str(tmp_path), "/job"]
    assert ["--ro-bind-try", "/opt/fpga", "/opt/fpga"] == a[a.index("/opt/fpga") - 1: a.index("/opt/fpga") + 2]
    assert a[-3:] == ["--", "yosys", "-q"]
    assert "/etc" not in a


@needs_bwrap
async def test_bwrap_cannot_read_etc_passwd(tmp_path, settings):
    s = dataclasses.replace(settings, sandbox="bwrap", tool_path="/usr/bin:/bin")
    res, lines = await collect(["python3", "-c", "open('/etc/passwd').read()"], tmp_path, s)
    assert res.exit_code != 0
    assert any("No such file" in l for l in lines)


@needs_bwrap
async def test_bwrap_has_no_network(tmp_path, settings):
    s = dataclasses.replace(settings, sandbox="bwrap", tool_path="/usr/bin:/bin")
    code = "import socket;socket.create_connection(('1.1.1.1',80),timeout=3)"
    res, _ = await collect(["python3", "-c", code], tmp_path, s)
    assert res.exit_code != 0


@needs_bwrap
async def test_bwrap_job_dir_writable_and_isolated(tmp_path, settings):
    s = dataclasses.replace(settings, sandbox="bwrap", tool_path="/usr/bin:/bin")
    res, _ = await collect(["python3", "-c", "open('ok.txt','w').write('1')"], tmp_path, s)
    assert res.exit_code == 0 and (tmp_path / "ok.txt").read_text() == "1"
    res, _ = await collect(["python3", "-c", f"open('{Path.home()}/x','w')"], tmp_path, s)
    assert res.exit_code != 0


def _wait_process_gone(pid: int, tries: int = 200, delay: float = 0.05) -> bool:
    for _ in range(tries):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(delay)
    return False


async def test_cancel_kills_process_tree(tmp_path, settings):
    script = "import os,time;open('pid.txt','w').write(str(os.getpid()));time.sleep(30)"
    task = asyncio.ensure_future(run_step([PY, "-c", script], tmp_path, settings, lambda l: None))
    pid_file = tmp_path / "pid.txt"
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text():
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("child never reported its pid")
    pid = int(pid_file.read_text())

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert _wait_process_gone(pid), "sandboxed process still alive after run_step was cancelled"


async def test_on_line_exception_kills_process_and_propagates(tmp_path, settings):
    script = (
        "import os,sys,time;"
        "open('pid.txt','w').write(str(os.getpid()));"
        "print('go');sys.stdout.flush();"
        "time.sleep(30)"
    )

    def boom(line: str) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await run_step([PY, "-c", script], tmp_path, settings, boom)

    pid = int((tmp_path / "pid.txt").read_text())
    assert _wait_process_gone(pid), "sandboxed process still alive after on_line raised"


async def test_stdout_file_rejects_path_separators(tmp_path, settings):
    with pytest.raises(ValueError):
        await run_step([PY, "-c", "print('x')"], tmp_path, settings, lambda l: None,
                        stdout_file="sub/out.txt")


async def test_stdout_file_does_not_follow_symlink(tmp_path, tmp_path_factory, settings):
    outside_dir = tmp_path_factory.mktemp("outside")
    outside = outside_dir / "target.txt"
    outside.write_text("untouched")
    (tmp_path / "hw.frames").symlink_to(outside)

    with pytest.raises(OSError):
        await run_step([PY, "-c", "print('x')"], tmp_path, settings, lambda l: None,
                        stdout_file="hw.frames")

    assert outside.read_text() == "untouched"
