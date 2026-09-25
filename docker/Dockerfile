# syntax=docker/dockerfile:1.7

# ---- openXC7 (nextpnr-xilinx, prjxray, fasm python env, prjxray-db) built with Nix ----
FROM nixos/nix:2.24.9 AS openxc7
ARG OPENXC7_COMMIT=8a01b11b7bac1e66c01d44f43c3a5290f65981a7
RUN git clone https://github.com/fpgawars/tools-openxc7 /src \
 && cd /src && git checkout ${OPENXC7_COMMIT}
COPY docker/openxc7-env.nix /openxc7-env.nix
RUN nix --extra-experimental-features 'nix-command flakes' build --impure -f /openxc7-env.nix -o /out \
 && mkdir -p /closure /opt/fpga \
 && cp -a $(nix-store -qR /out) /closure/ \
 && cp -a "$(readlink -f /out)"/. /opt/fpga/

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
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap python3 python3-venv perl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=openxc7 /closure /nix/store
COPY --from=openxc7 /opt/fpga/bin /opt/fpga/bin
COPY --from=openxc7 /opt/fpga/prjxray-db /opt/fpga/prjxray-db
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
