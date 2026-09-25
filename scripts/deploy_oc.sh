#!/usr/bin/env bash
# Build the image natively on the arm64 host and roll it out to its k3s cluster.
set -euo pipefail
HOST="${1:-oc}"
TAG="${2:-$(git rev-parse --short HEAD)}"
cd "$(dirname "$0")/.."

# A dirty tree would ship uncommitted changes labelled as HEAD's short SHA;
# redeploying the same tag after further edits also wouldn't roll the pod,
# since the spec is unchanged. Refuse by default; FORCE_DIRTY=1 opts in and
# gets a tag suffix so it's still a distinct, rollable image.
if [ -n "$(git status --porcelain)" ]; then
  if [ "${FORCE_DIRTY:-0}" = "1" ]; then
    TAG="${TAG}-dirty-$(date +%s)"
  else
    echo "refusing to deploy: working tree is dirty (commit/stash changes, or set FORCE_DIRTY=1 to deploy anyway)" >&2
    exit 1
  fi
fi

# For testing the dirty-tree/tag logic above without touching the host or
# building an image: DEPLOY_OC_DRY_RUN=1 prints the resolved TAG and exits.
if [ "${DEPLOY_OC_DRY_RUN:-0}" = "1" ]; then
  echo "TAG=$TAG"
  exit 0
fi

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
