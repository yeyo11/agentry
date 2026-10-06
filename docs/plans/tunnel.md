---
created_at: 2026-09-27T10:34:29.651906091Z
updated_at: 2026-10-06T12:00:00Z
tags:
    - plan
    - tunnel
    - remote-access
    - security
    - settings
    - built
    - tailscale
---
# Plan: reaching Agentry through a tunnel

Let a person open their Agentry from a phone or another network without a VPS, a domain, a
reverse proxy, an account or anything new to install. Agentry opens a tunnel through
[localhost.run](https://localhost.run) with the system's own `ssh`, shows the public HTTPS address
and a QR code, and closes it again, all from the settings page.

> **Superseded on 2026-10-06.** The provider is now Tailscale (`tailscale serve`, tailnet-only), not
> localhost.run over `ssh`: see [The move to Tailscale](#the-move-to-tailscale-2026-10-06). The rest
> of this plan is the record of the localhost.run build; the security rules, the layered settings,
> the Docker switch and the push answer still hold, adapted as that section says.

Status: **built on 2026-09-27** by the orchestration `tunnel` from `feat/tunnel`, as one pull
request. Every task delivered, and both open questions are answered below. The merged branch's e2e
verification runs in the orchestration. The measurements below were taken the same day. What each
task delivered is under [Outcome](#outcome), and the feature itself is documented in
[tunnel.md](../tunnel.md) and [layered-settings.md](../layered-settings.md).

## Why

[deploy.md](../deploy.md) covers exposing Agentry on purpose: Docker, Caddy, a domain, a
certificate. Many people want less than that: to glance at a running orchestration from the
phone, or answer a permission prompt away from the desk. A plain-HTTP LAN install is not enough
for that. It is unreachable outside the house, and without a secure origin the browser gives the
PWA no service worker and so no push ([plans/mobile.md](mobile.md)). A tunnel gives an HTTPS origin
with nothing to configure.

The tunnel does not touch Claude Code, so the one rule is not involved.

## One provider, and why this one

*Superseded on 2026-10-06 by Tailscale; see [The move to Tailscale](#the-move-to-tailscale-2026-10-06).*

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

1. **One provider: localhost.run, through the system's `ssh`** (superseded on 2026-10-06: Tailscale).
   No provider interface, no choice in the UI, no binary to download. Everything under "One provider, and why this one" holds.
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

Measured on 2026-09-27 against the real localhost.run, from OpenSSH 9.6p1, with the tunnel pointed
at a throwaway server on `127.0.0.1` that answered a fixed text (decision 5). The ssh process and
the server were killed by PID afterwards.

1. **The host key.** `ssh-keyscan localhost.run` prints nothing: the server (`lhr-2.0`) does not
   send its version until the client does, which `ssh-keyscan` does not wait for. The key was read
   from a real `ssh` session with a scratch `known_hosts` (`StrictHostKeyChecking=accept-new`). The
   name resolves to three addresses; the session reached one of them, and the later run with the
   pin and `StrictHostKeyChecking=yes` connected again:

   ```
   localhost.run ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILVqOuSMnyeGDVO1lG6EaG5In/dXABCchhmHKkuRU2s9
   SHA256:pG6qrBxubYfWa1Zadu/V0NUgjEDiBds/7e2xzte/QNM
   ```

   It is `LOCALHOST_RUN_KNOWN_HOSTS` in `packages/core/src/tunnel.ts`, written to
   `<dataDir>/tunnel/known_hosts` (mode `0600`) before every attempt, and ssh runs with
   `StrictHostKeyChecking=yes`, `UpdateHostKeys=no` and `GlobalKnownHostsFile=none`. A key that
   changes fails the tunnel with `tunnel.hostKey` and no retry, rather than being learned.
2. **The banner line.** The address arrives on **stdout**, after `authn: authenticated as anonymous
   user`, as `<id>.lhr.life tunneled with tls termination, https://<id>.lhr.life` (the id was 14
   hex characters, lines end in `\r\n`). The same output carries two other `https://` links (the
   docs and the "forever free" page), and stderr carries a welcome box and a line with the
   caller's **public IP** (`your connection id is <ip>:<port>`). So the parser matches that one line
   only, and requires the same name on both sides of it; and the IP line is never used as a failure
   reason shown on screen.
3. **The client's address.** localhost.run **adds no forwarding header at all**: no
   `X-Forwarded-For`, `X-Real-IP`, `Forwarded` or `X-Forwarded-Proto`. It keeps the public `Host`
   and passes the request's own headers through untouched, so an `X-Forwarded-For: 6.6.6.6` sent by
   the client arrived as exactly that. Keying the backoff by such a header would let a stranger
   pick whose budget they spend. The tunnel's host is therefore registered **without**
   `clientIpHeader` (`TUNNEL_HOST_OPTIONS`), and all tunnel traffic shares one backoff bucket of its
   own, apart from loopback: ten wrong guesses through the tunnel make the tunnel wait, never the
   owner at the desk. The cost is that a stranger can make the owner's phone wait too, for as long
   as the backoff lasts.

Also measured, and what it changed:

- **`/api/health` answers before the host is allowed.** The route is open and outside the host
  check, so verification goes through the public URL while the host is still off the allowlist.
  The host joins only after that first `200`. It took 2.3 s from `start` to `active`.
- **ssh never reads `~/.ssh`:** `-F none`, `BatchMode=yes`, `PubkeyAuthentication=no`,
  `IdentityAgent=none` and `IdentityFile=none`. The `nokey` user authenticates with `none`. The
  real run reached `active` with all of these options set.
- **The manual run:** the real `TunnelManager`, the system `ssh` and localhost.run, pointed at the
  throwaway server. It went `starting → verifying → active` in 2.3 s, and the public URL answered
  `200`. On `stop` it went `stopping → stopped`, the host left the list, and the ssh PID was gone.

Three places where this task changed a file outside the ownership table, because nothing else
could do it:

- `packages/core/src/paths.ts` (`settings-layers`) gained `sshBin`, read from `SSH_BIN` with `ssh`
  as the default.

- `packages/core/src/security/auth.ts` gained `beforeUnguarded`, which the store awaits before the
  mode turns to `none`. `Core` points it at `tunnel.stop('unguarded')`, so the answer to that `PUT`
  already finds the tunnel closed.
- `apps/api/src/server.ts` calls `core.tunnel.attach(port, host)` with the port it actually bound
  to.

## Answer: notifications after a domain change

**Yes, on Chrome (desktop and Android) it can: a push sent after the address changed opens the new
address. On iOS it is built the same way but could not be verified**, for lack of a device. Answered
by `push-current-url` on 2026-09-27.

### What happened before

`notificationclick` in `apps/web/public/sw.js` resolved `href` (a path such as
`/chats/<id>?prompt=<id>`) against `self.location.origin`, which is the origin the worker was
installed from. A phone that installed Agentry on `https://a….lhr.life` therefore opened
`https://a….lhr.life/chats/…` for every notification, including ones sent long after that address
stopped answering.

### The evidence

1. **The subscription survives the change.** A push subscription belongs to the service worker
   registration it was made from, not to the server that uses it. The
   [Push API](https://w3c.github.io/push-api/) deactivates one only when "its associated service
   worker registration is unregistered" or it expires, and the push service delivers by endpoint
   ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)), with the VAPID key as the only binding to the
   server. Nothing in the protocol looks at the origin, so the server keeps reaching the phone and the
   phone keeps running the *old* origin's worker. When that worker checks for an update and gets a
   network error or a page with the wrong MIME type, the
   [Service Workers](https://w3c.github.io/ServiceWorker/) Update algorithm rejects the update and
   removes the registration only "if newestWorker is null". An installed worker is not null, so it
   stays.
2. **`clients.openWindow` accepts another origin.** The spec's steps parse the URL, refuse only
   `about:blank` and calls without transient activation, and open the URL in a new top-level browsing
   context. When that context's storage key is not the worker's, the promise "resolve[s] with null".
   So the URL is opened, and the worker just gets no client for it.
   [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clients/openWindow) agrees ("resolves to
   a WindowClient … if the URL is from the same origin … or a null value otherwise") and notes that
   Chrome for Android may open it in an installed app whose scope covers it. `WindowClient.navigate`
   has the same shape: it navigates a controlled window across origins and resolves with null.
3. **A run in real Chrome.** Chrome 152, headless, with a scratch profile. Two HTTPS servers on
   `127.0.0.1` played the old and the new address, `https://0a1b….lhr.life` and
   `https://9f8e….lhr.life`, through `--host-resolver-rules` and a self-signed certificate, so
   nothing left the machine and Agentry was not involved. The built `sw.js` was served from both.
   - The page installed on the old address, and then the old server was shut down.
   - `ServiceWorker.deliverPushMessage` delivered a payload carrying the new address to the old
     registration. The old worker showed the notification, and its `data` held the new URL.
   - The old address's shell still painted from the worker's cache, controlled, with its server
     gone.
   - With that window open, the click's own code, `openUrl(destination(data))`, navigated it to
     `https://9f8e….lhr.life/chats/run1?prompt=p1`.
   - One thing could not be exercised: tapping a notification. CDP has no way to do it, and outside a
     tap `openWindow` is refused with `InvalidAccessError: Not allowed to open a window`, which is
     the spec's activation rule. That branch rests on the spec and MDN (point 2) and on the unit
     tests.
4. **iOS** (Web Push only reaches Home Screen apps, from 16.4). Tapping a notification launches
   the app on its start URL. Reports say that `openWindow` then does not navigate to the path it was
   given, while `client.navigate` on the window that was launched does
   ([Apple forums 733604](https://developer.apple.com/forums/thread/733604),
   [WebKit 252544](https://bugs.webkit.org/show_bug.cgi?id=252544): that window is inert for a
   moment, [WebKit 259212](https://bugs.webkit.org/show_bug.cgi?id=259212)). No source says what a
   standalone app does with a URL on *another* origin, and no iPhone was available to try. The likely
   outcome is Safari's in-app browser, as for any link out of the app's scope. **This is not
   verified.**

### What was built

- `PushPayload.url` (`packages/shared/src/types.ts`): the notification's path as an absolute URL
  on the tunnel's current address, or null while no tunnel is active.
  - `PushService` follows `tunnel.changed` on the bus, so nothing has to be wired to it. The address
    counts only while the state is `active`; while reconnecting, `url` is null.
  - The test notification carries it too.
  - `absoluteOn` only builds `https` URLs from rooted paths, so `//host` or an absolute `href` never
    becomes a URL on another site.
- The worker follows `url` only when **both** its own origin and `url` are tunnel addresses
  (`*.lhr.life`, `TUNNEL_SUFFIX` in `sw.js`), `url` is `https`, and it is on a different origin.
  - A phone installed on the LAN or at the desk keeps opening its own origin while a tunnel happens
    to be open, rather than being sent through the provider.
  - A test in core checks that the suffix matches what `parseTunnelUrl` produces.
- For another origin, the worker navigates the first open window (the iOS path, and what the Chrome
  run confirmed). With no window, or one it may not navigate, it calls `openWindow`. It never hands a
  cross-origin URL to the old page's router, which can only route within its own origin.

### What it cannot do, and what the person still sees

- **The new address is a new origin**, so the browser keeps its storage apart from the old one. It
  has no token in `localStorage` yet, so the person signs in again there once. It has no worker, no
  installed app and no push subscription of its own either.
- **Duplicates.** If the person enables notifications again on the new address, the phone holds two
  subscriptions, one per origin. It then receives each push twice until the old one is removed in
  Settings → Notifications. Tags only collapse within one origin. The server cannot tell that two
  endpoints are the same phone.
- **The old worker's `pushsubscriptionchange`** posts to its own origin, which no longer answers, so
  a rotation on an old install is lost until the person opens the current address.
- **The address in a push is the one current when it was sent.** The push service keeps a message
  for up to an hour while the phone is offline, and a change in that window makes the address stale.
  It is null when no tunnel was active at the time.
- **The notification does not say that the address changed.** The worker has no translations, and
  the payload's words are the server's, which already say what happened. Once opened, the new address
  explains itself.

## Answer: the tunnel in Docker

**The image offers the tunnel only when the operator turns it on**, with `AGENTRY_TUNNEL=on` in
`.env` for Compose, or `tunnel.enabled: true` in the Helm chart. Everywhere else (a source install,
the desktop app) it is on by default, and `AGENTRY_TUNNEL=off` turns it off there too.

### The evidence

Measured on 2026-09-27 with Docker 29.8.0 on the default `bridge` network, following decision 5.
The container was a throwaway `node:22-bookworm-slim` with `openssh-client` added. Inside it, a
throwaway server listened on `127.0.0.1:9999` and answered a fixed text. The container published
**no port at all**: `docker port` printed nothing.

- **Port 22 is open by default.** A TCP connect to `localhost.run:22` from the container succeeded.
  The container's ssh (OpenSSH 9.2p1, Debian 12, the same base as the image) then opened the tunnel
  with the exact options `TunnelManager` passes, including the pinned key and
  `StrictHostKeyChecking=yes`. The banner line gave a `<id>.lhr.life` address.
- **The tunnel goes around everything the operator put in front.** A `GET` of that public address,
  sent from the host over the internet, answered `200` with the throwaway text. So a server inside a
  container with nothing published was reachable from anywhere. That is also what happens to the
  real image's Compose setup:
  - Compose publishes only `127.0.0.1:${PORT}`.
  - The `tls` profile puts Caddy, with its own certificate, in front.
  - The tunnel skips both. It reaches `127.0.0.1:8787` from inside the container, and
    localhost.run's TLS and certificate replace the operator's.
- **Cleanup:** the ssh and the server were killed inside the container, the container was removed
  (`--rm`), and nothing from it was printed except the lines above. Its stderr holds the public IP.

### Why off in Docker

- **Docker and Kubernetes operators decide ingress outside the process.** In Compose they do it
  with `ports:` and a proxy; in Helm with a `ClusterIP` Service, an Ingress and NetworkPolicies. A
  Helm operator expects every way into a pod to appear in the manifests. A pod that dials out and
  opens a public way in of its own looks like a backdoor to a security review. A button in the UI
  that does this, where anyone who can sign in can press it, is not something to switch on by
  default.
- **Nothing in the network stops it.** The measurement shows that Docker's default bridge lets the
  container out on port 22, so the only thing between the image and a public address is Agentry's
  own switch. On a cluster with egress NetworkPolicies, or behind a firewall that blocks outbound
  22, turning it on is not enough either. The chart says so.
- **On a desktop the person is the operator.** The machine is theirs, nothing stands in front of
  the port, and the tunnel is the feature's whole point, so it stays on by default there.

### What was built

- `CoreConfig.tunnelEnabled` (`packages/core/src/paths.ts`), from `AGENTRY_TUNNEL`. It is decided
  the same way as `cswapManaged`: on by default, and off by default when
  `AGENTRY_DISTRIBUTION=docker`.
  - `on`, `1` and `true` turn it on; `off`, `0` and `false` turn it off.
  - Empty or unset means the default, because Compose passes empty variables through.
  - Any other value stops the wrapper at startup. A typo in the switch that opens a public address
    is not something to guess about.
- `TunnelStatus.enabled` (`packages/shared/src/types.ts`, schemas regenerated), so the UI can say
  who can turn the tunnel on instead of offering a button.
- `TunnelManager` with `enabled: false`:
  - `start` is refused with `409` and `tunnel.disabled`.
  - A "start with Agentry" saved earlier does not open the tunnel. The state stays `stopped`, not
    `failed`: nothing went wrong.
- Compose: `.env.example` documents `AGENTRY_TUNNEL=on` and what it goes around. `env_file: .env`
  already hands it to the container, so `docker-compose.yml` did not change.
- Helm: `tunnel.enabled: false` in `values.yaml`. The deployment always writes `AGENTRY_TUNNEL` as
  `on` or `off`, so the release decides whatever the image defaults to. `NOTES.txt` warns when it
  is on. The chart does not refuse `tunnel.enabled` with `auth.mode: none`, because `auth.mode`
  only seeds a fresh volume, and the UI's value wins after that. The tunnel checks the live mode
  itself.
- The Dockerfile only gained comments. `openssh-client` was already there, and
  `AGENTRY_DISTRIBUTION=docker` is what keeps the tunnel off.
- The `.deb` declares `openssh-client` (`apps/desktop/electron-builder.yml`).

Turned on, the image's tunnel is the same as everywhere else: it refuses under `mode: 'none'`, only
its exact host joins the allowlist, and it opens only when someone starts it or turns on "start with
Agentry".

Changed outside `packaging`'s ownership, because the answer needed them:

- `packages/shared/src/types.ts` (`TunnelStatus.enabled`) and the regenerated
  `apps/api/src/openapi/schemas.json`.
- `packages/core/src/tunnel.ts` and the wiring in `packages/core/src/index.ts`.
- The `GET` and `POST /tunnel/start` descriptions in `apps/api/src/openapi/routes.ts`.
- `.env.example`.
- One field added to the `TunnelStatus` literals in `packages/shared/test/notifications.test.ts`
  and `apps/api/test/tunnel.test.ts`.

## Outcome

Built on 2026-09-27 by the seven tasks of the orchestration, each on its own branch, merged into
`docs` in dependency order. Typecheck and the unit suite pass on the merge (shared 14, desktop 42,
core 540, web 529, api 115). The e2e suite, with the new `remote-access.spec.mjs`, runs once in the
orchestration's verification. The feature is documented in [tunnel.md](../tunnel.md) and
[layered-settings.md](../layered-settings.md).

- **`types`.** The contract as planned, plus three choices past the text:
  - `TunnelStatus.reason` is a `Localized`, so the web translates failures by `code`.
  - `TunnelStatus` carries `settings`, because no `GET` route for the tunnel settings was planned.
  - `AppSettings.allowedHosts` is only the configured part. A test also says that neither new event
    ever becomes a notification, so an address never reaches a lock screen or a push service.
- **`settings-layers`.** `AppSettingsStore` and `RuntimeHosts` on `Core`, `GET` and
  `PUT /api/settings/app`, and a `backoffKey` in `security.ts`. All four "done when" conditions have a
  test. Beyond the plan:
  - Small edits to `chats.ts` and `orchestrator.ts`, which no task owned, so the next run reads the
    store.
  - An empty `AGENTRY_MAX_CONCURRENT_RUNS` or `AGENTRY_DEFAULT_PERMISSION_MODE` now counts as unset.
    Before, an empty run limit meant a wrapper that could start no run.
  - A header registered with a runtime host is read at its last hop, because earlier hops are the
    client's to forge.
- **`tunnel-core`.** `TunnelManager`, the four routes under a new "Remote access" tag, the fake
  `ssh`, and the three findings above. The answer to the header question was "there is none", so the
  tunnel is registered without `clientIpHeader`, and all its traffic shares one backoff bucket, apart
  from loopback. It also went past the ownership table in three small places (`paths.ts`, `auth.ts`'s
  `beforeUnguarded`, `server.ts`), listed above. The manual run reached `active` in 2.3 s and stopped
  cleanly.
- **`push-current-url`.** Open question 1 is answered **yes, on Chrome; built but not verified on
  iOS**. `PushPayload.url` carries the current tunnel address, and the worker follows it only from one
  `*.lhr.life` origin to another. Its limits (sign in again, duplicates, a stale address, a lost
  renewal) are in the answer above and in [tunnel.md](../tunnel.md#the-address-changes).
- **`packaging`.** Open question 2 is answered **off in Docker unless the operator turns it on**:
  `AGENTRY_TUNNEL` in Compose's `.env`, and `tunnel.enabled` in the chart. It also added
  `TunnelStatus.enabled` and the `tunnel.disabled` refusal, both outside its ownership, and
  `openssh-client` to the `.deb`. A real image build confirmed the `409`.
- **`web`.** Settings → Remote access (state word and colour, address with copy, an in-house QR code
  for versions 1 to 10 with two new tokens, the auth warning, the no-ssh state, "start with Agentry",
  and a footnote about new addresses), and the three layered settings as two cards in Security. Both
  events write their caches directly. The e2e spec is written, not run, and `a11y.spec.mjs` covers
  the new tab.
- **`docs`.** It finished the merges and wrote [tunnel.md](../tunnel.md) and
  [layered-settings.md](../layered-settings.md). It added the Docker section and the Helm value to
  [deploy.md](../deploy.md) and the phone section and data paths to [desktop.md](../desktop.md), and
  updated the README (features, On a phone, the environment table, Securing it, Deploying, Known
  limitations), `SECURITY.md` and [status.md](../status.md). Two gaps showed up only once `packaging`
  and `web` met:
  - The merged tree did not typecheck: `enabled` was missing from the `TunnelStatus` literals of
    `push.test.ts` and `remote-access.test.tsx`.
  - The tab did not know `enabled`: in the Docker image it offered a start button that could only
    answer `409`, and `tunnel.disabled` had no translation.

  The tab now says that the deploy turned the tunnel off and names `AGENTRY_TUNNEL=on`, in `en` and
  `es`, with a unit test. The e2e fake status carries `enabled: true`. The README's `GET /tunnel` row
  gained `enabled`.

Left for later, as the plan already said: moving the event streams to `fetch`, so the token leaves
the URL, and a fixed domain. Also left: suggesting, from Settings → Notifications, removal of a
device registered on an old tunnel address.

## Follow-up: webhooks over the tunnel (2026-10-02)

Phase 6 of [code-hosts.md](code-hosts.md) uses the tunnel as the public address for code host
webhooks. What it changed here, and why:

- **The tunnel is the only public origin.** The code hosts plan also named "the configured public
  origin"; no such setting exists, so the registration service reads the active tunnel's address
  (`tunnel.status()`), and registering without one fails with `no-public-url`. A setting for a
  deployment with its own domain is left for later.
- **A new address re-points the hooks** (owner decision 2, 2026-09-30, option a): the service
  observes `tunnel.changed` and patches each registered hook by id. This is the one place the tunnel
  causes a call to a code host, and it is the person's earlier click, not a new action.
- **The receivers are exempt from the bearer token** in `security.ts`, only for `POST
  /api/webhooks/{github,gitlab}/<id>`. The allowlist still applies, and the tunnel's host is already
  on it while it is `active`. Rejected: a separate port for receivers, which would need a second
  tunnel for one feature.
- **The risk it adds:** a stranger who learns a registration id can send requests to a path with
  no token. They get `401` with no detail without the secret, the secret check is constant-time over
  the raw body, a rate limit applies only after verification, and a verified delivery can only
  bring a read forward.

[code-hosts.md](../code-hosts.md#events-and-paced-polling) has the receivers, the pacer and the
registration calls; [deploy.md](../deploy.md#webhooks-and-the-public-address) has what a deployment
must expose.

## The move to Tailscale (2026-10-06)

The owner decided on 2026-10-06 to replace localhost.run with the **Tailscale CLI**, and only
Tailscale: no provider selector, and localhost.run is gone from the code. Built on the branch
`feat/tunnel-tailscale`.

### Why

- **A stable host.** localhost.run's free name changed regularly, and everything that hangs off an
  origin paid for it: sign in again on every address, an installed PWA and its push subscription
  stuck on a dead origin, duplicated subscriptions, a voice shortcut to set up again. A node's MagicDNS
  name does not change while the machine keeps its name.
- **No third party in the clear.** localhost.run terminated TLS and saw every request, the bearer
  token and the `?token=` URLs included. Tailscale encrypts end to end and tailscaled terminates TLS
  on the machine itself, with a real certificate for the node's name.
- **No ssh, and the vendor's own CLI.** No pinned host key to keep current, no banner to parse, no
  public IP on stderr, no outbound TCP 22. Tailscale is reached the way the one rule asks of every
  program Agentry drives: its CLI flags and `--json` output, with the person's own session.
- **Not on the internet.** `tailscale serve`, never Funnel: only the person's tailnet can reach it.
  What was rejected in the first plan as "install and account" is what the owner chose: the phone
  needs the Tailscale app, and that is the boundary that keeps strangers out.

### Owner decisions

1. Tailscale only, localhost.run removed, no provider selector.
2. `tailscale serve` (tailnet-only) by default; Funnel is not offered.
3. Authentication stays required before the tunnel opens: the `mode: 'none'` refusal and the stop
   when the guard is turned off are unchanged.

### What was measured (tailscale 1.102.4, this machine, node in `Running`)

- `tailscale status --json` carries `BackendState` (`Running`, `NeedsLogin`, `Stopped`…),
  `Self.DNSName` with a trailing dot, `CertDomains` (only filled while HTTPS certificates are on) and
  `CurrentTailnet.MagicDNSEnabled`. A CLI that cannot reach tailscaled exits 1 with "failed to
  connect to local tailscaled" and no JSON.
- `tailscale serve status --json` printed `{}` for a node with no Serve config, and reading it needs
  no special permission.
- `tailscale serve --bg --yes --https=18443 http://127.0.0.1:<port>` was **refused**: "sending serve
  config: Access denied: serve config denied", with the advice `sudo tailscale set --operator=$USER`.
  The user here is not the node's operator, and Agentry does not change that, so adding a rule could
  not be exercised on the real node. That refusal became `tunnel.servePermission`.
- `tailscale serve --https=18443 off` on a port with no rule answered "error: failed to remove web
  serve: handler does not exist" (exit 1), without needing the operator: `off` is a read-modify-write
  of the CLI's that touches only the handler it names. Agentry treats that answer as already gone.
- The node's Serve config was `{}` before and after: nothing was left behind.

The shape of a rule in `serve status --json` (`TCP["<port>"].HTTPS` and
`Web["<node>:<port>"].Handlers["/"].Proxy`) is `ipn.ServeConfig`'s, as the CLI prints it; the fake CLI
(`packages/core/test/fixtures/fake-tailscale.mjs`) writes the same shape, and the tests drive every
path through it.

### Decisions taken while building it

- **Port 8443, configurable.** Serve config is global to the node, and `tailscale serve` without a
  port takes 443, which is where a person's own rule most likely is. Agentry uses 8443
  (`AGENTRY_TUNNEL_PORT`) and only ever adds or removes the `/` handler on that port. A port holding
  anything else, or even a rule of Agentry's exact shape that Agentry did not record adding, is
  `tunnel.portTaken`. Rejected: a path on 443 (`--set-path`), which would share a listener with the
  person's rules and make "remove only ours" depend on the CLI's handling of siblings.
- **`--bg` with a record, not a foreground process.** A background rule outlives Agentry, so the rule
  is recorded in `<dataDir>/tunnel/serve-rule.json` before it is sent, removed on stop and,
  synchronously, on shutdown, and reconciled on the next start after a crash. The pid file and the
  orphan logic of the ssh tunnel are gone. Rejected: a foreground `tailscale serve` child, whose rule
  would vanish with the child but which would linger as an orphan after a crash of Agentry, the very
  case the record covers.
- **Verified by reading the config back, not through the tailnet name.** A node reaching its own
  Serve listener through its MagicDNS name could not be measured (no operator), and MagicDNS may not
  resolve on the machine itself (`--accept-dns=false`). Reading `serve status --json` after adding
  proves the rule exists and points at this server. A monitor reads Tailscale and the rule every 30 s
  while active: a removed or changed rule fails the tunnel at once, Tailscale not ready twice in a
  row fails it with that reason, and a renamed node moves the allowed host.
- **Readiness is its own field.** `TunnelStatus.sshAvailable` became `tailscale`
  (`TailscaleReadiness`: `missing`, `unsupported` below 1.52, `daemonDown`, `loggedOut`, `stopped`,
  `httpsDisabled`, `ready`, with the CLI version, the node name and a localized reason) plus `port`.
  The tab shows nothing of the tunnel until it is `ready`, and `GET /api/tunnel` asks the CLI again
  when its answer is older than two seconds.
- **No trusted client header.** Serve's identity headers (`Tailscale-User-Login`…) are documented as
  replacing a client's own; whether `X-Forwarded-For` is set and safe could not be measured. The
  runtime host is still registered without `clientIpHeader`, and tunnel traffic keeps its own
  backoff bucket.
- **Webhooks lose their public origin.** A tailnet address is unreachable for GitHub or GitLab.com,
  so `Core` hands the webhook service no public URL (`no-public-url`) and no longer wires its
  `tunnel.changed` observer, so no hook is ever re-pointed at a tailnet name. The service keeps
  `follow` for a public origin a later setting may provide. The Webhooks card says the tunnel only
  reaches the tailnet, and its link to Remote access is gone.
- **Docker stays off, for a new reason.** The container sees neither the host's CLI nor its daemon;
  the image ships no `tailscale`. `openssh-client` stays in the image, for git.
- **Packaging.** The `.deb` no longer depends on `openssh-client`, and does not depend on
  `tailscale` (not in Debian's archive); the tab says how to install it. `SSH_BIN` is gone;
  `TAILSCALE_BIN` points at another CLI.
- **The worker's suffix** (`TUNNEL_SUFFIX` in `sw.js`) is now `.ts.net`: the address rarely moves,
  but when it does (a renamed node, another port) an install follows it as before.
- **The e2e suite never asks the real Tailscale**: `e2e/run.mjs` points `TAILSCALE_BIN` at the fake,
  with a node file in the sandbox.

## Related

[[deploy.md]] · [[desktop.md]] · [[plans/mobile.md]] · [[tunnel.md]] · [[code-hosts.md]] · [[layered-settings.md]] · [[security-model]]
