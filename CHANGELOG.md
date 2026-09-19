# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please) from the
commit messages. Do not edit it by hand.

## [0.4.1](https://github.com/yeyo11/agentry/compare/v0.4.0...v0.4.1) (2026-09-19)


### Bug fixes

* **release:** publish the version tags on the image ([b5097be](https://github.com/yeyo11/agentry/commit/b5097be79148ed54e2ee6ba16f8e05f28c71a25a))

## [0.4.0](https://github.com/yeyo11/agentry/compare/v0.3.0...v0.4.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **api:** GET /api/system returns `version` instead of `wrapperVersion`.

### Features

* **api:** rename SystemInfo.wrapperVersion to version ([996289b](https://github.com/yeyo11/agentry/commit/996289b67d1bb1916989eed45023cb876e47cb9f))


### Documentation

* describe what landed since the first release ([0e17de3](https://github.com/yeyo11/agentry/commit/0e17de3bb83ba3f9750cc38c8710090cffb5ae0b))

## [0.3.0](https://github.com/yeyo11/agentry/compare/v0.2.0...v0.3.0) (2026-09-18)


### Features

* answer a run's permission prompts from the panel ([e641538](https://github.com/yeyo11/agentry/commit/e6415382f6d3e6b6274a2f2bcab664ad6411ae58))

## [0.2.0](https://github.com/yeyo11/agentry/compare/v0.1.1...v0.2.0) (2026-09-18)


### Features

* **api:** extract startServer so the API can be embedded ([4940af7](https://github.com/yeyo11/agentry/commit/4940af77e5d0afb9472fee4ea95dec2c1ff721d2))
* **orchestration:** give each task its own git worktree ([3109982](https://github.com/yeyo11/agentry/commit/3109982d67979079d05c5c132d4febb33b3ded1e))
* **orchestration:** pre-authorise the tools workers may use ([b3e0cfd](https://github.com/yeyo11/agentry/commit/b3e0cfdb40420621072246509313bcb10d9ebd48))
* **orchestration:** record planner drafts and let the UI watch and recover them ([2b3c0eb](https://github.com/yeyo11/agentry/commit/2b3c0eb6148fccd73e11bfb4fe9e652ebc13672e))
* **orchestration:** remove the worktrees a graph left behind ([a6e76eb](https://github.com/yeyo11/agentry/commit/a6e76ebb0e63f1041f8a0cdca6c7b2b0897c0fc0))
* **orchestration:** resume a graph that was interrupted ([a6f993f](https://github.com/yeyo11/agentry/commit/a6f993f702700df54b8b6a3f5410c1ec72a094ce))
* **runs:** let a run name who answers its permission prompts ([13d5a42](https://github.com/yeyo11/agentry/commit/13d5a42a7bbe36c2ca1668a0c922917195aed7ee))
* **sessions:** open a transcript on its newest message and add a jump control ([2438cae](https://github.com/yeyo11/agentry/commit/2438cae062b6f6f03a4781182dd2ed0a90787251))
* use the CLI for background sessions, project state and budgets ([a801cb9](https://github.com/yeyo11/agentry/commit/a801cb9bd1aeef809edb9ee9d14d8ec1842136c6))


### Bug fixes

* resolve waitForResult for a run that already ended ([7f92a5d](https://github.com/yeyo11/agentry/commit/7f92a5dc2bfb1b21e255449993804c5a05a9ca54))
* **runs:** keep internal runs across a restart so the planner stops vanishing ([2ca484e](https://github.com/yeyo11/agentry/commit/2ca484ef5c832457b6ab857d3194faf6b1b0132a))


### Refactoring

* **orchestration:** let the CLI create the worktrees ([684799f](https://github.com/yeyo11/agentry/commit/684799fe8b58bb6188356d8b78274b6477c6f784))

## [0.1.1](https://github.com/yeyo11/agentry/compare/v0.1.0...v0.1.1) (2026-09-18)


### Build and packaging

* automate releases with release-please ([85f4d4b](https://github.com/yeyo11/agentry/commit/85f4d4b10e66cff545112b9a25e9ecdf2b1e539d))
* grant the image permissions on the calling jobs ([a213867](https://github.com/yeyo11/agentry/commit/a213867d8f60b416854cec3d125bc227e8fc2fbf))

## 0.1.0 (2026-09-18)

### Features

* Runs driven entirely through the Claude Code CLI: detection, auth status, multi-turn
  conversations over stream-json with transparent `--resume`, token streaming, background tasks
  and subagents.
* Session and project history read from the CLI's own transcripts, with every session attributed
  to its origin (CLI, Agentry run, orchestration worker).
* Orchestration: a DAG of tasks with parallelism, dependency context, a synthesis step and an
  auto-planner.
* Multi-account support through claude-swap, with usage per window, a proactive rotation
  supervisor, rotate-and-resume for a run that dies against its limit, and per-run account pinning.
* The full per-account configuration surface: settings, instructions, MCP servers, agents, skills,
  commands, output styles, rules, a confined file explorer, memory, plugins and marketplaces.
* An embedded SQLite store for everything that accumulates — rotation history, runs and
  orchestrations — so history survives a restart and two processes sharing a data dir no longer
  overwrite each other's records.
* REST API documented with an OpenAPI 3.1 document generated from the shared types and served
  with Scalar at `/docs`, plus a test that fails if a route is undocumented.
* Web UI with a command palette, light/dark/system themes, CodeMirror editors, unsaved-change
  guards and a responsive layout.

### Build and packaging

* Single non-root Docker image with the CLI baked in, published to `ghcr.io/yeyo11/agentry`.
* Unit, API integration and headless-browser test suites run on every push.
