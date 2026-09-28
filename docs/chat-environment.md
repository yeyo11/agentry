---
created_at: 2026-09-27T12:00:00Z
updated_at: 2026-09-27T12:00:00Z
tags:
    - chats
    - api
    - desktop
    - decision
    - fix
---
# A chat knows which wrapper runs it

Every chat Agentry starts gets two variables in its environment:

- `AGENTRY_API_URL`: the REST API of the wrapper that spawned it, with the real port it bound (for
  example `http://127.0.0.1:34331/api`). `startServer` sets it on the runtime once it listens.
- `AGENTRY_CHAT_ID`: the chat's own id.

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
- **No credential is passed.** Only the hash of the token is stored, and handing the admin token to
  every agent would widen what a prompt injection can reach. With authentication on, an agent that
  needs the API is given a token by the person.
- **Nothing is added to the system prompt.** The variable is there for whoever looks. This repo's
  `CLAUDE.md` tells agents to use it; other projects do not call Agentry's API.

Related: [[desktop]], [[pinned-chat-rotation]].
