# Security policy

## Read this before you deploy anything

Agentry is not hardened yet, and pretending otherwise would be the real vulnerability. As it
stands today:

- **The API has no authentication.** Every route is open to whoever can reach the port.
- **Runs default to `bypassPermissions` inside the container**, so a run does what it is asked
  without prompting.
- **`GET /config/mcp` returns MCP server definitions verbatim**, including env vars and headers,
  which is where people keep API keys.
- **Account credentials live in the data volume** and the API can write them.

Anyone who reaches the port can start a Claude Code run on your account, read every transcript on
the machine and edit the files the container can see.

**Bind it to localhost. Do not expose it to a network you do not control, and do not put it behind
a plain reverse proxy and call it done.** The authentication layer, the secret redaction and the
audit log are the first block of [ROADMAP.md](ROADMAP.md) for exactly this reason.

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
above, it will be closed as a duplicate of the roadmap — that is not a dismissal of the report,
just an acknowledgement that the gap is already on the record.
