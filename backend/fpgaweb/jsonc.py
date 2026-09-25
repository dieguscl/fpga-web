"""Load JSON with // line comments (Apio's .jsonc files)."""

import json
from pathlib import Path


def load_jsonc(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    out: list[str] = []
    i, n, in_str = 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith("//", i):
            nl = text.find("\n", i)
            i = n if nl < 0 else nl
            continue
        else:
            out.append(c)
        i += 1
    return json.loads("".join(out))
