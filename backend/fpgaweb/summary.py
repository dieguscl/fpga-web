"""Extract resource utilisation and fmax from a nextpnr --report JSON file."""

import json
import os
import stat
from pathlib import Path

# Same threat model as sandbox._open_stdout_file: a sandboxed step can plant
# a symlink (pointing outside the job dir) or a FIFO at this path. O_NOFOLLOW
# refuses the symlink instead of following it, and O_NONBLOCK keeps opening a
# FIFO from blocking the caller forever. A 200 MB report.json would also be
# read and json.loads-ed synchronously, so the size is capped too.
_MAX_REPORT_BYTES = 1 << 20  # 1 MB


def _safe_read(path: Path) -> str | None:
    """Read `path` as text, or return None if it isn't safe/small enough to read.

    Refuses anything that isn't a regular file (symlink, FIFO, device, ...)
    after opening, and anything over `_MAX_REPORT_BYTES`.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_REPORT_BYTES:
            return None
        with os.fdopen(fd, "rb") as f:
            fd = -1  # ownership transferred to the file object
            data = f.read(_MAX_REPORT_BYTES + 1)
    except OSError:
        return None
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) > _MAX_REPORT_BYTES:
        return None
    return data.decode("utf-8", "replace")


def read_summary(path: Path) -> dict:
    out: dict = {"utilization": {}, "fmax": {}}
    text = _safe_read(path)
    if text is None:
        return out
    try:
        data = json.loads(text)
    except ValueError:
        return out
    if not isinstance(data, dict):
        return out
    util = data.get("utilization")
    if isinstance(util, dict):
        for name, u in util.items():
            if not isinstance(u, dict):
                continue
            try:
                if u.get("used", 0) > 0:
                    out["utilization"][name] = {"used": int(u["used"]), "available": int(u.get("available", 0))}
            except (TypeError, ValueError):
                continue
    fmax = data.get("fmax")
    if isinstance(fmax, dict):
        for clk, f in fmax.items():
            if not isinstance(f, dict) or "achieved" not in f:
                continue
            try:
                out["fmax"][clk] = round(float(f["achieved"]), 2)
            except (TypeError, ValueError):
                continue
    return out
