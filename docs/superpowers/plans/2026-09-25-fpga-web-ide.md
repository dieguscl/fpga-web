# FPGA Web IDE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public web app where users write Verilog, the server builds a bitstream with the open-source FPGA toolchain, and the browser flashes it onto the user's own board over WebUSB.

**Architecture:** One Docker image: FastAPI backend (board registry, validation, per-arch build recipes, bubblewrap sandbox, asyncio job queue with SSE events, per-IP rate limiting) that also serves a static Vite/TypeScript SPA (CodeMirror editor, IndexedDB projects, `@yowasp/openfpgaloader` WebUSB flasher). Caddy terminates TLS in front. Toolchains: OSS CAD Suite (iCE40/ECP5/Gowin) + openXC7 built with Nix from `fpgawars/tools-openxc7` at the commit Apio ships, so Apio's Xilinx chipdb files are compatible.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, httpx, pytest, pytest-asyncio; TypeScript, Vite, CodeMirror 6, idb-keyval, fflate, vitest, Playwright; bubblewrap; Docker Compose; Caddy; Nix (build stage only).

**Spec:** `docs/superpowers/specs/2026-09-25-fpga-web-ide-design.md`

## Global Constraints

- Repo root: `~/projects/fpga-web`. Backend in `backend/` (package `fpgaweb`), frontend in `frontend/`, Docker files in `docker/`.
- Python ≥ 3.12. Node ≥ 22.
- Supported arches exactly: `xilinx`, `ice40`, `ecp5`, `gowin`. Constraint ext: xilinx `.xdc`, ice40 `.pcf`, ecp5 `.lpf`, gowin `.cst`. Bitstream ext: xilinx `.bit`, ice40 `.bin`, ecp5 `.bit`, gowin `.fs`.
- Request limits: ≤ 50 files, ≤ 1 MB total UTF-8, filename `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`, extensions `.v .sv .vh .svh .xdc .pcf .lpf .cst .hex .mem`. Files ending `_tb.v` / `_tb.sv` are not synthesised. HTTP body > 2 MB → 413.
- Job limits: 120 s wall per step, 90 s CPU per step, 4 GiB address space (RLIMIT_AS), 200 MB max file size, 5000 log lines per job, 2000 chars per log line. Container: `pids_limit: 512`, `mem_limit: 8g`.
- Concurrency: 2 workers, queue max 20 (→ 503), per IP 10 builds / 600 s and 1 active job (→ 429).
- Job directory + results deleted 600 s after completion.
- No user source code in logs. No database.
- Board definitions + examples vendored from Apio (GPL-2.0); keep `LICENSE` and attribution in `backend/fpgaweb/data/apio/`.
- Toolchain pins: openXC7 = `fpgawars/tools-openxc7` commit `8a01b11b7bac1e66c01d44f43c3a5290f65981a7` (nextpnr-xilinx `0eae9fbb19dfb83cdd30d5048d8b0ba744180ad0`, chipdb release tag `2026-09-24`); OSS CAD Suite release `2026-09-25`.
- Flashing only in Chromium browsers (WebUSB); other browsers get download-only mode.
- Commit after each task; messages in Conventional Commits style ending with the `Co-Authored-By` trailer used in this repo.

**Plan-level decisions (spec §7 refinements):** memory is capped with `RLIMIT_AS` = 4 GiB per tool process (portable, no cgroup delegation needed inside Docker; nextpnr-xilinx on the largest parts needs > 3 GB virtual), and the process-count cap is enforced by the container `pids_limit` instead of `RLIMIT_NPROC` (which is per-UID and would count all workers together).

## Review Focus

1. **CRLF / BOM files from Windows editors** — a project uploaded or pasted with `\r\n` line endings or a UTF-8 BOM must build exactly like the LF version (Task 3 test `test_crlf_and_bom_normalised`).
2. **`` `include `` of a sibling project file** — `` `include "defs.vh" `` must work while `` `include "/etc/passwd" `` must fail (Task 5 bwrap tests + Task 11 integration test `test_include_sibling_file`).
3. **Browser tab reload / SSE reconnect mid-build** — reconnecting with `Last-Event-ID` or `?from=` replays missed events and ends at the terminal event; the build keeps running after a disconnect (Task 8 `test_stream_replays_from_index`, Task 10 `test_sse_resume_last_event_id`).
4. **Two concurrent builds needing the same not-yet-cached Xilinx chipdb** — exactly one download, both builds proceed (Task 6 `test_concurrent_ensure_downloads_once`).
5. **Designs that print huge amounts of output** (e.g. thousands of warnings) — log capped with a single truncation notice, job still completes (Task 8 `test_log_is_truncated`).

---

## File Structure

```
fpga-web/
├── backend/
│   ├── pyproject.toml
│   ├── dev.env                      # local toolchain paths (Apio packages on x86 dev box)
│   ├── fpgaweb/
│   │   ├── __init__.py
│   │   ├── config.py                # Settings dataclass + from_env()
│   │   ├── jsonc.py                 # comment-stripping JSON loader
│   │   ├── boards.py                # Board, BoardRegistry, templates
│   │   ├── flash.py                 # flash capability + openFPGALoader args per board
│   │   ├── validation.py            # BuildRequest validation / normalisation
│   │   ├── recipes.py               # per-arch tool command plans
│   │   ├── sandbox.py               # bubblewrap + rlimits step runner
│   │   ├── chipdb.py                # lazy Xilinx chipdb download + verify
│   │   ├── summary.py               # nextpnr report.json → utilisation/fmax
│   │   ├── jobs.py                  # Job, JobManager (queue, workers, events, TTL)
│   │   ├── ratelimit.py             # sliding-window per-key limiter
│   │   ├── api.py                   # FastAPI app factory
│   │   ├── main.py                  # ASGI entrypoint (env → app)
│   │   └── data/apio/               # vendored Apio definitions (boards, fpgas, examples, parts index)
│   └── tests/
│       ├── conftest.py
│       ├── test_config.py  test_jsonc.py  test_boards.py  test_flash.py
│       ├── test_validation.py  test_recipes.py  test_sandbox.py
│       ├── test_chipdb.py  test_summary.py  test_jobs.py
│       ├── test_ratelimit.py  test_api.py
│       └── integration/test_toolchain.py
├── frontend/
│   ├── package.json  tsconfig.json  vite.config.ts  playwright.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── api.ts  project.ts  errors.ts  editor.ts
│   │   ├── flasher.ts  setup-help.ts  main.ts  style.css
│   └── tests/
│       ├── errors.test.ts  project.test.ts  flasher.test.ts
│       └── e2e/build.spec.ts
├── docker/
│   ├── Dockerfile
│   ├── Caddyfile
│   └── compose.yaml
├── scripts/
│   ├── vendor_apio_defs.sh
│   └── check_container.sh
└── docs/
    ├── deploy.md
    └── manual-flash-checklist.md
```

---

### Task 1: Backend scaffold, settings, JSONC loader, board registry

**Files:**
- Create: `backend/pyproject.toml`, `backend/fpgaweb/__init__.py`, `backend/fpgaweb/config.py`, `backend/fpgaweb/jsonc.py`, `backend/fpgaweb/boards.py`, `scripts/vendor_apio_defs.sh`, `backend/fpgaweb/data/apio/**` (generated by script), `.gitignore`
- Test: `backend/tests/__init__.py` (empty, lets tests import each other), `backend/tests/conftest.py`, `backend/tests/test_config.py`, `backend/tests/test_jsonc.py`, `backend/tests/test_boards.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `fpgaweb.config.Settings` (frozen dataclass; fields listed in Step 3) and `from_env(env: Mapping[str, str] = os.environ) -> Settings`.
  - `fpgaweb.jsonc.load_jsonc(path: Path) -> dict`.
  - `fpgaweb.boards.ARCH_CONSTRAINT: dict[str, str]`, `ARCH_BITSTREAM: dict[str, str]`, `CONSTRAINT_EXTS: frozenset[str]`.
  - `fpgaweb.boards.Board` (frozen dataclass: `id, description, arch, fpga_id, part_num, params: dict[str, str], programmer: dict, usb: dict | None`; properties `constraint_ext`, `bitstream_ext`).
  - `fpgaweb.boards.Template` (dataclass: `top: str, files: dict[str, str]`).
  - `fpgaweb.boards.BoardRegistry(data_dir: Path)` with `get(board_id) -> Board` (raises `KeyError`), `all() -> list[Board]` (sorted by id), `template(board_id) -> Template`.

- [ ] **Step 1: Create repo scaffolding and vendor Apio definitions**

`.gitignore`:
```gitignore
__pycache__/
*.pyc
.venv/
.pytest_cache/
node_modules/
frontend/dist/
frontend/test-results/
frontend/playwright-report/
```

`scripts/vendor_apio_defs.sh`:
```bash
#!/usr/bin/env bash
# Copy Apio board/FPGA definitions, blinky examples and the Xilinx parts index
# into backend/fpgaweb/data/apio. Re-run when bumping the Apio definitions.
set -euo pipefail
SRC="${APIO_PACKAGES:-$HOME/.apio/packages}"
DST="$(cd "$(dirname "$0")/.." && pwd)/backend/fpgaweb/data/apio"
rm -rf "$DST"
mkdir -p "$DST/examples"
cp "$SRC/definitions/boards.jsonc" "$SRC/definitions/fpgas.jsonc" \
   "$SRC/definitions/LICENSE" "$SRC/definitions/BUILD-INFO.json" "$DST/"
cp "$SRC/openxc7/XILINX-PARTS-INDEX.json" "$DST/"
for dir in "$SRC"/definitions/examples/*/blinky; do
  board="$(basename "$(dirname "$dir")")"
  mkdir -p "$DST/examples/$board"
  cp -r "$dir/." "$DST/examples/$board/"
done
cat > "$DST/NOTICE.md" <<'EOF'
Files in this directory are copied from the Apio project
(https://github.com/FPGAwars/apio), licensed under GPL-2.0 (see LICENSE).
EOF
echo "vendored $(ls "$DST/examples" | wc -l) examples into $DST"
```

Run:
```bash
cd ~/projects/fpga-web && chmod +x scripts/vendor_apio_defs.sh && scripts/vendor_apio_defs.sh
```
Expected: `vendored 51 examples into .../backend/fpgaweb/data/apio`

`backend/pyproject.toml`:
```toml
[project]
name = "fpgaweb"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["fpgaweb*"]

[tool.setuptools.package-data]
fpgaweb = ["data/**/*"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
markers = ["integration: needs real FPGA toolchains (FPGAWEB_INTEGRATION=1)"]
```

`backend/fpgaweb/__init__.py` and `backend/tests/__init__.py`: empty files.

Run:
```bash
cd ~/projects/fpga-web/backend && python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'
```

- [ ] **Step 2: Write failing tests for jsonc, config, boards**

`backend/tests/conftest.py`:
```python
from pathlib import Path

import pytest

from fpgaweb.boards import BoardRegistry
from fpgaweb.config import Settings

DATA_DIR = Path(__file__).resolve().parents[1] / "fpgaweb" / "data"


@pytest.fixture(scope="session")
def registry() -> BoardRegistry:
    return BoardRegistry(DATA_DIR)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        work_dir=tmp_path / "jobs",
        chipdb_dir=tmp_path / "chipdb",
        sandbox="none",
        tool_path="/usr/bin:/bin",
        ro_binds=(),
    )
```

`backend/tests/test_jsonc.py`:
```python
from pathlib import Path

from fpgaweb.jsonc import load_jsonc


def test_strips_line_comments_but_not_urls_in_strings(tmp_path: Path):
    p = tmp_path / "a.jsonc"
    p.write_text('// header\n{\n  "url": "https://x.org/a", // trailing\n  "n": 1\n}\n')
    assert load_jsonc(p) == {"url": "https://x.org/a", "n": 1}


def test_escaped_quote_inside_string(tmp_path: Path):
    p = tmp_path / "b.jsonc"
    p.write_text('{"s": "say \\"hi\\" // not a comment"}')
    assert load_jsonc(p) == {"s": 'say "hi" // not a comment'}
```

`backend/tests/test_config.py`:
```python
from pathlib import Path

from fpgaweb.config import Settings, from_env


def test_defaults_are_container_paths():
    s = Settings()
    assert s.work_dir == Path("/var/lib/fpgaweb/jobs")
    assert s.workers == 2 and s.queue_max == 20
    assert s.sandbox == "bwrap"


def test_from_env_parses_types():
    s = from_env({
        "FPGAWEB_WORKERS": "3",
        "FPGAWEB_WORK_DIR": "/tmp/j",
        "FPGAWEB_RO_BINDS": "/a:/b",
        "FPGAWEB_TRUST_PROXY": "true",
        "FPGAWEB_STATIC_DIR": "/srv/web",
        "UNRELATED": "x",
    })
    assert s.workers == 3
    assert s.work_dir == Path("/tmp/j")
    assert s.ro_binds == ("/a", "/b")
    assert s.trust_proxy is True
    assert s.static_dir == Path("/srv/web")
```

`backend/tests/test_boards.py`:
```python
import pytest

from fpgaweb.boards import ARCH_BITSTREAM, ARCH_CONSTRAINT


def test_registry_loads_all_apio_boards(registry):
    boards = registry.all()
    assert len(boards) == 109
    assert {b.arch for b in boards} == {"xilinx", "ice40", "ecp5", "gowin"}


def test_basys3_board(registry):
    b = registry.get("basys3")
    assert b.arch == "xilinx"
    assert b.params["yosys-part"] == "xc7a35tcpg236-1"
    assert b.constraint_ext == ".xdc" and b.bitstream_ext == ".bit"
    assert b.usb == {"vid": "0403", "pid": "6010", "product-regex": "^Digilent USB Device*"}


def test_unknown_board_raises(registry):
    with pytest.raises(KeyError):
        registry.get("nope")


def test_template_from_apio_example(registry):
    t = registry.template("sipeed-tang-nano-9k")
    assert t.top == "blinky"
    assert set(t.files) == {"blinky.v", "blinky.cst"}  # tb, gtkw, apio.ini, info, apio_testing.vh dropped


def test_template_fallback_for_board_without_example(registry):
    t = registry.template("colorlight-i9-v7-2-ft2232h")
    assert t.top == "main"
    assert "main.v" in t.files
    assert "colorlight-i9-v7-2-ft2232h.lpf" in t.files


def test_arch_tables_cover_all_arches():
    assert set(ARCH_CONSTRAINT) == set(ARCH_BITSTREAM) == {"xilinx", "ice40", "ecp5", "gowin"}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/projects/fpga-web/backend && .venv/bin/pytest -q`
Expected: collection errors, `ModuleNotFoundError: No module named 'fpgaweb.boards'`.

- [ ] **Step 4: Implement config, jsonc, boards**

`backend/fpgaweb/config.py`:
```python
"""Runtime settings, overridable with FPGAWEB_<FIELD> environment variables."""

import os
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Mapping

PACKAGE_DATA = Path(__file__).resolve().parent / "data"


@dataclass(frozen=True)
class Settings:
    data_dir: Path = PACKAGE_DATA
    work_dir: Path = Path("/var/lib/fpgaweb/jobs")
    chipdb_dir: Path = Path("/var/lib/fpgaweb/chipdb")
    chipdb_url: str = "https://github.com/fpgawars/tools-openxc7/releases/download/{tag}/{asset}"
    prjxray_db: Path = Path("/opt/fpga/prjxray-db")
    trellis_db: Path = Path("/opt/fpga/oss-cad-suite/share/trellis/database")
    yosys_share: Path = Path("/opt/fpga/oss-cad-suite/share/yosys")
    tool_path: str = "/opt/fpga/bin:/opt/fpga/oss-cad-suite/bin:/usr/bin:/bin"
    ro_binds: tuple[str, ...] = ("/opt/fpga", "/nix/store", "/var/lib/fpgaweb/chipdb")
    sandbox: str = "bwrap"  # "bwrap" | "none"
    static_dir: Path | None = None
    trust_proxy: bool = False
    workers: int = 2
    queue_max: int = 20
    job_ttl_s: int = 600
    wall_s: int = 120
    cpu_s: int = 90
    mem_bytes: int = 4 * 1024**3
    fsize_bytes: int = 200 * 1024**2
    max_log_lines: int = 5000
    max_line_chars: int = 2000
    rate_n: int = 10
    rate_window_s: int = 600


def _coerce(name: str, raw: str):
    default = getattr(Settings, name, None)
    if name == "ro_binds":
        return tuple(p for p in raw.split(":") if p)
    if name == "static_dir":
        return Path(raw) if raw else None
    if isinstance(default, bool):
        return raw.strip().lower() in ("1", "true", "yes")
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, Path):
        return Path(raw)
    return raw


def from_env(env: Mapping[str, str] = os.environ) -> Settings:
    kwargs = {}
    for f in fields(Settings):
        key = "FPGAWEB_" + f.name.upper()
        if key in env:
            kwargs[f.name] = _coerce(f.name, env[key])
    return Settings(**kwargs)
```

`backend/fpgaweb/jsonc.py`:
```python
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
```

`backend/fpgaweb/boards.py`:
```python
"""Board registry backed by Apio's vendored board and FPGA definitions."""

import configparser
from dataclasses import dataclass
from pathlib import Path

from fpgaweb.jsonc import load_jsonc

ARCH_CONSTRAINT = {"xilinx": ".xdc", "ice40": ".pcf", "ecp5": ".lpf", "gowin": ".cst"}
ARCH_BITSTREAM = {"xilinx": ".bit", "ice40": ".bin", "ecp5": ".bit", "gowin": ".fs"}
CONSTRAINT_EXTS = frozenset(ARCH_CONSTRAINT.values())
TEMPLATE_EXTS = frozenset({".v", ".sv", ".vh", ".svh", ".hex", ".mem"}) | CONSTRAINT_EXTS

_COMMENT = {".xdc": "#", ".pcf": "#", ".lpf": "#", ".cst": "//"}

FALLBACK_TOP = "main"
FALLBACK_VERILOG = """\
module main (
    input  wire clk,
    output wire led
);
  reg [23:0] counter = 0;
  always @(posedge clk) counter <= counter + 1;
  assign led = counter[23];
endmodule
"""


@dataclass(frozen=True)
class Board:
    id: str
    description: str
    arch: str
    fpga_id: str
    part_num: str
    params: dict[str, str]
    programmer: dict
    usb: dict | None

    @property
    def constraint_ext(self) -> str:
        return ARCH_CONSTRAINT[self.arch]

    @property
    def bitstream_ext(self) -> str:
        return ARCH_BITSTREAM[self.arch]


@dataclass(frozen=True)
class Template:
    top: str
    files: dict[str, str]


class BoardRegistry:
    def __init__(self, data_dir: Path):
        apio = data_dir / "apio"
        self._examples = apio / "examples"
        boards = load_jsonc(apio / "boards.jsonc")
        fpgas = load_jsonc(apio / "fpgas.jsonc")
        self._boards: dict[str, Board] = {}
        for board_id, b in boards.items():
            fpga = fpgas[b["fpga-id"]]
            arch = fpga["arch"]
            self._boards[board_id] = Board(
                id=board_id,
                description=b["description"],
                arch=arch,
                fpga_id=b["fpga-id"],
                part_num=fpga["part-num"],
                params=dict(fpga[f"{arch}-params"]),
                programmer=dict(b["programmer"]),
                usb=dict(b["usb"]) if "usb" in b else None,
            )

    def get(self, board_id: str) -> Board:
        return self._boards[board_id]

    def all(self) -> list[Board]:
        return [self._boards[k] for k in sorted(self._boards)]

    def template(self, board_id: str) -> Template:
        board = self.get(board_id)
        example = self._examples / board_id
        if example.is_dir():
            ini = configparser.ConfigParser()
            ini.read(example / "apio.ini")
            top = ini.get("env:default", "top-module", fallback=FALLBACK_TOP)
            files = {
                p.name: p.read_text(encoding="utf-8")
                for p in sorted(example.iterdir())
                if p.is_file()
                and p.suffix in TEMPLATE_EXTS
                and not p.stem.endswith("_tb")
                and not p.name.startswith("apio_testing")
            }
            return Template(top=top, files=files)
        c = _COMMENT[board.constraint_ext]
        constraint = (
            f"{c} Pin constraints for {board.description}.\n"
            f"{c} Map the ports of module '{FALLBACK_TOP}' (clk, led) to your board's pins.\n"
        )
        return Template(
            top=FALLBACK_TOP,
            files={"main.v": FALLBACK_VERILOG, f"{board_id}{board.constraint_ext}": constraint},
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/projects/fpga-web/backend && .venv/bin/pytest -q`
Expected: all tests PASS. If `test_registry_loads_all_apio_boards` reports a different count, the vendored Apio definitions changed; update the expected count to the number printed by `python -c "from fpgaweb.boards import BoardRegistry;from fpgaweb.config import PACKAGE_DATA;print(len(BoardRegistry(PACKAGE_DATA).all()))"`.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/fpga-web && git add -A && git commit -m "feat(backend): scaffold settings, jsonc loader and board registry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Flash capability and openFPGALoader arguments

**Files:**
- Create: `backend/fpgaweb/flash.py`
- Test: `backend/tests/test_flash.py`

**Interfaces:**
- Consumes: `fpgaweb.boards.Board`.
- Produces: `fpgaweb.flash.FlashPlan` (frozen dataclass: `mode: str` — `"browser"` or `"download"`, `args: list[str]`, `writes_flash: bool`) and `flash_plan(board: Board) -> FlashPlan`. `args` excludes the bitstream filename; the frontend appends it.

Mapping rules (from Apio's `programmer` field):
- `openfpgaloader`: `shlex.split(extra-args)`, with `${VID}` / `${PID}` replaced from `board.usb`. `writes_flash` true if `-f` or `--write-flash` present.
- `iceprog` (FTDI SPI flash, iCE40): `["-b", "ice40_generic"]`, `writes_flash=True`. Exception: boards whose Apio `extra-args` select another FTDI interface (e.g. `kefir` with `-I B`) → download.
- `dfu`: `["--dfu", "--vid", "0x<vid>", "--pid", "0x<pid>"]`, `writes_flash=True`; requires `board.usb`.
- `fujprog` (ULX3S): `["-b", "ulx3s"]`, `writes_flash=False`.
- anything else → `FlashPlan("download", [], False)`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_flash.py`:
```python
from fpgaweb.flash import flash_plan


def test_openfpgaloader_board_uses_apio_extra_args(registry):
    p = flash_plan(registry.get("basys3"))
    assert p.mode == "browser"
    assert p.args == ["--board", "basys3"]
    assert p.writes_flash is False


def test_vid_pid_placeholders_are_substituted(registry):
    b = registry.get("colorlight-i5-v7-0")
    p = flash_plan(b)
    assert p.mode == "browser"
    assert f"0x{b.usb['vid']}" in p.args and f"0x{b.usb['pid']}" in p.args
    assert not any("${" in a for a in p.args)
    assert p.writes_flash is True  # --write-flash


def test_iceprog_board_maps_to_ice40_generic(registry):
    p = flash_plan(registry.get("icebreaker"))
    assert p == p.__class__("browser", ["-b", "ice40_generic"], True)


def test_iceprog_with_custom_interface_is_download_only(registry):
    assert flash_plan(registry.get("kefir")).mode == "download"


def test_dfu_board(registry):
    b = registry.get("orangecrab-r02-25f")
    p = flash_plan(b)
    assert p.mode == "browser"
    assert p.args == ["--dfu", "--vid", f"0x{b.usb['vid']}", "--pid", f"0x{b.usb['pid']}"]


def test_fujprog_board(registry):
    assert flash_plan(registry.get("ulx3s-85f")).args == ["-b", "ulx3s"]


def test_unsupported_programmer_is_download_only(registry):
    p = flash_plan(registry.get("tinyfpga-bx"))
    assert p.mode == "download" and p.args == []


def test_most_boards_flash_in_browser(registry):
    modes = [flash_plan(b).mode for b in registry.all()]
    assert modes.count("browser") >= 90
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/fpga-web/backend && .venv/bin/pytest tests/test_flash.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'fpgaweb.flash'`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/flash.py`:
```python
"""How (and whether) the browser can flash a board with openFPGALoader (WebUSB)."""

import shlex
from dataclasses import dataclass, field

from fpgaweb.boards import Board

_FLASH_FLAGS = ("-f", "--write-flash")


@dataclass(frozen=True)
class FlashPlan:
    mode: str  # "browser" | "download"
    args: list[str] = field(default_factory=list)
    writes_flash: bool = False


_DOWNLOAD = FlashPlan("download", [], False)


def flash_plan(board: Board) -> FlashPlan:
    prog = board.programmer
    kind = prog["id"]
    extra = prog.get("extra-args", "").strip()
    usb = board.usb or {}

    if kind == "openfpgaloader":
        args = [
            a.replace("${VID}", usb.get("vid", "")).replace("${PID}", usb.get("pid", ""))
            for a in shlex.split(extra)
        ]
        return FlashPlan("browser", args, any(a in _FLASH_FLAGS for a in args))
    if kind == "iceprog":
        if extra:
            return _DOWNLOAD
        return FlashPlan("browser", ["-b", "ice40_generic"], True)
    if kind == "dfu":
        if not usb:
            return _DOWNLOAD
        return FlashPlan("browser", ["--dfu", "--vid", f"0x{usb['vid']}", "--pid", f"0x{usb['pid']}"], True)
    if kind == "fujprog":
        return FlashPlan("browser", ["-b", "ulx3s"], False)
    return _DOWNLOAD
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/fpga-web/backend && .venv/bin/pytest tests/test_flash.py -q`
Expected: PASS. If `test_most_boards_flash_in_browser` fails, print the count and the download-only boards (`[b.id for b in registry.all() if flash_plan(b).mode=="download"]`) and lower the floor to the actual count only if every listed board uses a programmer outside the mapping rules above.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/flash.py backend/tests/test_flash.py && git commit -m "feat(backend): map boards to browser flash plans

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Build request validation

**Files:**
- Create: `backend/fpgaweb/validation.py`
- Test: `backend/tests/test_validation.py`

**Interfaces:**
- Consumes: `fpgaweb.boards.Board`, `CONSTRAINT_EXTS`.
- Produces:
  - `ValidationError(ValueError)`.
  - `MAX_FILES = 50`, `MAX_TOTAL_BYTES = 1_000_000`, `DESIGN_EXTS = frozenset({".v", ".sv"})`.
  - `is_testbench(name: str) -> bool`.
  - `validate_files(board: Board, top: str, files: dict[str, str]) -> dict[str, str]` — returns normalised files (BOM stripped, CRLF/CR → LF) or raises `ValidationError` with a user-facing message.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_validation.py`:
```python
import pytest

from fpgaweb.validation import ValidationError, is_testbench, validate_files

V = "module main(input clk, output led); assign led = clk; endmodule\n"


@pytest.fixture
def basys3(registry):
    return registry.get("basys3")


def ok(**extra):
    return {"main.v": V, "pins.xdc": "# pins\n", **extra}


def test_valid_request_passes(basys3):
    assert validate_files(basys3, "main", ok()) == ok()


def test_crlf_and_bom_normalised(basys3):
    files = {"main.v": "\ufeffmodule main();\r\nendmodule\r\n", "pins.xdc": "# a\rb\n"}
    out = validate_files(basys3, "main", files)
    assert out["main.v"] == "module main();\nendmodule\n"
    assert out["pins.xdc"] == "# a\nb\n"


@pytest.mark.parametrize("name", ["../x.v", "/etc/passwd.v", "a/b.v", ".hidden.v", "x" * 70 + ".v", "a b.v"])
def test_bad_filenames_rejected(basys3, name):
    with pytest.raises(ValidationError, match="file name"):
        validate_files(basys3, "main", ok(**{name: V}))


def test_bad_extension_rejected(basys3):
    with pytest.raises(ValidationError, match="extension"):
        validate_files(basys3, "main", ok(**{"run.sh": "echo"}))


def test_too_many_files(basys3):
    files = ok(**{f"m{i}.v": "" for i in range(49)})
    with pytest.raises(ValidationError, match="50 files"):
        validate_files(basys3, "main", files)


def test_too_large(basys3):
    with pytest.raises(ValidationError, match="1 MB"):
        validate_files(basys3, "main", ok(**{"big.mem": "0" * 1_000_001}))


def test_nul_byte_rejected(basys3):
    with pytest.raises(ValidationError, match="binary"):
        validate_files(basys3, "main", ok(**{"x.v": "a\x00b"}))


def test_wrong_constraint_type_for_board(basys3):
    with pytest.raises(ValidationError, match=r"\.xdc"):
        validate_files(basys3, "main", {"main.v": V, "pins.pcf": ""})


def test_exactly_one_constraint_file(basys3):
    with pytest.raises(ValidationError, match="exactly one"):
        validate_files(basys3, "main", ok(**{"more.xdc": ""}))


def test_needs_a_design_source(basys3):
    with pytest.raises(ValidationError, match="Verilog"):
        validate_files(basys3, "main", {"main_tb.v": V, "pins.xdc": ""})


@pytest.mark.parametrize("top", ["", "1abc", "a b", "x;rm", "a" * 200])
def test_bad_top_module(basys3, top):
    with pytest.raises(ValidationError, match="top module"):
        validate_files(basys3, top, ok())


def test_is_testbench():
    assert is_testbench("cpu_tb.v") and is_testbench("x_tb.sv")
    assert not is_testbench("tb_helper.v")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_validation.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/validation.py`:
```python
"""Validate and normalise a build request's files before anything touches disk."""

import re

from fpgaweb.boards import CONSTRAINT_EXTS, Board

MAX_FILES = 50
MAX_TOTAL_BYTES = 1_000_000
DESIGN_EXTS = frozenset({".v", ".sv"})
ALLOWED_EXTS = DESIGN_EXTS | {".vh", ".svh", ".hex", ".mem"} | CONSTRAINT_EXTS

NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")


class ValidationError(ValueError):
    pass


def _ext(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot > 0 else ""


def is_testbench(name: str) -> bool:
    return _ext(name) in DESIGN_EXTS and name.rsplit(".", 1)[0].endswith("_tb")


def _normalise(text: str) -> str:
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n")


def validate_files(board: Board, top: str, files: dict[str, str]) -> dict[str, str]:
    if not MODULE_RE.fullmatch(top or ""):
        raise ValidationError("top module must be a valid Verilog identifier")
    if len(files) > MAX_FILES:
        raise ValidationError(f"a project can have at most {MAX_FILES} files")
    total = 0
    out: dict[str, str] = {}
    for name, text in files.items():
        if not NAME_RE.fullmatch(name):
            raise ValidationError(f"invalid file name: {name!r}")
        if _ext(name) not in ALLOWED_EXTS:
            raise ValidationError(f"file extension not allowed: {name!r}")
        if "\x00" in text:
            raise ValidationError(f"{name} looks binary (contains NUL bytes)")
        total += len(text.encode("utf-8"))
        out[name] = _normalise(text)
    if total > MAX_TOTAL_BYTES:
        raise ValidationError("project is larger than 1 MB")

    constraints = [n for n in out if _ext(n) in CONSTRAINT_EXTS]
    wrong = [n for n in constraints if _ext(n) != board.constraint_ext]
    if wrong:
        raise ValidationError(
            f"{board.id} uses {board.constraint_ext} constraint files, not {', '.join(wrong)}"
        )
    if len(constraints) != 1:
        raise ValidationError(f"project must contain exactly one {board.constraint_ext} file")
    if not any(_ext(n) in DESIGN_EXTS and not is_testbench(n) for n in out):
        raise ValidationError("project has no Verilog design source (.v or .sv)")
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_validation.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/validation.py backend/tests/test_validation.py && git commit -m "feat(backend): validate and normalise build requests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Per-arch build recipes

**Files:**
- Create: `backend/fpgaweb/recipes.py`
- Test: `backend/tests/test_recipes.py`

**Interfaces:**
- Consumes: `Board`, `Settings`, `validation.is_testbench`, `validation.DESIGN_EXTS`.
- Produces:
  - `Step` (frozen dataclass: `name: str, argv: list[str], stdout_file: str | None = None`).
  - `BuildPlan` (frozen dataclass: `steps: list[Step], extra_files: dict[str, str], output: str`).
  - `REPORT = "report.json"`.
  - `plan_build(board: Board, top: str, files: dict[str, str], settings: Settings, chipdb: Path | None, lint: bool) -> BuildPlan`. Raises `ValueError` if `board.arch == "xilinx"` and `chipdb is None`.

All job-local paths in argv are relative (the sandbox mounts the job dir as cwd). Absolute paths only for read-only toolchain data (`settings.prjxray_db`, `settings.trellis_db`, `settings.yosys_share`, `chipdb`). Flags mirror Apio 1.6.0's `scons/plugin_<arch>.py` with `-q` quiet mode.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_recipes.py`:
```python
from pathlib import Path

import pytest

from fpgaweb.recipes import REPORT, plan_build

FILES = {"main.v": "", "inc.vh": "", "main_tb.v": "", "b.sv": "", "pins.xdc": "", "pins.pcf": "",
         "pins.lpf": "", "pins.cst": ""}


def names(plan):
    return [s.name for s in plan.steps]


def test_xilinx_plan(registry, settings):
    chipdb = Path("/cdb/xc7a35tcpg236.bin")
    p = plan_build(registry.get("basys3"), "main", {"main.v": "", "b.sv": "", "main_tb.v": "", "pins.xdc": ""},
                   settings, chipdb, lint=False)
    assert names(p) == ["synth", "pnr", "fasm2frames", "frames2bit"]
    synth = p.steps[0].argv
    assert synth[:3] == ["yosys", "-q", "-p"]
    assert synth[3] == "synth_xilinx -arch xc7 -top main; write_json hw.json"
    assert synth[4:] == ["b.sv", "main.v"]  # sorted, testbench excluded
    pnr = p.steps[1].argv
    assert pnr[:4] == ["nextpnr-xilinx", "-q", "--chipdb", str(chipdb)]
    assert ["--xdc", "pins.xdc"] == pnr[4:6]
    assert "--report" in pnr and REPORT in pnr
    db = settings.prjxray_db / "artix7"
    assert p.steps[2].argv == ["fasm2frames", "--part", "xc7a35tcpg236-1", "--db-root", str(db), "hw.fasm"]
    assert p.steps[2].stdout_file == "hw.frames"
    assert p.steps[3].argv == ["xc7frames2bit", "--part_file", str(db / "xc7a35tcpg236-1" / "part.yaml"),
                               "--part_name", "xc7a35tcpg236-1", "--frm_file", "hw.frames",
                               "--output_file", "hw.bit"]
    assert p.output == "hw.bit"


def test_xilinx_requires_chipdb(registry, settings):
    with pytest.raises(ValueError, match="chipdb"):
        plan_build(registry.get("basys3"), "main", {"main.v": "", "p.xdc": ""}, settings, None, lint=False)


def test_ice40_plan(registry, settings):
    b = registry.get("icebreaker")
    p = plan_build(b, "top", {"main.v": "", "p.pcf": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    assert p.steps[0].argv[3] == "synth_ice40 -top top -json hw.json"
    pnr = p.steps[1].argv
    assert pnr[:3] == ["nextpnr-ice40", "-q", f"--{b.params['type']}"]
    assert ["--package", b.params["package"]] == pnr[3:5]
    assert pnr[-2:] == ["--pcf", "p.pcf"]
    assert p.steps[2].argv == ["icepack", "hw.asc", "hw.bin"]
    assert p.output == "hw.bin"


def test_ecp5_plan(registry, settings):
    b = registry.get("ulx3s-85f")
    p = plan_build(b, "top", {"main.v": "", "p.lpf": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    assert p.steps[0].argv[3] == "synth_ecp5 -top top -json hw.json"
    pnr = p.steps[1].argv
    assert pnr[:3] == ["nextpnr-ecp5", "-q", f"--{b.params['type']}"]
    assert "--timing-allow-fail" in pnr and ["--lpf", "p.lpf"] == pnr[-3:-1]
    assert p.steps[2].argv == ["ecppack", "--compress", "--db", str(settings.trellis_db), "hw.config", "hw.bit"]


def test_gowin_plan(registry, settings):
    b = registry.get("sipeed-tang-nano-9k")
    p = plan_build(b, "blinky", {"blinky.v": "", "blinky.cst": ""}, settings, None, lint=False)
    assert names(p) == ["synth", "pnr", "pack"]
    fam = b.params["yosys-family"]
    expected = "synth_gowin -top blinky" + (f" -family {fam}" if fam else "") + " -json hw.json"
    assert p.steps[0].argv[3] == expected
    pnr = p.steps[1].argv
    assert pnr[:4] == ["nextpnr-himbaechel", "-q", "--device", b.part_num]
    assert "cst=blinky.cst" in pnr
    assert p.steps[2].argv == ["gowin_pack", "-d", b.params["packer-device"], "-o", "hw.fs", "pnr.json"]
    assert p.output == "hw.fs"


def test_lint_step_first_with_vlt_waiver(registry, settings):
    p = plan_build(registry.get("icebreaker"), "top", {"main.v": "", "p.pcf": ""}, settings, None, lint=True)
    lint = p.steps[0]
    assert lint.name == "lint"
    assert lint.argv[0] == "verilator"
    assert "--lint-only" in lint.argv and "--top-module" in lint.argv
    assert "lint.vlt" in lint.argv and "main.v" in lint.argv
    assert str(settings.yosys_share / "ice40" / "cells_sim.v") in lint.argv
    assert f'lint_off -file "{settings.yosys_share}/*"' in p.extra_files["lint.vlt"]


def test_top_is_not_shell_interpreted(registry, settings):
    p = plan_build(registry.get("icebreaker"), "t_1", {"main.v": "", "p.pcf": ""}, settings, None, lint=False)
    assert all(isinstance(a, str) for s in p.steps for a in s.argv)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_recipes.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/recipes.py`:
```python
"""Tool command plans per FPGA architecture (flags mirror Apio 1.6 scons plugins)."""

from dataclasses import dataclass, field
from pathlib import Path

from fpgaweb.boards import Board
from fpgaweb.config import Settings
from fpgaweb.validation import DESIGN_EXTS, is_testbench

REPORT = "report.json"


@dataclass(frozen=True)
class Step:
    name: str
    argv: list[str]
    stdout_file: str | None = None


@dataclass(frozen=True)
class BuildPlan:
    steps: list[Step]
    extra_files: dict[str, str] = field(default_factory=dict)
    output: str = ""


def _sources(files: dict[str, str]) -> list[str]:
    return sorted(n for n in files if Path(n).suffix.lower() in DESIGN_EXTS and not is_testbench(n))


def _constraint(board: Board, files: dict[str, str]) -> str:
    return next(n for n in files if n.lower().endswith(board.constraint_ext))


def _lint_libs(board: Board, s: Settings) -> list[str]:
    lib = s.yosys_share / board.arch
    extra = {"xilinx": ["cells_xtra.v"], "ecp5": ["cells_bb.v"]}.get(board.arch, [])
    return [str(lib / f) for f in ["cells_sim.v", *extra]]


def _lint(board: Board, top: str, srcs: list[str], s: Settings) -> tuple[Step, dict[str, str]]:
    vlt = f'`verilator_config\nlint_off -file "{s.yosys_share}/*"\n'
    argv = [
        "verilator", "--lint-only", "--quiet", "--bbox-unsup", "--timing",
        "-Wno-TIMESCALEMOD", "-Wno-MULTITOP", "-Wno-fatal", "-DSYNTHESIZE",
        "--top-module", top, "lint.vlt", *_lint_libs(board, s), *srcs,
    ]
    return Step("lint", argv), {"lint.vlt": vlt}


def plan_build(board: Board, top: str, files: dict[str, str], settings: Settings,
               chipdb: Path | None, lint: bool) -> BuildPlan:
    s = settings
    p = board.params
    srcs = _sources(files)
    cons = _constraint(board, files)
    yosys = lambda script: Step("synth", ["yosys", "-q", "-p", script, *srcs])  # noqa: E731

    if board.arch == "xilinx":
        if chipdb is None:
            raise ValueError("xilinx builds need a chipdb path")
        part, family = p["yosys-part"], p["yosys-family"]
        db = s.prjxray_db / family
        steps = [
            yosys(f"synth_xilinx -arch {p['yosys-arch']} -top {top}; write_json hw.json"),
            Step("pnr", ["nextpnr-xilinx", "-q", "--chipdb", str(chipdb), "--xdc", cons,
                         "--json", "hw.json", "--fasm", "hw.fasm", "--report", REPORT]),
            Step("fasm2frames", ["fasm2frames", "--part", part, "--db-root", str(db), "hw.fasm"],
                 stdout_file="hw.frames"),
            Step("frames2bit", ["xc7frames2bit", "--part_file", str(db / part / "part.yaml"),
                                "--part_name", part, "--frm_file", "hw.frames", "--output_file", "hw.bit"]),
        ]
        output = "hw.bit"
    elif board.arch == "ice40":
        steps = [
            yosys(f"synth_ice40 -top {top} -json hw.json"),
            Step("pnr", ["nextpnr-ice40", "-q", f"--{p['type']}", "--package", p["package"],
                         "--json", "hw.json", "--asc", "hw.asc", "--report", REPORT, "--pcf", cons]),
            Step("pack", ["icepack", "hw.asc", "hw.bin"]),
        ]
        output = "hw.bin"
    elif board.arch == "ecp5":
        steps = [
            yosys(f"synth_ecp5 -top {top} -json hw.json"),
            Step("pnr", ["nextpnr-ecp5", "-q", f"--{p['type']}", "--package", p["package"],
                         "--speed", p["speed"], "--json", "hw.json", "--textcfg", "hw.config",
                         "--report", REPORT, "--timing-allow-fail", "--lpf", cons, "--force"]),
            Step("pack", ["ecppack", "--compress", "--db", str(s.trellis_db), "hw.config", "hw.bit"]),
        ]
        output = "hw.bit"
    elif board.arch == "gowin":
        fam = f" -family {p['yosys-family']}" if p.get("yosys-family") else ""
        nfam = ["--vopt", f"family={p['nextpnr-family']}"] if p.get("nextpnr-family") else []
        steps = [
            yosys(f"synth_gowin -top {top}{fam} -json hw.json"),
            Step("pnr", ["nextpnr-himbaechel", "-q", "--device", board.part_num, "--json", "hw.json",
                         "--write", "pnr.json", "--report", REPORT, "--vopt", f"cst={cons}", *nfam]),
            Step("pack", ["gowin_pack", "-d", p["packer-device"], "-o", "hw.fs", "pnr.json"]),
        ]
        output = "hw.fs"
    else:
        raise ValueError(f"unsupported arch {board.arch}")

    extra: dict[str, str] = {}
    if lint:
        lint_step, extra = _lint(board, top, srcs, s)
        steps = [lint_step, *steps]
    return BuildPlan(steps=steps, extra_files=extra, output=output)
```

Note on `test_ecp5_plan`: `["--lpf", "p.lpf"] == pnr[-3:-1]` holds because `--force` is last.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_recipes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/recipes.py backend/tests/test_recipes.py && git commit -m "feat(backend): per-arch build recipes mirroring apio

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sandboxed step runner

**Files:**
- Create: `backend/fpgaweb/sandbox.py`
- Test: `backend/tests/test_sandbox.py`

**Interfaces:**
- Consumes: `Settings`.
- Produces:
  - `RunResult` (frozen dataclass: `exit_code: int, killed: str | None = None`; `killed` ∈ `{"timeout", "cpu", "memory", "killed", None}`).
  - `sandbox_argv(argv: list[str], cwd: Path, settings: Settings) -> list[str]`.
  - `async run_step(argv: list[str], cwd: Path, settings: Settings, on_line: Callable[[str], None], stdout_file: str | None = None) -> RunResult`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_sandbox.py`:
```python
import dataclasses
import shutil
import subprocess
import sys
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
    assert res.exit_code == 0 and lines[0].endswith("\ufffd")


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_sandbox.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/sandbox.py`:
```python
"""Run one toolchain command in a bubblewrap sandbox with resource limits."""

import asyncio
import os
import resource
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

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
    out_f = open(cwd / stdout_file, "wb") if stdout_file else None
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
        rc = proc.returncode
        return RunResult(rc, _classify(rc, oom))
    finally:
        if out_f:
            out_f.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_sandbox.py -q`
Expected: PASS (bwrap tests run on this machine: Mint 22 ships bubblewrap with an AppArmor profile permitting user namespaces). `test_long_line_and_bad_utf8`: the 200 000-byte line exceeds `_READ_LIMIT`? No — 200 000 < 1 MiB, so `readline` returns it whole; the test checks the decoding replacement char.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/sandbox.py backend/tests/test_sandbox.py && git commit -m "feat(backend): bubblewrap step runner with rlimits and timeouts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Lazy Xilinx chipdb store

**Files:**
- Create: `backend/fpgaweb/chipdb.py`
- Test: `backend/tests/test_chipdb.py`

**Interfaces:**
- Consumes: `Settings` (`chipdb_dir`, `chipdb_url`, `data_dir`).
- Produces:
  - `ChipdbError(RuntimeError)`.
  - `Fetcher = Callable[[str, Path], Awaitable[None]]` (download URL to path).
  - `ChipdbStore(settings: Settings, index: dict | None = None, fetch: Fetcher | None = None)`; index defaults to `settings.data_dir / "apio" / "XILINX-PARTS-INDEX.json"`.
  - `async ChipdbStore.ensure(part: str) -> Path` — returns path to a verified chipdb file; downloads once per chipdb file even under concurrency.

Index format (Apio `XILINX-PARTS-INDEX.json`): `{"release-tag": "2026-09-24", "parts": [[part, {"chipdb", "chipdb-size", "chipdb-sha256", "asset", "asset-sha256", ...}], ...]}`. Assets are `.tgz` with the chipdb file at the root.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_chipdb.py`:
```python
import asyncio
import dataclasses
import hashlib
import io
import tarfile
from pathlib import Path

import pytest

from fpgaweb.chipdb import ChipdbError, ChipdbStore

CHIPDB = b"CHIPDB-CONTENT" * 100


def make_asset(name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo(name)
        info.size = len(content)
        tf.addfile(info, io.BytesIO(content))
    return buf.getvalue()


ASSET = make_asset("xc7a35tcpg236.bin", CHIPDB)


def index(asset_sha=None, chip_sha=None):
    return {
        "release-tag": "2026-09-24",
        "parts": [["xc7a35tcpg236-1", {
            "chipdb": "xc7a35tcpg236.bin",
            "chipdb-size": len(CHIPDB),
            "chipdb-sha256": chip_sha or hashlib.sha256(CHIPDB).hexdigest(),
            "asset": "apio-xilinx-chipdb-xc7a35tcpg236-20260924.bin.tgz",
            "asset-sha256": asset_sha or hashlib.sha256(ASSET).hexdigest(),
        }]],
    }


class FakeFetch:
    def __init__(self, payload=ASSET, delay=0.0):
        self.urls: list[str] = []
        self.payload, self.delay = payload, delay

    async def __call__(self, url: str, dest: Path) -> None:
        self.urls.append(url)
        await asyncio.sleep(self.delay)
        dest.write_bytes(self.payload)


async def test_downloads_verifies_and_caches(settings):
    fetch = FakeFetch()
    store = ChipdbStore(settings, index(), fetch)
    p = await store.ensure("xc7a35tcpg236-1")
    assert p == settings.chipdb_dir / "xc7a35tcpg236.bin"
    assert p.read_bytes() == CHIPDB
    assert fetch.urls == ["https://github.com/fpgawars/tools-openxc7/releases/download/2026-09-24/"
                          "apio-xilinx-chipdb-xc7a35tcpg236-20260924.bin.tgz"]
    await store.ensure("xc7a35tcpg236-1")
    assert len(fetch.urls) == 1


async def test_concurrent_ensure_downloads_once(settings):
    fetch = FakeFetch(delay=0.05)
    store = ChipdbStore(settings, index(), fetch)
    a, b = await asyncio.gather(store.ensure("xc7a35tcpg236-1"), store.ensure("xc7a35tcpg236-1"))
    assert a == b and len(fetch.urls) == 1


async def test_existing_file_with_right_size_is_reused(settings):
    settings.chipdb_dir.mkdir(parents=True)
    (settings.chipdb_dir / "xc7a35tcpg236.bin").write_bytes(CHIPDB)
    fetch = FakeFetch()
    await ChipdbStore(settings, index(), fetch).ensure("xc7a35tcpg236-1")
    assert fetch.urls == []


async def test_bad_asset_hash_rejected(settings):
    store = ChipdbStore(settings, index(asset_sha="0" * 64), FakeFetch())
    with pytest.raises(ChipdbError, match="checksum"):
        await store.ensure("xc7a35tcpg236-1")
    assert not (settings.chipdb_dir / "xc7a35tcpg236.bin").exists()


async def test_bad_chipdb_hash_rejected(settings):
    store = ChipdbStore(settings, index(chip_sha="0" * 64), FakeFetch())
    with pytest.raises(ChipdbError, match="checksum"):
        await store.ensure("xc7a35tcpg236-1")


async def test_unknown_part(settings):
    with pytest.raises(ChipdbError, match="not supported"):
        await ChipdbStore(settings, index(), FakeFetch()).ensure("xc7z999")


def test_default_index_is_vendored_file(settings):
    s = dataclasses.replace(settings, data_dir=Path(__file__).resolve().parents[1] / "fpgaweb" / "data")
    store = ChipdbStore(s)
    assert "xc7a35tcpg236-1" in store.parts
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_chipdb.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/chipdb.py`:
```python
"""Download Xilinx chipdb files from Apio's openXC7 release on first use."""

import asyncio
import hashlib
import json
import os
import tarfile
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from fpgaweb.config import Settings

Fetcher = Callable[[str, Path], Awaitable[None]]


class ChipdbError(RuntimeError):
    pass


async def http_fetch(url: str, dest: Path) -> None:
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=300)) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ChipdbStore:
    def __init__(self, settings: Settings, index: dict | None = None, fetch: Fetcher | None = None):
        if index is None:
            index = json.loads((settings.data_dir / "apio" / "XILINX-PARTS-INDEX.json").read_text())
        self._s = settings
        self._tag = index["release-tag"]
        self.parts: dict[str, dict] = {name: info for name, info in index["parts"]}
        self._fetch = fetch or http_fetch
        self._locks: dict[str, asyncio.Lock] = {}

    async def ensure(self, part: str) -> Path:
        info = self.parts.get(part)
        if info is None:
            raise ChipdbError(f"part {part} is not supported by the Xilinx toolchain")
        dest = self._s.chipdb_dir / info["chipdb"]
        lock = self._locks.setdefault(info["chipdb"], asyncio.Lock())
        async with lock:
            if dest.is_file() and dest.stat().st_size == info["chipdb-size"]:
                return dest
            await self._download(info, dest)
        return dest

    async def _download(self, info: dict, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = self._s.chipdb_url.format(tag=self._tag, asset=info["asset"])
        with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
            tgz = Path(tmp) / info["asset"]
            try:
                await self._fetch(url, tgz)
            except Exception as e:  # network errors surface as a build error
                raise ChipdbError(f"could not download chip database: {e}") from e
            if _sha256(tgz) != info["asset-sha256"]:
                raise ChipdbError("chip database download failed checksum verification")
            with tarfile.open(tgz, "r:gz") as tf:
                member = tf.getmember(info["chipdb"])
                src = tf.extractfile(member)
                if src is None:
                    raise ChipdbError("chip database archive is malformed")
                out = Path(tmp) / info["chipdb"]
                with out.open("wb") as f:
                    while chunk := src.read(1 << 20):
                        f.write(chunk)
            if _sha256(out) != info["chipdb-sha256"]:
                raise ChipdbError("chip database failed checksum verification")
            os.replace(out, dest)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_chipdb.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/chipdb.py backend/tests/test_chipdb.py && git commit -m "feat(backend): lazy verified Xilinx chipdb downloads

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: nextpnr report summary

**Files:**
- Create: `backend/fpgaweb/summary.py`
- Test: `backend/tests/test_summary.py`

**Interfaces:**
- Produces: `read_summary(path: Path) -> dict` returning `{"utilization": {resource: {"used": int, "available": int}}, "fmax": {clock: float_mhz}}` with only `used > 0` resources; returns `{"utilization": {}, "fmax": {}}` if the file is missing or malformed.

nextpnr `--report` JSON format: `{"utilization": {"ICESTORM_LC": {"used": 60, "available": 5280}, ...}, "fmax": {"clk": {"achieved": 71.2, "constraint": 12.0}}, ...}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_summary.py`:
```python
import json

from fpgaweb.summary import read_summary


def test_parses_utilization_and_fmax(tmp_path):
    p = tmp_path / "report.json"
    p.write_text(json.dumps({
        "utilization": {"LUT": {"used": 30, "available": 20800}, "DSP": {"used": 0, "available": 90}},
        "fmax": {"clk$SB_IO_IN_$glb_clk": {"achieved": 71.234, "constraint": 12.0}},
    }))
    assert read_summary(p) == {
        "utilization": {"LUT": {"used": 30, "available": 20800}},
        "fmax": {"clk$SB_IO_IN_$glb_clk": 71.23},
    }


def test_missing_or_bad_file(tmp_path):
    empty = {"utilization": {}, "fmax": {}}
    assert read_summary(tmp_path / "nope.json") == empty
    (tmp_path / "bad.json").write_text("{not json")
    assert read_summary(tmp_path / "bad.json") == empty
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_summary.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/summary.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_summary.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/summary.py backend/tests/test_summary.py && git commit -m "feat(backend): parse nextpnr utilisation and fmax

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Job manager (queue, workers, events, TTL)

**Files:**
- Create: `backend/fpgaweb/jobs.py`
- Test: `backend/tests/test_jobs.py`

**Interfaces:**
- Consumes: `Board`; `Settings`; `recipes.plan_build`/`BuildPlan`/`Step`/`REPORT`; `sandbox.RunResult`; `chipdb.ChipdbStore.ensure`, `ChipdbError`; `summary.read_summary`.
- Produces:
  - `JobState` (`str` Enum: `QUEUED="queued"`, `RUNNING="running"`, `DONE="done"`, `FAILED="failed"`).
  - `Job` (fields `id, ip, board, top, files, lint, dir: Path, state, events: list[dict], bitstream: Path | None, finished_at: float | None`; property `terminal: bool`; method `emit(event: dict)`; async generator `stream(start: int = 0) -> AsyncIterator[tuple[int, dict]]`).
  - `QueueFull(Exception)`.
  - `RunStep = Callable[[list[str], Path, Settings, Callable[[str], None], str | None], Awaitable[RunResult]]`.
  - `JobManager(settings, *, run_step: RunStep, chipdb, plan=plan_build, clock=time.monotonic)` with `async start()`, `async stop()`, `submit(ip, board, top, files, lint) -> Job` (raises `QueueFull`), `get(job_id) -> Job | None`, `active_count(ip) -> int`, `sweep() -> None`.
- Event shapes (exact keys): `{"type": "queued", "position": int}`, `{"type": "step", "name": str}`, `{"type": "log", "line": str}`, `{"type": "done", "summary": dict, "bitstream": str}`, `{"type": "error", "message": str}`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_jobs.py`:
```python
import asyncio
import dataclasses

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
    assert (job.dir / "main.v").read_text() == FILES["main.v"]


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_jobs.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/jobs.py`:
```python
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
                if not job.terminal:
                    self._fail(job, "internal build error")
            finally:
                job.finished_at = self._clock()

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
            res = await self._run(step.argv, job.dir, self._s, sink, step.stdout_file)
            if res.exit_code != 0:
                if res.killed:
                    reason = _KILL_TEXT[res.killed].format(wall=self._s.wall_s)
                    return self._fail(job, f"{step.name} {reason}")
                return self._fail(job, f"{step.name} failed (exit code {res.exit_code})")

        out = job.dir / plan.output
        if not out.is_file() or out.stat().st_size == 0:
            return self._fail(job, "no bitstream was produced")
        job.bitstream = out
        job.state = JobState.DONE
        job.emit({"type": "done", "summary": read_summary(job.dir / REPORT), "bitstream": plan.output})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_jobs.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/jobs.py backend/tests/test_jobs.py && git commit -m "feat(backend): job manager with queue, events and TTL cleanup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Rate limiter

**Files:**
- Create: `backend/fpgaweb/ratelimit.py`
- Test: `backend/tests/test_ratelimit.py`

**Interfaces:**
- Produces: `RateLimiter(limit: int, window_s: float, clock=time.monotonic)` with `allow(key: str) -> bool` (records the hit only when allowed) and `retry_after(key: str) -> int` (seconds until the oldest hit leaves the window, ≥ 1).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_ratelimit.py`:
```python
from fpgaweb.ratelimit import RateLimiter


def test_sliding_window():
    now = [0.0]
    rl = RateLimiter(2, 10, clock=lambda: now[0])
    assert rl.allow("a") and rl.allow("a")
    assert not rl.allow("a")
    assert rl.allow("b")
    now[0] = 9.9
    assert not rl.allow("a")
    assert rl.retry_after("a") == 1
    now[0] = 10.1
    assert rl.allow("a")


def test_rejected_hits_are_not_recorded():
    now = [0.0]
    rl = RateLimiter(1, 10, clock=lambda: now[0])
    assert rl.allow("a")
    for _ in range(5):
        assert not rl.allow("a")
    now[0] = 10.5
    assert rl.allow("a")


def test_idle_keys_are_pruned():
    now = [0.0]
    rl = RateLimiter(1, 10, clock=lambda: now[0])
    rl.allow("a")
    now[0] = 100
    rl.allow("b")
    assert "a" not in rl._hits
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_ratelimit.py -q`
Expected: FAIL, `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/ratelimit.py`:
```python
"""Sliding-window rate limiter keyed by client IP."""

import math
import time
from collections import deque
from typing import Callable


class RateLimiter:
    def __init__(self, limit: int, window_s: float, clock: Callable[[], float] = time.monotonic):
        self._limit, self._window, self._clock = limit, window_s, clock
        self._hits: dict[str, deque[float]] = {}

    def _prune(self, now: float) -> None:
        cutoff = now - self._window
        for key in list(self._hits):
            q = self._hits[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if not q:
                del self._hits[key]

    def allow(self, key: str) -> bool:
        now = self._clock()
        self._prune(now)
        q = self._hits.setdefault(key, deque())
        if len(q) >= self._limit:
            return False
        q.append(now)
        return True

    def retry_after(self, key: str) -> int:
        q = self._hits.get(key)
        if not q:
            return 1
        return max(1, math.ceil(q[0] + self._window - self._clock()))
```

Note: `_prune` iterates all keys on each call; fine at hobby scale (spec §2 assumption).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_ratelimit.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fpgaweb/ratelimit.py backend/tests/test_ratelimit.py && git commit -m "feat(backend): per-IP sliding window rate limiter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: HTTP API and ASGI entrypoint

**Files:**
- Create: `backend/fpgaweb/api.py`, `backend/fpgaweb/main.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: `Settings`, `BoardRegistry`, `flash_plan`, `validate_files`/`ValidationError`, `JobManager`/`QueueFull`, `RateLimiter`, `sandbox.run_step`, `ChipdbStore`.
- Produces:
  - `create_app(settings: Settings, registry: BoardRegistry, manager: JobManager, limiter: RateLimiter) -> FastAPI`. The app's lifespan calls `manager.start()` / `manager.stop()`.
  - `fpgaweb.main:app` built from `from_env()`.
  - HTTP:
    - `GET /api/boards` → `200 [{"id","description","arch","part","constraint_ext","bitstream_ext","flash","ofl_args","writes_flash"}]`
    - `GET /api/boards/{id}/template` → `200 {"top", "files"}` / `404`
    - `POST /api/build` body `{"board", "top", "files", "lint": true}` → `202 {"job_id", "queue_position"}` / `400 {"detail"}` / `413` / `429 {"detail"}` + `Retry-After` / `503 {"detail"}`
    - `GET /api/jobs/{id}/events?from=N` (SSE; honours `Last-Event-ID`) → frames `id: <n>\ndata: <json>\n\n`; stream closes after the terminal event / `404`
    - `GET /api/jobs/{id}/bitstream` → `200 application/octet-stream`, `Content-Disposition: attachment; filename="<board>.<ext>"` / `404`
    - `/` static SPA when `settings.static_dir` is set.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api.py`:
```python
import dataclasses
import json

import httpx
import pytest

from fpgaweb.api import create_app
from fpgaweb.jobs import JobManager
from fpgaweb.ratelimit import RateLimiter
from tests.test_jobs import FakeChipdb, FakeRunner

V = "module main(input clk, output led); assign led = clk; endmodule\n"
BODY = {"board": "icebreaker", "top": "main", "files": {"main.v": V, "p.pcf": ""}, "lint": False}


@pytest.fixture
async def client(settings, registry):
    async def _client(runner=None, limiter=None, **overrides):
        s = dataclasses.replace(settings, **overrides)
        manager = JobManager(s, run_step=runner or FakeRunner(), chipdb=FakeChipdb())
        app = create_app(s, registry, manager, limiter or RateLimiter(100, 600))
        await manager.start()
        clients.append((manager, httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                    base_url="http://t")))
        return clients[-1][1]

    clients = []
    yield _client
    for manager, c in clients:
        await c.aclose()
        await manager.stop()


def sse_events(text: str) -> list[tuple[int, dict]]:
    out = []
    for frame in text.strip().split("\n\n"):
        lines = dict(l.split(": ", 1) for l in frame.splitlines())
        out.append((int(lines["id"]), json.loads(lines["data"])))
    return out


async def test_boards_listing(client):
    c = await client()
    r = await c.get("/api/boards")
    assert r.status_code == 200
    basys = next(b for b in r.json() if b["id"] == "basys3")
    assert basys == {"id": "basys3", "description": "Basys3 (Xilinx, Artix7)", "arch": "xilinx",
                     "part": "XC7A35T-1CPG236", "constraint_ext": ".xdc", "bitstream_ext": ".bit",
                     "flash": "browser", "ofl_args": ["--board", "basys3"], "writes_flash": False}


async def test_template(client):
    c = await client()
    r = await c.get("/api/boards/icebreaker/template")
    assert r.status_code == 200 and r.json()["top"]
    assert (await c.get("/api/boards/nope/template")).status_code == 404


async def test_build_happy_path_and_events(client):
    c = await client()
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert r.json()["queue_position"] == 1
    r = await c.get(f"/api/jobs/{job_id}/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r.text)
    assert events[-1][1]["type"] == "done"
    assert [i for i, _ in events] == list(range(len(events)))
    r = await c.get(f"/api/jobs/{job_id}/bitstream")
    assert r.status_code == 200 and r.content == b"\x7e\xaa\x99\x7e"
    assert 'filename="icebreaker.bin"' in r.headers["content-disposition"]


async def test_sse_resume_last_event_id(client):
    c = await client()
    job_id = (await c.post("/api/build", json=BODY)).json()["job_id"]
    full = sse_events((await c.get(f"/api/jobs/{job_id}/events")).text)
    r = await c.get(f"/api/jobs/{job_id}/events", headers={"Last-Event-ID": "2"})
    assert sse_events(r.text) == full[3:]
    r = await c.get(f"/api/jobs/{job_id}/events?from=4")
    assert sse_events(r.text) == full[4:]


async def test_validation_error_is_400(client):
    c = await client()
    r = await c.post("/api/build", json={**BODY, "files": {"main.v": V, "p.xdc": ""}})
    assert r.status_code == 400 and ".pcf" in r.json()["detail"]


async def test_unknown_board_is_400(client):
    c = await client()
    r = await c.post("/api/build", json={**BODY, "board": "nope"})
    assert r.status_code == 400 and "unknown board" in r.json()["detail"]


async def test_malformed_body_is_400_or_422(client):
    c = await client()
    r = await c.post("/api/build", json={"board": 1})
    assert r.status_code in (400, 422)


async def test_body_too_large_is_413(client):
    c = await client()
    r = await c.post("/api/build", content=b"{" + b" " * 2_100_000 + b"}",
                     headers={"content-type": "application/json"})
    assert r.status_code == 413


async def test_rate_limit_429(client):
    c = await client(limiter=RateLimiter(1, 600))
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 202
    await c.get(f"/api/jobs/{r.json()['job_id']}/events")  # wait until the first job is finished
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 429 and "Retry-After" in r.headers


async def test_one_active_job_per_ip(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate))
    assert (await c.post("/api/build", json=BODY)).status_code == 202
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 429 and "already" in r.json()["detail"]
    gate.set()


async def test_queue_full_503(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate), queue_max=0)
    r = await c.post("/api/build", json=BODY)
    assert r.status_code == 503
    gate.set()


async def test_forwarded_for_used_only_when_trusted(client):
    import asyncio
    gate = asyncio.Event()
    c = await client(runner=FakeRunner(gate=gate), trust_proxy=True)
    h1 = {"X-Forwarded-For": "9.9.9.9, 10.0.0.1"}
    h2 = {"X-Forwarded-For": "8.8.8.8"}
    assert (await c.post("/api/build", json=BODY, headers=h1)).status_code == 202
    assert (await c.post("/api/build", json=BODY, headers=h2)).status_code == 202  # different client
    assert (await c.post("/api/build", json=BODY, headers=h1)).status_code == 429
    gate.set()


async def test_unknown_job_404(client):
    c = await client()
    assert (await c.get("/api/jobs/nope/events")).status_code == 404
    assert (await c.get("/api/jobs/nope/bitstream")).status_code == 404


async def test_static_spa_served(client, tmp_path):
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<h1>hi</h1>")
    c = await client(static_dir=tmp_path / "web")
    r = await c.get("/")
    assert r.status_code == 200 and "hi" in r.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_api.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'fpgaweb.api'`.

- [ ] **Step 3: Implement**

`backend/fpgaweb/api.py`:
```python
"""HTTP API: boards, build submission, SSE job events, bitstream download, SPA."""

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from fpgaweb.boards import Board, BoardRegistry
from fpgaweb.config import Settings
from fpgaweb.flash import flash_plan
from fpgaweb.jobs import JobManager, QueueFull
from fpgaweb.ratelimit import RateLimiter
from fpgaweb.validation import ValidationError, validate_files

MAX_BODY = 2_000_000


class BuildBody(BaseModel):
    board: str
    top: str
    files: dict[str, str]
    lint: bool = True


def _board_json(b: Board) -> dict:
    fp = flash_plan(b)
    return {"id": b.id, "description": b.description, "arch": b.arch, "part": b.part_num,
            "constraint_ext": b.constraint_ext, "bitstream_ext": b.bitstream_ext,
            "flash": fp.mode, "ofl_args": fp.args, "writes_flash": fp.writes_flash}


def create_app(settings: Settings, registry: BoardRegistry, manager: JobManager,
               limiter: RateLimiter) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    app = FastAPI(title="FPGA Web IDE", lifespan=lifespan, docs_url=None, redoc_url=None)
    boards_json = [_board_json(b) for b in registry.all()]

    def client_ip(request: Request) -> str:
        if settings.trust_proxy:
            fwd = request.headers.get("x-forwarded-for")
            if fwd:
                return fwd.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY:
            return JSONResponse({"detail": "request too large"}, status_code=413)
        return await call_next(request)

    @app.get("/api/boards")
    async def boards() -> list[dict]:
        return boards_json

    @app.get("/api/boards/{board_id}/template")
    async def template(board_id: str) -> dict:
        try:
            t = registry.template(board_id)
        except KeyError:
            raise HTTPException(404, "unknown board")
        return {"top": t.top, "files": t.files}

    @app.post("/api/build", status_code=202)
    async def build(body: BuildBody, request: Request):
        try:
            board = registry.get(body.board)
        except KeyError:
            raise HTTPException(400, f"unknown board: {body.board}")
        try:
            files = validate_files(board, body.top, body.files)
        except ValidationError as e:
            raise HTTPException(400, str(e))
        ip = client_ip(request)
        if manager.active_count(ip) > 0:
            raise HTTPException(429, "you already have a build running; wait for it to finish")
        if not limiter.allow(ip):
            return JSONResponse({"detail": "too many builds; slow down"}, status_code=429,
                                headers={"Retry-After": str(limiter.retry_after(ip))})
        try:
            job = manager.submit(ip, board, body.top, files, body.lint)
        except QueueFull:
            raise HTTPException(503, "build server is busy; try again in a minute")
        return {"job_id": job.id, "queue_position": job.events[0]["position"]}

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str, request: Request, start: int | None = None):
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(404, "unknown or expired job")
        if start is None:
            start = int(request.query_params.get("from", "0") or 0)
            last = request.headers.get("last-event-id")
            if last and last.isdigit():
                start = int(last) + 1

        async def gen():
            async for i, ev in job.stream(start):
                yield f"id: {i}\ndata: {json.dumps(ev)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/jobs/{job_id}/bitstream")
    async def bitstream(job_id: str):
        job = manager.get(job_id)
        if job is None or job.bitstream is None or not job.bitstream.is_file():
            raise HTTPException(404, "no bitstream for this job")
        return FileResponse(job.bitstream, media_type="application/octet-stream",
                            filename=f"{job.board.id}{job.board.bitstream_ext}")

    if settings.static_dir is not None:
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="spa")
    return app
```

`backend/fpgaweb/main.py`:
```python
"""ASGI entrypoint: uvicorn fpgaweb.main:app"""

import logging

from fpgaweb.api import create_app
from fpgaweb.boards import BoardRegistry
from fpgaweb.chipdb import ChipdbStore
from fpgaweb.config import from_env
from fpgaweb.jobs import JobManager
from fpgaweb.ratelimit import RateLimiter
from fpgaweb.sandbox import run_step

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

settings = from_env()
registry = BoardRegistry(settings.data_dir)
manager = JobManager(settings, run_step=run_step, chipdb=ChipdbStore(settings))
limiter = RateLimiter(settings.rate_n, settings.rate_window_s)
app = create_app(settings, registry, manager, limiter)
```

Note: the `client` fixture calls `manager.start()` itself because `httpx.ASGITransport` does not run lifespan events.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest -q`
Expected: all backend tests PASS (`tests/test_api.py` imports fakes from `tests.test_jobs` via the `tests/__init__.py` created in Task 1).

- [ ] **Step 5: Log one line per finished build (IP, board, duration, outcome — no code)**

In `backend/fpgaweb/jobs.py`, in `_worker`'s `finally:` block, after `job.finished_at = self._clock()`, add:
```python
                log.info("build ip=%s board=%s state=%s", job.ip, job.board.id, job.state.value)
```
Re-run `.venv/bin/pytest -q` → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend && git commit -m "feat(backend): HTTP API with SSE events and ASGI entrypoint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Real-toolchain integration tests (dev machine)

**Files:**
- Create: `backend/dev.env`, `backend/tests/integration/__init__.py`, `backend/tests/integration/test_toolchain.py`

**Interfaces:**
- Consumes: `from_env`, `BoardRegistry`, `JobManager`, `sandbox.run_step`, `ChipdbStore`.
- Produces: `dev.env` (sourced by later tasks for local runs), pytest marker `integration`.

- [ ] **Step 1: Create `backend/dev.env`**

```bash
# Local toolchain = Apio's packages on the x86-64 dev machine.
A="$HOME/.apio/packages"
export FPGAWEB_WORK_DIR="$HOME/.cache/fpgaweb/jobs"
export FPGAWEB_CHIPDB_DIR="$A/openxc7/chipdb"
export FPGAWEB_PRJXRAY_DB="$A/openxc7/share/nextpnr/external/prjxray-db"
export FPGAWEB_TRELLIS_DB="$A/oss-cad-suite/share/trellis/database"
export FPGAWEB_YOSYS_SHARE="$A/oss-cad-suite/share/yosys"
export FPGAWEB_TOOL_PATH="$A/openxc7/bin:$A/oss-cad-suite/bin:/usr/bin:/bin"
export FPGAWEB_RO_BINDS="$A"
export FPGAWEB_SANDBOX=bwrap
```

- [ ] **Step 2: Write the integration tests**

`backend/tests/integration/__init__.py`: empty.

`backend/tests/integration/test_toolchain.py`:
```python
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
```

- [ ] **Step 3: Run the integration tests**

Run:
```bash
cd ~/projects/fpga-web/backend && source dev.env && FPGAWEB_INTEGRATION=1 .venv/bin/pytest -m integration -v
```
Expected: 7 PASS. The first ECP5/Gowin runs may take ~30 s each. Troubleshooting, in order:
- A tool reports `command not found` inside bwrap → the tool is a bash wrapper resolving paths with `readlink`; confirm `FPGAWEB_RO_BINDS` covers `$HOME/.apio/packages` and that `/usr/bin/env` exists. Re-run one step by hand: `bwrap --unshare-all --ro-bind /usr /usr --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind-try /bin /bin --ro-bind "$HOME/.apio/packages" "$HOME/.apio/packages" --proc /proc --dev /dev --setenv PATH "$FPGAWEB_TOOL_PATH" -- yosys -V`.
- The lint step fails on a template with errors inside yosys cell libraries → confirm `lint.vlt` waives `$FPGAWEB_YOSYS_SHARE/*`; if Verilator still errors (not warns) on library files, drop `-Wall`-style warnings by adding `-Wno-lint -Wno-style` to the lint argv in `recipes._lint` and update `test_lint_step_first_with_vlt_waiver` if it asserts on the flag list.
- `test_syntax_error_reports_file_and_line`: if yosys prints the location as `main.v:2:` the substring check still passes; if it prints `/job/main.v:2`, it also passes.

- [ ] **Step 4: Commit**

```bash
git add backend/dev.env backend/tests/integration && git commit -m "test(backend): real toolchain builds for one board per arch

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Frontend scaffold, API client, projects store, error-location parser

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/src/api.ts`, `frontend/src/project.ts`, `frontend/src/errors.ts`
- Test: `frontend/tests/project.test.ts`, `frontend/tests/errors.test.ts`

**Interfaces:**
- Consumes: HTTP API from Task 10.
- Produces:
  - `api.ts`: types `BoardInfo {id, description, arch, part, constraint_ext, bitstream_ext, flash: 'browser'|'download', ofl_args: string[], writes_flash: boolean}`, `Template {top, files: Record<string,string>}`, `BuildEvent` (union of the 5 event shapes), `ApiError extends Error {status: number}`; functions `fetchBoards(): Promise<BoardInfo[]>`, `fetchTemplate(boardId): Promise<Template>`, `submitBuild(req: {board, top, files, lint}): Promise<{job_id: string, queue_position: number}>`, `streamEvents(jobId, onEvent: (ev: BuildEvent) => void): () => void` (returns close fn; closes itself after `done`/`error`), `fetchBitstream(jobId): Promise<Uint8Array>`, `bitstreamUrl(jobId): string`.
  - `project.ts`: `Project {id, name, board, top, files: Record<string,string>, updatedAt: number}`; `ProjectStore` class with `list(): Promise<Project[]>` (newest first), `get(id)`, `save(p)`, `remove(id)`; `newProject(name, board, tpl: Template): Project`; `exportZip(p): Uint8Array`; `importZip(bytes: Uint8Array): Project` (throws `Error` on invalid content).
  - `errors.ts`: `Location {file: string, line: number}`; `parseLocations(text: string): Location[]`.

- [ ] **Step 1: Scaffold**

`frontend/package.json`:
```json
{
  "name": "fpga-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@codemirror/language": "^6.10.0",
    "@codemirror/legacy-modes": "^6.4.0",
    "@codemirror/state": "^6.4.0",
    "@codemirror/view": "^6.28.0",
    "@yowasp/openfpgaloader": "1.1.1-179.268",
    "codemirror": "^6.0.1",
    "fflate": "^0.8.2",
    "idb-keyval": "^6.2.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "@types/w3c-web-usb": "^1.0.10",
    "fake-indexeddb": "^6.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["w3c-web-usb", "vite/client"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`frontend/vite.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@yowasp/openfpgaloader'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/*.test.ts'] },
});
```

Run: `cd ~/projects/fpga-web/frontend && npm install`
Expected: installs without errors.

- [ ] **Step 2: Write the failing tests**

`frontend/tests/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseLocations } from '../src/errors';

describe('parseLocations', () => {
  it('parses yosys errors', () => {
    expect(parseLocations('main.v:12: ERROR: syntax error, unexpected ;')).toEqual([{ file: 'main.v', line: 12 }]);
  });
  it('parses verilator errors with column and sandbox path', () => {
    expect(parseLocations('%Error: /job/cpu.sv:7:5: Cannot find')).toEqual([{ file: 'cpu.sv', line: 7 }]);
  });
  it('parses constraint files and multiple hits', () => {
    expect(parseLocations('pins.xdc:3 and top.v:4')).toEqual([
      { file: 'pins.xdc', line: 3 },
      { file: 'top.v', line: 4 },
    ]);
  });
  it('ignores non-project extensions', () => {
    expect(parseLocations('/usr/share/yosys/foo.txt:3')).toEqual([]);
  });
});
```

`frontend/tests/project.test.ts`:
```ts
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { exportZip, importZip, newProject, ProjectStore } from '../src/project';

const tpl = { top: 'main', files: { 'main.v': 'module main; endmodule\n', 'p.xdc': '' } };

describe('projects', () => {
  it('zip roundtrip keeps files and metadata', () => {
    const p = newProject('demo', 'basys3', tpl);
    const q = importZip(exportZip(p));
    expect(q.name).toBe('demo');
    expect(q.board).toBe('basys3');
    expect(q.top).toBe('main');
    expect(q.files).toEqual(p.files);
    expect(q.id).not.toBe(p.id);
  });

  it('rejects zips with bad file names', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      'project.json': strToU8(JSON.stringify({ name: 'x', board: 'basys3', top: 'main' })),
      '../evil.v': strToU8('x'),
    });
    expect(() => importZip(bad)).toThrow(/file name/);
  });

  it('rejects zips without project.json', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    expect(() => importZip(zipSync({ 'a.v': strToU8('x') }))).toThrow(/project.json/);
  });

  it('store saves, lists newest first, removes', async () => {
    const store = new ProjectStore('test-db');
    const a = newProject('a', 'basys3', tpl);
    const b = { ...newProject('b', 'basys3', tpl), updatedAt: a.updatedAt + 10 };
    await store.save(a);
    await store.save(b);
    expect((await store.list()).map((p) => p.name)).toEqual(['b', 'a']);
    await store.remove(a.id);
    expect((await store.list()).map((p) => p.name)).toEqual(['b']);
    expect(await store.get(b.id)).toEqual(b);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot resolve `../src/errors` / `../src/project`.

- [ ] **Step 4: Implement**

`frontend/src/errors.ts`:
```ts
export interface Location {
  file: string;
  line: number;
}

const LOC_RE = /(?:^|[\s/:(])([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:sv|v|vh|svh|xdc|pcf|lpf|cst)):(\d+)/g;

export function parseLocations(text: string): Location[] {
  const out: Location[] = [];
  for (const m of text.matchAll(LOC_RE)) out.push({ file: m[1], line: Number(m[2]) });
  return out;
}
```

`frontend/src/project.ts`:
```ts
import { createStore, del, get, set, values, type UseStore } from 'idb-keyval';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Template } from './api';

export interface Project {
  id: string;
  name: string;
  board: string;
  top: string;
  files: Record<string, string>;
  updatedAt: number;
}

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function newProject(name: string, board: string, tpl: Template): Project {
  return { id: crypto.randomUUID(), name, board, top: tpl.top, files: { ...tpl.files }, updatedAt: Date.now() };
}

export class ProjectStore {
  private store: UseStore;
  constructor(dbName = 'fpga-web') {
    this.store = createStore(dbName, 'projects');
  }
  async list(): Promise<Project[]> {
    const all = (await values(this.store)) as Project[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Promise<Project | undefined> {
    return get(id, this.store);
  }
  save(p: Project): Promise<void> {
    return set(p.id, p, this.store);
  }
  remove(id: string): Promise<void> {
    return del(id, this.store);
  }
}

export function exportZip(p: Project): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify({ name: p.name, board: p.board, top: p.top })),
  };
  for (const [name, text] of Object.entries(p.files)) entries[name] = strToU8(text);
  return zipSync(entries);
}

export function importZip(bytes: Uint8Array): Project {
  const entries = unzipSync(bytes);
  const meta = entries['project.json'];
  if (!meta) throw new Error('zip has no project.json');
  const { name, board, top } = JSON.parse(strFromU8(meta));
  const files: Record<string, string> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path === 'project.json' || path.endsWith('/')) continue;
    if (!NAME_RE.test(path)) throw new Error(`invalid file name in zip: ${path}`);
    files[path] = strFromU8(data);
  }
  return { id: crypto.randomUUID(), name: String(name), board: String(board), top: String(top), files, updatedAt: Date.now() };
}
```

`frontend/src/api.ts`:
```ts
export interface BoardInfo {
  id: string;
  description: string;
  arch: 'xilinx' | 'ice40' | 'ecp5' | 'gowin';
  part: string;
  constraint_ext: string;
  bitstream_ext: string;
  flash: 'browser' | 'download';
  ofl_args: string[];
  writes_flash: boolean;
}

export interface Template {
  top: string;
  files: Record<string, string>;
}

export type BuildEvent =
  | { type: 'queued'; position: number }
  | { type: 'step'; name: string }
  | { type: 'log'; line: string }
  | { type: 'done'; bitstream: string; summary: { utilization: Record<string, { used: number; available: number }>; fmax: Record<string, number> } }
  | { type: 'error'; message: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(r.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return r.json() as Promise<T>;
}

export const fetchBoards = () => fetch('/api/boards').then((r) => json<BoardInfo[]>(r));
export const fetchTemplate = (id: string) => fetch(`/api/boards/${encodeURIComponent(id)}/template`).then((r) => json<Template>(r));

export function submitBuild(req: { board: string; top: string; files: Record<string, string>; lint: boolean }) {
  return fetch('/api/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => json<{ job_id: string; queue_position: number }>(r));
}

export function streamEvents(jobId: string, onEvent: (ev: BuildEvent) => void): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as BuildEvent;
    onEvent(ev);
    if (ev.type === 'done' || ev.type === 'error') es.close();
  };
  return () => es.close();
}

export const bitstreamUrl = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/bitstream`;

export async function fetchBitstream(jobId: string): Promise<Uint8Array> {
  const r = await fetch(bitstreamUrl(jobId));
  if (!r.ok) throw new ApiError(r.status, 'bitstream not available (expired?)');
  return new Uint8Array(await r.arrayBuffer());
}
```

EventSource reconnects automatically after a dropped connection and sends `Last-Event-ID`; the backend (Task 10) resumes from the next event, so a network blip neither loses nor duplicates events.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/fpga-web && git add frontend && git commit -m "feat(frontend): scaffold, API client, project store, error parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Flasher and setup help

**Files:**
- Create: `frontend/src/flasher.ts`, `frontend/src/setup-help.ts`
- Test: `frontend/tests/flasher.test.ts`

**Interfaces:**
- Consumes: `BoardInfo`.
- Produces:
  - `flasher.ts`: `webUsbSupported(): boolean`; `buildOflArgs(board: BoardInfo, fileName: string, toFlash: boolean): string[]`; `flash(board: BoardInfo, bitstream: Uint8Array, toFlash: boolean, onLog: (text: string) => void): Promise<void>` (throws `Error` with a user-facing message).
  - `setup-help.ts`: `type OS = 'linux' | 'windows' | 'mac' | 'other'`; `detectOS(ua?: string): OS`; `setupHelpHtml(os: OS): string`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/flasher.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildOflArgs } from '../src/flasher';
import { detectOS, setupHelpHtml } from '../src/setup-help';
import type { BoardInfo } from '../src/api';

const board = (over: Partial<BoardInfo> = {}): BoardInfo => ({
  id: 'basys3', description: '', arch: 'xilinx', part: '', constraint_ext: '.xdc', bitstream_ext: '.bit',
  flash: 'browser', ofl_args: ['--board', 'basys3'], writes_flash: false, ...over,
});

describe('buildOflArgs', () => {
  it('SRAM load appends only the file', () => {
    expect(buildOflArgs(board(), 'basys3.bit', false)).toEqual(['--board', 'basys3', 'basys3.bit']);
  });
  it('flash write adds -f once', () => {
    expect(buildOflArgs(board(), 'b.bit', true)).toEqual(['--board', 'basys3', '-f', 'b.bit']);
    const w = board({ ofl_args: ['-c', 'cmsisdap', '--write-flash'], writes_flash: true });
    expect(buildOflArgs(w, 'b.bit', true)).toEqual(['-c', 'cmsisdap', '--write-flash', 'b.bit']);
  });
  it('rejects download-only boards', () => {
    expect(() => buildOflArgs(board({ flash: 'download' }), 'b.bit', false)).toThrow(/download/);
  });
});

describe('setup help', () => {
  it('detects OS from user agent', () => {
    expect(detectOS('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
  });
  it('has Linux udev and Windows Zadig instructions', () => {
    expect(setupHelpHtml('linux')).toContain('udev');
    expect(setupHelpHtml('windows')).toContain('Zadig');
    expect(setupHelpHtml('windows')).toMatch(/Vivado/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot resolve `../src/flasher`.

- [ ] **Step 3: Implement**

`frontend/src/flasher.ts`:
```ts
import type { BoardInfo } from './api';

export function webUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export function buildOflArgs(board: BoardInfo, fileName: string, toFlash: boolean): string[] {
  if (board.flash !== 'browser') throw new Error(`${board.id} is download-only; flash it with your own tool`);
  const args = [...board.ofl_args];
  if (toFlash && !board.writes_flash && !args.includes('-f') && !args.includes('--write-flash')) args.push('-f');
  return [...args, fileName];
}

export async function flash(board: BoardInfo, bitstream: Uint8Array, toFlash: boolean,
                            onLog: (text: string) => void): Promise<void> {
  if (!webUsbSupported()) throw new Error('This browser has no WebUSB. Use Chrome or Edge, or download the bitstream.');
  const { runOpenFPGALoader } = await import('@yowasp/openfpgaloader');
  try {
    await navigator.usb.requestDevice({ filters: runOpenFPGALoader.requiresUSBDevice as USBDeviceFilter[] });
  } catch {
    throw new Error('No USB device selected.');
  }
  const fileName = `${board.id}${board.bitstream_ext}`;
  const decoder = new TextDecoder();
  const out = (bytes: Uint8Array | null) => {
    if (bytes) onLog(decoder.decode(bytes, { stream: true }));
  };
  try {
    await runOpenFPGALoader(buildOflArgs(board, fileName, toFlash), { [fileName]: bitstream }, { stdout: out, stderr: out });
  } catch (e) {
    const code = (e as { code?: number }).code;
    throw new Error(code !== undefined ? `openFPGALoader exited with code ${code}` : String(e));
  }
}
```

`frontend/src/setup-help.ts`:
```ts
export type OS = 'linux' | 'windows' | 'mac' | 'other';

export function detectOS(ua: string = navigator.userAgent): OS {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

const UDEV = `sudo tee /etc/udev/rules.d/70-fpga-webusb.rules >/dev/null <<'EOF'
# FTDI (Digilent, iCE40 boards, ...), CMSIS-DAP, DFU bootloaders
SUBSYSTEM=="usb", ATTRS{idVendor}=="0403", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d50", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="c251", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger`;

export function setupHelpHtml(os: OS): string {
  switch (os) {
    case 'linux':
      return `<h3>Linux: allow the browser to open your board</h3>
<p>Run once, then unplug and replug the board. These udev rules make the device accessible to your user:</p>
<pre>${UDEV}</pre>
<p>If flashing still fails with "access denied", the <code>ftdi_sio</code> serial driver may hold the interface; unplug/replug after closing any serial terminal.</p>`;
    case 'windows':
      return `<h3>Windows: switch the JTAG interface to WinUSB</h3>
<ol><li>Download <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener">Zadig</a>.</li>
<li>Options → List All Devices. Pick your board's <b>Interface 0</b> (e.g. "Digilent USB Device (Interface 0)").</li>
<li>Select <b>WinUSB</b> and click Replace Driver.</li></ol>
<p><b>Note:</b> this replaces the vendor driver on that interface, so Vivado / Digilent Adept will not see the board until you reinstall their driver (Device Manager → Uninstall device, then replug).</p>`;
    case 'mac':
      return `<h3>macOS</h3><p>No setup is usually needed. If the board is not listed, unplug it, close apps using its serial port, and try again.</p>`;
    default:
      return `<h3>Setup</h3><p>Use Chrome or Edge on Linux, Windows or macOS to flash from the browser.</p>`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend && git commit -m "feat(frontend): WebUSB flasher and per-OS setup help

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Editor UI and page wiring, end-to-end test

**Files:**
- Create: `frontend/index.html`, `frontend/src/style.css`, `frontend/src/editor.ts`, `frontend/src/main.ts`, `frontend/playwright.config.ts`, `frontend/tests/e2e/build.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 12–13; backend from Task 10 with toolchain from Task 11 (`dev.env`).
- Produces: `editor.ts`: `class Editor { constructor(parent: HTMLElement, onChange: (text: string) => void); setDoc(name: string, text: string): void; gotoLine(line: number): void; }`. `main.ts`: page behaviour (no exports). DOM ids used by e2e: `#board`, `#top`, `#new-project`, `#project`, `#file-list`, `#add-file`, `#lint`, `#build`, `#flash`, `#to-flash`, `#download`, `#status`, `#log`, `#summary`, `#banner`, `#setup-help`, `#import`, `#export`.

- [ ] **Step 1: Write the e2e test first**

`frontend/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  use: { baseURL: 'http://127.0.0.1:8765', browserName: 'chromium' },
  webServer: {
    command:
      'bash -c "source ../backend/dev.env && FPGAWEB_STATIC_DIR=$PWD/dist ../backend/.venv/bin/uvicorn fpgaweb.main:app --app-dir ../backend --port 8765"',
    url: 'http://127.0.0.1:8765/api/boards',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
```

`frontend/tests/e2e/build.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('new basys3 project builds and offers a download', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'basys3');
  page.once('dialog', (d) => d.accept('blink'));
  await page.click('#new-project');
  await expect(page.locator('#file-list')).toContainText('blinky.v');
  await page.click('#build');
  await expect(page.locator('#status')).toContainText('Build succeeded', { timeout: 150_000 });
  await expect(page.locator('#summary')).not.toBeEmpty();
  const download = page.waitForEvent('download');
  await page.click('#download');
  expect((await download).suggestedFilename()).toBe('basys3.bit');
});

test('syntax error shows a clickable location', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'icebreaker');
  page.once('dialog', (d) => d.accept('broken'));
  await page.click('#new-project');
  await page.locator('#file-list li', { hasText: 'blinky.v' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nmodule oops( ;\n');
  await page.click('#build');
  await expect(page.locator('#status')).toContainText('failed', { timeout: 120_000 });
  const link = page.locator('#log a.loc').first();
  await expect(link).toContainText('blinky.v:');
  await link.click();
  await expect(page.locator('.cm-activeLine')).toBeVisible();
});
```

- [ ] **Step 2: Build and run e2e to verify it fails**

Run:
```bash
cd ~/projects/fpga-web/frontend && npx playwright install chromium && npm run build ; npx playwright test
```
Expected: `npm run build` fails (no `index.html`) or tests fail because elements are missing.

- [ ] **Step 3: Implement page, editor, wiring**

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FPGA Web IDE</title>
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <div id="banner" hidden></div>
  <header>
    <strong>FPGA Web IDE</strong>
    <select id="project" aria-label="Project"></select>
    <button id="new-project">New</button>
    <button id="import">Import .zip</button>
    <button id="export">Export .zip</button>
    <span class="sep"></span>
    <select id="board" aria-label="Board"></select>
    <label>Top <input id="top" size="12" /></label>
    <label><input type="checkbox" id="lint" checked /> Lint</label>
    <button id="build" class="primary">Build</button>
    <button id="flash" disabled>Flash</button>
    <label><input type="checkbox" id="to-flash" /> Write to flash</label>
    <a id="download" hidden>Download</a>
    <button id="help">USB setup</button>
  </header>
  <main>
    <aside>
      <ul id="file-list"></ul>
      <button id="add-file">+ File</button>
    </aside>
    <section id="editor"></section>
    <section id="output">
      <div id="status">Ready</div>
      <div id="summary"></div>
      <pre id="log"></pre>
    </section>
  </main>
  <dialog id="setup-help"><div id="setup-help-body"></div><form method="dialog"><button>Close</button></form></dialog>
  <input type="file" id="import-file" accept=".zip" hidden />
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`frontend/src/style.css`:
```css
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #0a66c2; --err: #b3261e; --ok: #1b7f3b; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #e8e8ed; --muted: #9a9aa2; --line: #33333a; --accent: #5aa2ff; --err: #ff8a80; --ok: #7ddc9a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px system-ui, sans-serif; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }
header .sep { flex: 1; }
button, select, input { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button:disabled { opacity: .5; }
main { flex: 1; display: grid; grid-template-columns: 180px 1fr 38%; min-height: 0; }
aside { border-right: 1px solid var(--line); padding: 8px; overflow: auto; }
#file-list { list-style: none; margin: 0 0 8px; padding: 0; }
#file-list li { padding: 4px 6px; border-radius: 4px; cursor: pointer; display: flex; justify-content: space-between; }
#file-list li.active { background: color-mix(in srgb, var(--accent) 15%, transparent); }
#file-list li button { border: none; padding: 0 4px; color: var(--muted); }
#editor { min-height: 0; overflow: hidden; }
#editor .cm-editor { height: 100%; }
#output { border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
#status { padding: 8px; border-bottom: 1px solid var(--line); }
#status.ok { color: var(--ok); } #status.err { color: var(--err); }
#summary { padding: 0 8px; font-size: 12px; color: var(--muted); }
#log { flex: 1; margin: 0; padding: 8px; overflow: auto; font: 12px ui-monospace, monospace; white-space: pre-wrap; }
#log a.loc { color: var(--accent); cursor: pointer; }
#banner { padding: 8px 12px; background: color-mix(in srgb, var(--err) 15%, transparent); }
@media (max-width: 800px) { main { grid-template-columns: 1fr; grid-template-rows: auto 50vh auto; } aside, #output { border: none; } }
```

`frontend/src/editor.ts`:
```ts
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';

export class Editor {
  private view: EditorView;
  constructor(parent: HTMLElement, private onChange: (text: string) => void) {
    this.view = new EditorView({ parent, state: this.state('') });
  }
  private state(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        StreamLanguage.define(verilog),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onChange(u.state.doc.toString());
        }),
      ],
    });
  }
  setDoc(_name: string, text: string): void {
    this.view.setState(this.state(text));
  }
  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    this.view.focus();
  }
}
```

`frontend/src/main.ts`:
```ts
import { ApiError, fetchBitstream, fetchBoards, fetchTemplate, streamEvents, submitBuild, type BoardInfo, type BuildEvent } from './api';
import { Editor } from './editor';
import { parseLocations } from './errors';
import { flash, webUsbSupported } from './flasher';
import { exportZip, importZip, newProject, ProjectStore, type Project } from './project';
import { detectOS, setupHelpHtml } from './setup-help';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = new ProjectStore();
let boards: BoardInfo[] = [];
let project: Project;
let currentFile = '';
let lastBitstream: { data: Uint8Array; board: BoardInfo } | null = null;
let saveTimer: number | undefined;

const editor = new Editor($('editor'), (text) => {
  project.files[currentFile] = text;
  scheduleSave();
});

function scheduleSave() {
  project.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => store.save(project), 400);
}

function boardInfo(id: string): BoardInfo | undefined {
  return boards.find((b) => b.id === id);
}

function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
  const s = $('status');
  s.textContent = text;
  s.className = kind;
}

function renderFiles() {
  const ul = $('file-list');
  ul.replaceChildren();
  for (const name of Object.keys(project.files).sort()) {
    const li = document.createElement('li');
    li.className = name === currentFile ? 'active' : '';
    const label = document.createElement('span');
    label.textContent = name;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = `Delete ${name}`;
    rm.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${name}?`)) return;
      delete project.files[name];
      scheduleSave();
      openFile(Object.keys(project.files).sort()[0] ?? '');
    };
    li.append(label, rm);
    li.onclick = () => openFile(name);
    ul.append(li);
  }
}

function openFile(name: string) {
  currentFile = name;
  editor.setDoc(name, project.files[name] ?? '');
  renderFiles();
}

async function renderProjects() {
  const sel = $<HTMLSelectElement>('project');
  sel.replaceChildren();
  for (const p of await store.list()) sel.append(new Option(`${p.name} (${p.board})`, p.id, false, p.id === project?.id));
}

async function openProject(p: Project) {
  project = p;
  $<HTMLSelectElement>('board').value = p.board;
  $<HTMLInputElement>('top').value = p.top;
  const firstV = Object.keys(p.files).sort().find((n) => /\.s?v$/.test(n)) ?? Object.keys(p.files)[0] ?? '';
  openFile(firstV);
  await renderProjects();
  resetOutput();
}

async function createProject(boardId: string, name?: string) {
  const projectName = name ?? prompt('Project name', `${boardId}-blinky`) ?? '';
  if (!projectName) return;
  const p = newProject(projectName, boardId, await fetchTemplate(boardId));
  await store.save(p);
  await openProject(p);
}

function resetOutput() {
  $('log').replaceChildren();
  $('summary').replaceChildren();
  $<HTMLButtonElement>('flash').disabled = true;
  $('download').hidden = true;
  lastBitstream = null;
  setStatus('Ready');
}

function appendLog(line: string) {
  const log = $('log');
  const locs = parseLocations(line);
  if (locs.length === 0) {
    log.append(line + '\n');
  } else {
    let rest = line;
    for (const loc of locs) {
      const token = `${loc.file}:${loc.line}`;
      const idx = rest.indexOf(token);
      if (idx < 0) continue;
      log.append(rest.slice(0, idx));
      const a = document.createElement('a');
      a.className = 'loc';
      a.textContent = token;
      a.onclick = () => {
        if (loc.file in project.files) {
          openFile(loc.file);
          editor.gotoLine(loc.line);
        }
      };
      log.append(a);
      rest = rest.slice(idx + token.length);
    }
    log.append(rest + '\n');
  }
  log.scrollTop = log.scrollHeight;
}

function renderSummary(ev: Extract<BuildEvent, { type: 'done' }>) {
  const parts = Object.entries(ev.summary.utilization).map(([k, u]) => `${k} ${u.used}/${u.available}`);
  const fmax = Object.entries(ev.summary.fmax).map(([k, f]) => `fmax ${k}: ${f} MHz`);
  $('summary').textContent = [...parts, ...fmax].join(' · ');
}

async function build() {
  resetOutput();
  const board = boardInfo(project.board)!;
  project.top = $<HTMLInputElement>('top').value.trim();
  scheduleSave();
  $<HTMLButtonElement>('build').disabled = true;
  setStatus('Submitting…');
  try {
    const { job_id } = await submitBuild({ board: project.board, top: project.top, files: project.files, lint: $<HTMLInputElement>('lint').checked });
    streamEvents(job_id, async (ev) => {
      if (ev.type === 'queued') setStatus(`Queued (position ${ev.position})`);
      else if (ev.type === 'step') { setStatus(`Running: ${ev.name}`); appendLog(`== ${ev.name}`); }
      else if (ev.type === 'log') appendLog(ev.line);
      else if (ev.type === 'error') { setStatus(`Build failed: ${ev.message}`, 'err'); $<HTMLButtonElement>('build').disabled = false; }
      else if (ev.type === 'done') {
        renderSummary(ev);
        lastBitstream = { data: await fetchBitstream(job_id), board };
        const a = $<HTMLAnchorElement>('download');
        a.href = URL.createObjectURL(new Blob([lastBitstream.data]));
        a.download = `${board.id}${board.bitstream_ext}`;
        a.hidden = false;
        $<HTMLButtonElement>('flash').disabled = !(board.flash === 'browser' && webUsbSupported());
        setStatus('Build succeeded', 'ok');
        $<HTMLButtonElement>('build').disabled = false;
      }
    });
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : String(e);
    setStatus(`Build failed: ${msg}`, 'err');
    $<HTMLButtonElement>('build').disabled = false;
  }
}

async function doFlash() {
  if (!lastBitstream) return;
  const toFlash = $<HTMLInputElement>('to-flash').checked;
  setStatus('Flashing…');
  appendLog('== flash');
  try {
    await flash(lastBitstream.board, lastBitstream.data, toFlash, (t) => appendLog(t.trimEnd()));
    setStatus(toFlash ? 'Written to flash' : 'Loaded into FPGA', 'ok');
  } catch (e) {
    setStatus(`Flash failed: ${(e as Error).message}`, 'err');
    showHelp();
  }
}

function showHelp() {
  $('setup-help-body').innerHTML = setupHelpHtml(detectOS());
  $<HTMLDialogElement>('setup-help').showModal();
}

async function init() {
  boards = await fetchBoards();
  const sel = $<HTMLSelectElement>('board');
  for (const b of boards) sel.append(new Option(`${b.description}${b.flash === 'download' ? ' (download only)' : ''}`, b.id));
  if (!webUsbSupported()) {
    const banner = $('banner');
    banner.textContent = 'This browser cannot flash boards (no WebUSB). Use Chrome or Edge, or download the bitstream.';
    banner.hidden = false;
  }
  sel.onchange = () => {
    if (confirm('Start a new project for this board? (Cancel keeps the current files and just changes the target.)')) {
      createProject(sel.value);
    } else {
      project.board = sel.value;
      scheduleSave();
      resetOutput();
    }
  };
  $('new-project').onclick = () => createProject(sel.value);
  $<HTMLSelectElement>('project').onchange = async (e) => {
    const p = await store.get((e.target as HTMLSelectElement).value);
    if (p) await openProject(p);
  };
  $('add-file').onclick = () => {
    const name = prompt('File name (e.g. counter.v)')?.trim();
    if (!name) return;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) return alert('Invalid file name');
    project.files[name] ??= '';
    scheduleSave();
    openFile(name);
  };
  $('build').onclick = build;
  $('flash').onclick = doFlash;
  $('help').onclick = showHelp;
  $('export').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportZip(project)], { type: 'application/zip' }));
    a.download = `${project.name}.zip`;
    a.click();
  };
  $('import').onclick = () => $<HTMLInputElement>('import-file').click();
  $<HTMLInputElement>('import-file').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const p = importZip(new Uint8Array(await f.arrayBuffer()));
      if (!boardInfo(p.board)) throw new Error(`unknown board ${p.board}`);
      await store.save(p);
      await openProject(p);
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
  };

  const existing = await store.list();
  if (existing.length) await openProject(existing[0]);
  else await createProject('basys3', 'basys3-blinky');
}

init().catch((e) => setStatus(`Failed to load: ${e}`, 'err'));
```

- [ ] **Step 4: Build and run unit + e2e tests**

Run:
```bash
cd ~/projects/fpga-web/frontend && npm test && npm run build && ls dist/assets | grep -c wasm ; npx playwright test
```
Expected: vitest PASS; build succeeds; `dist/assets` contains the `openFPGALoader` `.wasm` (count ≥ 1); both Playwright tests PASS.
If the wasm is missing from `dist/assets`, the YoWASP bundle resolves it with `new URL('./openFPGALoader.wasm', import.meta.url)`; confirm by `grep -o "openFPGALoader.wasm" node_modules/@yowasp/openfpgaloader/gen/bundle.js`, then add `assetsInclude: ['**/*.wasm']` to `vite.config.ts` and rebuild.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/fpga-web && git add frontend && git commit -m "feat(frontend): editor UI, build/flash wiring and e2e tests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Docker image (multi-arch toolchains), Compose, Caddy

**Files:**
- Create: `docker/Dockerfile`, `docker/Caddyfile`, `docker/compose.yaml`, `.dockerignore`, `scripts/check_container.sh`

**Interfaces:**
- Consumes: backend package, `frontend/dist` (built in-image), Settings defaults (`/opt/fpga/...`, `/var/lib/fpgaweb/...`).
- Produces: image `fpga-web:latest` for `linux/amd64` and `linux/arm64`; compose services `app` (port 8000 internal) and `caddy` (80/443); env `DOMAIN`.

- [ ] **Step 1: Write the Dockerfile**

`.dockerignore`:
```
**/node_modules
**/.venv
**/__pycache__
frontend/dist
.git
```

`docker/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1.7

# ---- openXC7 (nextpnr-xilinx, prjxray, fasm, prjxray-db) built with Nix ----
FROM nixos/nix:2.24.9 AS openxc7
ARG OPENXC7_COMMIT=8a01b11b7bac1e66c01d44f43c3a5290f65981a7
RUN git clone https://github.com/fpgawars/tools-openxc7 /src \
 && cd /src && git checkout ${OPENXC7_COMMIT}
WORKDIR /src
RUN nix --extra-experimental-features 'nix-command flakes' build \
      .#nextpnr-xilinx .#prjxray .#fasm .#prjxray-db --out-link /out/r \
 && mkdir -p /closure \
 && cp -a $(nix-store -qR /out/r*) /closure/ \
 && mkdir -p /opt/fpga/bin \
 && for d in /out/r*/bin; do for f in "$d"/*; do ln -sf "$(readlink -f "$f")" /opt/fpga/bin/; done; done \
 && ln -s "$(readlink -f /out/r-3)" /opt/fpga/prjxray-db-src

# ---- OSS CAD Suite (yosys, nextpnr-ice40/ecp5/himbaechel, packers, verilator) ----
FROM debian:bookworm-slim AS osscad
ARG OSS_CAD_DATE=2026-09-25
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
 && D=$(echo ${OSS_CAD_DATE} | tr -d -) \
 && curl -fL "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${OSS_CAD_DATE}/oss-cad-suite-linux-${ARCH}-${D}.tgz" \
    | tar -xz -C /opt

# ---- Frontend ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Runtime ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=openxc7 /closure /nix/store
COPY --from=openxc7 /opt/fpga/bin /opt/fpga/bin
COPY --from=openxc7 /opt/fpga/prjxray-db-src /opt/fpga/prjxray-db
COPY --from=osscad /opt/oss-cad-suite /opt/fpga/oss-cad-suite
COPY backend/ /app/backend/
RUN python3 -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir '/app/backend[dev]'
COPY --from=web /web/dist /app/web
RUN useradd --system --uid 10001 --home /var/lib/fpgaweb fpgaweb \
 && mkdir -p /var/lib/fpgaweb/jobs /var/lib/fpgaweb/chipdb \
 && chown -R fpgaweb /var/lib/fpgaweb
ENV FPGAWEB_STATIC_DIR=/app/web FPGAWEB_TRUST_PROXY=true
USER fpgaweb
EXPOSE 8000
CMD ["/app/venv/bin/uvicorn", "fpgaweb.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
```

Note on `--out-link /out/r`: with 4 installables Nix creates `/out/r`, `/out/r-1`, `/out/r-2`, `/out/r-3` in argument order, so `/out/r-3` is `prjxray-db`. Step 3 verifies this layout.

- [ ] **Step 2: Compose and Caddy**

`docker/Caddyfile`:
```
{$DOMAIN} {
	encode zstd gzip
	reverse_proxy app:8000 {
		flush_interval -1
	}
}
```

`docker/compose.yaml`:
```yaml
services:
  app:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    image: fpga-web:latest
    restart: unless-stopped
    environment:
      FPGAWEB_WORKERS: "2"
    volumes:
      - chipdb:/var/lib/fpgaweb/chipdb
    mem_limit: 8g
    pids_limit: 512
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
      # bubblewrap needs unprivileged user namespaces inside the container
      - seccomp:unconfined
      - apparmor:unconfined
    tmpfs:
      - /var/lib/fpgaweb/jobs:size=2g,uid=10001
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      DOMAIN: ${DOMAIN:?set DOMAIN in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [app]
volumes:
  chipdb:
  caddy_data:
```

- [ ] **Step 3: Build locally (amd64) and verify toolchain layout**

Run:
```bash
cd ~/projects/fpga-web/frontend && npm install --package-lock-only
cd ~/projects/fpga-web && docker build -f docker/Dockerfile -t fpga-web:latest . 2>&1 | tail -20
docker run --rm fpga-web:latest bash -c 'ls /opt/fpga/bin; ls /opt/fpga/prjxray-db; yosys -V; nextpnr-xilinx --version 2>&1 | head -1' 
```
Expected: `/opt/fpga/bin` lists `nextpnr-xilinx`, `fasm2frames`, `xc7frames2bit` (plus others); `/opt/fpga/prjxray-db` lists `artix7 kintex7 spartan7 zynq7`; yosys prints a version. The Nix build takes 20–60 min the first time.
If `fasm2frames` or `xc7frames2bit` is missing from `/opt/fpga/bin`, locate them with `docker run --rm fpga-web:latest bash -c 'find /nix/store -name "fasm2frames*" -o -name "xc7frames2bit*"'` and add explicit `ln -sf` lines for those paths in the openxc7 stage. If `/opt/fpga/prjxray-db` has no `artix7`, change `/out/r-3` to the out-link whose `ls` shows `artix7`.

- [ ] **Step 4: Container check script**

`scripts/check_container.sh`:
```bash
#!/usr/bin/env bash
# Build blinky for one board per arch inside the running image (sandbox on).
set -euo pipefail
IMAGE="${1:-fpga-web:latest}"
docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --cap-drop ALL --pids-limit 512 -v fpga-web-chipdb:/var/lib/fpgaweb/chipdb \
  -e FPGAWEB_INTEGRATION=1 --entrypoint bash "$IMAGE" -c '
    cd /app/backend && /app/venv/bin/python -m pytest -q -m integration tests/integration tests/test_sandbox.py'
```

Run:
```bash
chmod +x scripts/check_container.sh && scripts/check_container.sh
```
Expected: integration tests (7) and sandbox tests PASS inside the container, including the bwrap tests (not skipped).
If the bwrap tests are skipped or builds fail with `setting up uid map: Permission denied` / `No permissions to create a new namespace`, the host (Ubuntu ≥ 23.10, incl. Mint 22) blocks unprivileged user namespaces for unconfined processes. Allow them on the host: `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf && sudo sysctl --system`, then re-run. This is a host-wide security setting; record it in `docs/deploy.md` (Task 16 already lists it for the Oracle host). This confirms the Apio chipdb downloaded from the `2026-09-24` release loads in the Nix-built `nextpnr-xilinx` (`test_blinky_builds[basys3]`).
If `test_blinky_builds[basys3]` fails with `internal IDs inconsistent with the supplied chip database`, the Nix build is not the same nextpnr-xilinx revision as the chipdb: confirm `/src/nix/nextpnr-xilinx.nix` has `rev = "0eae9fbb19dfb83cdd30d5048d8b0ba744180ad0"` in the openxc7 stage. If the revision matches and it still fails, switch to generating chipdbs in-image: add `.#nextpnr-xilinx-chipdb.<die>` for each die in `chipdb-parts.json` to the Nix build, copy them to `/opt/fpga/chipdb`, set `FPGAWEB_CHIPDB_DIR=/opt/fpga/chipdb`, and make `ChipdbStore.ensure` skip downloading when the file exists regardless of size (update `test_existing_file_with_right_size_is_reused` accordingly).

- [ ] **Step 5: Commit**

```bash
git add .dockerignore docker scripts/check_container.sh frontend/package-lock.json && git commit -m "build: multi-arch Docker image with openXC7 and OSS CAD Suite, Caddy compose

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: ARM deployment on Oracle A1 and docs

**Files:**
- Create: `docs/deploy.md`, `docs/manual-flash-checklist.md`, `README.md`

**Interfaces:**
- Consumes: Task 15 image and compose.
- Produces: running deployment reachable at `https://$DOMAIN`; docs.

- [ ] **Step 1: Write deployment doc**

`docs/deploy.md`:
````markdown
# Deploying on an Oracle Cloud Ampere A1 (arm64) instance

## Once
1. Instance: Ubuntu 24.04 (aarch64), ≥ 2 OCPU / 12 GB RAM. Boot volume ≥ 50 GB.
2. Oracle VCN security list: allow TCP 80 and 443 from 0.0.0.0/0.
3. On the instance also open the host firewall (Oracle Ubuntu images ship iptables rules):
   ```bash
   sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
   sudo netfilter-persistent save
   ```
4. Install Docker: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (log out/in).
5. Allow unprivileged user namespaces (bubblewrap inside the container needs them; Ubuntu 24.04 restricts them by default):
   `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf && sudo sysctl --system`
6. Point a domain at the instance's public IP (A record), e.g. a free DuckDNS subdomain.

## Deploy / update
```bash
git clone <repo-url> ~/fpga-web && cd ~/fpga-web/docker
echo "DOMAIN=fpga.example.duckdns.org" > .env
docker compose build        # first build on ARM: 30–90 min (Nix builds nextpnr-xilinx)
docker compose up -d
../scripts/check_container.sh fpga-web:latest
```
Update: `git pull && docker compose build && docker compose up -d`.

## Operate
- Logs: `docker compose logs -f app` (one line per build: ip, board, state; no source code).
- Chipdb cache lives in the `chipdb` volume (~100–200 MB per Xilinx part, downloaded on first use).
- Bump toolchains: change `OSS_CAD_DATE` / `OPENXC7_COMMIT` in `docker/Dockerfile`; when bumping openXC7, also re-vendor `XILINX-PARTS-INDEX.json` from the matching Apio openxc7 package (`scripts/vendor_apio_defs.sh`) so chipdb downloads match.
````

- [ ] **Step 2: Manual flash checklist and README**

`docs/manual-flash-checklist.md`:
```markdown
# Manual WebUSB flash checklist (needs real hardware)

Run on Chrome/Edge against the deployed site (HTTPS) or `npm run dev` on localhost.

- [ ] Linux: udev rules from the "USB setup" dialog applied; board replugged.
- [ ] Windows: Zadig → WinUSB on the board's JTAG interface.
- [ ] Build the board's blinky template → "Build succeeded".
- [ ] Flash (SRAM) → browser shows device picker → select board → "Loaded into FPGA" → LED blinks.
- [ ] Power-cycle board → design gone (SRAM load).
- [ ] Flash with "Write to flash" → "Written to flash" → power-cycle → LED still blinks.
- [ ] Cancel the device picker → status "Flash failed: No USB device selected." and setup help opens.
- [ ] Firefox: banner says flashing is unavailable; Download still works.

Boards verified (fill in): | board | OS | SRAM | flash | date |
```

`README.md`:
```markdown
# FPGA Web IDE

Write Verilog in the browser, build it on the server with the open-source FPGA toolchain
(Yosys, nextpnr, openXC7), and flash your own board over WebUSB.

- Spec: `docs/superpowers/specs/2026-09-25-fpga-web-ide-design.md`
- Deploy: `docs/deploy.md`

## Develop
```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest -q
source dev.env && .venv/bin/uvicorn fpgaweb.main:app --reload     # API on :8000
cd ../frontend && npm install && npm run dev                      # UI on :5173
```
Integration tests (real toolchains from `~/.apio`): `source backend/dev.env && FPGAWEB_INTEGRATION=1 backend/.venv/bin/pytest -m integration`.

Board definitions and examples come from [Apio](https://github.com/FPGAwars/apio) (GPL-2.0).
```

- [ ] **Step 3: Deploy to the Oracle box and verify**

Follow `docs/deploy.md` on the instance. Verify:
```bash
curl -fsS https://$DOMAIN/api/boards | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
```
Expected: `109`. Then open `https://$DOMAIN` in Chrome, build the basys3 template, and confirm "Build succeeded" and a `basys3.bit` download. Record timings for one build per arch in `docs/deploy.md` under a new "Measured build times (A1)" heading.

- [ ] **Step 4: Commit and push**

```bash
cd ~/projects/fpga-web && git add README.md docs && git commit -m "docs: deployment guide, flash checklist, README

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Pushing requires a remote; create one only after asking the user where the repo should live.
