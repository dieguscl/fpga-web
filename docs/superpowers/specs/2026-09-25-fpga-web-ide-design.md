# FPGA Web IDE — Design Spec

Date: 2026-09-25
Status: Draft for review

## 1. Goal

A public website where anyone can write Verilog, build a bitstream for their
FPGA board on our server, and flash it onto their own board directly from the
browser. No local tool installation beyond a one-time USB permission setup.

**Success:** open site → pick board → write/edit code → Build → Flash → design
runs on the user's board.

## 2. Requirements

### Stated
- Public, open access, no accounts.
- Server-side builds using the open-source toolchain (Apio's supported set).
- Browser-side flashing to the user's own board via WebUSB.
- "Any board" the open-source toolchain supports.
- Deployed as Docker on an Oracle Cloud free Ampere A1 instance (aarch64).

### Assumed
- Flashing supported in Chromium browsers only (Chrome, Edge); others get
  download-only mode.
- "Any board" = the 109 boards in Apio's definitions (Xilinx 7-series, iCE40,
  ECP5, Gowin). Intel/Altera and UltraScale+/Versal are out of scope (no open
  toolchain).
- Projects stored client-side only.
- Hobby-scale traffic (tens of concurrent users at most).

### Out of scope (v1)
- Accounts, server-side project storage, share links.
- In-browser simulation / waveform viewing.
- VHDL (GHDL plugin) — possible later.
- Vendor toolchains (Vivado, Quartus, Gowin IDE).

## 3. Architecture

```
Browser (Chrome/Edge)                         Oracle A1 (Docker Compose)
┌──────────────────────────────┐              ┌────────────────────────────────┐
│ Static SPA                   │ POST /build  │ caddy (TLS, reverse proxy)     │
│ - CodeMirror editor, tabs    │ ───────────► │   │                            │
│ - board picker               │              │   ▼                            │
│ - projects in IndexedDB,     │  SSE logs    │ app: FastAPI                   │
│   zip import/export          │ ◄─────────── │ - validation, rate limit       │
│ - Flash: @yowasp/            │  bitstream   │ - job queue (2 workers)        │
│   openfpgaloader (WebUSB)    │ ◄─────────── │ - bubblewrap sandbox per job   │
└──────────────────────────────┘              │ - toolchains + board defs      │
          │ USB                               │ - serves the SPA static files  │
     user's board                             └────────────────────────────────┘
```

Server never touches USB. Browser never runs synthesis.

### Units

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `boards` (backend) | Load Apio `boards.jsonc`/`fpgas.jsonc`; expose board → arch, part, package, constraint type, flash capability | definitions data |
| `recipes` (backend) | Given board + job dir + top module, produce the ordered list of tool commands per arch | `boards` |
| `sandbox` (backend) | Run one command inside bubblewrap with limits; stream output | bubblewrap, cgroups |
| `jobs` (backend) | Queue, workers, job lifecycle, TTL cleanup, SSE event stream | `recipes`, `sandbox` |
| `api` (backend) | HTTP endpoints, validation, rate limiting | `jobs`, `boards` |
| `editor` (frontend) | Files, tabs, CodeMirror, project persistence, zip import/export | IndexedDB |
| `build-client` (frontend) | Submit build, render log stream, surface errors with file:line links | `api` |
| `flasher` (frontend) | WebUSB permission, run openFPGALoader WASM, progress | `@yowasp/openfpgaloader` |
| `setup-help` (frontend) | Browser/OS detection, udev / Zadig / macOS instructions | — |

## 4. Toolchain on aarch64

Apio does not publish linux-aarch64 packages, so the image builds its own:

- **iCE40, ECP5, Gowin:** YosysHQ OSS CAD Suite linux-arm64 release (yosys,
  nextpnr-ice40, nextpnr-ecp5, nextpnr-himbaechel, icepack, ecppack,
  gowin_pack, verilator). Pinned by release date.
- **Xilinx 7-series:** nextpnr-xilinx and prjxray (`fasm2frames`,
  `xc7frames2bit`) compiled from openXC7 sources in a multi-stage Docker build,
  pinned by commit. Chip databases (`*.bin`) taken from Apio's
  `tools-openxc7` release assets; verify they load on aarch64 during the first
  implementation task, and fall back to generating them in-image if not.
- **prjxray-db** for Artix-7/Spartan-7/Zynq-7000/Kintex-7, pinned.
- Image is multi-arch (amd64 + arm64) so it runs on the dev machine too.

## 5. Build pipeline

### Request
`POST /api/build` (multipart or JSON):
- `board`: Apio board id (e.g. `basys3`)
- `top`: top module name
- `files`: map of filename → text content

Validation:
- ≤ 50 files, ≤ 1 MB total, UTF-8.
- Filenames match `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`, extension in
  `.v .sv .vh .svh .xdc .pcf .lpf .cst .hex .mem`. No directories.
- Exactly one constraint file of the type matching the board's arch.
- Files ending `_tb.v`/`_tb.sv` are excluded from synthesis.

Response: `{job_id, queue_position}`.

### Recipes (per arch)

| Arch | Synth | Place & route | Pack | Output |
|------|-------|---------------|------|--------|
| xilinx | `yosys -p "synth_xilinx -arch xc7 -top T; write_json hw.json"` | `nextpnr-xilinx --chipdb <part>.bin --xdc <xdc> --json hw.json --fasm hw.fasm` | `fasm2frames --part <part> --db-root <db>` → `xc7frames2bit` | `.bit` |
| ice40 | `yosys -p "synth_ice40 -top T -json hw.json"` | `nextpnr-ice40 --<type> --package <pkg> --pcf <pcf> --json hw.json --asc hw.asc` | `icepack hw.asc hw.bin` | `.bin` |
| ecp5 | `yosys -p "synth_ecp5 -top T -json hw.json"` | `nextpnr-ecp5 --<size> --package <pkg> --lpf <lpf> --json hw.json --textcfg hw.config` | `ecppack hw.config hw.bit` | `.bit` |
| gowin | `yosys -p "synth_gowin -top T -json hw.json"` | `nextpnr-himbaechel --device <dev> --vopt family=<fam> --vopt cst=<cst> --json hw.json --write pnr.json` | `gowin_pack -d <fam> -o hw.fs pnr.json` | `.fs` |

Exact flags are taken from Apio's SCons recipes for each arch so results
match `apio build`. Recipes are data-driven by `fpgas.jsonc` params.

Optional first step: `verilator --lint-only` (toggle in UI, default on).

### Output
- Events over SSE `GET /api/jobs/{id}/events`: `queued(position)`,
  `step(name)`, `log(line)`, `done(summary)`, `error(message)`.
- Summary: resource utilisation and max frequency parsed from nextpnr report.
- Bitstream `GET /api/jobs/{id}/bitstream`.
- Job directory deleted 10 minutes after completion.

### Board metadata
`GET /api/boards` → list of `{id, description, arch, part, constraint_ext,
flash: "browser" | "download", ofl_board}`.

Board definitions and examples are vendored from Apio (GPL-2.0) with
attribution. Per-board starter templates come from Apio's `examples/<board>/`
(blinky where available).

## 6. Flashing (browser)

- Bundled `@yowasp/openfpgaloader` (WebUSB build of openFPGALoader).
- Flash button → WebUSB device picker → `openFPGALoader -b <ofl_board>
  <bitstream>` (SRAM) or with `-f` (write to flash), chosen by user.
- `flash` capability per board:
  - `browser`: Apio programmer is openFPGALoader, or the board maps to an
    openFPGALoader board name (e.g. iCEBreaker, ULX3S, DFU boards).
  - `download`: everything else (e.g. `tinyprog`); user gets the file.
  - The mapping table is built during implementation from openFPGALoader's
    board list; target ≈ 90 of 109 boards in `browser` mode.
- Setup help panel, shown on first flash or on USB errors:
  - Linux: udev rules one-liner.
  - Windows: Zadig → WinUSB for the FTDI JTAG interface, with a warning that
    it replaces the vendor driver on that interface.
  - macOS: usually no setup.
- Non-Chromium browsers: banner, download-only mode.

## 7. Security and abuse limits

- **Sandbox (bubblewrap per tool invocation):** no network namespace, own
  PID/IPC/UTS/user namespaces, read-only bind of toolchain and chipdb, job dir
  as the only writable mount, `/tmp` tmpfs, no access to other jobs or host
  paths. Container runs as non-root with dropped capabilities (plus the
  minimum needed for bubblewrap user namespaces).
- **Resource limits per job:** 3 GB memory (cgroup), 90 s CPU, 120 s wall,
  max 256 processes, 200 MB disk in job dir. Exceed → kill → `error` event.
- **Concurrency:** 2 workers; queue max 20; beyond that → HTTP 503 "busy".
- **Rate limit:** per IP, 10 builds / 10 min and 1 active job; exceed → 429.
- **TLS:** Caddy with Let's Encrypt; requires a domain or free subdomain
  (e.g. DuckDNS). HTTPS is mandatory for WebUSB.
- **Data:** no database, no user code retained after TTL. Logs record IP,
  board, duration, outcome — no source code.
- **Oracle:** security list opens 80/443 only.

## 8. Frontend

- Plain TypeScript + Vite, CodeMirror 6 with Verilog mode. No framework
  requirement; keep bundle small.
- Layout: left file list, centre editor with tabs, right/bottom panel with
  board picker, Build / Flash buttons, log output, utilisation summary.
- New project → choose board → prefilled with the board's blinky example and
  constraint template.
- Projects persisted in IndexedDB; export/import as `.zip`.
- Build errors: parse `file:line` from yosys/nextpnr/verilator output, link to
  the editor location.

## 9. Deployment

- Repo: `~/projects/fpga-web`.
- `docker compose` services: `app` (FastAPI + SPA + toolchains), `caddy`.
- Multi-arch image; build on the dev machine with buildx or directly on the
  Oracle box.
- Config via env: domain, worker count, limits.

## 10. Testing

- **Unit (pytest):** validation rules, board loading, recipe command
  generation per arch, rate limiter, job lifecycle.
- **Toolchain integration (in image):** build Apio's blinky for one board per
  arch — `basys3`, `icebreaker`, `ulx3s-85f`, `sipeed-tang-nano-9k` — assert a valid
  bitstream is produced (non-empty, correct header/magic). Run on amd64 and
  arm64 (QEMU in CI).
- **Sandbox:** `` `include "/etc/passwd" `` fails; `$readmemh` outside job dir
  fails; network access fails; memory-hungry design gets killed within limits.
- **Frontend (Playwright):** new project → build → log appears → bitstream
  downloads; error path shows file:line link.
- **Manual:** WebUSB flash on real hardware (Basys 3 / user's board) —
  checklist in the repo.

## 11. Open items (resolved during planning)

- Confirm Apio's xilinx chipdb `.bin` files are architecture-independent.
- Final openFPGALoader board-name mapping table.
- Domain name for the deployment.
