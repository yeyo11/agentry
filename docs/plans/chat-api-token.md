---
created_at: 2026-09-28T21:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - plan
    - spec
    - security
    - chats
    - api
    - built
---
# Spec: a chat Agentry starts gets its own API token (CW-10)

Status: **built** (CW-10). Under `mode: none` the actor stays `local` even with a chat token; the
CW-17 amendment below is not part of this change. This spec builds section 2 of
[flow-start-and-chat-token.md](flow-start-and-chat-token.md), which records the owner's decision
(option A, 2026-09-28). The decision is not reopened here. This document turns it into something a
developer can build without asking.

## Why

Every chat gets `AGENTRY_API_URL` and `AGENTRY_CHAT_ID` ([chat-environment.md](../chat-environment.md)).
When the API is guarded (the desktop app is set up for the tunnel, so it runs in `token` mode), the
chat has no credential and every call answers `401`. On 2026-09-28 a chat had to open `wrapper.db`
read-only to diagnose the board. The Agentry assistant's MCP server
([agentry-assistant.md](agentry-assistant.md)) will need the same credential.

`chat-environment.md` currently says "No credential is passed". This change replaces that decision
with a narrower one: the chat never gets the owner's token. It gets its own token, scoped to one
process and to loopback.

## The one rule

This change stays inside Agentry. It adds an environment variable to the `claude` process that
Agentry already spawns. It uses no SDK and makes no call to Anthropic.

## Where it lives

| Piece | File |
|---|---|
| The chat-token store (mint, verify, revoke, revoke all) | new `packages/core/src/security/chat-tokens.ts`, owned by the `AuthStore` or next to it on `core.security` |
| Minting at spawn, and revoking when the process exits | `packages/core/src/chats.ts`, `spawnProcess` (the only place a CLI process starts) |
| Accepting the token: loopback check, actor, admin routes refused | `apps/api/src/security.ts`, the `onRequest` hook |
| The documented actor format | `packages/shared/src/types.ts`, the `AuditEntry.actor` doc comment (comment only, no shape change) |
| Docs | `docs/chat-environment.md`, `SECURITY.md` |

No route is added or changed, so no OpenAPI schema, `routes.ts` entry or README row is needed. If the
developer does change a shared type, the usual CI rules apply (see the acceptance criteria).

## Behaviour

### Minting

- `spawnProcess` mints a fresh token **every time it spawns a process**, and puts it in the child's
  environment as `AGENTRY_API_TOKEN`, next to `AGENTRY_API_URL`. A chat that runs several turns
  (one process per turn) gets a new token each turn.
- The token is minted **whatever the current mode**. Minting is cheap. If the owner switches the mode
  from `none` to `token` while a turn is running, that turn still holds a working credential. Under
  `mode: none` the guard never reads the token, so behaviour there is unchanged.
- The token is 32 random bytes, encoded as base64url (the same as `AuthStore.setToken`). Give it a
  recognisable prefix, for example `agc_`, so a leaked one can be recognised in a log.
- The token is added only when the runtime knows its API URL (`this.apiUrl`). Without a URL the
  token is useless.
- An inherited `AGENTRY_API_TOKEN` is always removed first, the same way `AGENTRY_API_URL` is. Its
  own chats must never see the token of a wrapper that was started from another wrapper's chat.
- MCP servers that the CLI starts inherit the CLI's environment. That is how the assistant's MCP
  server will get the token. Nothing extra is needed for this.

### Storage

- The token is kept **in memory only**, as its SHA-256 hash, together with the chat id, the process
  it belongs to, and the time it was minted. It is never written to `auth.json`, SQLite or a log. So
  a restart of the wrapper revokes every chat token by construction.
- Verification compares digests with `timingSafeEqual`, like `sameSecret` in `auth.ts`.

### Lifetime and revocation

- The token is revoked when **its** process ends: on `exit` or `error`, whichever comes first.
  Revocation is keyed by that process's token, not by the chat. A late `exit` from an earlier process
  must not revoke the token of the chat's current process. The same rule already guards the chat's
  status (`current()` in `spawnProcess`).
- If `spawn` throws, the token minted for it is revoked immediately.
- `stopAll()` (the wrapper shutting down) revokes every chat token.
- Every token also has a hard maximum age of **24 hours**. After that it is refused even if its
  process is still alive. This covers a process whose `exit` event was lost. It is also what "short-lived" means in
  the decision, since one turn normally ends long before that. Put the value in a named constant.

### Accepting the token

In `onRequest`, when the mode is not `none` and the presented credential is not the owner's (or OIDC
does not validate it), the guard tries the chat-token store. A chat token is accepted only when
**all** of these hold:

1. **The peer is loopback.** `req.socket.remoteAddress` matches `LOOPBACK`. Fastify does not trust
   `X-Forwarded-For` (SECURITY.md), so `req.ip` is the peer too. Read the socket anyway, so that a
   future `trustProxy` cannot widen this check.
2. **The authority dialled is loopback.** `hostNameOf(req.headers.host)` is `localhost`, `::1` or
   `127.x.x.x`. A request with no `Host` fails this check, and so does a request on a runtime host
   (the tunnel) or on an `AGENTRY_ALLOWED_HOSTS` name. **This condition is required:** tunnel
   traffic arrives from `127.0.0.1` (`ssh -R 80:127.0.0.1:<port>`, [tunnel.md](../tunnel.md)), so
   the peer check alone would accept a leaked chat token from the internet.
3. **No forwarding header is present.** The request has no `Forwarded`, no `X-Forwarded-For`, and no
   `clientIpHeader` of any runtime host. A local reverse proxy on loopback that forwards outside
   traffic is not a chat.
4. The token's hash is in the store, and the token has not expired.

If any condition fails, the answer is exactly the same `401` the owner's wrong token gets (same body,
same `WWW-Authenticate`), and it counts in `FailureBackoff`. A caller must not be able to tell "good
chat token, wrong address" apart from "bad token".

The chat token is honoured in **both guarded modes, `token` and `oidc`**. The decision names `token`
mode because that is the owner's setup. The problem it solves (a chat with a URL but no credential)
is the same under OIDC, and the loopback rules make the token no wider there. If the owner wants
`token` mode only, the change is a single condition.

### What a chat token can do

- The same routes as the owner's token, with read-only mode still applied, **except administration
  of the guard itself.** A chat token gets `403 {"error":"a chat's token cannot change the API's
  authentication"}` on `PUT /api/security/auth`, `POST /api/security/token`,
  `DELETE /api/security/token`, `POST /api/tunnel/start` and `PUT /api/tunnel/settings`. Without this
  rule, a prompt injection could rotate the owner's token, switch the guard off, or open the tunnel.
  `POST /api/tunnel/stop` stays allowed, because stopping only reduces exposure.
- `GET` on the query-string routes (`?token=`) accepts a chat token under the same loopback rules.
  No other change is made there.

### Attribution

- `req.actor` is `chat:<chatId>` (the chat's id, which the process also sees as `AGENTRY_CHAT_ID`).
  The existing `onResponse` hook writes it to the audit log unchanged, so every write names the chat
  that made it.
- The owner's actor stays `token:<tokenId>` or the OIDC subject. `local` under `mode: none` is also
  unchanged, even when a chat presents its token. Open mode behaves exactly as before.
- **Amended by CW-17** ([assistant-write-tools.md](assistant-write-tools.md), "Attribution"): under
  `mode: none`, a chat token that is presented and valid sets `chat:<chatId>`, as a label only. This
  keeps the assistant's writes attributed when the guard is off. It never answers `401` and grants
  nothing.

### Unchanged

- Owner token: minting, rotation, `AGENTRY_AUTH_TOKEN_RESET`, the `401`/`429` answers, and the
  `WWW-Authenticate` header.
- `mode: none`: no guard, actor `local`, and no chat-token code on the request path.
- Host allowlist (`421`) and read-only (`405`). Both run for chat tokens exactly as they do for the
  owner's.
- The UI: no screen changes. The audit table already shows `actor` as text.

## Tests

- **Core** (`packages/core/test/chats.test.ts`, following the existing `AGENTRY_CHAT_ID|AGENTRY_API_URL`
  fake-CLI test):
  - The child sees a non-empty `AGENTRY_API_TOKEN`.
  - An inherited `AGENTRY_API_TOKEN` in `process.env` is replaced, never passed through.
  - Two turns get two different tokens.
  - The token verifies while the process lives, and is refused after `exit`.
  - A late exit from an earlier process leaves the current token valid.
  - `stopAll` revokes all tokens.
  - An expired token is refused (use an injectable clock).
- **Store unit test:** only a hash is held (no field equals the token), and a new store (restart)
  knows no token.
- **API** (`apps/api/test/security.test.ts`, with `inject`, whose `remoteAddress` can be set):
  - In `token` mode, a chat token opens a guarded GET and a write from `127.0.0.1` with
    `Host: 127.0.0.1:<port>`, and the audit row's actor is `chat:<id>`.
  - It gets `401` from a non-loopback `remoteAddress`, from loopback with a runtime (tunnel) `Host`,
    from loopback with an `X-Forwarded-For`, after revocation, and after a new store.
  - It gets `403` on each administration route listed above.
  - The same passes in `oidc` mode.
  - The owner's token and `mode: none` answer and audit exactly as before. The existing tests stay
    green without edits.

The e2e suite is not required: no screen changes.

## Docs

- `docs/chat-environment.md`: add `AGENTRY_API_TOKEN` to the list. Replace "No credential is passed"
  with the new decision (own token per process, loopback only, revoked at exit and restart, cannot
  administer the guard, audited as `chat:<id>`), and link this spec and the plan.
- `SECURITY.md`: under "Protected once you turn it on", describe chat tokens and their limits. Under
  "Not protected", add that a process on the machine that can read a chat's environment
  (`/proc/<pid>/environ` as the same user) can use that chat's token from loopback while the chat
  runs. This is the same boundary as `mode: none` for a local user, and it is narrower in time.
- `CLAUDE.md` of this repo: the sentence about `AGENTRY_API_URL` should add "with
  `Authorization: Bearer $AGENTRY_API_TOKEN` when it is set".

## Out of scope

- A UI for listing or revoking chat tokens.
- Per-route scopes finer than "everything except administering the guard".
- Tokens for processes Agentry does not spawn through `spawnProcess`.

## Related

[[plans/flow-start-and-chat-token.md]] · [[chat-environment.md]] · [[plans/agentry-assistant.md]] · [[tunnel.md]] · [[deploy.md]]
