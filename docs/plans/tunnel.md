---
created_at: 2026-09-27T10:34:29.651906091Z
updated_at: 2026-09-27T10:35:09.641387596Z
tags:
    - plan
    - tunnel
    - remote-access
    - security
    - settings
    - launched
---
# Plan: reaching Agentry through a tunnel

Let a person open their Agentry from a phone or another network without a VPS, a domain, a
reverse proxy, an account or anything new to install. Agentry opens a tunnel through
[localhost.run](https://localhost.run) with the system's own `ssh`, shows the public HTTPS address
and a QR code, and closes it again, all from the settings page.

Status: **orchestration `tunnel` launched on 2026-09-27** from `feat/tunnel`. The measurements below
were taken the same day.

## Why

[deploy.md](../deploy.md) covers exposing Agentry on purpose: Docker, Caddy, a domain, a
certificate. Many people want less than that: to glance at a running orchestration from the
phone, or answer a permission prompt away from the desk. A plain-HTTP LAN install is not enough
for that. It is unreachable outside the house, and without a secure origin the browser gives the
PWA no service worker and so no push ([plans/mobile.md](mobile.md)). A tunnel gives an HTTPS origin
with nothing to configure.

The tunnel does not touch Claude Code, so the one rule is not involved.

## One provider, and why this one

The requirement is **one option, with nothing extra to install**. A provider interface and a
choice in the UI are left out on purpose.

localhost.run is reached with `ssh -R 80:127.0.0.1:<port> nokey@localhost.run`. `ssh` is already
there:

- on every Linux desktop and on macOS;
- in the Docker image (`openssh-client` in `docker/Dockerfile`);
- in the desktop `.deb` it becomes a declared dependency (`openssh-client` in
  `apps/desktop/electron-builder.yml`), which a desktop system already has.

It needs no account and no key: the `nokey@` user gets an anonymous tunnel.

### How the candidates were measured

A throwaway Node server on `127.0.0.1` sent one SSE event per second, with the exact headers
`apps/api/src/sse.ts` sends (`text/event-stream`, `Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`). Agentry itself was never exposed. As a control, localhost delivered one
event per second (+1.0 s … +6.0 s).

| Provider | Extra install | `GET` stream | Why not chosen |
| --- | --- | --- | --- |
| **localhost.run** | none (`ssh`) | streams (+2.2 s … +7.2 s) | — |
| Cloudflare quick tunnel | the `cloudflared` binary | **buffered until the response ends** (+6.1 s, over QUIC or HTTP/2, with or without padding or compression). `POST` streams | Agentry's streams are `EventSource`, which can only `GET`. A known limitation: [cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449) |
| Pinggy | none (`ssh`) | streams | the free tunnel expires after 60 min, and the subdomain contains the machine's public IP |
| Tailscale serve / funnel | the Tailscale app, on the phone too | not measured | install and account |
| ngrok | the `ngrok` binary | not measured | account; free caps (1 GB, 20k requests, 2 h); a browser interstitial reported to break SSE |

Because localhost.run streams a `GET`, the web's `EventSource` streams work unchanged. Moving them
to `fetch` is not needed for the tunnel.

### What comes with it

- **The free domain changes regularly**, and it is speed-limited, which localhost.run does to keep
  phishing off its domains. A fixed domain is $9/month and out of scope. The UI says that the
  address changes. An installed PWA and its push subscription belong to the origin they were
  created on, so after a change the phone has to open the new address.
- **localhost.run terminates TLS**, so it sees every request, the bearer token included. The
  settings page says so in one sentence, next to the start button.
- **Three routes still take `?token=` in the URL** (`security.ts`, `QUERY_TOKEN`: the two event
  streams and three downloads), and that URL passes through the provider. This is accepted for v1,
  and the doc says so. Moving the streams to `fetch` with an `Authorization` header is the later fix.

## Settings in layers

Tunnel settings are settings-shaped, so they go in JSON files. They also need something Agentry
lacks today: **changing at runtime what is now only read from the environment at startup.** The
allowlist is the clearest case (`loadConfig` in `packages/core/src/paths.ts`,
`registerSecurity` in `apps/api/src/security.ts:212`).

- **Order of precedence: the environment, then a JSON file editable from the UI, then the
  default.** A value set in the environment is shown read-only with "set by the environment", the
  same pattern `AuthStore` already follows with `AGENTRY_AUTH_TOKEN`.
- **First cases:** `allowedHosts`, `maxConcurrentRuns`, `defaultPermissionMode`. Each moves one
  at a time. None changes behaviour for an install that sets nothing.
- **No global singleton.** The stores hang off `Core` like every other one (`core.security`,
  `core.push`…). Tests and the e2e harness build several wrappers in one process, each with its own
  config. The dependencies between stores (the tunnel reads `security.mode` and writes the
  allowlist) are passed in the constructor, where a test can see and replace them.
- **Allowlist:** the static part stays as it is. A runtime part holds exact names added and removed
  by their owner, which is the tunnel manager. `hostAllowed` reads both on every request. The
  runtime part never accepts a pattern: `*.lhr.life` would let in everybody else's tunnels too.

## The tunnel

### Core: `TunnelManager` (`packages/core/src/tunnel.ts`)

- **The process:**
  `ssh -T -n -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o UserKnownHostsFile=<dataDir>/tunnel/known_hosts -o StrictHostKeyChecking=yes -R 80:127.0.0.1:<port> nokey@localhost.run`.
  The URL is parsed from its output (`https://<id>.lhr.life`).
  `SSH_BIN` points at another `ssh`.
- **The host key is pinned.** localhost.run's key ships with Agentry and is written to Agentry's
  own `known_hosts` file. The person's `~/.ssh` is never read or written. Without the pin, a network
  that intercepts the SSH connection could swap the endpoint and receive every request.
- **States:** `stopped → starting → verifying → active`, with `failed` (and its reason) and
  `stopping`. The tunnel only reaches `active` once `GET /api/health` answers `200` through the
  public URL. The URL and QR code are only shown when the tunnel is active. A resolver asked too
  early caches the missing name, which during the Cloudflare trial made a working tunnel look
  broken for a minute.
- **Domain changes:** when the connection drops or a new URL appears, the old host leaves the
  allowlist, the new one joins once it is verified, and the change goes out on `/api/events`.
- **Lifecycle:** the tunnel reconnects with backoff, and dies with Agentry: the child is killed on
  shutdown, and a pid file clears an orphan on the next start. "Start with Agentry" is a setting and
  is off by default.
- **Port:** the port the server actually bound to, not the preferred one. The desktop keeps it
  stable already (`apps/desktop/src/server-port.ts`).
- **No `ssh`:** the tab says it is missing and how to install it, instead of offering a button that
  fails.

### Security: what has to be true before a byte crosses

1. **No tunnel without authentication.** `start` refuses under `mode: 'none'`. Switching to
   `none` while a tunnel is open stops the tunnel first. Under `none`, the tunnel would turn "whoever
   reaches the port owns the machine" into "whoever has the URL owns the machine".
2. **Only the tunnel's exact host joins the allowlist**, while the tunnel is active, and it leaves
   when the tunnel stops.
3. **The real client address.** Every request through the tunnel arrives from `127.0.0.1`, and
   `FailureBackoff` is keyed by `req.ip` (`security.ts:231`). Ten wrong guesses by a stranger
   would make the owner wait too. The PR checks which forwarding header localhost.run sets.
   Requests whose `Host` is the tunnel's host are keyed by that header instead. Requests on any
   other host ignore it, so nobody on the machine can forge it. If the header turns out not to
   exist, tunnel traffic gets a backoff bucket of its own, apart from local traffic.
4. **Audit:** starting and stopping a tunnel, and every host it had, are rows in the security
   history.

### API

`GET /api/tunnel` (state, URL when active, reason when failed, whether `ssh` was found),
`PUT /api/tunnel/settings`, `POST /api/tunnel/start`, `POST /api/tunnel/stop`, and state changes on
`/api/events`. Each route gets a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in
the README. The types go in `packages/shared/src/types.ts`, with the schemas regenerated.

### UI: Settings → "Remote access"

A tab next to Security (`apps/web/src/pages/config/`), built with the Night Shift rules:

- A start/stop button (the zone's single `--grad` action), and the state as a word plus a colour:
  ok for active, warn for starting or verifying, bad for failed, idle for stopped.
- When active, the URL in mono with copy, and a QR code. A QR library is a dependency to justify in
  the PR, or it is generated in-house.
- The auth warning, with a link to Security, replaces the start button while `mode` is `none`.
- One line saying that the address changes and that the provider sees the traffic.
- Copy goes through i18n with `en`/`es` parity, per the glossary.

## The orchestration: `tunnel`

The owner decided on 2026-09-27 that the whole feature is built by **one orchestration**, launched
from the branch `feat/tunnel` (cut from `main` at `815d9bd`), and that it lands as **one pull
request**. The two questions left open by the design are tasks of this orchestration rather than
questions for later: `push-current-url` and `packaging` each answer one with evidence, write the
answer into this plan, and build it.

Every task runs on Opus, with no time or cost limit.

### Decisions already taken, not to be reopened by a task

1. **One provider: localhost.run, through the system's `ssh`.** No provider interface, no choice in
   the UI, no binary to download. Everything under "One provider, and why this one" holds.
2. **No tunnel without authentication**, and the security list above is the definition of done
   for the tunnel, item by item.
3. **Layered settings hang off `Core`.** No global singleton and no module-level state. A test can
   build two wrappers in one process, each with its own settings and its own tunnel.
4. **The web's streams stay on `EventSource`.** Moving them to `fetch` is a later change.
5. **Agentry itself is never exposed during development.** A task that needs the real localhost.run
   (to read its host key or its forwarding headers) points the tunnel at a throwaway server on
   `127.0.0.1` that answers a fixed text, and closes it before finishing. Tests never touch the
   network: they use a fake `ssh`.

### Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects in
   English, with a body that explains why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By` and no "Generated with" trailer, ever.
3. **Code, comments and docs are in English.** The `es` copy follows
   `apps/web/src/i18n/GLOSSARY.md`: Spanish from Spain, infinitive buttons, sentence case.
4. **Checks you run:** `timeout 900 pnpm typecheck` and `timeout 900 pnpm test`. You may write e2e
   specs, but **do not run `pnpm e2e`**: it runs once, in the verification, on the merged branch.
5. **Every long command runs under `timeout`.** If one hits its timeout twice, stop and report it.
6. **TypeScript strict and no `any`.** Respect `noUncheckedIndexedAccess`. Comments explain why.
7. **Storage follows the convention.** Settings-shaped documents go in JSON files written with
   `writeAtomic`. A document that holds a secret is written with mode `0600`.
8. **Every new route** gets a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in the
   README's REST API tables. After changing `packages/shared/src/types.ts`, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the result.
9. **Every change reaches the event feed.** A setting or the tunnel changing emits an
   `AgentryEvent` that carries what a client needs to refetch.
10. **Never touch the real `~/.claude` or `~/.ssh`.** Tests and experiments use scratch directories.
11. **Don't touch files outside your scope** (see ownership). If you need something from another
    task's file, say so in your result instead of editing it.
12. If something in your scope turns out impossible, or much larger than it looks, **do the rest
    and say what you left out**. Don't silently narrow the scope.
13. **In your result**, say plainly what you delivered, what you left out and why, how you verified
    it (the exact commands and their outcome), and notes for the `docs` task.

### File ownership

| Task | Owns |
|---|---|
| `types` | `packages/shared/src/types.ts` (the new sections), the generated OpenAPI schemas |
| `settings-layers` | new `packages/core/src/app-settings.ts`, `packages/core/src/paths.ts`, the wiring in `packages/core/src/index.ts`, `apps/api/src/security.ts`, new `apps/api/src/routes/app-settings.ts` and its registration, their `openapi/routes.ts` entries and README rows, their tests |
| `tunnel-core` | new `packages/core/src/tunnel.ts` (and siblings such as the pinned host key), its wiring in `packages/core/src/index.ts` after `settings-layers`, new `apps/api/src/routes/tunnel.ts` and its registration, their `openapi/routes.ts` entries and README rows, the fake `ssh` and their tests |
| `push-current-url` | `packages/core/src/push.ts`, `apps/web/public/sw.js`, `apps/web/test/pwa.test.ts`, the `PushPayload` change in `types.ts` after `types` and the regenerated schemas, their tests |
| `packaging` | `docker/**`, `deploy/**`, `apps/desktop/electron-builder.yml`, the Docker-specific default in `paths.ts` after `settings-layers` |
| `web` | `apps/web/src/**` (the "set by the environment" state on existing settings, the new Remote access tab, i18n in `en` and `es`), web tests and e2e specs |
| `docs` | `docs/**` except `docs/design-system/**`, `README.md` outside the REST rows |

### Stage 0

#### `types` (the contract)

Add to `packages/shared/src/types.ts`, each under its own section header with the reasoning as a
comment:

- **Layered settings:** `AppSettings` with `allowedHosts`, `maxConcurrentRuns` and
  `defaultPermissionMode`; for each, where its value comes from (`env`, `file`, `default`), so the UI
  can show "set by the environment"; and `UpdateAppSettingsRequest`, which can only change what the
  environment did not set.
- **Tunnel:** `TunnelState` (`stopped`, `starting`, `verifying`, `active`, `stopping`, `failed`),
  `TunnelStatus` (state, URL when active, the reason when failed, whether `ssh` was found, when the
  current address started), `TunnelSettings` (start with Agentry) and its update request.
- **Events:** `settings.changed` and `tunnel.changed`, added to the `AgentryEvent` union.
- **Done when**: typecheck passes across the workspace, the OpenAPI schemas are regenerated and
  committed, and nothing that exists changed shape.

### Stage 1

#### `settings-layers` (depends on `types`)

- `AppSettingsStore` in core. It reads the environment, then `app-settings.json` in the data
  directory, then the defaults. It refuses a write to a key the environment set, and it validates
  the same way `parseAllowedHosts` does today, so a pattern like `*.com` is refused from the file
  too.
- `CoreConfig` keeps the environment's values. What changes at runtime is read from the store, and
  `maxConcurrentRuns` and `defaultPermissionMode` apply to the next run without a restart.
- **The runtime allowlist:** `security.ts` reads the static names, the settings file's names and a
  runtime set on every request. The runtime set is an API on the store or on `Core`
  (`add(host, { clientIpHeader? })`, `remove(host)`) that takes exact names only.
- **The real client address:** a request whose `Host` is a runtime host registered with a
  `clientIpHeader` is keyed in `FailureBackoff` by that header. Any other request ignores the
  header. With no header registered, runtime-host traffic gets a bucket of its own, apart from
  loopback.
- `GET /api/settings/app` and `PUT /api/settings/app`, guarded like the other settings routes.
- **Done when**: an install that sets nothing behaves exactly as today (a test says so), a value in
  the environment beats the file (a test), a runtime host is answered and forgotten again (a test),
  and ten failures through a runtime host do not make a loopback client wait (a test).

### Stage 2

#### `tunnel-core` (depends on `types` and `settings-layers`)

Build "Core: `TunnelManager`" and "Security" above, item by item, plus the routes under "API".

- First, **against the real service with a throwaway server** (decision 5): read localhost.run's
  host key and pin it, record the exact banner line the URL comes from, and find out which headers
  carry the client's address. Write the three findings into this plan, under "What `tunnel-core`
  found".
- A fake `ssh` for the tests: a small script that prints a localhost.run-shaped banner, forwards
  to the port it was given, and can be told to drop and come back with a new address.
- Tests for: start refused under `mode: 'none'`; switching to `none` stops the tunnel; the host
  joins the allowlist only once verified and leaves on stop; a domain change swaps the host; the
  child dies with Agentry, and an orphan from a crash is cleared; `ssh` missing is a state, not a
  crash; the pinned key is used, and `~/.ssh` is never read.
- **Done when**: everything above has a test, and a short manual run against the throwaway server
  reached `active` and was stopped cleanly.

#### `push-current-url` (depends on `tunnel-core`): open question 1

**The question:** a notification that arrives after the domain changed opens the old address. Can
it open the current one?

- Find out first, and write the answer with its evidence into this plan, under "Answer:
  notifications after a domain change". What does `notificationclick` in `apps/web/public/sw.js`
  do with `href` today? Does `clients.openWindow` accept a URL on another origin, in Chrome on
  Android and in Safari on iOS? Is the subscription still valid after the origin changes, given
  that it belongs to the service worker of the origin that created it and not to the push service?
- **If it can be done**, do it: the payload carries the absolute URL of the current tunnel address
  when there is one, and the click opens it. A test shows that a notification sent after a domain
  change opens the new address.
- **If it cannot be done**, or only on some platforms, build what can be done (for instance, the
  notification says the address changed) and say plainly in the plan what cannot.

#### `packaging` (depends on `tunnel-core`): open question 2

**The question:** should the Docker image offer the tunnel at all?

- Find out first, and write the answer with its evidence into this plan, under "Answer: the tunnel
  in Docker". The facts that matter: the image already has `openssh-client`. The tunnel reaches the
  server at `127.0.0.1` inside the container, so it goes around a Compose file that only publishes
  on `127.0.0.1`, and around the operator's proxy and TLS profile. Can a container reach
  localhost.run on port 22 by default? What would a Helm operator expect?
- Build the answer. A tunnel that is off in Docker unless the operator enables it is decided the
  same way `cswapManaged` is today (`AGENTRY_DISTRIBUTION=docker`), with a variable to turn it on,
  documented in `.env.example` and in the chart's `values.yaml`. If the answer is "on", say why the
  bypass above is acceptable.
- Add `openssh-client` to the `.deb` dependencies in `apps/desktop/electron-builder.yml`.

### Stage 3

#### `web` (depends on `settings-layers`, `tunnel-core` and `push-current-url`)

- The three layered settings, editable where they fit in Settings, and read-only with "set by the
  environment" when the environment set them.
- The **Remote access** tab next to Security, as described under "UI" above: state as a word plus
  a colour, the URL in mono with copy, a QR code, the auth warning with a link to Security in place
  of the button while `mode` is `none`, the "ssh not found" state, and the line about the changing
  address and the provider seeing the traffic.
- It follows `tunnel.changed` and `settings.changed` on the event feed.
- The QR code: no new dependency unless its size and licence are stated in the result.
  Generating it in-house is fine.
- Night Shift: open `docs/design-system.md` and the Settings reference screens before building. No
  new prototype is required, because the tab is built from components the settings pages already
  use. A new variant, if one is needed, goes into `agentry-ds.css` and the doc.
- An e2e spec for the tab against a fake tunnel, written but not run.

### Stage 4

#### `docs` (depends on every other task)

- `docs/tunnel.md`: what the feature is, how to use it, what the provider sees, and what the
  changing address means for an installed PWA.
- Sections in [deploy.md](../deploy.md) (Docker, from the answer of `packaging`) and
  [desktop.md](../desktop.md). The README's feature list and environment table.
- This plan's **Outcome** section: what each task delivered and where it went past or around this
  text. The status line at the top changes from proposed to built.

### Verification

Once the graph is integrated: `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e`, with a
fixer.

## What `tunnel-core` found

To be written by `tunnel-core`.

## Answer: notifications after a domain change

To be written by `push-current-url`.

## Answer: the tunnel in Docker

To be written by `packaging`.

## Outcome

To be written by the `docs` task.

## Related

[[deploy.md]] · [[desktop.md]] · [[plans/mobile.md]] · [[security-model]] · [[layered-settings]]
