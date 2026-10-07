---
created_at: 2026-09-27T18:00:00Z
updated_at: 2026-10-06T12:00:00Z
tags:
    - tunnel
    - remote-access
    - security
    - mobile
    - tailscale
---
# Remote access through Tailscale

Settings → **Remote access** serves this Agentry on the person's own
[Tailscale](https://tailscale.com) tailnet, so a phone or a laptop signed in to the same tailnet can
reach it. The address is the machine's MagicDNS name on a port of Agentry's own,
`https://<machine>.<tailnet>.ts.net:8443`, shown with a QR code, and it stays the same from one
start to the next. Nothing is published on the internet: Agentry uses `tailscale serve`, never
Funnel.

Until 2026-10-06 the tunnel went through localhost.run over `ssh`; why it moved, and what was
measured, is in [the plan](plans/tunnel.md#the-move-to-tailscale-2026-10-06).

## The rule it follows

Tailscale is reached **only through its CLI**: its flags and its `--json` output, with the session
the person already has. No LocalAPI socket, no tsnet, no sign-in of Agentry's own, and Agentry never
runs `tailscale up`, `login` or `set`. It is the same rule Agentry follows for the agents
([providers.md](providers.md)) and the code hosts ([code-hosts.md](code-hosts.md)). The calls:

| Call | Why |
| --- | --- |
| `tailscale version` | Installed, and at least 1.52, where `serve` took its current arguments |
| `tailscale status --json` | `BackendState`, `Self.DNSName`, `CurrentTailnet.MagicDNSEnabled`, `CertDomains` |
| `tailscale serve status --json` | The node's Serve config, read before adding, after adding, and before removing |
| `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<agentry port>` | Adds Agentry's rule |
| `tailscale serve --yes --https=<port> off` | Removes it |

The tunnel does not touch Claude Code. It forwards HTTP to Agentry's own port.

## What has to be ready

The whole section depends on Tailscale. Until it is ready, the tab offers neither the button nor
"start with Agentry"; it says what is missing, and `GET /api/tunnel` carries it as
`tailscale.state` with a `reason` to translate:

| `tailscale.state` | Reason code | What the tab offers |
| --- | --- | --- |
| `missing` | `tunnel.tailscaleMissing` | `Empty` with the `cli-missing` illustration and **Install Tailscale** (`https://tailscale.com/download`) |
| `unsupported` | `tunnel.tailscaleUnsupported` | Older than 1.52: **Update Tailscale** |
| `daemonDown` | `tunnel.tailscaleDaemonDown` | The CLI cannot reach `tailscaled`: start the service |
| `loggedOut` | `tunnel.tailscaleLoggedOut` | `NeedsLogin` or `NeedsMachineAuth`: run `tailscale up` |
| `stopped` | `tunnel.tailscaleNotConnected` | Any other state than `Running` (`Stopped`…): run `tailscale up` |
| `httpsDisabled` | `tunnel.magicDnsOff`, `tunnel.httpsOff` | MagicDNS or HTTPS certificates are off: **Open DNS settings** (`https://login.tailscale.com/admin/dns`) |
| `ready` | – | The tunnel card, with the node's name |

Every state but `missing` has **Check again**, which reads the status again: `GET /api/tunnel` asks
the CLI anew when its last answer is more than two seconds old, so a `tailscale up` in a terminal
shows without a restart.

Two more things are only learned when the rule is added, and fail the start with their reason:

- **`tunnel.servePermission`**: tailscaled refuses Serve changes from a user who is not the node's
  operator ("Access denied: serve config denied", measured). The fix is
  `sudo tailscale set --operator=$USER`, once; the tab says so and never runs it.
- **`tunnel.portTaken`**: the port already serves something Agentry did not add (below).

## Using it

1. **Turn on authentication first** (Settings → Security: a token or OIDC). While the mode is
   `none`, the tab shows a warning with a link to Security instead of the button. Every device on the
   tailnet that can reach the machine could otherwise drive it.
2. Press **Open tunnel**. The state reads *opening* while the rule is added, then *checking* while
   Agentry reads the Serve config back. Only then does it read *open*.
3. Once *open*, the tab shows the address in mono with a copy button and a QR code.
4. On the phone, with the Tailscale app signed in to the same tailnet, open the address and sign in
   to Agentry with the token once.
5. **Close tunnel** takes the name off the allowlist, then removes the rule. When the page you are on
   came through the tunnel itself, it asks first, and answers before the rule goes.

**Open the tunnel when Agentry starts** is a switch on the same tab, off by default, kept in
`tunnel-settings.json` in the data directory.

| State | Word on the tab | Colour | What is happening |
| --- | --- | --- | --- |
| `stopped` | closed | idle | No rule of Agentry's |
| `starting` | opening | warn | Reading the Serve config and adding the rule |
| `verifying` | checking | warn | Reading the Serve config back |
| `active` | open | ok | The rule holds, and the node's exact name is on the allowlist |
| `stopping` | closing | warn | The name left the allowlist; the rule is being removed |
| `failed` | failed | bad | Gave up, with a reason |

While active, Agentry reads Tailscale and the Serve config again every 30 s. A rule removed or
changed in a terminal (`tailscale serve reset`) fails the tunnel with `tunnel.ruleRemoved` at once;
Tailscale not ready in two readings in a row fails it with that reason. A node renamed in the admin
console moves the allowed name and the address with it. There is no reconnect loop: Tailscale keeps
its own connection, and a failed tunnel is opened again with the button.

## Only what Agentry added

Serve config is global to the node, and the person may have rules of their own. So:

- **A port of its own.** The rule lives on `AGENTRY_TUNNEL_PORT`, `8443` by default, and never on
  `443`, which `tailscale serve` uses when no port is named. A port number that is not 1 to 65535
  stops Agentry at startup.
- **A port that is not free is left alone.** Agentry's rule has one shape: an HTTPS listener on the
  port with one `/` handler proxying to this server. If the port holds anything (another target, a
  path beside `/`, a TCP forwarder, a foreground `tailscale serve`), the start fails with
  `tunnel.portTaken`. Even a rule of exactly Agentry's shape is not adopted unless Agentry recorded
  adding it.
- **Recorded before it is added.** `<dataDir>/tunnel/serve-rule.json` (mode 600) holds the port, the
  name and the target, written before `serve --bg` runs.
- **Removed only while it is still exactly that.** On stop, on shutdown (synchronously, as the
  process leaves), and when the tunnel fails, Agentry reads the config and runs
  `serve --https=<port> off` only if the port still holds its rule. A port someone else took over
  drops the record and keeps their rule. `off` on a missing handler answers "handler does not exist"
  (measured), which counts as gone.
- **Reconciled after a crash.** A background Serve rule outlives the process that added it, so a
  record found when Agentry starts is reconciled the same way before anything else, including "start
  with Agentry". A second Agentry on the same machine (a dev server beside the desktop app) gets
  `tunnel.portTaken` rather than taking the first one's rule; give it another `AGENTRY_TUNNEL_PORT`.

## What has to hold before a byte crosses

- **No tunnel without authentication.** `POST /api/tunnel/start` answers `409` under `mode: none`.
  Switching the mode to `none` stops the tunnel first, before the change is saved.
- **Only the node's exact name is let in, and only while the rule holds.** It joins the runtime
  allowlist ([layered-settings.md](layered-settings.md)) once the rule reads back, and leaves on stop,
  on failure and on shutdown. A pattern such as `*.ts.net` is never added.
- **No verification through the tailnet name.** The localhost.run tunnel asked `GET /api/health`
  through its public address. Reading the Serve config back proves the rule is in place and points at
  this server, without depending on MagicDNS resolving on this machine (`--accept-dns=false` is
  common on servers) or on a node reaching its own Serve listener, which could not be measured here.
- **The security history records it.** The name joining and leaving the allowlist, and every start
  or stop Agentry does on its own, are audit rows.

## Who sees what

- **Tailscale encrypts end to end**, and TLS is terminated by tailscaled on this machine with a
  certificate for the node's name, so no relay reads the requests. The bearer token and the five
  `?token=` URLs stay between the phone and this machine.
- **The tailnet is the audience.** Every device the tailnet's access rules let reach this node can
  reach the address; the token is still required.
- **No trusted client address.** Serve sets `Tailscale-User-Login` and friends for tailnet users,
  documented as replacing a client's own copies. Whether it also sets `X-Forwarded-For`, and whether a
  client could forge it, could not be measured (the test machine's user is not the node's operator),
  so no header is trusted: every request through the tunnel shares one failed-login bucket, apart
  from loopback. A guess from another tailnet device can make your phone wait for up to a minute,
  never the desk.

## The address

The address is the node's MagicDNS name, which does not change while the machine keeps its name, so
an installed app, its push subscription and the token stored for that origin keep working from one
start to the next. The certificate is real (Let's Encrypt, through Tailscale), so the browser gives
the PWA a service worker and push.

It moves only when the machine is renamed or `AGENTRY_TUNNEL_PORT` changes. Each push carries the
current address (`PushPayload.url`), and the worker of an install made on an older `*.ts.net` origin
follows it to the new one (`TUNNEL_SUFFIX` in `apps/web/public/sw.js`), as it did for localhost.run's
changing names; an install at the desk or on the LAN keeps its own origin. The phone signs in again
on a new origin.

## Webhooks

The tunnel is no longer a public origin: a code host on the internet cannot deliver to a tailnet
address. Registering a hook answers `no-public-url`, polling carries the pull requests, and `Core`
no longer re-points hooks on `tunnel.changed`, so a hook is never moved to a tailnet name
([code-hosts.md](code-hosts.md#events-and-paced-polling), [deploy.md](deploy.md#webhooks-and-the-public-address)).
Funnel would give one, and is left out on purpose (owner decision, 2026-10-06).

## Where it is available

| Install | Default | Turn it on or off |
| --- | --- | --- |
| Source checkout | on | `AGENTRY_TUNNEL=off` |
| Desktop app | on (Tailscale installed separately; not a `.deb` dependency) | `AGENTRY_TUNNEL=off` |
| Docker image | **off** | `AGENTRY_TUNNEL=on` in `.env` |
| Helm chart | **off** | `tunnel.enabled: true` |

In a container the host's `tailscale` CLI and `tailscaled` are not visible, so turned on with
nothing else the tab says Tailscale is not installed; and once it opens, the rule goes around the
published port, the proxy and the Ingress. [deploy.md](deploy.md#the-tunnel-in-docker) has the
details. `AGENTRY_TUNNEL` accepts `on`, `1`, `true`, `off`, `0` and `false`; empty or unset means the
default, and any other value stops Agentry at startup. `TAILSCALE_BIN` points at another CLI (the
macOS app keeps it inside the bundle).

## Where things live

| What | Path |
| --- | --- |
| The rule Agentry added, while it exists | `<dataDir>/tunnel/serve-rule.json` |
| "Open the tunnel when Agentry starts" | `<dataDir>/tunnel-settings.json` |
| The node's name on the allowlist | memory only, never a file |
| The code | `packages/core/src/tunnel.ts`, `apps/api/src/routes/tunnel.ts`, `apps/web/src/pages/config/RemoteAccessTab.tsx` |
| The fake CLI the tests and the e2e suite use | `packages/core/test/fixtures/fake-tailscale.mjs` |

## API

`GET /api/tunnel` returns the state, `url` and `since` (only while `active`), `reason` (only while
`failed`), `enabled`, `tailscale` (`state`, `version`, `host`, `reason`), `port` and the settings.
`PUT /api/tunnel/settings` takes `{ startWithAgentry }`, and `POST /api/tunnel/start` and
`POST /api/tunnel/stop` open and close the tunnel. A stop that arrives through the tunnel itself
answers first, with `state: 'stopping'`, and removes the rule a second after the reply is sent.
Every move emits `tunnel.changed` on `/api/events`, carrying the whole status; the event's title
never contains the address, and it never becomes a notification. The rows are in the README's
[Remote access](../README.md#remote-access) table.

## Related

[[plans/tunnel.md]] · [[code-hosts.md]] · [[layered-settings.md]] · [[deploy.md]] · [[desktop.md]] · [[notifications.md]] · [[plans/mobile.md]] · [[providers.md]] · [[security-model]]
