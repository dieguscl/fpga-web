"""Build job queue: workers run recipe steps in the sandbox and publish events."""

import asyncio
import enum
import logging
import secrets
import shutil
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable

from fpgaweb.boards import Board
from fpgaweb.chipdb import ChipdbError
from fpgaweb.config import Settings
from fpgaweb.recipes import REPORT, plan_build
from fpgaweb.sandbox import RunResult
from fpgaweb.summary import read_summary

log = logging.getLogger("fpgaweb.jobs")

RunStep = Callable[[list[str], Path, Settings, Callable[[str], None], str | None], Awaitable[RunResult]]

_KILL_TEXT = {
    "timeout": "exceeded the {wall}s time limit",
    "cpu": "exceeded the CPU time limit",
    "memory": "exceeded the memory limit",
    "killed": "was killed by a resource limit",
}


class JobState(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class QueueFull(Exception):
    pass


@dataclass(eq=False)
class Job:
    id: str
    ip: str
    board: Board
    top: str
    files: dict[str, str]
    lint: bool
    dir: Path
    state: JobState = JobState.QUEUED
    events: list[dict] = field(default_factory=list)
    bitstream: Path | None = None
    finished_at: float | None = None
    _changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def terminal(self) -> bool:
        return self.state in (JobState.DONE, JobState.FAILED)

    def emit(self, event: dict) -> None:
        self.events.append(event)
        self._changed.set()
        self._changed = asyncio.Event()

    async def stream(self, start: int = 0) -> AsyncIterator[tuple[int, dict]]:
        i = max(0, start)
        while True:
            while i < len(self.events):
                yield i, self.events[i]
                i += 1
            if self.terminal:
                return
            await self._changed.wait()


class _LogSink:
    def __init__(self, job: Job, settings: Settings):
        self._job, self._max, self._chars, self._n = job, settings.max_log_lines, settings.max_line_chars, 0

    def __call__(self, line: str) -> None:
        self._n += 1
        if self._n > self._max:
            if self._n == self._max + 1:
                self._job.emit({"type": "log", "line": "[log truncated: further output suppressed]"})
            return
        if len(line) > self._chars:
            line = line[: self._chars] + "…"
        self._job.emit({"type": "log", "line": line})


class JobManager:
    def __init__(self, settings: Settings, *, run_step: RunStep, chipdb, plan=plan_build,
                 clock: Callable[[], float] = time.monotonic):
        self._s = settings
        self._run = run_step
        self._chipdb = chipdb
        self._plan = plan
        self._clock = clock
        self._jobs: dict[str, Job] = {}
        self._pending: deque[Job] = deque()
        self._queue: asyncio.Queue[Job] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        self._s.work_dir.mkdir(parents=True, exist_ok=True)
        self._tasks = [asyncio.create_task(self._worker()) for _ in range(self._s.workers)]
        self._tasks.append(asyncio.create_task(self._janitor()))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

    def submit(self, ip: str, board: Board, top: str, files: dict[str, str], lint: bool) -> Job:
        if len(self._pending) >= self._s.queue_max:
            raise QueueFull()
        job_id = secrets.token_urlsafe(12)
        job = Job(id=job_id, ip=ip, board=board, top=top, files=files, lint=lint,
                  dir=self._s.work_dir / job_id)
        self._jobs[job_id] = job
        self._pending.append(job)
        job.emit({"type": "queued", "position": len(self._pending)})
        self._queue.put_nowait(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def active_count(self, ip: str) -> int:
        return sum(1 for j in self._jobs.values() if j.ip == ip and not j.terminal)

    def sweep(self) -> None:
        now = self._clock()
        for job_id, job in list(self._jobs.items()):
            if job.finished_at is not None and now - job.finished_at > self._s.job_ttl_s:
                shutil.rmtree(job.dir, ignore_errors=True)
                del self._jobs[job_id]

    async def _janitor(self) -> None:
        while True:
            await asyncio.sleep(30)
            self.sweep()

    async def _worker(self) -> None:
        while True:
            job = await self._queue.get()
            if job in self._pending:
                self._pending.remove(job)
            for pos, other in enumerate(self._pending, start=1):
                other.emit({"type": "queued", "position": pos})
            try:
                await self._execute(job)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("job %s crashed", job.id)
                if not job.events or job.events[-1]["type"] not in ("done", "error"):
                    self._fail(job, "internal build error")
            finally:
                job.finished_at = self._clock()
                log.info("build ip=%s board=%s state=%s", job.ip, job.board.id, job.state.value)

    def _fail(self, job: Job, message: str) -> None:
        job.state = JobState.FAILED
        job.emit({"type": "error", "message": message})

    async def _execute(self, job: Job) -> None:
        job.state = JobState.RUNNING
        job.dir.mkdir(parents=True, exist_ok=True)
        for name, text in job.files.items():
            (job.dir / name).write_text(text, encoding="utf-8")

        chipdb_path = None
        if job.board.arch == "xilinx":
            job.emit({"type": "step", "name": "chipdb"})
            try:
                chipdb_path = await self._chipdb.ensure(job.board.params["yosys-part"])
            except ChipdbError as e:
                return self._fail(job, str(e))

        plan = self._plan(job.board, job.top, job.files, self._s, chipdb_path, job.lint)
        for name, text in plan.extra_files.items():
            (job.dir / name).write_text(text, encoding="utf-8")

        sink = _LogSink(job, self._s)
        for step in plan.steps:
            job.emit({"type": "step", "name": step.name})
            try:
                res = await self._run(step.argv, job.dir, self._s, sink, step.stdout_file)
            except (OSError, ValueError):
                return self._fail(job, f"{step.name} failed")
            if res.exit_code != 0:
                if res.killed:
                    reason = _KILL_TEXT[res.killed].format(wall=self._s.wall_s)
                    return self._fail(job, f"{step.name} {reason}")
                return self._fail(job, f"{step.name} failed (exit code {res.exit_code})")

        out = job.dir / plan.output
        if out.is_symlink() or not out.is_file() or out.stat().st_size == 0:
            return self._fail(job, "no bitstream was produced")

        report_path = job.dir / REPORT
        if report_path.is_symlink():
            summary = {"utilization": {}, "fmax": {}}
        else:
            try:
                summary = read_summary(report_path)
            except Exception:
                summary = {"utilization": {}, "fmax": {}}

        job.bitstream = out
        job.state = JobState.DONE
        job.emit({"type": "done", "summary": summary, "bitstream": plan.output})
