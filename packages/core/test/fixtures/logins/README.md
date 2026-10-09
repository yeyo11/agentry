# Sign-in recordings

Raw output of each documented sign-in command, run with **no TTY**, recorded on 2026-10-08 for
step 1 of [the in-app setup plan](../../../../../docs/plans/in-app-setup.md). They are what
`LoginService`'s patterns and the fake CLIs in its tests are written from.

## How they were made

- In a throwaway container (`docker run --rm`) of `agentry:fixes-test`, the image built from this
  branch's earlier commit: Claude Code, Codex 0.159.3, Gemini, Copilot 1.0.93 and OpenCode. gh 2.102.0
  and glab 1.120.0 were the vendors' linux amd64 release binaries, checked against their checksum
  files and mounted on the `PATH`.
- Every home pointed at a fresh folder inside the container: `HOME`, `CODEX_HOME`, `COPILOT_HOME`,
  `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`. No keyring, no clipboard,
  no browser, no `DISPLAY`.
- Each command started in its own process group with stdin from `/dev/null` (device flows) or a pipe
  (key flows), stdout and stderr captured to separate files. A device flow was stopped with SIGTERM
  to the process group 3 s after its code appeared. Nobody opened a URL, so no account signed in.
- Per recording: `<tool>-<method>.stdout`, `.stderr`, and `.json` with the command, stdin, exit code,
  how it was stopped, how long it ran, the CLI version and the date. Nothing is redacted: the codes
  are one-time and expired unused. The bytes are as the CLI wrote them, ANSI escapes included.

## Device-code flows

All four run with no TTY and keep polling until approved, cancelled or expired.

| Tool | Command | Stream | URL line | Code line | Lifetime printed | Exit on SIGTERM |
|---|---|---|---|---|---|---|
| Codex | `codex login --device-auth` | stdout | `   https://auth.openai.com/codex/device` (alone, indented, ANSI blue) | `   LK0C-T6BJV` (alone, indented, ANSI blue), after `2. Enter this one-time code (expires in 15 minutes)` | 15 minutes | 0 |
| Copilot | `copilot login --device-code` | stdout, and repeated twice on stderr | `To authenticate, visit https://github.com/login/device and enter code 0472-EEB7` (URL and code on one line) | same line | not printed | 143 |
| gh | `gh auth login --web -h github.com --git-protocol https --skip-ssh-key` | stderr | `Open this URL to continue in your web browser: https://github.com/login/device` | `! First copy your one-time code: 250D-975E` | not printed | 143 |
| glab | `glab auth login --device --hostname gitlab.com` | stderr | `Then open this URL on any device to authorize: https://gitlab.com/oauth/device` | `First copy your one-time code: 5NZYG1XD` | not printed | 1, after printing `The command execution has been interrupted.` |

What the patterns have to allow for:

- **Strip ANSI first.** Codex colours its output with no TTY (`\x1b[94m…\x1b[0m`), and glab's error box
  is coloured too.
- **Code shapes differ.** Codex `XXXX-XXXXX` (4 + 5), Copilot and gh `XXXX-XXXX`, glab eight characters
  with no dash. All upper-case letters and digits.
- **Codex prints the URL and the code on lines of their own**, so the parser reads them by position
  after the numbered steps, not by a label on the same line.
- **The exit code says nothing about success.** Codex exits 0 when killed, before any approval. The
  plan's rule stands: success is the readiness probe after exit.
- **Noise to ignore.** Copilot says on stderr it failed to open a browser and the clipboard; gh says it
  could not copy the code to the clipboard. Both still print the URL and the code.
- **Lifetimes.** Only Codex prints one (15 minutes). The others need the plan's 15-minute ceiling.

## Key and token paths, with a bad credential

| Tool | Command | Exit | What it does with a bad key |
|---|---|---|---|
| Codex | `echo bad \| codex login --with-api-key` | 0 | **Accepts and stores it.** stderr: `Reading API key from stdin...`, `Successfully logged in`; `codex login status` then says `Logged in using an API key`. A bad key surfaces only on first use. |
| Copilot | `echo bad \| copilot login --with-token` | 1 | Refused locally: `Login failed: Error: Unsupported token type. Use a fine-grained personal access token …` |
| Copilot | `echo github_pat_11AAAA…0 \| copilot login --with-token` (well-shaped, invalid) | 1 | Refused by GitHub: `Login failed: Error: Failed to fetch Copilot user info: 401 Unauthorized: {"message":"Bad credentials"}` |
| gh | `echo bad \| gh auth login --with-token -h github.com` | 1 | Refused: `error validating token: HTTP 401: Bad credentials (https://api.github.com/)` |
| glab | `echo bad \| glab auth login --hostname gitlab.com --stdin` | 0 | **Accepts and stores it** with a warning: `WARNING: Could not look up the username for this token: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}`, then `✓ Stored your credentials in the configuration file.` |

So for Codex and glab the exit code cannot tell a refusal: Codex says nothing at all, and glab's only
sign is the `401` warning. `LoginService` must re-run the tool's readiness probe after a key, and for
glab may also read that warning line, before it says the key worked.

## Storage without a keyring

- **glab** does not ask: `WARNING: The operating system keyring is unavailable. Storing credentials as
  plaintext in the configuration file.` (in `GLAB_CONFIG_DIR/config.yml`). It also checks for updates
  and prints a banner (`A new version of glab is available`), which the parser ignores.
- **gh** asks nothing in either path; with no keyring it keeps the token in `GH_CONFIG_DIR/hosts.yml`.
  This was not observed here (no token was accepted) and is gh's documented fallback.
- **Copilot** (observed 2026-10-08 in the image, Copilot 1.0.93, with a real account, no TTY and no
  system keychain): `copilot login --device-code` prints its code, waits, and once the person
  approves it on github.com writes on stderr

  ```
  Login succeeded, but the token was not saved. Install a system keychain or rerun login and accept plaintext storage.
  ```

  and exits 1. Its `login --help` says that with no credential store the token "will be stored in a
  plain text config file under ~/.copilot/", but that takes a question only a real terminal can
  answer: stdin from `/dev/null` and a pipe carrying `y\n` both end with the same message. Nothing is
  written under `COPILOT_HOME`. `copilot login --with-token` reaches the same save step, so neither
  of Copilot's own sign-ins works in the image (Agentry showed `cli-refused`).

  What does work, and what Agentry now uses (decision 7 of the plan, docs/setup.md "Copilot in a
  container"): GitHub's documented credential order, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, the keychain, then the GitHub CLI's `gh auth token`. With gh signed in to
  github.com by device code (a `gho_` token kept in `GH_CONFIG_DIR/hosts.yml`) and Copilot never
  signed in, `copilot -p "Reply with the single word OK" --allow-all-tools </dev/null` answered.

  `copilot-device-code.*` stays as the record of what the command prints before the approval, which
  is where its trouble starts; no parser reads it any more (`DEVICE_PATTERNS` has no Copilot row).
  `copilot-with-token-*` show its refusals of a bad and an invalid token.

## Tailscale (recorded 2026-10-08, for the daemon the image runs)

Not in the image run above: tailscale 1.102.4's release binaries on the recording machine, the CLI
pointed with `--socket` at a **throwaway** `tailscaled --tun=userspace-networking
--state=<tmp>/state --socket=<tmp>/sock --statedir=<tmp> --port=0 --no-logs-no-support`, started
as an unprivileged user with a fresh state, the way the image starts its own. The machine's own
signed-in daemon was never asked anything but `--help`. The throwaway was killed by its PID and its
folder removed once the URL showed; nobody opened it, so no node joined a tailnet.

| Recording | Command | Exit | What it shows |
|---|---|---|---|
| `tailscale-up.*` | `tailscale up --reset --hostname=agentry`, stdin `/dev/null` | 1 on SIGTERM (`context canceled`) | stderr only: an empty line, `To authenticate, visit:`, an empty line, the URL alone after a tab (`\thttps://login.tailscale.com/a/<id>`), an empty line. **No code**: opening the URL is the sign-in. It took about 4.6 s to appear (the daemon asks the control server for it), and the command then waits until the node is `Running` (`--timeout` 0 = forever) |
| `tailscale-up-auth-key-bad.*` | the same with `--auth-key=file:<tmp>/key` (mode 0600, a well-shaped key that does not exist) | 1, at once | stderr `backend error: invalid key: API key does not exist`. The `file:` form is read: 1.102's `up --help` documents it, and a missing file answers `open <path>: no such file or directory` |

Also measured on the throwaway, and why `LoginService` runs what it runs:

- **`up` with flags that differ from what the daemon kept is refused** (`changing settings via 'tailscale
  up' requires mentioning all non-default flags`) unless `--reset` is given; `tailscale login` skips
  that check but its help calls it alpha. Hence `up --reset --hostname=<name>`, on a daemon only
  Agentry drives.
- **The CLI and the daemon run as the same unprivileged user** and the CLI may change everything
  (`up`, `logout`) with no `--operator`.
- **`tailscale logout`** on a node that is not signed in exits 0 with no output.
- **`status --json`** on the fresh daemon answers `BackendState: NeedsLogin`, `TUN: false`, and
  once `up` printed its URL, `AuthURL` holds it too.

## Blockers

Every device flow runs without a terminal. Copilot's is the one that cannot finish there: it gets
its approval and then cannot store the token (above), so Copilot's Code is gh's device sign-in.
