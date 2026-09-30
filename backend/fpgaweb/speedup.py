"""Virtual-board speed-up: scale large constants in comparisons of a Yosys
word-level JSON netlist, so clock dividers (e.g. `count == 49_999_999`) tick
`factor` times sooner. Runs inside the build sandbox as a script:

    python3 speedup.py in.json out.json FACTOR
"""

import json
import sys

COMPARE_CELLS = {"$eq", "$ne", "$lt", "$le", "$gt", "$ge", "$eqx", "$nex"}
MIN_VALUE = 1000  # smaller constants (bit indices, state codes, baud dividers…) are left alone
MIN_RESULT = 10


def scale_bits(bits: list, factor: int) -> list | None:
    """bits are LSB-first strings '0'/'1'; returns scaled bits or None if untouched."""
    if not bits or not all(b in ("0", "1") for b in bits):
        return None
    value = int("".join(reversed(bits)), 2)
    if value < MIN_VALUE or value // factor < MIN_RESULT:
        return None
    new = max(1, round(value / factor))
    return [str((new >> i) & 1) for i in range(len(bits))]


def scale_netlist(netlist: dict, factor: int) -> int:
    """Scale constants in place; returns how many were changed."""
    changed = 0
    for module in netlist.get("modules", {}).values():
        for cell in module.get("cells", {}).values():
            if cell.get("type") not in COMPARE_CELLS:
                continue
            for port in ("A", "B"):
                bits = cell.get("connections", {}).get(port)
                new = scale_bits(bits, factor) if isinstance(bits, list) else None
                if new is not None:
                    cell["connections"][port] = new
                    changed += 1
    return changed


def main(argv: list[str]) -> int:
    src, dst, factor = argv[1], argv[2], int(argv[3])
    with open(src, encoding="utf-8") as f:
        netlist = json.load(f)
    n = scale_netlist(netlist, factor) if factor > 1 else 0
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(netlist, f)
    print(f"speed-up x{factor}: scaled {n} constant(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
