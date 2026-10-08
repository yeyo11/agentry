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
- **Copilot**: its `login --help` says that when no credential store is found the token "will be stored
  in a plain text config file under ~/.copilot/", and mentions no question. That step runs only after
  an approval or a valid token, which these recordings never give, and the application is bundled
  inside a native binary that could not be searched for a prompt. **Unverified**: whether Copilot asks
  before storing in plain text. Neither recorded path asked anything before the code or the refusal,
  and stdin was `/dev/null` or a closed pipe, so a question would end the command rather than hang it.
  To settle it, run `copilot login --device-code` once with a real account and no keyring.

## Blockers

None: every device flow ran without a terminal, so the plan keeps all four device methods (gh's
included).
