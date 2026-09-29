---
created_at: 2026-09-29T12:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - decision
    - security
    - authentication
    - desktop
    - tray
    - rate-limiting
---
# Decision: a request without a credential is not a failed authentication

Decided by the owner on 2026-09-29, after the desktop app (0.23.0, `.deb`) locked him out of his own
install.

## What happened

The owner turned `token` mode on from Settings → Security, so `auth.json` held only the token's
hash and `AGENTRY_AUTH_TOKEN` was not in the environment. Three things then met:

1. The desktop tray's `LiveMonitor` only had a bearer token when `AGENTRY_AUTH_TOKEN` was set, so it
   polled `GET /api/events` every 15 s and `GET /api/overview` every 30 s with no credential, and
   `server.log` filled with 401s from `127.0.0.1` (514 and 299 in a morning).
2. The guard's `FailureBackoff` counted every refused request under `req.ip`. On a local install
   every process is `127.0.0.1`, so after ten refusals the owner's authenticated window and his
   chats (`POST /api/chats/:id/resume`) were answered `429 too many failed authentications from
   this address`, for up to a minute, renewed as long as the tray kept polling.
3. Chats Agentry starts get `AGENTRY_API_URL` with no token (work item CW-10, separate), so a chat
   calling the API could do the same.

## The rule

- **Only a presented credential that fails counts** toward the wait: a wrong bearer token, a wrong
  `?token=` on the five routes that read one, an invalid JWT. A request with no credential (or an
  empty bearer) is still answered `401`, but it is neither counted nor made to wait, even from an
  address that is blocked. It cannot get closer to the token by repeating itself, so slowing it
  down protects nothing and only punishes whoever shares its address.
- Everything else stands: a guessing client still waits, a blocked address stays blocked for its
  credentials (the real token included), a credential that works clears the count, `OPTIONS` is
  untouched and the `421` host check still comes first (`apps/api/src/security.ts`).
- **The desktop app authenticates its tray** with a secret of its own: 32 random bytes generated at
  each launch, handed to the server it spawns as `AGENTRY_DESKTOP_TOKEN`. The server keeps its
  SHA-256 in memory only (`AuthStore`, `packages/core/src/security/auth.ts`), compares in constant
  time, accepts it only from a loopback socket dialled on a loopback `Host` (a tunnel or a reverse
  proxy also arrives from `127.0.0.1`, but carries the public name), and deletes the variable from
  `process.env` once read so no chat or command inherits it.
- **The `desktop` actor only reads** (`GET`, `HEAD`; anything else is `403`). The tray needs nothing
  more, and a secret that sits in a second process's memory is kept to the least it needs. Giving it
  the owner's rights was the alternative; it bought nothing the tray uses.
- **The tray backs off when refused**: a `401` or `403` quiets both the feed and the poll for 5
  minutes, doubling up to 30; a `429` waits for `Retry-After`. It logs the first refusal of a spell
  and the recovery, not every attempt (`apps/desktop/src/live-monitor.ts`).

## Why not the alternatives

- **Exempting loopback from the wait** would also exempt the tunnel and any local reverse proxy,
  which all arrive from `127.0.0.1`, and a guesser on the machine.
- **Keying the wait per credential** needs the credential to be known first, and a guesser sends a
  new one every time.
- **Handing the tray the owner's token** means storing it somewhere the app can read, which the
  hash-only design of `auth.json` exists to avoid.

## Related

[[desktop.md]] · [[tunnel.md]] · [[chat-environment.md]]
