#!/usr/bin/env bash
# Build the image natively on the arm64 host and roll it out to its k3s cluster.
set -euo pipefail
HOST="${1:-oc}"
TAG="${2:-$(git rev-parse --short HEAD)}"
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .venv --exclude frontend/dist --exclude .git --exclude .superpowers --exclude .omc --exclude "*.egg-info" ./ "$HOST:fpga-web/"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
cd ~/fpga-web
sudo cp deploy/apparmor/fpgaweb-bwrap /etc/apparmor.d/fpgaweb-bwrap
sudo apparmor_parser -r /etc/apparmor.d/fpgaweb-bwrap
docker buildx build --load -f docker/Dockerfile -t fpga-web:$TAG .
docker save fpga-web:$TAG | sudo k3s ctr images import -
sudo k3s kubectl apply -f deploy/k8s/traefik-config.yaml
sed 's/fpga-web:IMAGE_TAG/fpga-web:$TAG/' deploy/k8s/fpga-web.yaml | sudo k3s kubectl apply -f -
sudo k3s kubectl -n fpga-web rollout status deploy/fpga-web --timeout=600s
EOF
echo "deployed fpga-web:$TAG to $HOST"
