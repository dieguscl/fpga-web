# Deployment (host `oc`, k3s)

- Host: Oracle Cloud Ampere A1, Ubuntu 24.04 aarch64, single-node k3s with Traefik on 80/443.
- Namespace `fpga-web`: Deployment (1 replica), Service, Ingress `fpga.dieguscl.com`, PVC `chipdb` (Xilinx chipdb cache, local-path).
- Public access: Cloudflare proxied DNS record `fpga.dieguscl.com` → host public IP. SSL mode "Full" (Traefik serves its default certificate on 443) or "Flexible" (HTTP to origin). WebUSB needs the HTTPS that Cloudflare provides.
- Origin lock: Traefik's Service uses `externalTrafficPolicy: Local` (`deploy/k8s/traefik-config.yaml`) and the Ingress has an `ipAllowList` middleware with Cloudflare's ranges, so only Cloudflare can reach the site and `CF-Connecting-IP` can be trusted. Refresh the ranges from https://www.cloudflare.com/ips/ occasionally.
- Pod security: non-root (uid 10001), all capabilities dropped, no privilege escalation, `hostUsers: false` (own user namespace) and `procMount: Unmasked` so bubblewrap can mount a fresh `/proc` for each sandboxed build (the Docker equivalent used by `scripts/check_container.sh` is `--security-opt systempaths=unconfined`).
- Build isolation: each tool runs in bubblewrap. Ubuntu 24.04 blocks unprivileged user namespaces for unconfined processes, so the pod runs under the AppArmor profile `fpgaweb-bwrap` (`deploy/apparmor/`), which only adds the `userns` permission. No host-wide sysctl is changed.

## Security trade-offs

The pod runs with three permissive settings that would normally be a red
flag, all required for bubblewrap to build a nested user namespace and a
fresh `/proc` per sandboxed build step:

- `seccompProfile: {type: Unconfined}` -- no syscall filter on the container.
- `appArmorProfile` `fpgaweb-bwrap` (`deploy/apparmor/`) -- effectively
  unconfined; it only adds the `userns` permission Ubuntu 24.04 otherwise
  blocks for unprivileged processes.
- `securityContext.procMount: Unmasked` -- lets bubblewrap mount its own
  `/proc`.

This is mitigated, not eliminated, by: `hostUsers: false` (the pod gets its
own user namespace, so root inside a nested userns is not root on the node),
non-root (`runAsUser: 10001`, `runAsNonRoot: true`), all Linux capabilities
dropped (`capabilities: {drop: [ALL]}`), and no privilege escalation
(`allowPrivilegeEscalation: false`). In short: a memory-corruption bug in
yosys/nextpnr/etc, running inside bubblewrap, gets the full syscall surface
of an unprivileged, capability-less, non-root process in its own user and
mount namespace -- not the full surface of the node.

Follow-ups, in rough priority order:
- Pass a seccomp filter to bwrap itself (`--seccomp FD`), blocking `keyctl`,
  `bpf`, `userfaultfd`, `perf_event_open`, `add_key` and nested `unshare`,
  so the *sandboxed tool* (not just the pod) has a narrower syscall surface
  than "whatever an unprivileged process can call".
- `automountServiceAccountToken: false` on the pod spec -- done now, it's
  free (this pod never calls the Kubernetes API).
- Cloudflare SSL mode "Full (strict)" with a Cloudflare Origin CA cert in a
  Traefik TLS secret, instead of "Flexible" (plaintext to origin) or "Full"
  (encrypted but unverified) -- either of the latter two lets a
  Cloudflare-to-origin man-in-the-middle tamper with uploaded source or
  downloaded bitstreams.
- Pin the OSS CAD Suite tarball to a checksum (`docker/Dockerfile`) instead
  of trusting GitHub's TLS alone; every other toolchain dependency is
  already pinned this way.
- Re-attach the UI to a still-running job after a page reload (store
  `{projectId, jobId}` in `sessionStorage`; the server already supports
  replaying events via `from`), so a lost tab doesn't strand a job the
  user can't see or cancel and then bump into the "1 active job" limit.

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
