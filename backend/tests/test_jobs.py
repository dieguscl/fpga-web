import asyncio
import dataclasses
import os

import pytest

from fpgaweb.jobs import JobManager, JobState, QueueFull
from fpgaweb.sandbox import RunResult

FILES = {"main.v": "module main; endmodule\n", "p.pcf": ""}


class FakeRunner:
    """Pretends to run tools: writes the expected output of each step."""

    def __init__(self, fail_step=None, lines_per_step=1, gate: asyncio.Event | None = None, killed=None):
        self.calls: list[list[str]] = []
        self.fail_step, self.lines, self.gate, self.killed = fail_step, lines_per_step, gate, killed

    async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
        self.calls.append(argv)
        if self.gate:
            await self.gate.wait()
        for i in range(self.lines):
            on_line(f"{argv[0]} line {i}")
        if argv[0] == self.fail_step:
            return RunResult(1, self.killed)
        if argv[0] == "icepack":
            (cwd / "hw.bin").write_bytes(b"\x7e\xaa\x99\x7e")
        if argv[0].startswith("nextpnr"):
            (cwd / "report.json").write_text('{"utilization": {"LC": {"used": 5, "available": 10}}}')
        return RunResult(0)


class FakeChipdb:
    async def ensure(self, part):
        raise AssertionError("not used for ice40")


async def drain(job):
    return [ev async for _, ev in job.stream()]


@pytest.fixture
async def make(settings):
    managers = []

    async def _make(runner, **overrides):
        s = dataclasses.replace(settings, **overrides)
        m = JobManager(s, run_step=runner, chipdb=FakeChipdb())
        await m.start()
        managers.append(m)
        return m

    yield _make
    for m in managers:
        await m.stop()


async def test_successful_build(make, registry):
    runner = FakeRunner()
    m = await make(runner)
    job = m.submit("1.2.3.4", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[0] == {"type": "queued", "position": 1}
    assert [e["name"] for e in events if e["type"] == "step"] == ["synth", "pnr", "pack"]
    assert events[-1] == {"type": "done", "bitstream": "hw.bin",
                          "summary": {"utilization": {"LC": {"used": 5, "available": 10}}, "fmax": {}}}
    assert job.state is JobState.DONE and job.bitstream.read_bytes() == b"\x7e\xaa\x99\x7e"


async def test_failed_step_stops_build(make, registry):
    m = await make(FakeRunner(fail_step="nextpnr-ice40"))
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "pnr failed (exit code 1)"}
    assert job.state is JobState.FAILED and job.bitstream is None


async def test_resource_kill_message(make, registry):
    m = await make(FakeRunner(fail_step="yosys", killed="memory"))
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1]["message"] == "synth exceeded the memory limit"


async def test_missing_output_is_failure(make, registry):
    class NoOutput(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            return RunResult(0)
    m = await make(NoOutput())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    assert (await drain(job))[-1] == {"type": "error", "message": "no bitstream was produced"}


async def test_queue_positions_and_limit(make, registry):
    gate = asyncio.Event()
    m = await make(FakeRunner(gate=gate), workers=1, queue_max=2)
    b = registry.get("icebreaker")
    j1 = m.submit("a", b, "main", FILES, False)
    await asyncio.sleep(0.01)  # j1 picked up by the single worker
    j2 = m.submit("b", b, "main", FILES, False)
    j3 = m.submit("c", b, "main", FILES, False)
    assert j2.events[-1] == {"type": "queued", "position": 1}
    assert j3.events[-1] == {"type": "queued", "position": 2}
    with pytest.raises(QueueFull):
        m.submit("d", b, "main", FILES, False)
    assert m.active_count("a") == 1
    gate.set()
    await drain(j3)
    assert {"type": "queued", "position": 1} in j3.events  # moved up when j2 started
    assert m.active_count("a") == 0


async def test_log_is_truncated(make, registry):
    m = await make(FakeRunner(lines_per_step=10), max_log_lines=12)
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    logs = [e["line"] for e in events if e["type"] == "log"]
    assert len(logs) == 13
    assert logs[-1].startswith("[log truncated")
    assert events[-1]["type"] == "done"


async def test_long_log_line_is_clipped(make, registry):
    class Long(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            on_line("x" * 5000)
            return await super().__call__(argv, cwd, settings, lambda _: None, stdout_file)
    m = await make(Long(), max_line_chars=100)
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    logs = [e["line"] for e in await drain(job) if e["type"] == "log"]
    assert all(len(l) <= 101 for l in logs)


async def test_stream_replays_from_index(make, registry):
    m = await make(FakeRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    full = await drain(job)
    tail = [(i, ev) async for i, ev in job.stream(start=3)]
    assert [i for i, _ in tail] == list(range(3, len(full)))
    assert [ev for _, ev in tail] == full[3:]


async def test_xilinx_fetches_chipdb_first(settings, registry, tmp_path):
    class Chip:
        parts = []
        async def ensure(self, part):
            self.parts.append(part)
            return tmp_path / "x.bin"

    class XRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            if argv[0] == "xc7frames2bit":
                (cwd / "hw.bit").write_bytes(b"\x00\x09")
            return RunResult(0)

    chip = Chip()
    m = JobManager(settings, run_step=XRunner(), chipdb=chip)
    await m.start()
    try:
        job = m.submit("ip", registry.get("basys3"), "main", {"main.v": "", "p.xdc": ""}, False)
        events = await drain(job)
        assert events[1] == {"type": "step", "name": "chipdb"}
        assert chip.parts == ["xc7a35tcpg236-1"]
        assert events[-1]["type"] == "done"
    finally:
        await m.stop()


async def test_chipdb_error_fails_job(settings, registry):
    from fpgaweb.chipdb import ChipdbError

    class Bad:
        async def ensure(self, part):
            raise ChipdbError("could not download chip database: boom")

    m = JobManager(settings, run_step=FakeRunner(), chipdb=Bad())
    await m.start()
    try:
        job = m.submit("ip", registry.get("basys3"), "main", {"main.v": "", "p.xdc": ""}, False)
        assert (await drain(job))[-1] == {"type": "error", "message": "could not download chip database: boom"}
    finally:
        await m.stop()


async def test_sweep_removes_expired_jobs(settings, registry):
    now = [1000.0]
    m = JobManager(settings, run_step=FakeRunner(), chipdb=FakeChipdb(), clock=lambda: now[0])
    await m.start()
    try:
        job = m.submit("ip", registry.get("icebreaker"), "main", FILES, False)
        await drain(job)
        now[0] += settings.job_ttl_s + 1
        m.sweep()
        assert m.get(job.id) is None and not job.dir.exists()
    finally:
        await m.stop()


async def test_job_files_cleared_after_planning(make, registry):
    m = await make(FakeRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    await drain(job)
    assert job.state is JobState.DONE
    assert job.files == {}


async def test_build_log_line_includes_duration(make, registry, caplog):
    import logging
    import re

    caplog.set_level(logging.INFO, logger="fpgaweb.jobs")
    m = await make(FakeRunner())
    job = m.submit("1.2.3.4", registry.get("icebreaker"), "main", FILES, lint=False)
    await drain(job)
    lines = [r.getMessage() for r in caplog.records if r.name == "fpgaweb.jobs"]
    assert any(re.search(r"^build ip=1\.2\.3\.4 board=icebreaker state=done duration=\d+\.\d+s$", l)
              for l in lines), lines


# --- Job-dir disk hygiene (final review Issue #2) ---


async def test_failed_job_dir_removed_immediately(make, registry):
    m = await make(FakeRunner(fail_step="nextpnr-ice40"))
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    await drain(job)
    assert job.state is JobState.FAILED
    assert not job.dir.exists()


async def test_success_keeps_only_the_bitstream(make, registry):
    m = await make(FakeRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    await drain(job)
    assert job.state is JobState.DONE
    assert {p.name for p in job.dir.iterdir()} == {"hw.bin"}
    assert job.bitstream.read_bytes() == b"\x7e\xaa\x99\x7e"


async def test_job_dir_over_size_limit_fails_and_removes_dir(make, registry):
    class BigFileRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "yosys":
                (cwd / "big.bin").write_bytes(b"0" * 1000)
            return RunResult(0)

    m = await make(BigFileRunner(), max_job_dir_bytes=100)
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "synth exceeded the disk limit"}
    assert job.state is JobState.FAILED and job.bitstream is None
    assert not job.dir.exists()


# --- Controller rulings: symlink safety and precise failure messages ---


async def test_symlinked_bitstream_is_rejected(make, registry, tmp_path):
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"\x7e\xaa\x99\x7e")

    class SymlinkRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "icepack":
                (cwd / "hw.bin").symlink_to(outside)
            if argv[0].startswith("nextpnr"):
                (cwd / "report.json").write_text('{"utilization": {"LC": {"used": 5, "available": 10}}}')
            return RunResult(0)

    m = await make(SymlinkRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "no bitstream was produced"}
    assert job.state is JobState.FAILED and job.bitstream is None


async def test_fifo_report_does_not_hang_the_job(make, registry):
    class FifoReportRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "icepack":
                (cwd / "hw.bin").write_bytes(b"\x7e\xaa\x99\x7e")
            if argv[0].startswith("nextpnr"):
                os.mkfifo(cwd / "report.json")
            return RunResult(0)

    m = await make(FifoReportRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await asyncio.wait_for(drain(job), timeout=5)
    assert events[-1] == {"type": "done", "bitstream": "hw.bin", "summary": {"utilization": {}, "fmax": {}}}
    assert job.state is JobState.DONE


async def test_symlinked_report_is_ignored(make, registry, tmp_path):
    outside = tmp_path / "outside_report.json"
    outside.write_text('{"utilization": {"LC": {"used": 9, "available": 20}}}')

    class SymlinkReportRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "icepack":
                (cwd / "hw.bin").write_bytes(b"\x7e\xaa\x99\x7e")
            if argv[0].startswith("nextpnr"):
                (cwd / "report.json").symlink_to(outside)
            return RunResult(0)

    m = await make(SymlinkReportRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "done", "bitstream": "hw.bin", "summary": {"utilization": {}, "fmax": {}}}
    assert job.state is JobState.DONE


async def test_empty_bitstream_is_rejected(make, registry):
    class EmptyBitstreamRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "icepack":
                (cwd / "hw.bin").write_bytes(b"")
            if argv[0].startswith("nextpnr"):
                (cwd / "report.json").write_text('{"utilization": {"LC": {"used": 5, "available": 10}}}')
            return RunResult(0)

    m = await make(EmptyBitstreamRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "no bitstream was produced"}
    assert job.state is JobState.FAILED and job.bitstream is None


async def test_bad_report_value_falls_back_to_empty_summary(make, registry):
    class BadReportRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            self.calls.append(argv)
            for i in range(self.lines):
                on_line(f"{argv[0]} line {i}")
            if argv[0] == "icepack":
                (cwd / "hw.bin").write_bytes(b"\x7e\xaa\x99\x7e")
            if argv[0].startswith("nextpnr"):
                (cwd / "report.json").write_text('{"fmax": {"c": {"achieved": "n/a"}}}')
            return RunResult(0)

    m = await make(BadReportRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "done", "bitstream": "hw.bin", "summary": {"utilization": {}, "fmax": {}}}
    assert job.state is JobState.DONE


async def test_run_step_os_error_fails_job_with_step_name(make, registry):
    class RaisingRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            if argv[0] == "icepack":
                raise OSError("boom")
            return await super().__call__(argv, cwd, settings, on_line, stdout_file)

    m = await make(RaisingRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "pack failed"}
    assert job.state is JobState.FAILED and job.bitstream is None


async def test_run_step_value_error_fails_job_with_step_name(make, registry):
    class RaisingRunner(FakeRunner):
        async def __call__(self, argv, cwd, settings, on_line, stdout_file=None):
            if argv[0] == "icepack":
                raise ValueError("bad stdout_file")
            return await super().__call__(argv, cwd, settings, on_line, stdout_file)

    m = await make(RaisingRunner())
    job = m.submit("ip", registry.get("icebreaker"), "main", FILES, lint=False)
    events = await drain(job)
    assert events[-1] == {"type": "error", "message": "pack failed"}
    assert job.state is JobState.FAILED and job.bitstream is None
