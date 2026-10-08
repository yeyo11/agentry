---
created_at: 2026-10-08T18:30:00Z
updated_at: 2026-10-08T18:30:00Z
tags:
    - docker
    - deploy
    - providers
    - decision
    - operations
---
# What a container keeps, and what it carries

Two things went wrong in the Docker image: it carried one agent when Agentry drives five, and an
update could lose a person's account setup, transcripts and projects without anything saying so.
This page records what was found, what was decided and what it costs. How to run and update the
image is in [deploy.md](deploy.md#updating-a-container-without-losing-anything).

## What was wrong

**Data lost at an update.** The README's first command named one volume, `-v agentry-data:/data`.
The image declares `VOLUME` for `/home/node/.claude`, `/workspace` and `/data`, so Docker made an
anonymous volume for the two the command did not name. Replacing the container, which is what the
Updates card in Settings told people to do ("the volumes keep every chat, setting and credential"),
started again with empty ones. Measured on the built image: after removing the container and
running the same command, a file in `~/.claude` and one in `/workspace` were gone; `/data` stayed.
Nothing in the server noticed, and the Quick start's `-v "$PWD/workspace:/workspace"` was a different
folder whenever the command was run from another directory.

**One agent in the image.** Only Claude Code was installed, so Codex, Gemini, Copilot and OpenCode
read as not installed in a container. What a person installed by hand, and the sign-in that agent
kept in its home (`~/.codex`, `~/.gemini`, `~/.copilot`, `~/.config/opencode`,
`~/.local/share/opencode`), sat outside every volume and went with the container.

**Smaller things.** The compose file passed a `CLAUDE_SWAP_VERSION` build argument the Dockerfile
no longer declares, and the Helm chart defaulted to image tag `0.15.2` while `main` was at `0.36.1`:
nothing moved the chart's tag, so a plain `helm install` ran a very old release.

## Decisions

- **The four CLIs go in the image, pinned.** Each to a version inside the range its manifest
  declares, because the driver is written for that range and a rebuild must not move off it by
  accident; a test fails when a pin leaves its range. The alternatives were a volume of tools the
  person installs into (no pinned versions, a manual step per agent) and a second, fuller image
  (twice the CI and the documentation). The cost is size: the image went from under 1 GB to about
  2 GB, because Codex, OpenCode, Copilot and Gemini ship native binaries.
- **Their homes move under `/data/provider-homes`.** `CODEX_HOME`, `GEMINI_CLI_HOME`,
  `COPILOT_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are set in the image, so the volume that
  already holds the wrapper's state holds the sign-ins too, with no fourth volume to forget. The
  server creates the folders on start (`ensureProviderHomes`), only those inside the data
  directory, because Codex refuses a home that does not exist and a fresh volume has none. `XDG_*`
  also moves what other tools keep there; pnpm's store is held in the image (`npm_config_store_dir`)
  so it does not grow the volume.
- **The server says when a folder would be lost.** `GET /system/storage` reads
  `/proc/self/mountinfo` and classifies the config dir, the data dir and the workspace as
  `persistent`, `anonymous`, `container`, `temporary` or `unknown`. It works under any way of
  starting the container, since it reads what the process sees. Settings → Account shows a warning
  with the command that names all three volumes, before any update command. It cannot tell a new
  empty named volume from the intended one (Compose started from another folder), so the compose
  file and the README tell people to set `COMPOSE_PROJECT_NAME` once.
- **Every command names three volumes, and the workspace is one of them.** `agentry-workspace`, not
  `$PWD/workspace`. A folder of one's own is fine as an absolute path.
- **The chart's tag follows the release.** `values.yaml` carries release-please's marker, and a test
  checks it equals the root `package.json` version, so it cannot go stale silently again.
- **No forced compose project name.** Adding `name: agentry` would rename the volumes of everyone
  whose folder is called something else and look like the data was lost, which is the failure this
  page is about.

## Checked

On the image built from this branch, with the real server: all five providers are detected at their
pinned versions (signed out, until someone signs in); the provider folders exist under
`/data/provider-homes` and the CLIs write there; the README's old command reports `atRisk: true` with
config and workspace anonymous; with three named volumes it reports `false` and a file in each folder,
and a Codex sign-in marker, survive the replacement. The migration in deploy.md was run against a
container started with anonymous volumes and copied all three folders.

Not checked: signing in to each agent from inside a container (it needs an account of each), the
Helm chart (no `helm` here), and an image build on a clean cache.

## Related

[[deploy.md]] · [[providers.md]] · [[plans/multi-provider.md]] · [[desktop.md]] · [[status.md]]
