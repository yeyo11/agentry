---
created_at: 2026-09-27T18:00:00Z
updated_at: 2026-10-09T10:00:00Z
tags:
    - settings
    - configuration
    - security
    - operations
---
# Settings in layers: what changes without a restart

Three settings used to be read from the environment once, at startup. They can now change while
Agentry runs, from Settings → Security:

| Setting | Variable | Default | Applies to |
| --- | --- | --- | --- |
| `allowedHosts` | `AGENTRY_ALLOWED_HOSTS` (its hosts add to the file's, see below) | none (loopback only) | the next request |
| `maxConcurrentRuns` | `AGENTRY_MAX_CONCURRENT_RUNS` | `8` (1 to 64) | the next chat or orchestration worker |
| `defaultPermissionMode` | `AGENTRY_DEFAULT_PERMISSION_MODE` | `acceptEdits` (`bypassPermissions` in the image) | the next run that does not choose one |
| `setupSeen` | `AGENTRY_SETUP_SEEN` (`on` or `off`; the older `AGENTRY_PROVIDERS_STEP_SEEN` still counts) | `off` | the next start: the setup assistant is shown only while it is off. A `providersStepSeen` stored before the rename counts as `setupSeen` |

## Which value wins

Each setting is read from three layers, in a fixed order:

1. **The environment.** Whoever deployed the install decided it, and the UI must not quietly
   override a deploy. The UI shows such a value read-only, tagged "set by the environment" and
   naming its variable, the same way `AGENTRY_AUTH_TOKEN` already works for the guard.
2. **`app-settings.json`** in the data directory. It holds only what was changed from the UI, and is
   not written at all on an install where nobody changed anything.
3. **The default.** An install that sets nothing behaves exactly as it did before.

`allowedHosts` is the one exception, described in [the next section](#allowed-hosts-add-up).

`GET /api/settings/app` returns the values and, in `sources`, where each comes from (`env`, `file` or
`default`). `PUT /api/settings/app` takes only the keys that change. A key the environment set is
refused with `400`, even when its value is the same, rather than written to a file that would never
apply. Every change emits `settings.changed` on `/api/events` with the whole document. Both routes
are guarded like every other settings route, so read-only mode answers `405`.

## Allowed hosts add up

Since 2026-10-06 the layers of `allowedHosts` add up instead of replacing each other. The guard
answers the union of three sets:

- **The environment's hosts** (`AGENTRY_ALLOWED_HOSTS`). They are fixed: the UI lists each one
  read-only, tagged "set by the environment", and no `PUT` can remove one.
- **The hosts added in the UI**, stored as `allowedHosts` in `app-settings.json`. A `PUT` of
  `allowedHosts` replaces this set and is accepted even when the variable is set. It applies to the
  next request, without a restart.
- **The runtime hosts**, such as a running tunnel's host (see below). They are listed read-only in
  the card, tagged "tunnel", and never stored.

`GET /api/settings/app` reports them like this:

- `allowedHosts` is the configured list: the environment's hosts, then the UI's. Runtime hosts are
  never in it.
- `allowedHostLayers` gives `{ env, file, runtime }`, so a client can tell the fixed hosts from the
  editable ones.
- `sources.allowedHosts` names the highest layer that contributes any host (`env`, then `file`, then
  `default`). For this key it does **not** mean read-only.

A host the environment already names is left out of what a `PUT` stores. A client that sends back
the whole list it read therefore does not copy the deploy's hosts into the file. The same filter
applies when the file is read, so a host that the variable later takes over is not listed twice.

A runtime host coming or going emits `settings.changed`, so an open settings page shows the tunnel's
host as soon as it is lent. The draft in the field survives that refresh, because the card only
remounts when the UI's own hosts change.

**Why.** The owner's desktop app runs with `AGENTRY_ALLOWED_HOSTS=*.devtunnels.ms,192.168.1.184`.
That made the whole list read-only, and adding a host meant editing the launcher and restarting.
The rule "the environment wins" exists so the UI cannot quietly undo a deploy. Adding a host undoes
nothing the deploy decided, while removing one would, so only adding is allowed. Two alternatives
were rejected:

- A switch that hands the list over to the UI when the variable is set. It would let the UI drop a
  host the deploy depends on (a proxy's public name).
- Keeping the list read-only and documenting the restart. That keeps the original problem.

**Compatibility.** The file keeps its shape (`allowedHosts: string[]`), so existing files load
unchanged. One behaviour does change: an `allowedHosts` stored in the file *before* the variable was
set used to be ignored while the variable was set, and it now adds to it. Such a file could only
come from an install that ran without the variable first, or from a hand edit. The card shows those
hosts in the field, where they can be removed. Old clients that read only `sources` still see `env`
and keep showing the list read-only, which is safe.

**An empty variable counts as unset.** Compose passes `VAR=` through. Before, an empty
`AGENTRY_MAX_CONCURRENT_RUNS` became `0` (a wrapper that could start no run), and an empty mode was
passed to the CLI as is. Now either one means the default, and the setting stays editable in the UI.

**In the Docker image, the permission mode is read-only in the UI.** The image sets
`AGENTRY_DEFAULT_PERMISSION_MODE=bypassPermissions` in its `ENV`, so there the environment owns it.

## What a write is held to

A write is checked as a whole before anything is saved, so a request with one bad key changes
nothing:

- Unknown keys are refused.
- `allowedHosts` follows the same rule as the variable: a name, or a `*.domain` pattern for that
  domain's subdomains, and never a pattern over a public suffix such as `*.com`. A port is refused
  rather than dropped, because the guard ignores ports and an entry that looks narrower than what it
  lets in is a misunderstanding. At most 100 entries.
- `maxConcurrentRuns` is a whole number from 1 to 64, and the mode is a valid permission mode.

A hand-edited file is read with the same rules. A bad key is dropped and falls back to the default,
so the file can never widen the allowlist. A file that is not valid JSON makes Agentry start on the
defaults and refuse writes, so the file is never overwritten with a guess at what it held. Writes
are atomic and one at a time.

## The runtime allowlist

Beside the configured hosts, the guard also answers a set of **runtime hosts**: exact names that
their owner adds and removes while Agentry runs. The only owner so far is the
[tunnel](tunnel.md), which lends the node's tailnet name while its Serve rule holds. The set:

- **Exact names only, never a pattern.** `*.ts.net` would let in every other node of every tailnet.
- **Memory only.** Never written to `app-settings.json` or any file. `GET /api/settings/app` lists
  them apart, in `allowedHostLayers.runtime`, for reading only: `allowedHosts` there is the
  configured part. Adding or removing one emits `settings.changed`.
- **Its own failed-login bucket.** A runtime host may be registered with a header that carries the
  client's address. Its failed logins are then keyed by the last hop of that header, because earlier
  hops can be forged by the client. With no header (the tunnel's case: Tailscale Serve's were not measured), all
  of that host's traffic shares one bucket, `runtime:<host>`, kept apart from loopback. On every other
  host, the key stays the peer's address and any such header is ignored, so nobody on the machine can
  forge their way into another bucket.

## Where it lives in the code

- `AppSettingsStore` and `RuntimeHosts` in `packages/core/src/app-settings.ts`, as `core.appSettings`
  and `core.appSettings.runtimeHosts`. There is no global singleton: two wrappers in one process keep
  separate settings.
- `CoreConfig` keeps the environment's values, and `settingsFromEnv` records which of the three the
  environment set (`packages/core/src/paths.ts`).
- The guard reads the allowlist on every request and only rebuilds it when it changed
  (`apps/api/src/security.ts`).
- The UI is two cards in Settings → Security, `apps/web/src/pages/config/AppSettingsCards.tsx`. The
  hosts card lists the environment's and the runtime hosts, each with a tag, above a field that holds
  only the UI's hosts; `changedSettings` compares that field with `allowedHostLayers.file`.
- The contract is `AppSettings` and `AllowedHostLayers` in `packages/shared/src/types.ts`.

## Related

[[tunnel.md]] · [[plans/tunnel.md]] · [[deploy.md]] · [[security-model.md]]
