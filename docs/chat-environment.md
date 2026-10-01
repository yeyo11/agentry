---
created_at: 2026-09-27T12:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - chats
    - api
    - desktop
    - decision
    - fix
    - security
---
# A chat knows which wrapper runs it

Every chat Agentry starts gets these variables in its environment:

- `AGENTRY_API_URL`: the REST API of the wrapper that spawned it, with the real port it bound (for
  example `http://127.0.0.1:34331/api`). `startServer` sets it on the runtime once it listens.
- `AGENTRY_CHAT_ID`: the chat's own id.
- `AGENTRY_API_TOKEN`: a credential of the chat's own for that API, minted for each process (each
  turn) whenever `AGENTRY_API_URL` is set. Send it as `Authorization: Bearer $AGENTRY_API_TOKEN`.
  Under `mode: none` nothing reads it.

## Why

On one machine there are often two wrappers: the desktop app (loopback, a port it keeps between
launches, data in `~/.config/Agentry/data`) and a dev server from a checkout (`8787`, data in the
checkout's `data/`). A chat in the desktop app asked to launch an orchestration called
`localhost:8787` from habit. The orchestration ran, on the dev server, and never appeared in the
app the person was looking at. Nothing told the agent where its own wrapper was.

## Decisions

- **The address comes from the listening server, not from config.** A port asked for is only a
  preference (`listenOn` falls back to a free one), so only the bound address is right.
- **An inherited value is removed.** A wrapper started from a chat of another wrapper inherits that
  chat's `AGENTRY_API_URL`. Its own chats must not see it: before the API listens, they get none.
- **The chat gets its own token, never the owner's** (CW-10, replacing "no credential is passed").
  With the guard on, a chat with a URL and no credential got `401` on every call, and one had to read
  `wrapper.db` to diagnose the board. Handing it the owner's token would widen what a prompt
  injection reaches, so `spawnProcess` mints a fresh token per process instead
  (`packages/core/src/security/chat-tokens.ts`):
  - 32 random bytes in base64url with the prefix `agc_`, held in memory only as its SHA-256 beside
    the chat id, the process and the mint time; never in `auth.json`, SQLite or a log.
  - Revoked when its own process exits or fails to spawn (keyed by that process's token, so a late
    exit of an earlier process leaves the current one alone), on `stopAll`, on a restart by
    construction, and after `CHAT_TOKEN_MAX_AGE_MS` (24 h) at most.
  - Accepted in `token` and `oidc` modes only from a loopback peer, on a loopback `Host`, with no
    `Forwarded`, `X-Forwarded-For` or tunnel client-IP header: the tunnel arrives from 127.0.0.1 too.
    Anything else answers the same `401` as a wrong token and counts toward the wait.
  - It cannot administer the guard: `PUT /api/security/auth`, `POST|DELETE /api/security/token`,
    `POST /api/tunnel/start` and `PUT /api/tunnel/settings` answer `403`. Read-only and the host
    allowlist apply as to the owner.
  - Writes are audited as `chat:<chatId>`.
  - An inherited `AGENTRY_API_TOKEN` is always removed, like the URL: it is another wrapper's.
  - MCP servers the CLI starts inherit it, which is how the assistant's server calls the API. Agentry's
    own server (`agentry`) is given it in its config file as `${AGENTRY_API_TOKEN}`, expanded by the CLI
    ([agentry-mcp-server.md](plans/agentry-mcp-server.md)).

  The full specification is [chat-api-token.md](plans/chat-api-token.md); the decision is §2 of
  [flow-start-and-chat-token.md](plans/flow-start-and-chat-token.md).
- **Nothing is added to the system prompt.** The variable is there for whoever looks. This repo's
  `CLAUDE.md` tells agents to use it; other projects do not call Agentry's API.

Related: [[desktop]], [[pinned-chat-rotation]], [[plans/chat-api-token.md]], [[plans/flow-start-and-chat-token.md]].
