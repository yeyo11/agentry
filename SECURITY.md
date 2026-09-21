# Security policy

## Read this before you deploy anything

Agentry can now guard the API, but it starts with the guard **off**, and turning it on is your job.
What is and is not protected:

**Protected once you turn it on** (Settings → Security, or `AGENTRY_AUTH_MODE` on a fresh install):

- **Authentication in front of every route.** `token` needs `Authorization: Bearer …` and stores only
  the SHA-256 of the token; `oidc` needs a JWT the issuer's JWKS validates, with the right `aud` and an
  unexpired `exp`. Only `GET /api/health` and the built UI bundle stay open. `/docs` and
  `/openapi.json` are guarded.
- **Read-only mode**, which refuses every write except answering a permission prompt.
- **Secrets in MCP `env` and `headers`** (and in settings' `env`) are not returned by the API: a
  placeholder stands for the value.
- **An audit log of writes**: who, what route, the status. Never the body.

**Not protected, and still true with everything on:**

- **Authentication is off by default.** With `mode: none`, every route is open to whoever can reach the
  port: they can start a Claude Code chat on your account, read every transcript on the machine and
  edit the files the container can see.
- **Agentry does not terminate TLS.** A token sent over plain HTTP can be read on the way. Put a
  TLS-terminating proxy in front (`docker compose --profile tls`, or the Helm chart behind your own
  ingress) and see [docs/deploy.md](docs/deploy.md) for what it must pass.
- **The token can travel in a query string** on three GETs a browser makes without headers
  (`/api/events`, `/api/chats/:id/stream`, `/api/uploads/:id/content`), so a proxy's access log may
  record it.
- **There is one credential.** Everyone who holds the token is the same user; nothing isolates one
  person's chats from another's. OIDC validates a JWT, it does not sign anyone in.
- **Chats default to `bypassPermissions` inside the container**, so a chat does what it is asked
  without prompting. The container is the sandbox.
- **Account credentials live in the data volume**, and the API can write them.
- **Per-chat MCP config files hold a server's real `env` and `headers`.** They are mode 600 in a
  mode 700 directory of the data volume.

**Bind it to localhost until the guard and a TLS proxy are both in place.**

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
