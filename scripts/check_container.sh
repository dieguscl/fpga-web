#!/usr/bin/env bash
# Build blinky for one board per arch inside the image (sandbox on), then the sandbox tests.
# systempaths=unconfined mirrors the pod's procMount: Unmasked (bwrap mounts a fresh /proc).
set -euo pipefail
IMAGE="${1:-fpga-web:dev}"
# Extra docker run flags, e.g. DOCKER_RUN_ARGS=--network=host where the default bridge has no internet.
# shellcheck disable=SC2086
docker run --rm ${DOCKER_RUN_ARGS:-} --security-opt systempaths=unconfined --security-opt seccomp=unconfined --security-opt apparmor=fpgaweb-bwrap \
  --security-opt no-new-privileges --cap-drop ALL -v fpga-web-chipdb:/var/lib/fpgaweb/chipdb \
  -e FPGAWEB_INTEGRATION=1 --entrypoint bash "$IMAGE" -c '
    cd /app/backend &&
    /app/venv/bin/python -m pytest -q -p no:cacheprovider -m integration tests/integration &&
    /app/venv/bin/python -m pytest -q -p no:cacheprovider -rs tests/test_sandbox.py'
