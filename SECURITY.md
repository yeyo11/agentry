# Security policy

## Read this before you deploy anything

Agentry can now guard the API, but it starts with the guard **off**, and turning it on is your job.
What is and is not protected:

**On by default, whether or not the guard is on:**

- **It listens on `127.0.0.1`.** `HOST` is how you widen that, and widening it is meant to be a
  deliberate act; the image sets `HOST=0.0.0.0` because Compose publishes the container on loopback
  anyway. A bind to every interface while the mode is `none` logs a warning once the server is up.
- **An authority this wrapper does not answer to is refused `421`**, before the credential is even
  looked at — so it holds under `mode: none`, where there is no credential to refuse by. Loopback
  always passes (`localhost`, `::1`, any `127.x.x.x`); `AGENTRY_ALLOWED_HOSTS` is the comma-separated
  list of whatever else a deployment answers to, compared without the port and case-insensitively.
  An entry may be a `*.domain` pattern, which stands for that domain's subdomains and not for the
  domain itself — what a tunnel or a per-branch environment needs, since its host is new every time.
  This is what stands between the API and a page on someone else's domain that rebinds its own name
  to `127.0.0.1` and then drives Agentry from the browser of whoever visited it. `GET /api/health`
  stays open regardless, so a probe is unaffected, and a request carrying no `Host` at all passes:
  HTTP/1.1 requires one and every browser sends one, so it cannot be the rebinding case.
- **The configuration explorer hides the credentials by path, not by the kind of scope.**
  `.credentials.json`, `.claude.json` and the transcripts are refused whenever the root being read
  resolves to the CLI's own configuration directory — symlinks included. It used to depend on the
  scope being `user`, so importing `$HOME` as a project made `$HOME/.claude` a project root and
  `GET /config/files` handed out the account credential. A directory that is or contains the
  configuration directory can no longer be imported as a project at all.
- **`credentials.json` and `auth.json` are mode 600 from the instant they exist**: the mode is given
  to the temporary file that is renamed into place, instead of being applied after the fact, so
  there is no moment where they are world-readable.
- **The UI bundle is served unframeable and unsniffable**, under a Content-Security-Policy that names
  the hash of its one inline script (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, `object-src 'none'`, `connect-src 'self'`).
  `style-src` keeps `'unsafe-inline'`, deliberately: Vite's build hands out no nonce and the UI styles
  from React.
- **A failure nobody meant to return says nothing about this machine.** An error that is not a
  deliberate refusal answers `500 {"error":"internal error"}` and goes to the log with its URL, so a
  stray `ENOENT` no longer tells a stranger where the configuration directory is. Deliberate
  refusals keep their 4xx and their own words.
- **Who may read this API from a browser is decided in one place** (`AGENTRY_CORS_ORIGIN`), the event
  streams included. Setting that variable to anything used to make `/api/events` and
  `/api/chats/:id/stream` answer *any* origin; they now go through the same allowlist as every other
  route.

**Protected once you turn it on** (Settings → Security, or `AGENTRY_AUTH_MODE` on a fresh install):

- **Authentication in front of every route.** `token` needs `Authorization: Bearer …` and stores only
  the SHA-256 of the token; `oidc` needs a JWT the issuer's JWKS validates, with the right `aud` and an
  unexpired `exp`. A configured `oidc.clientId` (`AGENTRY_OIDC_CLIENT_ID`) is now applied rather than
  merely stored: a token whose `azp` names another client is refused. A token that carries no `azp` is
  still accepted — OIDC Core 1.0 §3.1.3.7 only requires the claim when the authorized party differs
  from the audience, and demanding it would lock out the issuers that omit it. Only `GET /api/health`
  and the built UI bundle stay open. `/docs` and `/openapi.json` are guarded.
- **Guessing the token is slowed down.** Ten failed authentications from a client address are free;
  after that the answer is `429` with a `Retry-After` that doubles from one second to a minute, and an
  address that stops failing is forgotten after fifteen quiet minutes. A token you choose yourself
  must now be at least 24 characters — that minimum and this wait are halves of the same defence. A
  token Agentry generates is 32 random bytes and was never in reach of guessing.
- **Read-only mode**, which refuses every write except answering a permission prompt of **the chat in
  the path**: a request id belonging to another chat answers `404`, identically to one that never
  existed. Read-only lets someone unblock the chat they are watching, and nothing else.
- **Secrets in MCP `env` and `headers`** (and in settings' `env`) are not returned by the API: a
  placeholder stands for the value.
- **An audit log of writes**: who, what route, the status. Never the body. It can be narrowed by path (matched literally: `%` and `_` are not wildcards), method and status code or class.

**Not protected, and still true with everything on:**

- **Authentication is off by default.** With `mode: none`, every route is open to whoever can reach the
  port under an authority it answers to — on a default install, anyone with an account on the machine:
  they can start a Claude Code chat on your account, read every transcript on the machine and
  edit the files the container can see.
- **The Host allowlist only stops a browser.** Anything that sets its own `Host` header — `curl`, a
  script, a port scanner that guesses the name — walks straight past it. It closes DNS rebinding,
  which is the one case where the attacker cannot choose the header; it is not access control, and it
  is no reason to publish the port.
- **Agentry does not terminate TLS.** A token sent over plain HTTP can be read on the way. Put a
  TLS-terminating proxy in front (`docker compose --profile tls`, or the Helm chart behind your own
  ingress) and see [docs/deploy.md](docs/deploy.md) for what it must pass — including the `Host` the
  allowlist above now reads.
- **Behind a proxy, the failed-authentication wait is shared.** The address it counts is the peer's,
  and Fastify is not configured to trust `X-Forwarded-For`, so every request arriving through a
  reverse proxy counts as the same client: someone guessing through that proxy can make it answer
  `429` to everyone else for up to a minute. The cap is what keeps that to a minute rather than a
  lockout, and it is why the wait is not a substitute for a long token.
- **The token can travel in a query string** on the five GETs a browser makes without headers
  (`/api/events`, `/api/chats/:id/stream`, `/api/uploads/:id/content`, `/api/chats/:id/export` and
  `/api/projects/:id/export`), so a proxy's access log may record it.
- **There is one credential.** Everyone who holds the token is the same user; nothing isolates one
  person's chats from another's. OIDC validates a JWT, it does not sign anyone in.
- **Chats default to `bypassPermissions` inside the container**, so a chat does what it is asked
  without prompting. The container is the sandbox.
- **Account credentials live in the data volume**, and the API can write them.
- **Per-chat MCP config files hold a server's real `env` and `headers`.** They are mode 600 in a
  mode 700 directory of the data volume.
- **A refusal raised deep in the core can still name a file.** The error handler returns the text of a
  deliberate 4xx unchanged, and some of those texts are built from a path — a malformed settings file
  answers `400` with the path it could not parse. It takes an authenticated caller to see one.

**It binds to localhost. Leave it there until the guard and a TLS proxy are both in place**, and when
you do move it, name the host it will be reached by in `AGENTRY_ALLOWED_HOSTS` — otherwise every
request through the proxy answers `421`.

**Lost the token?** The environment seeds only a fresh install, so setting `AGENTRY_AUTH_TOKEN` again
does nothing by itself. Set it to a new value together with `AGENTRY_AUTH_TOKEN_RESET=1` and restart:
the new token replaces the stored hash, and the audit log records the change with actor `env`. The
mode, OIDC settings and read-only stay as they were. The hash of the value applied is kept, so a
restart with the variables still set changes nothing and a token rotated afterwards survives; set a
different value to reset again. With access to the data volume, deleting `auth.json` also works, but
it resets the whole guard to the environment's seed.

## Supported versions

The project is pre-1.0 and moves on `main`. Fixes land there; there are no backported releases.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/yeyo11/agentry/security/advisories/new). Please do
not open a public issue for something exploitable.

Useful reports say what an attacker gains, how they reach it, and what you already had to have
(network access, a valid account, a file on disk). A proof of concept helps; a working exploit
against someone else's deployment does not.

Expect a first reply within a week. If a report turns out to describe one of the known gaps listed
above, it will be closed as a duplicate — that is not a dismissal of the report, just an
acknowledgement that the gap is already on the record.
