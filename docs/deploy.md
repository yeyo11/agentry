# Deploying Agentry

Three ways to run the image, from one machine to a cluster, what a phone needs from it, and what
to know about restarts.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d                   # Agentry alone, on 127.0.0.1:8787
docker compose --profile tls up -d     # plus a TLS-terminating proxy on :80 and :443
```

The default profile publishes the API on `127.0.0.1` only. The `tls` profile adds Caddy in front of
it, using [`deploy/Caddyfile`](../deploy/Caddyfile). Set `AGENTRY_DOMAIN` in `.env` to a public name
and Caddy fetches and renews a Let's Encrypt certificate; left as `localhost` it issues one from its
own local CA, which is enough to try it. Its certificates live in a volume, so recreating the
container does not spend a rate-limited issuance.

Agentry does not terminate TLS itself, and the proxy only encrypts: **turn on authentication before
you use the `tls` profile** (`AGENTRY_AUTH_MODE=token` and `AGENTRY_AUTH_TOKEN` in `.env`, or
`oidc`). The proxy must:

- pass `Host` and set `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` (Caddy does);
- not buffer `/api/events` and the chat streams, which are long-lived event streams
  (`flush_interval -1` in Caddy, `proxy_buffering off` in nginx);
- not cut idle connections faster than the 15 s heartbeat the streams send.

## Kubernetes (Helm)

```bash
kubectl create secret generic agentry-claude --from-literal=CLAUDE_CODE_OAUTH_TOKEN=…
kubectl create secret generic agentry-token --from-literal=token="$(openssl rand -hex 32)"

helm install agentry ./deploy/helm/agentry \
  --set image.tag=0.13.1 \
  --set claude.existingSecret=agentry-claude \
  --set auth.mode=token --set auth.token.existingSecret=agentry-token
```

The chart is a Deployment (one replica, `Recreate`), a Service, and one PersistentVolumeClaim that
holds everything worth keeping through subPaths: `/data`, `~/.claude`, the claude-swap credentials
and `/workspace`. The claim carries `helm.sh/resource-policy: keep`, so `helm uninstall` leaves the
account setup and the transcripts alone. Values worth knowing: `image.tag`, `port`, `resources`,
`persistence.*`, `auth.mode` (`none`, `token`, `oidc`), `auth.readOnly`. `helm lint` and
`helm template` are clean for every auth mode; rendering fails on purpose when `token` or `oidc` is
chosen without what it needs.

There is exactly one replica because the SQLite store is shared by the API and the CLI processes it
starts. Do not scale it.

The `auth.*` values seed a volume that has no `auth.json` yet. After that the settings saved in the UI
win, so changing the value and upgrading does not change a running install.

## Notifications on a phone

Agentry installs to a home screen and can push a notification to it while the app is closed. Both
rest on a service worker, and a browser gives a page a service worker **only on a secure origin**:
`https://…`, or `localhost`. There is nothing to configure beyond that — no push account, no
Firebase project, no key of anyone else's.

- **Serve it over TLS.** `docker compose --profile tls up -d` is the short answer: Caddy in front of
  Agentry, with `AGENTRY_DOMAIN` set to a public name so it fetches and renews a certificate. Behind
  a proxy of your own, the requirements are the ones above — plus letting the `Authorization` header
  through, since the push routes are guarded like every other one.
- **A LAN install over plain HTTP gets the app, not the push.** On `http://192.168.1.10:8787` a phone
  can still add Agentry to its home screen, but the browser registers no worker there: no cached
  shell, and no notification while the app is closed. Settings → Notifications says exactly that,
  naming the origin, rather than showing a switch that does nothing. A browser on the same machine as
  the server is the exception: `http://localhost:8787` is a secure origin, so push works untouched.
- **The keypair is made on first use** and kept as `push.json` in the data directory (mode 600, in
  the mode 700 directory). The private half never leaves the server and no route returns it. It is
  made once and never rotated, because every subscription was taken out against that public key:
  keep the data volume and push survives a restart, a rebuild and a new image. Lose it and every
  registered install goes quiet until it subscribes again.
- **Set `AGENTRY_PUSH_SUBJECT`** to a `mailto:` or `https:` a push service can complain to, before
  the first push goes out — the claim is stored with the keypair when it is made. The default is
  `mailto:agentry@localhost`, which the push services accept but nobody can reach.
- **Outbound only.** The server POSTs each notification to whatever endpoint the browser handed it —
  `*.push.services.mozilla.com`, `web.push.apple.com`, `fcm.googleapis.com`. A wrapper behind NAT
  needs nothing opened; an egress-filtered one needs those hosts allowed, and without them a push is
  a log line and nothing else.
- **In Kubernetes**, `push.json` sits on the same PersistentVolumeClaim as the rest of the data
  directory, which the chart keeps through `helm uninstall`. Bring your own Ingress, and terminate
  TLS there.

The payload itself holds only what a lock screen shows anyway — the kind, a title and body, the chat
or orchestration id and the path to open — because it passes through a push service nobody here runs.
See "Securing it" in the [README](../README.md#securing-it).

## Pinned Claude Code

The image pins the Claude Code it installs (`CLAUDE_CODE_VERSION` in `docker/Dockerfile`), so an
image is the same tomorrow as today. The System information on the Account tab of Settings shows the
version in use, the version the image pins and the newest published one. The registry
(`registry.npmjs.org`, package metadata only) is read when you press **Check for updates** and once a
day while the wrapper runs, never when a page loads. Turn the daily check off with
`AGENTRY_CLI_UPDATE_CHECK=off` (the button keeps working); point it at a mirror with
`AGENTRY_CLI_REGISTRY_URL`.

To move to a newer version, rebuild with `CLAUDE_CODE_VERSION=<version>` (set it in `.env` for
Compose) or use a newer Agentry image. The CLI's own autoupdater is disabled in the image so a
restart cannot change the version.

## Health and restarts

`GET /api/health` is open even with authentication on, and answers `200` while Claude is logged out:
a restart would not fix a missing credential, so it is a liveness probe, not a login check.

- **Docker Compose.** Docker only *marks* a container unhealthy; a restart policy reacts to an exit,
  never to `unhealthy`. The image's healthcheck (`docker/healthcheck.sh`) therefore ends the server
  itself after `AGENTRY_HEALTH_RESTART_AFTER` consecutive failed probes (default 3, 30 s apart): it
  sends `SIGTERM` to the process named in `AGENTRY_PID_FILE`, waits up to five seconds and then sends
  `SIGKILL`, because a wedged event loop never runs the `SIGTERM` handler. The container exits and
  `restart: unless-stopped` starts it again. It needs a restart policy: without one the container
  stays down.
- **Kubernetes.** The image's `HEALTHCHECK` is ignored; the chart declares startup, liveness and
  readiness probes on the same route, and a failing liveness probe restarts the container natively.

### Signals

| Signal | What the server does |
| --- | --- |
| `SIGTERM`, `SIGINT` | Clean shutdown: stops the update timer, stops every chat process (the transcripts are on disk, so the chats can be resumed), closes the SQLite store, closes the HTTP server **including open event streams**, exits `0`. |
| `SIGKILL` | Nothing runs. Chats in flight are restored on the next start as cut off by the restart, and the store is left to SQLite's own crash recovery. |

Both orchestrators allow 30 s between `SIGTERM` and `SIGKILL` (`stop_grace_period` in Compose,
`terminationGracePeriodSeconds` in the chart). Run the image with `--init` (Compose does) so the
`claude` processes are reaped.
