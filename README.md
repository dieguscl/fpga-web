# FPGA Web IDE

Write Verilog in the browser, build it on the server with the open-source FPGA toolchain
(Yosys, nextpnr, openXC7), and flash your own board over WebUSB. Live at https://fpga.dieguscl.com.

Features:
- Build bitstreams for ~109 boards (Xilinx 7-series, iCE40, ECP5, Gowin) in a sandboxed server-side toolchain.
- Flash your board from Chrome/Edge over WebUSB, or download the bitstream.
- Simulate testbenches with Icarus Verilog and inspect the waveform in the browser.
- Draw circuits (Digital-style schematic editor) that generate Verilog, with live in-browser simulation.
- Visual pin planner for the Basys 3 that writes the `.xdc` for you.
- English, Português (Portugal) and Español; dark/light themes.

- Spec: `docs/superpowers/specs/2026-09-25-fpga-web-ide-design.md`
- Deploy: `docs/deploy.md`

## Develop
```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest -q
source dev.env && .venv/bin/uvicorn fpgaweb.main:app --reload     # API on :8000
cd ../frontend && npm install && npm run dev                      # UI on :5173
```
Integration tests (real toolchains from `~/.apio`): `source backend/dev.env && FPGAWEB_INTEGRATION=1 backend/.venv/bin/pytest -m integration`.

Board definitions and examples come from [Apio](https://github.com/FPGAwars/apio).

## License
GPL-3.0-or-later (see `LICENSE`). Board definitions and examples in `backend/fpgaweb/data/apio/` are from Apio, also GPL-3.0.
