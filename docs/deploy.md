# Deployment (host `oc`, k3s)

- Host: Oracle Cloud Ampere A1, Ubuntu 24.04 aarch64, single-node k3s with Traefik on 80/443.
- Namespace `fpga-web`: Deployment (1 replica), Service, Ingress `fpga.dieguscl.com`, PVC `chipdb` (Xilinx chipdb cache, local-path).
- Public access: Cloudflare proxied DNS record `fpga.dieguscl.com` → host public IP. SSL mode "Full" (Traefik serves its default certificate on 443) or "Flexible" (HTTP to origin). WebUSB needs the HTTPS that Cloudflare provides.
- Origin lock: Traefik's Service uses `externalTrafficPolicy: Local` (`deploy/k8s/traefik-config.yaml`) and the Ingress has an `ipAllowList` middleware with Cloudflare's ranges, so only Cloudflare can reach the site and `CF-Connecting-IP` can be trusted. Refresh the ranges from https://www.cloudflare.com/ips/ occasionally.
- Pod security: non-root (uid 10001), all capabilities dropped, no privilege escalation, `hostUsers: false` (own user namespace) and `procMount: Unmasked` so bubblewrap can mount a fresh `/proc` for each sandboxed build (the Docker equivalent used by `scripts/check_container.sh` is `--security-opt systempaths=unconfined`).
- Build isolation: each tool runs in bubblewrap. Ubuntu 24.04 blocks unprivileged user namespaces for unconfined processes, so the pod runs under the AppArmor profile `fpgaweb-bwrap` (`deploy/apparmor/`), which only adds the `userns` permission. No host-wide sysctl is changed.

## Verify an image before deploying
```bash
DOCKER_RUN_ARGS=--network=host scripts/check_container.sh fpga-web:<tag>   # 7 real builds + sandbox tests inside the image
```
(`--network=host` only where Docker's default bridge has no internet; the chipdb for basys3 is downloaded on first use.)

## Deploy / update
```bash
scripts/deploy_oc.sh oc            # rsync, build on oc (arm64), import into k3s, apply, wait
```
The script re-loads the AppArmor profile each time (after a reboot the profile is loaded from /etc/apparmor.d automatically).

## Operate
- Logs: `ssh oc sudo k3s kubectl -n fpga-web logs -f deploy/fpga-web` (one line per build: ip, board, state; no source code).
- Chipdb cache: PVC `chipdb` (~100–200 MB per Xilinx part, downloaded on first use).
- Bump toolchains: change `OSS_CAD_DATE` / `OPENXC7_COMMIT` in `docker/Dockerfile`; when bumping openXC7 also re-vendor `XILINX-PARTS-INDEX.json` from the matching Apio openxc7 package (`scripts/vendor_apio_defs.sh`) so chipdb downloads match.
- Old images: `ssh oc 'sudo k3s crictl images | grep fpga-web'`, remove with `sudo k3s crictl rmi <id>`; `docker image prune` for the build cache.

## Measured build times (A1, 2026-09-25)
- basys3 (Xilinx, first build incl. chipdb download, lint on): 10.3 s end to end through Cloudflare.
- In-image integration suite on oc (basys3, icebreaker, ulx3s-85f, sipeed-tang-nano-9k + include/syntax tests): 7 passed in 20.2 s.
