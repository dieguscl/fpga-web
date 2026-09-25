"""Extract resource utilisation and fmax from a nextpnr --report JSON file."""

import json
from pathlib import Path


def read_summary(path: Path) -> dict:
    out: dict = {"utilization": {}, "fmax": {}}
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
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
