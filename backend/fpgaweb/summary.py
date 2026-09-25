"""Extract resource utilisation and fmax from a nextpnr --report JSON file."""

import json
from pathlib import Path


def read_summary(path: Path) -> dict:
    out: dict = {"utilization": {}, "fmax": {}}
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return out
    for name, u in (data.get("utilization") or {}).items():
        if isinstance(u, dict) and u.get("used", 0) > 0:
            out["utilization"][name] = {"used": int(u["used"]), "available": int(u.get("available", 0))}
    for clk, f in (data.get("fmax") or {}).items():
        if isinstance(f, dict) and "achieved" in f:
            out["fmax"][clk] = round(float(f["achieved"]), 2)
    return out
