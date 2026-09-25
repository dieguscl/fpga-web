"""Run one toolchain command in a bubblewrap sandbox with resource limits."""

import asyncio
import contextlib
import os
import resource
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable

from fpgaweb.config import Settings

SYSTEM_RO = ("/usr", "/bin", "/sbin", "/lib", "/lib64")
OOM_MARKERS = ("std::bad_alloc", "out of memory", "Cannot allocate memory", "MemoryError")
_READ_LIMIT = 1 << 20


@dataclass(frozen=True)
class RunResult:
    exit_code: int
    killed: str | None = None


def sandbox_argv(argv: list[str], cwd: Path, settings: Settings) -> list[str]:
    if settings.sandbox == "none":
        return list(argv)
    a = [
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        "--setenv", "PATH", settings.tool_path,
        "--setenv", "HOME", "/job",
        "--setenv", "LANG", "C.UTF-8",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ]
    for p in (*SYSTEM_RO, *settings.ro_binds):
        a += ["--ro-bind-try", p, p]
    a += ["--bind", str(cwd), "/job", "--chdir", "/job", "--", *argv]
    return a


def _limits(s: Settings) -> Callable[[], None]:
    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_AS, (s.mem_bytes, s.mem_bytes))
        resource.setrlimit(resource.RLIMIT_CPU, (s.cpu_s, s.cpu_s + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (s.fsize_bytes, s.fsize_bytes))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _open_stdout_file(cwd: Path, name: str) -> BinaryIO:
    """Open cwd/name for the step's stdout, refusing to follow a symlink.

    A prior sandboxed step could have planted a symlink at this name pointing
    outside the job directory (e.g. into the backend's own writable files).
    The name must be a plain filename (no path separators, not "." or "..")
    and the open itself must fail rather than follow an existing symlink.
    """
    if "/" in name or name in (".", ".."):
        raise ValueError(f"invalid stdout_file name: {name!r}")
    fd = os.open(
        cwd / name,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o644,
    )
    return os.fdopen(fd, "wb")


def _classify(rc: int, oom: bool) -> str | None:
    if rc == 0:
        return None
    if rc in (-signal.SIGXCPU, 128 + signal.SIGXCPU):
        return "cpu"
    if oom:
        return "memory"
    if rc in (-signal.SIGKILL, 128 + signal.SIGKILL):
        return "killed"
    return None


async def run_step(argv: list[str], cwd: Path, settings: Settings,
                   on_line: Callable[[str], None], stdout_file: str | None = None) -> RunResult:
    env = None
    if settings.sandbox == "none":
        env = {"PATH": settings.tool_path, "HOME": str(cwd), "LANG": "C.UTF-8"}
    out_f = _open_stdout_file(cwd, stdout_file) if stdout_file else None
    try:
        proc = await asyncio.create_subprocess_exec(
            *sandbox_argv(argv, cwd, settings),
            cwd=cwd, env=env, limit=_READ_LIMIT,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=out_f if out_f else asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE if out_f else asyncio.subprocess.STDOUT,
            preexec_fn=_limits(settings), start_new_session=True,
        )
        stream = proc.stderr if out_f else proc.stdout
        oom = False

        async def pump() -> None:
            nonlocal oom
            while True:
                try:
                    raw = await stream.readline()
                except ValueError:  # line longer than _READ_LIMIT
                    raw = await stream.read(_READ_LIMIT)
                if not raw:
                    return
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if any(m in line for m in OOM_MARKERS):
                    oom = True
                on_line(line)

        try:
            await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=settings.wall_s)
        except asyncio.TimeoutError:
            _kill_group(proc)
            await proc.wait()
            return RunResult(proc.returncode if proc.returncode is not None else -9, "timeout")
        except BaseException:
            # Cancellation (e.g. the caller's task was cancelled) or an
            # exception raised from on_line() both unwind past the awaits
            # above without the subprocess having exited. Make sure the
            # sandboxed process tree doesn't keep running before we let the
            # original exception/cancellation propagate.
            if proc.returncode is None:
                _kill_group(proc)
                with contextlib.suppress(BaseException):
                    await asyncio.shield(proc.wait())
            raise
        rc = proc.returncode
        return RunResult(rc, _classify(rc, oom))
    finally:
        if out_f:
            out_f.close()
