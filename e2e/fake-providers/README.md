# The fake codex, copilot, gemini and opencode

Four names for one small executable (`agent`), for the providers specs: the e2e sandbox has no other
agent installed, and the suite never depends on a real one. They are **not** on `PATH`, so the fake
`claude` specs are unchanged: `e2e/run.mjs` seeds `providers.json` so Codex uses the `codex` here,
and a spec points another provider at `copilot`, `gemini` or `opencode` with the binary override in
Settings → Providers. Each answers `--version`; `codex login status` answers too (the only provider
with an auth probe that costs nothing).

Started the way a manifest's `launch` starts the real one, each speaks its protocol, replaying the
recordings (`packages/core/test/fixtures/recordings`) through the fakes the core tests use:

| Name | Started with | Becomes |
| --- | --- | --- |
| `codex` | `app-server` | `fake-codex-app-server.mjs` |
| `copilot` | `--acp …` | `fake-acp-agent.mjs --profile copilot` |
| `gemini` | `--acp` | `fake-acp-agent.mjs --profile gemini` |
| `opencode` | `acp` | `fake-acp-agent.mjs --profile opencode` |

So the detector's handshake, and a chat on a fake, see the replies the recordings show. The protocol
fakes script a turn by the first word of the prompt; their own headers list the words.

What they answer is read from `$AGENTRY_DATA_DIR/fake-providers/<name>.json` (the detector hands the
server's environment to its probes), so a spec changes it without restarting anything:

| Key | Default | Effect |
| --- | --- | --- |
| `version` | the recorded one (codex `0.159.3`, copilot `1.0.91`, gemini `0.62.0`, opencode `1.18.34`) | The version `--version` prints, and the one the Copilot protocol fake answers as (`1.0.65`, `1.0.90` or `1.0.91`) |
| `signedIn` | `true` | `login status` exits 0, or 1 when `false`; the protocol fakes answer as signed out |
| `versionExit` | `0` | A non-zero exit code for `--version`: a binary that is broken |

The defaults are inside each driver's tested range, so a fake is `ready` until a spec says otherwise.
Its own test, which needs no build, browser or server: `node --test e2e/fake-providers/fake-providers.test.mjs`.
