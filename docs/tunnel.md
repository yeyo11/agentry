---
created_at: 2026-09-27T18:00:00Z
updated_at: 2026-10-02T18:00:00Z
tags:
    - tunnel
    - remote-access
    - security
    - mobile
    - operations
---
# Remote access through a tunnel

Settings → **Remote access** opens a public HTTPS address for this Agentry, so a phone or a laptop on
another network can reach it. The address is shown with a QR code, and the tunnel is closed again
from the same place. It needs no VPS, no domain, no proxy, no account and nothing new to install. The
tunnel goes through [localhost.run](https://localhost.run), over the system's own `ssh`:

```
ssh -R 80:127.0.0.1:<port> nokey@localhost.run
```

`nokey@` is localhost.run's anonymous user. Why this provider and not Cloudflare, Pinggy, Tailscale
or ngrok, and how the candidates were measured, is in [the plan](plans/tunnel.md#one-provider-and-why-this-one).
Mainly, localhost.run streams a `GET`, and the web's event streams are `EventSource`, which can
only `GET`.

The tunnel does not touch Claude Code. It forwards HTTP to Agentry's own port, so the
one rule (the CLI only) is not involved.

## Using it

1. **Turn on authentication first** (Settings → Security: a token or OIDC). While the mode is
   `none`, the tab shows a warning with a link to Security instead of the button. Without a
   credential, whoever has the address would own the machine.
2. Press **Open tunnel**. The state reads *opening* while ssh waits for an address, then *checking*
   while Agentry makes sure it answers through that address. Only then does it read *open*.
3. Once *open*, the tab shows the address in mono with a copy button, a QR code to scan with the
   phone's camera, and how long ago this address started working.
4. On the phone, open the address and sign in with the token. It is a new site for the browser, so
   it has no token yet (see [The address changes](#the-address-changes)).
5. **Close tunnel** takes the address off the allowlist, then ends ssh. When the page you are on
   came through the tunnel itself, it asks first, because closing the tunnel ends that page too.
   Once closed, that page says the tunnel is closed and its address no longer works, instead of
   reporting the dropped connection as an error.

**Open the tunnel when Agentry starts** is a switch on the same tab, off by default. It still needs
authentication on and ssh installed. It is kept in `tunnel-settings.json` in the data directory.

| State | Word on the tab | Colour | What is happening |
| --- | --- | --- | --- |
| `stopped` | closed | idle | No ssh running |
| `starting` | opening | warn | ssh is connecting, or reconnecting after a drop |
| `verifying` | checking | warn | An address arrived; Agentry asks `GET /api/health` through it |
| `active` | open | ok | The address answers, and its exact host is on the allowlist |
| `stopping` | closing | warn | The host left the allowlist; ssh is ending |
| `failed` | failed | bad | Gave up, with a reason (below) |

A dropped connection reconnects on its own, waiting 1, 2, 5, 10 and then 30 s between attempts, and
shows as *opening* meanwhile. After six attempts in a row that never reach *open*, the tunnel is
`failed`, with the last attempt's reason.
Verifying gives up after 60 s. The tunnel dies with Agentry: its ssh is killed on shutdown, and an
orphan left by a crash is killed on the next start, but only if its command line names Agentry's own
`known_hosts`, so a process that later reused the PID is left alone.

### Why it failed

The reason carries a `code`, and the tab shows it translated:

| Code | Meaning |
| --- | --- |
| `tunnel.authRequired` | The auth mode is `none` |
| `tunnel.disabled` | This deploy does not offer the tunnel (`AGENTRY_TUNNEL`, below) |
| `tunnel.noPort` | The server is not listening yet |
| `tunnel.sshMissing` | No `ssh` to run: install `openssh-client`. The tab shows how, with a **Try again** button |
| `tunnel.hostKey` | localhost.run answered with a host key other than the pinned one. Not retried |
| `tunnel.unverified` | An address arrived, but Agentry could not reach itself through it |
| `tunnel.exited` | ssh ended before an address arrived; `detail` says how |

`tunnel.hostKey` means either that localhost.run rotated its key or that something between you and
it is intercepting the connection. Agentry never learns a new key by itself. A release that ships
the new key is the fix, once it has been checked.

## What has to hold before a byte crosses

- **No tunnel without authentication.** `POST /api/tunnel/start` answers `409` under `mode: none`.
  Switching the mode to `none` stops the tunnel first, before the change is saved, so the answer to
  that request already finds it closed. A reconnect that finds the mode at `none` stops instead of
  reconnecting.
- **Only the tunnel's exact host is let in, and only while it answers.** The host joins the runtime
  allowlist (see [layered-settings.md](layered-settings.md)) after `GET /api/health` has answered
  `200` through the public address. That route is open on any host, which is what makes the check
  possible before the host is allowed. The host leaves on stop, on a drop, or when a new address
  replaces it. A pattern such as `*.lhr.life` is never added: it would let in everyone else's
  tunnels too.
- **The provider's host key is pinned.** localhost.run's key
  (`SHA256:pG6qrBxubYfWa1Zadu/V0NUgjEDiBds/7e2xzte/QNM`) ships with Agentry and is written to its
  own `known_hosts` before every attempt, and ssh runs with `StrictHostKeyChecking=yes`. Without the
  pin, a network that intercepts the SSH connection could swap the endpoint and receive every
  request.
- **Your `~/.ssh` is never read.** ssh runs with `-F none`, `BatchMode=yes`, no key, no agent and no
  global `known_hosts`.
- **The security history records it.** A host joining and leaving the allowlist, and every start or
  stop Agentry does on its own ("start with Agentry", authentication turned off), are rows in the
  audit log. A start or stop someone requested is a row like any other request.

## What the provider sees

- **Everything.** localhost.run terminates TLS, so it sees every request and every answer in the
  clear, the bearer token included. The tab says so next to the button. Use the tunnel for your own
  install, and rotate the token if that is a concern afterwards.
- **The token in five URLs.** A browser cannot put a header on an `EventSource`, an `<img>` or a
  download, so the two event streams and three downloads carry `?token=` in the URL, and that URL
  goes through the provider too. Moving the streams to `fetch` with an `Authorization` header is the
  later fix.
- **No real client address.** localhost.run adds no forwarding header at all, and passes a client's
  own `X-Forwarded-For` through untouched, so anyone could forge one. Agentry therefore trusts no
  header. Every request through the tunnel shares one failed-login bucket of its own, apart from
  loopback. Ten wrong guesses by a stranger make the tunnel wait, and never the owner at the desk.
  They can make your phone wait, though, for up to a minute.
- **Your public IP, on its side.** ssh prints a line with the machine's public IP on stderr. Agentry
  never shows that line as a failure reason. Keep it out of anything you paste, too.

## The address changes

The free address (`https://<id>.lhr.life`) changes from time to time, and localhost.run rate-limits
it to keep phishing off its domains. A fixed domain is a paid plan and out of scope. When the
address changes on a connection that stays up, the old host leaves the allowlist, the new one joins
once it answers, and `tunnel.changed` tells every open page.

**For the browser, a new address is a new site**, and that has consequences on a phone:

- **Sign in again**, once per address: the token is stored per origin.
- **An app installed from an old address keeps opening that address.** Its worker, cached shell and
  push subscription belong to the old origin.
- **Notifications follow the current address, on Chrome.** While the tunnel is open, every push
  carries the absolute URL of its page on the current address (`PushPayload.url`). An install made on
  an older `*.lhr.life` address opens that URL when tapped. This was checked in real Chrome (desktop
  and Android behave the same by the spec). **On iOS it is built the same way but not verified**:
  it most likely opens in Safari's in-app browser. The worker only follows the URL from one tunnel
  address to another, so a phone installed on the LAN or at the desk keeps opening its own origin.
  The evidence is in [the plan](plans/tunnel.md#answer-notifications-after-a-domain-change).
- **Duplicates.** If you turn notifications on again at the new address, the phone holds two
  subscriptions and gets each push twice. Remove the old device under Settings → Notifications. The
  server cannot tell that two endpoints are the same phone.
- **A stale address.** The URL in a push is the one current when it was sent. The push service keeps
  a message for up to an hour while the phone is offline, so an address that changed in that window
  is stale. It is also null while no tunnel is open, or while it is reconnecting.
- **A renewal can be lost.** When the browser renews an old install's subscription on its own, the
  worker reports it to the old origin, which no longer answers. Open the current address to
  subscribe again.

## Webhooks

The tunnel's address is what Agentry hands a code host as the place to deliver webhooks
([code-hosts.md](code-hosts.md#events-and-paced-polling)). Registering a GitHub hook is refused
(`no-public-url`) until the tunnel is `active`; the hook's URL is
`<tunnel address>/api/webhooks/github/<registration id>`.

- **The address changes, the hook follows.** On every `tunnel.changed` to a new address Agentry
  re-points the hooks it registered, by id, with no click (owner decision 2). A hook that cannot be
  moved is marked `stale` and retried on the next address; until then polling covers the repository.
  Closing the tunnel does not remove a hook: its deliveries fail at the host until the next
  address, and the pacer's normal reads continue.
- **No bearer token on the receiver.** A browser cannot sign in for a host, so the two receiver paths
  are exempt from the token and checked by signature instead. They are the only paths where
  the tunnel carries a request without a credential of the person's, and they cannot change state.
- **The provider sees the deliveries**, the same as every other request through it. They carry
  repository names and pull request titles, never the secret.

## Where it is available

| Install | Default | Turn it on or off |
| --- | --- | --- |
| Source checkout | on | `AGENTRY_TUNNEL=off` |
| Desktop app | on (the `.deb` depends on `openssh-client`) | `AGENTRY_TUNNEL=off` |
| Docker image | **off** | `AGENTRY_TUNNEL=on` in `.env` |
| Helm chart | **off** | `tunnel.enabled: true` |

In Docker the tunnel goes around everything the operator put in front of the server: the port
Compose publishes only on `127.0.0.1`, the `tls` profile's proxy and its certificate, and in
Kubernetes the Service, the Ingress and any ingress NetworkPolicy. Measured, a container that
published no port at all was reachable from the internet. So the image leaves the choice to the
operator. [deploy.md](deploy.md#the-tunnel-in-docker) has the details, and
[the plan](plans/tunnel.md#answer-the-tunnel-in-docker) has the evidence. Where the tunnel is off,
the tab says so and names the switch instead of offering a button.

`AGENTRY_TUNNEL` accepts `on`, `1`, `true`, `off`, `0` and `false`. Empty or unset means the
default. Any other value stops Agentry at startup, because a typo in the switch that opens a public
address should not be guessed at.

The tunnel needs **outbound TCP 22** to `localhost.run`. A firewall or an egress NetworkPolicy that
blocks it makes every attempt end in `tunnel.exited`. `SSH_BIN` points at another `ssh`.

## Where things live

| What | Path |
| --- | --- |
| The pinned host key | `<dataDir>/tunnel/known_hosts` (mode 600, rewritten before every attempt) |
| The running ssh's PID | `<dataDir>/tunnel/ssh.pid` |
| "Open the tunnel when Agentry starts" | `<dataDir>/tunnel-settings.json` |
| The tunnel's host on the allowlist | memory only, never a file |

## API

`GET /api/tunnel` returns the state, `url` and `since` (only while `active`), `reason` (only while
`failed`), `enabled`, `sshAvailable` and the settings. `PUT /api/tunnel/settings` takes
`{ startWithAgentry }`, and `POST /api/tunnel/start` and `POST /api/tunnel/stop` open and close the
tunnel. A stop that arrives through the tunnel itself answers first, with `state: 'stopping'`, and
ends ssh a second after the reply is sent: the reply travels back through the ssh that the stop
kills, so stopping first would leave the caller with nothing but a dropped connection. Every move emits `tunnel.changed` on `/api/events`, carrying the whole status, so a client
never has to refetch. The event's title never contains the address, and neither event ever becomes
a notification, so an address never ends up on a lock screen or in a push service. The rows are in the
README's [Remote access](../README.md#remote-access) table.

## Related

[[plans/tunnel.md]] · [[code-hosts.md]] · [[layered-settings.md]] · [[deploy.md]] · [[desktop.md]] · [[notifications.md]] · [[plans/mobile.md]] · [[security-model]]
