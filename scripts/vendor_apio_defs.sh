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
