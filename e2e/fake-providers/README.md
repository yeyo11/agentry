# The fake codex, gemini and copilot

Three names for one small executable (`agent`), for the providers specs: the e2e sandbox has no other
agent installed, and the suite never depends on a real one. They are **not** on `PATH`, so the fake
`claude` specs are unchanged: `e2e/run.mjs` seeds `providers.json` so Codex uses the `codex` here,
and a spec points another provider at `gemini` or `copilot` with the binary override in
Settings → Providers. Each answers `--version`; `codex login status` answers too (the only provider
with an auth probe that costs nothing).

What they answer is read from `$AGENTRY_DATA_DIR/fake-providers/<name>.json` (the detector hands the
server's environment to its probes), so a spec changes it without restarting anything:

| Key | Default | Effect |
| --- | --- | --- |
| `version` | `0.50.0` | The version `--version` prints |
| `signedIn` | `true` | `login status` exits 0, or 1 when `false` |
| `versionExit` | `0` | A non-zero exit code for `--version`: a binary that is broken |
