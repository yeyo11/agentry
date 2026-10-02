---
created_at: 2026-09-27T09:01:53.660082511Z
updated_at: 2026-09-27T09:01:53.660082511Z
tags:
    - plan
    - accounts
    - claude-swap
    - superseded
    - desktop
    - packaging
---
# Plan: claude-swap that comes with Agentry

> **Superseded** by phase 4 of [[plans/multi-provider.md]] (2026-10-02): Agentry no longer switches Claude accounts, so the managed claude-swap install no longer exists. Kept as the record of why it was built.

Make multiple accounts work out of the box in the desktop app. Today they need claude-swap to be installed by hand. Agentry will install a pinned claude-swap itself, on demand, into its own data directory, and keep talking to it only through its CLI.

## Why

Agentry delegates multiple accounts and automatic rotation to
[claude-swap](https://github.com/realiti4/claude-swap) (`cswap`), a Python ≥ 3.12 CLI under the MIT
licence. `packages/core/src/accounts.ts` runs `cswap list / switch / add-token --json`, supervises
`cswap auto --json`, and spawns `cswap run … --` for a chat pinned to an account.

Whether it is there depends on where Agentry runs:

| Distribution | claude-swap |
|---|---|
| Docker | Baked in: `uv tool install claude-swap${CLAUDE_SWAP_VERSION}`, with the data dir as a volume |
| Desktop (AppImage, `.deb`) | Whatever is on the user's `PATH`, or nothing |
| From source | Whatever is on the developer's `PATH` |

On the desktop, the Accounts page is a dead end. It shows "claude-swap is not installed" and a link to a guide. To continue, the user has to open a terminal, install `uv`, run `uv tool install claude-swap` and come back. A GUI launch reads the login shell's `PATH` once (`apps/desktop/src/shell-path.ts`), so the app may still say "not installed" until it restarts.

There is also a quieter problem. Agentry parses cswap's `--json` output, and the Dockerfile installs the latest version when `CLAUDE_SWAP_VERSION` is empty. A claude-swap release that changes that output breaks the integration with no clear message: usage stops refreshing, or the account list comes back empty.

## Decision

**Keep claude-swap an external CLI, pin its version, and let Agentry install that version itself when the user asks for multiple accounts.**

Alternatives considered and rejected:

- **Git submodule or vendored source.** A submodule is for code you build with your own. This one needs a Python runtime on the user's machine either way, so it does not solve distribution, and it leaves a fork to maintain.
- **Rewriting it in TypeScript.** This would lose claude-swap's refresh-token handling, cooldown, hysteresis and quarantine. Every upstream fix would become our work.
- **A frozen binary (PyInstaller or Nuitka) in `extraResources`.** Activation would be instant and work offline. But every user would download another 30–50 MB on each install and each update, though most never use more than one account. We would also need a Python build per architecture in CI. If offline activation ever matters, this can replace the installer without touching `accounts.ts`, because only the binary's origin changes.

The process boundary stays where it is. Agentry reaches claude-swap the same way it reaches Claude Code: through flags, `--json` output and exit codes.

## Design

### One pin

A single module in core, `packages/core/src/cswap-pin.ts`, holds:

- `CSWAP_VERSION`: the exact version Agentry installs.
- `CSWAP_COMPATIBLE`: the range of versions whose `--json` output Agentry parses (e.g. `>=0.26 <0.27`).
- `UV_VERSION` and `UV_SHA256`: the `uv` release the installer downloads, and its digest.

The Dockerfile's `CLAUDE_SWAP_VERSION` default becomes that pinned version instead of empty (latest). `apps/api/test/packaging.test.ts` checks that the two match, the way the uv digest is already kept in step.

### Resolving the binary

Order, first match wins:

1. `CSWAP_BIN`, if set. The operator chose it, so it is used even if it is incompatible; Accounts shows a warning.
2. `cswap` on `PATH`, if its version is in `CSWAP_COMPATIBLE`.
3. The managed copy under `<dataDir>/tools/bin/cswap`.
4. An incompatible `cswap` on `PATH`, used with a warning and an offer to install Agentry's version.
5. Nothing: `installed: false`.

With `CSWAP_BIN` set, Agentry installs and removes nothing: the operator owns the binary.

`CswapInfo` in `packages/shared/src/types.ts` grows:

```ts
source: 'env' | 'path' | 'managed' | null;
compatible: boolean;
pinned: string;               // CSWAP_VERSION
managed: {
  available: boolean;         // false in Docker, or with AGENTRY_CSWAP_MANAGED=0
  state: 'absent' | 'installing' | 'installed' | 'failed';
  step?: 'uv' | 'claude-swap';   // uv fetches Python inside the second step
  version: string | null;       // of the managed copy
  error?: string;
};
```

### The managed install

`packages/core/src/cswap-install.ts`, in the background. It never blocks a request.

1. Download `uv` `UV_VERSION` for linux-x86_64 into `<dataDir>/tools/uv`, and verify `UV_SHA256` before running it. If the digest does not match, the install fails.
2. Run `uv tool install claude-swap==CSWAP_VERSION` with every uv path inside the tools dir: `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR`. Nothing lands in the user's `~/.local`. uv fetches a standalone Python 3.12 if the system lacks one.
3. Run `cswap --version` and require it to equal the pin. Then clear `detect()`'s cache and start the auto-switch supervisor, as at boot.

The install:

- **Runs only when asked.** That means `POST /accounts/cswap/install`, or a managed copy that is older than the pin after an Agentry update. Nothing downloads at first launch, and a user with one account pays nothing.
- **Leaves the account data alone.** claude-swap keeps accounts in its own data dir (`~/.local/share/claude-swap`), separate from the binary. Installing, updating or removing the managed copy never touches it, and someone who already used cswap keeps their accounts.
- **Upgrades after an Agentry update.** When a managed copy differs from the pin at boot, it is reinstalled in the background (`uv tool install --force`). The auto-switch supervisor stops for the reinstall and starts again after.
- **Is off in Docker**, where the image already bakes the pinned version (`AGENTRY_DISTRIBUTION`). `AGENTRY_CSWAP_MANAGED=0` turns it off anywhere.
- **Fails in the open.** A network error, a digest mismatch or a uv failure sets `state: 'failed'` with the reason. It never loops.

### API

| Method | Path | |
|---|---|---|
| POST | `/accounts/cswap/install` | Start (or retry) the managed install; answers at once with `managed.state: installing`, progress in `GET /accounts` |
| DELETE | `/accounts/cswap` | Remove the managed copy; accounts are kept |

Both are writes: they respect auth and read-only mode like the other `/accounts` writes. They need summaries and tags in `apps/api/src/openapi/routes.ts`, rows in the README's REST API table, and the OpenAPI schemas need regenerating.

### UI (Accounts)

These states follow the design system and use the existing `Empty` and illustrations. The Spanish copy follows the glossary.

- **Not installed, managed install available.** `cli-missing` in `warn`, "Activate multiple accounts" as the primary button, and the install guide as a secondary link for people who prefer their own.
- **Installing.** The braille spinner next to the step ("Downloading uv…", "Installing claude-swap…"). The page polls `GET /accounts` until the state changes. When it ends, the Add account dialog opens.
- **Failed.** `bad`, the reason, and "Retry".
- **Incompatible.** A `warn` notice above the accounts: "claude-swap 0.30 on your PATH is not compatible — use Agentry's version". Its action installs the managed copy, which then takes precedence.
- **Managed and installed.** The header shows the version and source (`claude-swap 0.26.0 · Agentry`). "Remove claude-swap" in the "⋯" menu (a `Sheet` on a phone) asks for confirmation and says the accounts are kept.
- **Not available (Docker, or turned off).** As today, with the guide.

The Updates card in Settings → Account lists claude-swap's version beside the CLI's.

## What the user sees

- **One account (most users).** Nothing changes, and nothing is downloaded.
- **Wants several accounts.** One button and about 20 s the first time (50–80 MB when uv also has to fetch Python), instead of a terminal and two tools.
- **Already uses cswap.** Their binary and accounts keep working. The only new thing is a warning if their version drifts outside the range Agentry understands.

## Tasks

- `cswap-core` (shared, core): the pin, the resolver, the installer, the extended `CswapInfo`, and restarting the supervisor after install or upgrade. Tests use a fake `uv` and a fake `cswap` on a temp `PATH`, and cover the resolution order, an incompatible version, a digest mismatch, a failed install and an upgrade.
- `cswap-api` (api; deps `cswap-core`): the two routes, OpenAPI, the README rows, and the Docker gating.
- `cswap-docker` (docker): the pinned default and the packaging test.
- `cswap-web` (web; deps `cswap-api`): the Accounts states, the Updates card row, and `en`/`es` copy.
- Docs: update [desktop.md](../desktop.md) (the requirements table and a section on accounts) and the README's multiple-accounts section.

## Not in this plan

- Bundling claude-swap inside the AppImage (see Decision).
- arm64, macOS or Windows: the desktop app ships only for Linux x86_64. The installer should pick uv's asset by platform so this does not have to be redone.
- Installing claude-swap from `scripts/install.sh`. The in-app button covers it; the script may later mention it next to its Claude Code hint.

## Open questions

- Should the claude-swap install be pinned by hash too, not only by exact version? It would guard against a replaced PyPI release, at the cost of a lock to regenerate on every bump. `uv tool install` has no `--require-hashes`, so it would mean a `uv pip install --require-hashes` into a venv of our own instead. PyPI does not let a released version be re-uploaded, so the exact pin is kept for now.

## Related

[[desktop.md]] · [[deploy.md]] · [[plans/app-updates.md]] · [[plans/roadmap-completion.md]]
