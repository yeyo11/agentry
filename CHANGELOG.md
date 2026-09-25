# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please) from the
commit messages. Do not edit it by hand.

## [0.18.0](https://github.com/yeyo11/agentry/compare/v0.17.2...v0.18.0) (2026-09-25)


### Features

* interruption level for notifications, and mobile layout fixes ([#93](https://github.com/yeyo11/agentry/issues/93)) ([5b05df2](https://github.com/yeyo11/agentry/commit/5b05df2b41bad5e1196ef7e03bb672974bcc8a77))


### Bug fixes

* app-updates follow-up — AppImage relaunch, Docker commands, .deb elevation, ELECTRON_RUN_AS_NODE ([#97](https://github.com/yeyo11/agentry/issues/97)) ([306d605](https://github.com/yeyo11/agentry/commit/306d6054b9000f262a2bebe27b6a70a89867d415))

## [0.17.2](https://github.com/yeyo11/agentry/compare/v0.17.1...v0.17.2) (2026-09-25)


### Documentation

* where the project stands, and the knowledge base that keeps it ([#89](https://github.com/yeyo11/agentry/issues/89)) ([90f46c0](https://github.com/yeyo11/agentry/commit/90f46c0746046b1c96628d7913cb0b7c4ccc851c))

## [0.17.1](https://github.com/yeyo11/agentry/compare/v0.17.0...v0.17.1) (2026-09-24)


### Bug fixes

* **web:** the pages of a chat read back survive leaving it ([#87](https://github.com/yeyo11/agentry/issues/87)) ([695bccb](https://github.com/yeyo11/agentry/commit/695bccbf2408f555f36a62e3c7b0b6ea5819e867))

## [0.17.0](https://github.com/yeyo11/agentry/compare/v0.16.3...v0.17.0) (2026-09-24)


### Features

* **web:** the chat on a phone, and the models the CLI really offers ([e4d6064](https://github.com/yeyo11/agentry/commit/e4d6064943e799307daa03e34290dc2408110867))


### Bug fixes

* **push:** a VAPID subject Apple accepts, and the reason when it does not ([#85](https://github.com/yeyo11/agentry/issues/85)) ([3981af3](https://github.com/yeyo11/agentry/commit/3981af36f833255a1fed4aa6f1b08538a6e3432b))

## [0.16.3](https://github.com/yeyo11/agentry/compare/v0.16.2...v0.16.3) (2026-09-23)


### Bug fixes

* **desktop:** keep the port the app listened on, instead of a new one each launch ([#82](https://github.com/yeyo11/agentry/issues/82)) ([0bd7cea](https://github.com/yeyo11/agentry/commit/0bd7cea035564a1edc21df4123176328ece009c5))
* the recovery paths, which the happy path had been hiding ([#83](https://github.com/yeyo11/agentry/issues/83)) ([cc939f7](https://github.com/yeyo11/agentry/commit/cc939f75141a2212ad6b5cdf5bb2e7dfe010fe1b))

## [0.16.2](https://github.com/yeyo11/agentry/compare/v0.16.1...v0.16.2) (2026-09-23)


### Bug fixes

* **api:** an allowed host may be a `*.domain` pattern ([#80](https://github.com/yeyo11/agentry/issues/80)) ([3e5d21c](https://github.com/yeyo11/agentry/commit/3e5d21c1ea96939c15081a20f6bfeb4056fed307))

## [0.16.1](https://github.com/yeyo11/agentry/compare/v0.16.0...v0.16.1) (2026-09-23)


### Bug fixes

* bind to loopback, refuse an unknown Host, and stop handing out the credentials ([#77](https://github.com/yeyo11/agentry/issues/77)) ([17e76d1](https://github.com/yeyo11/agentry/commit/17e76d132f8e90eaeb3af8924185c946d238b3e5))

## [0.16.0](https://github.com/yeyo11/agentry/compare/v0.15.3...v0.16.0) (2026-09-23)


### Features

* install Agentry on a phone, and push to it with the app closed ([#76](https://github.com/yeyo11/agentry/issues/76)) ([7ef73d9](https://github.com/yeyo11/agentry/commit/7ef73d9aa118b259556c4bbe1bba5880d074e891))

## [0.15.3](https://github.com/yeyo11/agentry/compare/v0.15.2...v0.15.3) (2026-09-22)


### Performance

* **core:** chats list and chat detail stop re-reading the machine on every request ([#72](https://github.com/yeyo11/agentry/issues/72)) ([73aca06](https://github.com/yeyo11/agentry/commit/73aca06b17ad4ad51631fbfe30c03950a87d4d53))
* **web:** the chat view streams without re-rendering or re-reading the page ([#73](https://github.com/yeyo11/agentry/issues/73)) ([567c045](https://github.com/yeyo11/agentry/commit/567c0452955b9e1c970dd6851f385cfec3d07694))
* **web:** the chats list stops rereading itself on every event ([#74](https://github.com/yeyo11/agentry/issues/74)) ([7ea9407](https://github.com/yeyo11/agentry/commit/7ea9407f52f73606d39799a11d3449d8982b7be4))

## [0.15.2](https://github.com/yeyo11/agentry/compare/v0.15.1...v0.15.2) (2026-09-22)


### Bug fixes

* **web:** sticky bars flush with the page's edges, chat header under the top bar, logo on phones ([#69](https://github.com/yeyo11/agentry/issues/69)) ([2868ed4](https://github.com/yeyo11/agentry/commit/2868ed437784f3febf02ccab2835338f3c0793df))

## [0.15.1](https://github.com/yeyo11/agentry/compare/v0.15.0...v0.15.1) (2026-09-22)


### Bug fixes

* chat inspector drawer flush to the edge, and the chat stream opens at once ([#67](https://github.com/yeyo11/agentry/issues/67)) ([015bc51](https://github.com/yeyo11/agentry/commit/015bc51d11e28ad36a9dae34e9cb848aeaf79364))

## [0.15.0](https://github.com/yeyo11/agentry/compare/v0.14.0...v0.15.0) (2026-09-21)


### Features

* close what the roadmap left open after [#60](https://github.com/yeyo11/agentry/issues/60) and [#62](https://github.com/yeyo11/agentry/issues/62) ([#64](https://github.com/yeyo11/agentry/issues/64)) ([161cff2](https://github.com/yeyo11/agentry/commit/161cff2af7930fab299f51573d25b8039b6fbd43))


### Bug fixes

* **core:** judge a command by the stage that does the work, not a trailing echo ([#63](https://github.com/yeyo11/agentry/issues/63)) ([d130694](https://github.com/yeyo11/agentry/commit/d130694c47ac00b422bf117c8b44f7fdb48aef4e))

## [0.14.0](https://github.com/yeyo11/agentry/compare/v0.13.1...v0.14.0) (2026-09-21)


### ⚠ BREAKING CHANGES

* chats, projects and Agentry's own model ([#60](https://github.com/yeyo11/agentry/issues/60))

### Features

* chats, projects and Agentry's own model ([#60](https://github.com/yeyo11/agentry/issues/60)) ([f78fab7](https://github.com/yeyo11/agentry/commit/f78fab7b057c613190f60f5c380b8a5164f058d6))
* finish the roadmap's Next section ([#62](https://github.com/yeyo11/agentry/issues/62)) ([db276e6](https://github.com/yeyo11/agentry/commit/db276e65e25a0a6740d70e7e69ee2e358ea0c0af))

## [0.13.1](https://github.com/yeyo11/agentry/compare/v0.13.0...v0.13.1) (2026-09-20)


### Bug fixes

* **web:** colour code blocks the way shiki does, measured ([#56](https://github.com/yeyo11/agentry/issues/56)) ([d6560e1](https://github.com/yeyo11/agentry/commit/d6560e19a390704d538a883167bd6deff94bfa98))

## [0.13.0](https://github.com/yeyo11/agentry/compare/v0.12.0...v0.13.0) (2026-09-19)


### Features

* improve task orchestration, transcript performance, and i18n [#54](https://github.com/yeyo11/agentry/issues/54)) ([0ffa2c7](https://github.com/yeyo11/agentry/commit/0ffa2c7c5111644f9d2ca794ed14a61291371f0b))

## [0.12.0](https://github.com/yeyo11/agentry/compare/v0.11.1...v0.12.0) (2026-09-19)


### Features

* page long transcripts from the API and window them in the UI ([3f79a06](https://github.com/yeyo11/agentry/commit/3f79a0690588418405afbf0d455b86fb9a1ad040))


### Bug fixes

* **core:** list monitors started by CLI sessions as background tasks ([#52](https://github.com/yeyo11/agentry/issues/52)) ([f645950](https://github.com/yeyo11/agentry/commit/f64595085bd7c10f96003903705f43057c2ba3ba))


### Performance

* **web:** merge highlighted tokens into coloured runs ([dea38a3](https://github.com/yeyo11/agentry/commit/dea38a33ad8421e214b784bda21350eba76a65d4))
* **web:** render answers with @tanstack/markdown instead of react-markdown ([e7c2c25](https://github.com/yeyo11/agentry/commit/e7c2c2543a8699072499fcb5ea918f9844f461fe))


### Documentation

* note what 0.11.0 left for the observability work ([#49](https://github.com/yeyo11/agentry/issues/49)) ([0d38623](https://github.com/yeyo11/agentry/commit/0d38623990aada865b7f5a67c551cd3c311fa1a8))

## [0.11.1](https://github.com/yeyo11/agentry/compare/v0.11.0...v0.11.1) (2026-09-19)


### Bug fixes

* **web:** stop the run view freezing while typing a message ([#50](https://github.com/yeyo11/agentry/issues/50)) ([0209347](https://github.com/yeyo11/agentry/commit/020934737f9c2ab98b70b5c5520e674f26fb2710))

## [0.11.0](https://github.com/yeyo11/agentry/compare/v0.10.0...v0.11.0) (2026-09-19)


### Features

* live event feed, notifications and full execution detail ([#47](https://github.com/yeyo11/agentry/issues/47)) ([c772df7](https://github.com/yeyo11/agentry/commit/c772df751c21648b0f27df1fadc501e7ac0ebc20))


### Documentation

* plan agent observability and make it the top roadmap priority ([#46](https://github.com/yeyo11/agentry/issues/46)) ([c25acd3](https://github.com/yeyo11/agentry/commit/c25acd372206097210ca28151aa09cd3f285162d))

## [0.10.0](https://github.com/yeyo11/agentry/compare/v0.9.0...v0.10.0) (2026-09-19)


### Features

* **orchestration:** run a graph as a Claude Code workflow ([#44](https://github.com/yeyo11/agentry/issues/44)) ([63442bc](https://github.com/yeyo11/agentry/commit/63442bcfa19c560563c837cad2765a131d1c9394))

## [0.9.0](https://github.com/yeyo11/agentry/compare/v0.8.0...v0.9.0) (2026-09-19)


### Features

* tell Claude Code's tasks apart and show its workflows ([#42](https://github.com/yeyo11/agentry/issues/42)) ([da0339d](https://github.com/yeyo11/agentry/commit/da0339d5d25ee9581cb5bd30fdab361dc854b334))

## [0.8.0](https://github.com/yeyo11/agentry/compare/v0.7.3...v0.8.0) (2026-09-19)


### Features

* full control of runs from the panel through the CLI control protocol ([#37](https://github.com/yeyo11/agentry/issues/37)) ([a79cb39](https://github.com/yeyo11/agentry/commit/a79cb39ae367c5a9980b0253e40bb1e0f818d4c4))
* **web:** render Claude's answers as markdown with highlighted code ([#38](https://github.com/yeyo11/agentry/issues/38)) ([47ad9f8](https://github.com/yeyo11/agentry/commit/47ad9f889a2d5bff7f9e4c1d438128f3443fcaf3))


### Bug fixes

* **release:** attach the packages before publishing an immutable release ([#40](https://github.com/yeyo11/agentry/issues/40)) ([25386ac](https://github.com/yeyo11/agentry/commit/25386acdfde87aff61de9e8608c4944c7a018175))

## [0.7.3](https://github.com/yeyo11/agentry/compare/v0.7.2...v0.7.3) (2026-09-19)


### Documentation

* sync the documentation with the code ([#35](https://github.com/yeyo11/agentry/issues/35)) ([b93e0fa](https://github.com/yeyo11/agentry/commit/b93e0fa55526fe5d98fecabafef005ce1da96fe2))

## [0.7.2](https://github.com/yeyo11/agentry/compare/v0.7.1...v0.7.2) (2026-09-19)


### Build and packaging

* **deps:** bump actions/attest-build-provenance from 2 to 4 ([45df85c](https://github.com/yeyo11/agentry/commit/45df85cd4f70193f52e8524380469d2dd91429c6))
* **deps:** bump actions/checkout from 4 to 7 ([02aa7f6](https://github.com/yeyo11/agentry/commit/02aa7f6ae367d51ddd07561301c2835b5354157b))
* **deps:** bump docker/build-push-action from 6 to 7 ([8439b6c](https://github.com/yeyo11/agentry/commit/8439b6c16ee7197093e4621571f01bc8a52984c3))
* **deps:** bump docker/metadata-action from 5 to 6 ([d526aa3](https://github.com/yeyo11/agentry/commit/d526aa3f6f4922646d7b3e9ef7f0b596c46d6e65))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([7ee9ef9](https://github.com/yeyo11/agentry/commit/7ee9ef9b51034fb1786ca1a2c866f3f454770733))

## [0.7.1](https://github.com/yeyo11/agentry/compare/v0.7.0...v0.7.1) (2026-09-19)


### Bug fixes

* **core:** restore the Core facade the 0.7.0 release commit reverted ([b05b2ee](https://github.com/yeyo11/agentry/commit/b05b2ee76ebccf02b620280c010921e5a489ad5c))
* **release:** stop the release PR from rewriting source to bump the version ([1b8a738](https://github.com/yeyo11/agentry/commit/1b8a738328db41446a467376ca47ec94e931a27b))

## [0.7.0](https://github.com/yeyo11/agentry/compare/v0.6.0...v0.7.0) (2026-09-19)


### Features

* **desktop:** Linux desktop app (AppImage and .deb) ([41ab148](https://github.com/yeyo11/agentry/commit/41ab14872c2ec5b9327903475cf542756218f727))
* **desktop:** one-line installer ([5255811](https://github.com/yeyo11/agentry/commit/52558115ad93252076cea9879f55abdd5c0ee0ae))
* **desktop:** package an AppImage and a .deb and publish them on release ([87ccdd3](https://github.com/yeyo11/agentry/commit/87ccdd3ead0ebb4ecb2b11ebe17201a4d35fba10))
* **orchestration:** deliver one integrated branch ([4d09c4b](https://github.com/yeyo11/agentry/commit/4d09c4b876d2ea25607c28d7bb6f8e4b60a04921))


### Bug fixes

* **desktop:** show the app icon on the running window ([22123ea](https://github.com/yeyo11/agentry/commit/22123eae5c07cac9158f9f1607b7115ef52f2986))
* **web:** count live sessions on the Sessions nav item ([c51923e](https://github.com/yeyo11/agentry/commit/c51923e6918b0b042011ed323996546b2b54d13c))


### Documentation

* **desktop:** document the Linux desktop app ([8f99700](https://github.com/yeyo11/agentry/commit/8f9970014ca0b26d1b749e3d446d58daf73892fa))

## [0.6.0](https://github.com/yeyo11/agentry/compare/v0.5.1...v0.6.0) (2026-09-19)


### Features

* **orchestration:** resume with corrected settings, delete, honest progress ([afabe9c](https://github.com/yeyo11/agentry/commit/afabe9cdb941581596368bbf4f480c190f9931b1))

## [0.5.1](https://github.com/yeyo11/agentry/compare/v0.5.0...v0.5.1) (2026-09-19)


### Bug fixes

* read background work from disk so no screen depends on the live stream ([df9ae76](https://github.com/yeyo11/agentry/commit/df9ae76bf47319822897f0a179603613a3e6cd83))

## [0.5.0](https://github.com/yeyo11/agentry/compare/v0.4.1...v0.5.0) (2026-09-19)


### Features

* show the background agents of sessions started from a terminal ([243e8af](https://github.com/yeyo11/agentry/commit/243e8af76e335b9d71b8fbc59b18c2e6f41c56d5))

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
