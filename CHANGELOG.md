# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please) from the
commit messages. Do not edit it by hand.

## [0.37.0](https://github.com/yeyo11/agentry/compare/v0.36.1...v0.37.0) (2026-10-09)


### Features

* **setup:** set up a fresh Agentry from Agentry, with the adjustments made on the way ([#228](https://github.com/yeyo11/agentry/issues/228)) ([7dd2e67](https://github.com/yeyo11/agentry/commit/7dd2e67b0c41e10c19efe465a837d4397ec023c9))

## [0.36.1](https://github.com/yeyo11/agentry/compare/v0.36.0...v0.36.1) (2026-10-08)


### Bug fixes

* **chats:** every message is tracked by id from send to delivery; the audit that found why messages got lost (CW-37) ([#227](https://github.com/yeyo11/agentry/issues/227)) ([df44517](https://github.com/yeyo11/agentry/commit/df445179c2e64d4964ee3c41c1827afe0be9368c))
* **web:** copy works over plain HTTP, and a copy that fails says so (CW-38) ([#225](https://github.com/yeyo11/agentry/issues/225)) ([5cc131c](https://github.com/yeyo11/agentry/commit/5cc131caae4f92f5c480ae081d61e60e201a7515))

## [0.36.0](https://github.com/yeyo11/agentry/compare/v0.35.0...v0.36.0) (2026-10-08)


### Features

* **mcp:** tools answer only the fields a model needs, compact; TOON measured and not adopted (CW-33) ([#221](https://github.com/yeyo11/agentry/issues/221)) ([89719d9](https://github.com/yeyo11/agentry/commit/89719d9871194f617413e5868d2fdfabde7b16fc))
* **web:** an editable Home kept per project, with Documents and Flow widgets (CW-34) ([#224](https://github.com/yeyo11/agentry/issues/224)) ([dde0292](https://github.com/yeyo11/agentry/commit/dde02921591d271cb9ccdf13747f01f56a1c8a91))


### Documentation

* **status:** three plans marked built, and what Night Shift still leaves ([#220](https://github.com/yeyo11/agentry/issues/220)) ([60342f7](https://github.com/yeyo11/agentry/commit/60342f7c718f701e3e23b0550fe20fe5838c119c))

## [0.35.0](https://github.com/yeyo11/agentry/compare/v0.34.0...v0.35.0) (2026-10-07)


### Features

* the Agentry assistant: a global entry, a confined chat and write tools the person confirms (CW-30, CW-18, CW-17) ([#216](https://github.com/yeyo11/agentry/issues/216)) ([e873846](https://github.com/yeyo11/agentry/commit/e87384663b4d76e30eaa2d2093fcec2af82b4f6e))


### Documentation

* final verification of the two roadmap plans (CW-7), CW-4 superseded, status brought up to date ([#217](https://github.com/yeyo11/agentry/issues/217)) ([161382c](https://github.com/yeyo11/agentry/commit/161382c11141607a292bd6960f2f3f8c4aa29013))

## [0.34.0](https://github.com/yeyo11/agentry/compare/v0.33.1...v0.34.0) (2026-10-07)


### Features

* choose the effort level wherever a model is chosen (CW-25) ([#215](https://github.com/yeyo11/agentry/issues/215)) ([0e58044](https://github.com/yeyo11/agentry/commit/0e580440961517f4efd08c7be14da80c8f7a89ca))
* **core:** every flow, agent file and assistant prompt records in English (CW-2) ([#204](https://github.com/yeyo11/agentry/issues/204)) ([ba558cc](https://github.com/yeyo11/agentry/commit/ba558ccf3326628e53f744bb1b356af43c882005))
* drop Jira from Agentry ([#211](https://github.com/yeyo11/agentry/issues/211)) ([cf3f582](https://github.com/yeyo11/agentry/commit/cf3f58259c0e001bc630622b5ba71eae9b7fc8b1))
* **orchestration:** cheaper worker checks and an e2e-specs task before the merge (CW-15) ([#213](https://github.com/yeyo11/agentry/issues/213)) ([5bf55d2](https://github.com/yeyo11/agentry/commit/5bf55d2f9532a05fcc6300b4ba7e67e2b550536a))
* **settings:** add hosts in the UI on top of AGENTRY_ALLOWED_HOSTS ([#194](https://github.com/yeyo11/agentry/issues/194)) ([f4db9bb](https://github.com/yeyo11/agentry/commit/f4db9bbda8259c1650a48a00db52fa137c8cc061))
* shorter orchestration chains, with planner guidance and a longest-chain hint (CW-16) ([#205](https://github.com/yeyo11/agentry/issues/205)) ([ac50698](https://github.com/yeyo11/agentry/commit/ac50698ed4d6d9ed72da944516668ef52efce95e))
* **trackers:** YouTrack through youtrack-app, recorded on an instance of our own (code hosts phase 5, step 2) ([#203](https://github.com/yeyo11/agentry/issues/203)) ([dc125c2](https://github.com/yeyo11/agentry/commit/dc125c2fc107462a09833af12fcaf5b30a950578))
* **tunnel:** remote access through tailscale serve instead of localhost.run ([#195](https://github.com/yeyo11/agentry/issues/195)) ([fbce38b](https://github.com/yeyo11/agentry/commit/fbce38b2b36ab7e0b4a583367e68f9f7512c38c3))
* **web:** every phone detail screen heads itself, with no app top bar (CW-8) ([#208](https://github.com/yeyo11/agentry/issues/208)) ([0e217cd](https://github.com/yeyo11/agentry/commit/0e217cdf297feec82a6830eff2d5ad723a8cb3ab))
* where an orchestration's time went, recorded, served and shown (CW-13) ([#210](https://github.com/yeyo11/agentry/issues/210)) ([0d000d4](https://github.com/yeyo11/agentry/commit/0d000d4598de02029b9c166468e010395c8e80c3))


### Bug fixes

* **core:** mask YouTrack's token too in what leaves the machine ([#209](https://github.com/yeyo11/agentry/issues/209)) ([8f81a77](https://github.com/yeyo11/agentry/commit/8f81a77207b69db9813189628b99ca1f937a27f5))
* **decisions:** mask Agentry's own tokens and keys in what leaves the machine ([#201](https://github.com/yeyo11/agentry/issues/201)) ([5ffa4e4](https://github.com/yeyo11/agentry/commit/5ffa4e4b504206fdd3c864dc85fd9fccc04ec9c5))
* **deps:** override source-map-js to 1.2.2 for GHSA-68fv-2mgg-jv7q ([#196](https://github.com/yeyo11/agentry/issues/196)) ([5153883](https://github.com/yeyo11/agentry/commit/51538838c9c52da382952dfc9424f239d9268e03))
* record Jev's cost from its input tokens and backfill history (CW-29) ([#212](https://github.com/yeyo11/agentry/issues/212)) ([168e04c](https://github.com/yeyo11/agentry/commit/168e04cd3bffcb056e090f02b71b45c7bd0cdbc7))
* **test:** runners time out and force their exit, and every api test shuts its Core down (CW-27) ([#214](https://github.com/yeyo11/agentry/issues/214)) ([914b794](https://github.com/yeyo11/agentry/commit/914b794203eca535e88507da2e33083ad02bb009))
* **web:** every flow run is its own link, a failed one shows its raw error and its retry (CW-20) ([#206](https://github.com/yeyo11/agentry/issues/206)) ([6c9be8e](https://github.com/yeyo11/agentry/commit/6c9be8e6b6f2b8d51bfa29deb8bf373201a72638))


### Build and packaging

* **deps-dev:** bump the dev-dependencies group across 1 directory with 5 updates ([#109](https://github.com/yeyo11/agentry/issues/109)) ([fd6b54a](https://github.com/yeyo11/agentry/commit/fd6b54ad3cceaaaa916d2b6b9d552ed67038c0ee))
* **deps:** bump docker/login-action from 3 to 4 ([#162](https://github.com/yeyo11/agentry/issues/162)) ([c1e3e4d](https://github.com/yeyo11/agentry/commit/c1e3e4d24e0717262be2ced88a3935d597e8efa9))
* **deps:** bump googleapis/release-please-action from 4 to 5 ([#161](https://github.com/yeyo11/agentry/issues/161)) ([5cd0f69](https://github.com/yeyo11/agentry/commit/5cd0f69e452f26776003a09c9449ea9a4bb1e49f))
* **deps:** the production group of [#200](https://github.com/yeyo11/agentry/issues/200), with the CSS parity floor following shiki 4.5 ([#202](https://github.com/yeyo11/agentry/issues/202)) ([f7ce383](https://github.com/yeyo11/agentry/commit/f7ce383881d98ab40da537c0dbfcce541c802fd4))
* **docker:** Node 26 image, pnpm from npm ([#199](https://github.com/yeyo11/agentry/issues/199)) ([4a777b4](https://github.com/yeyo11/agentry/commit/4a777b45119abc91273dddbd7a2fa979caf713a2))

## [0.33.1](https://github.com/yeyo11/agentry/compare/v0.33.0...v0.33.1) (2026-10-03)


### Bug fixes

* **e2e:** point CLAUDE_BIN at the fake CLI so fakeCli specs stop reaching the real one ([#190](https://github.com/yeyo11/agentry/issues/190)) ([a1aab18](https://github.com/yeyo11/agentry/commit/a1aab18e70cb20e6cf352118fb6626e99b017ffb))
* **providers:** Copilot reads its login from its state file and learns its models from chats ([#191](https://github.com/yeyo11/agentry/issues/191)) ([627bab7](https://github.com/yeyo11/agentry/commit/627bab7c4f1e7a8a1be2263ed21359667a251e1c))

## [0.33.0](https://github.com/yeyo11/agentry/compare/v0.32.0...v0.33.0) (2026-10-03)


### Features

* **hosts:** GitLab webhooks: register, test, remove, re-point and verify the signing token (phase 6, step 2) ([#181](https://github.com/yeyo11/agentry/issues/181)) ([8ee45be](https://github.com/yeyo11/agentry/commit/8ee45be9465742b9b529f7b14e10f27996cb0c3c))
* **providers:** rotation between providers at a usage limit, and claude-swap retired (multiple providers phase 4) ([#188](https://github.com/yeyo11/agentry/issues/188)) ([be1318f](https://github.com/yeyo11/agentry/commit/be1318fd54c741c035d462efe25f6bccd7b51206))


### Documentation

* commit the team's agent types, project skills and seven refined CW specs ([#184](https://github.com/yeyo11/agentry/issues/184)) ([d57d3a6](https://github.com/yeyo11/agentry/commit/d57d3a69fb836134240ddc40893c0a85b2831a10))
* **plans:** voice actions through Siri Shortcuts ([#187](https://github.com/yeyo11/agentry/issues/187)) ([0aa60e3](https://github.com/yeyo11/agentry/commit/0aa60e339b5609a8de6ba58861ba0dc9b3f918ba))
* record the CW-18 answers and the decision on authentication off ([#183](https://github.com/yeyo11/agentry/issues/183)) ([d8a2d4c](https://github.com/yeyo11/agentry/commit/d8a2d4c19d31946108f710e045832a451abaa5f1))

## [0.32.0](https://github.com/yeyo11/agentry/compare/v0.31.0...v0.32.0) (2026-10-02)


### Features

* **hosts:** the pacer, webhook receivers and GitHub hook registration, code hosts phase 6 (step 1) ([#177](https://github.com/yeyo11/agentry/issues/177)) ([1d47e75](https://github.com/yeyo11/agentry/commit/1d47e75a098c20a2c0bac3b5c30d589f25b821f4))
* **web:** the official logo of every program Agentry names ([#179](https://github.com/yeyo11/agentry/issues/179)) ([37320c6](https://github.com/yeyo11/agentry/commit/37320c64163b1e333d03d70e2fc802a97c2ce369))


### Documentation

* **plans:** record the decisions on providers phase 4 and assistant writes ([#180](https://github.com/yeyo11/agentry/issues/180)) ([ce74531](https://github.com/yeyo11/agentry/commit/ce745319fd13aec6dd1f4a091fedfac648ab0efd))

## [0.31.0](https://github.com/yeyo11/agentry/compare/v0.30.0...v0.31.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* **api:** lean orchestration list, compression and ETags; plan the format for model-facing tools ([#157](https://github.com/yeyo11/agentry/issues/157))

### Features

* **assistant:** Agentry's own MCP server with read tools, handed to chats (CW-6) ([#171](https://github.com/yeyo11/agentry/issues/171)) ([3414b9a](https://github.com/yeyo11/agentry/commit/3414b9a98d33c946410d901f6d647c22f419206f))
* **hosts:** GitHub and GitLab issues as trackers, code hosts phase 5 (step 1) ([#176](https://github.com/yeyo11/agentry/issues/176)) ([716d821](https://github.com/yeyo11/agentry/commit/716d8216cfd04ae0859c22a348768adaef365a67))
* **hosts:** merging with a head guard, auto-merge and blocked states, code hosts phase 4 ([#175](https://github.com/yeyo11/agentry/issues/175)) ([aafcce1](https://github.com/yeyo11/agentry/commit/aafcce1ccc151b76faa07c6962fd8b1c9803c225))
* **hosts:** reviews, threads and Address with an agent, code hosts phase 3 ([#174](https://github.com/yeyo11/agentry/issues/174)) ([199b625](https://github.com/yeyo11/agentry/commit/199b625539ab41df358d4afc02b12bf240b76218))
* **providers:** Codex, Copilot, Gemini and OpenCode drivers, multiple providers phase 3 ([#167](https://github.com/yeyo11/agentry/issues/167)) ([7c7b6e0](https://github.com/yeyo11/agentry/commit/7c7b6e03b6a43e235be004e4b273e5575d00b0df))


### Bug fixes

* **core:** finalize a chat once its output is read, so a failure keeps its reason ([#173](https://github.com/yeyo11/agentry/issues/173)) ([63b9fad](https://github.com/yeyo11/agentry/commit/63b9fad5b31c319d5d6052d72902ddceff6d6812))
* **desktop:** give the first-run step and the sign-in a drag region so the mouse works on Wayland ([#170](https://github.com/yeyo11/agentry/issues/170)) ([0ef1e5c](https://github.com/yeyo11/agentry/commit/0ef1e5ccff120518386ed1c488daf873570d1993))


### Performance

* **api:** lean orchestration list, compression and ETags; plan the format for model-facing tools ([#157](https://github.com/yeyo11/agentry/issues/157)) ([10feb0f](https://github.com/yeyo11/agentry/commit/10feb0fcd4cf1d3b1dd41aa42f67e96f1248dffb))


### Documentation

* **plans:** plan multiple providers phase 4 ([#172](https://github.com/yeyo11/agentry/issues/172)) ([6c6398e](https://github.com/yeyo11/agentry/commit/6c6398e84902f7c8262785d543f90d6cb482e2df))

## [0.30.0](https://github.com/yeyo11/agentry/compare/v0.29.1...v0.30.0) (2026-10-01)


### Features

* **core:** put Claude Code behind a provider driver ([#155](https://github.com/yeyo11/agentry/issues/155)) ([31905a3](https://github.com/yeyo11/agentry/commit/31905a3085c2a2313d3c6b07896edfd9a7ee0786))
* **hosts:** CI checks and fixing them, code hosts phase 2 ([#165](https://github.com/yeyo11/agentry/issues/165)) ([d57069b](https://github.com/yeyo11/agentry/commit/d57069b3cbb09719ad8462c7686b6098a2516136))
* **hosts:** GitHub and GitLab as code hosts, phase 1 ([#159](https://github.com/yeyo11/agentry/issues/159)) ([654745f](https://github.com/yeyo11/agentry/commit/654745f09a7c91a401ab2cbc8580b5bd219df28b))


### Bug fixes

* **e2e:** wait on conditions, not on time ([#166](https://github.com/yeyo11/agentry/issues/166)) ([93b4f7c](https://github.com/yeyo11/agentry/commit/93b4f7ce07e8e4613b75fca70c3a4ea9d2c66bde))


### Refactoring

* **web:** split the web UI into @agentry/ui and @agentry/chat-ui ([#156](https://github.com/yeyo11/agentry/issues/156)) ([f994c06](https://github.com/yeyo11/agentry/commit/f994c06e55abf29383c4a4bab9d8a22991edd3e3))


### Documentation

* **plans:** plan phase 3 of multiple providers from recorded CLI facts ([#163](https://github.com/yeyo11/agentry/issues/163)) ([7242b4f](https://github.com/yeyo11/agentry/commit/7242b4fee4455dcf60f7e8d891b564b5b20f6075))
* **plans:** verify roadmap-completion and post-roadmap against main ([#164](https://github.com/yeyo11/agentry/issues/164)) ([1af4427](https://github.com/yeyo11/agentry/commit/1af4427008da39d223f59e4ce18dc137940b966c))

## [0.29.1](https://github.com/yeyo11/agentry/compare/v0.29.0...v0.29.1) (2026-09-30)


### Bug fixes

* **decisions:** score notification.urgency only when the push was opened ([#153](https://github.com/yeyo11/agentry/issues/153)) ([aec1bab](https://github.com/yeyo11/agentry/commit/aec1bab2262a6b12b81b71a0901ed543ac0f5d5e))

## [0.29.0](https://github.com/yeyo11/agentry/compare/v0.28.0...v0.29.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* chats, projects and Agentry's own model ([#60](https://github.com/yeyo11/agentry/issues/60))
* **api:** GET /api/system returns `version` instead of `wrapperVersion`.

### Features

* answer a run's permission prompts from the panel ([e641538](https://github.com/yeyo11/agentry/commit/e6415382f6d3e6b6274a2f2bcab664ad6411ae58))
* **api:** extract startServer so the API can be embedded ([4940af7](https://github.com/yeyo11/agentry/commit/4940af77e5d0afb9472fee4ea95dec2c1ff721d2))
* **api:** rename SystemInfo.wrapperVersion to version ([996289b](https://github.com/yeyo11/agentry/commit/996289b67d1bb1916989eed45023cb876e47cb9f))
* **chat:** attach files to messages ([efa4614](https://github.com/yeyo11/agentry/commit/efa4614daa224ddb89205cefc4ecc1831c31c70a))
* **chat:** attach files to messages ([c24ed5e](https://github.com/yeyo11/agentry/commit/c24ed5e03b2e4e4205e0abde554ab7be2cf1000e))
* chats, projects and Agentry's own model ([#60](https://github.com/yeyo11/agentry/issues/60)) ([f78fab7](https://github.com/yeyo11/agentry/commit/f78fab7b057c613190f60f5c380b8a5164f058d6))
* **chats:** give every chat Agentry starts its own API token ([#133](https://github.com/yeyo11/agentry/issues/133)) ([8c1406d](https://github.com/yeyo11/agentry/commit/8c1406dad92ee0dfad6a4bcbabd8ea3f53a51095))
* close what the roadmap left open after [#60](https://github.com/yeyo11/agentry/issues/60) and [#62](https://github.com/yeyo11/agentry/issues/62) ([#64](https://github.com/yeyo11/agentry/issues/64)) ([161cff2](https://github.com/yeyo11/agentry/commit/161cff2af7930fab299f51573d25b8039b6fbd43))
* continue a terminal session in Agentry, or in a copy of it ([#41](https://github.com/yeyo11/agentry/issues/41)) ([2246e54](https://github.com/yeyo11/agentry/commit/2246e5491156d1fcde79c5d68059a66b288c487b))
* **core:** tell every chat which wrapper runs it ([#107](https://github.com/yeyo11/agentry/issues/107)) ([3bd4c04](https://github.com/yeyo11/agentry/commit/3bd4c04ce2384d6b6bab61a6b7287fbd08777744))
* decision engine with TypeSafe's Jev (beta) ([#141](https://github.com/yeyo11/agentry/issues/141)) ([6eec081](https://github.com/yeyo11/agentry/commit/6eec081b9769c1dac5e8bf2c50662ae503953730))
* **decisions:** shadow-accuracy resolvers for palette.intent, notification.urgency and orchestration.model ([#144](https://github.com/yeyo11/agentry/issues/144)) ([b1c29ec](https://github.com/yeyo11/agentry/commit/b1c29ec26191eb8b01b0f4d21a98802c6d3fa79b))
* **desktop:** Linux desktop app (AppImage and .deb) ([41ab148](https://github.com/yeyo11/agentry/commit/41ab14872c2ec5b9327903475cf542756218f727))
* **desktop:** one-line installer ([5255811](https://github.com/yeyo11/agentry/commit/52558115ad93252076cea9879f55abdd5c0ee0ae))
* **desktop:** package an AppImage and a .deb and publish them on release ([87ccdd3](https://github.com/yeyo11/agentry/commit/87ccdd3ead0ebb4ecb2b11ebe17201a4d35fba10))
* detect agent providers, with a first-run step and Settings → Providers ([#150](https://github.com/yeyo11/agentry/issues/150)) ([48bd066](https://github.com/yeyo11/agentry/commit/48bd066f933109dc8211840847ce403bdff25187))
* finish the roadmap's Next section ([#62](https://github.com/yeyo11/agentry/issues/62)) ([db276e6](https://github.com/yeyo11/agentry/commit/db276e65e25a0a6740d70e7e69ee2e358ea0c0af))
* **flow:** offer to start the cards already waiting when the flow is switched on ([#123](https://github.com/yeyo11/agentry/issues/123)) ([faaa7f9](https://github.com/yeyo11/agentry/commit/faaa7f9c8b9641c18eb3e54d4497d09c02ce90bd))
* full control of runs from the panel through the CLI control protocol ([#37](https://github.com/yeyo11/agentry/issues/37)) ([a79cb39](https://github.com/yeyo11/agentry/commit/a79cb39ae367c5a9980b0253e40bb1e0f818d4c4))
* improve task orchestration, transcript performance, and i18n [#54](https://github.com/yeyo11/agentry/issues/54)) ([0ffa2c7](https://github.com/yeyo11/agentry/commit/0ffa2c7c5111644f9d2ca794ed14a61291371f0b))
* install a pinned claude-swap from the app for multiple accounts ([#104](https://github.com/yeyo11/agentry/issues/104)) ([815d9bd](https://github.com/yeyo11/agentry/commit/815d9bdfd70c235fe015705716dd4a4f6d71c81c))
* install Agentry on a phone, and push to it with the app closed ([#76](https://github.com/yeyo11/agentry/issues/76)) ([7ef73d9](https://github.com/yeyo11/agentry/commit/7ef73d9aa118b259556c4bbe1bba5880d074e891))
* interruption level for notifications, and mobile layout fixes ([#93](https://github.com/yeyo11/agentry/issues/93)) ([5b05df2](https://github.com/yeyo11/agentry/commit/5b05df2b41bad5e1196ef7e03bb672974bcc8a77))
* live event feed, notifications and full execution detail ([#47](https://github.com/yeyo11/agentry/issues/47)) ([c772df7](https://github.com/yeyo11/agentry/commit/c772df751c21648b0f27df1fadc501e7ac0ebc20))
* **orchestration:** deliver one integrated branch ([4d09c4b](https://github.com/yeyo11/agentry/commit/4d09c4b876d2ea25607c28d7bb6f8e4b60a04921))
* **orchestration:** deliver one integrated branch ([0d20cf1](https://github.com/yeyo11/agentry/commit/0d20cf17965f35fc593b58419895011df25aa7d8))
* **orchestration:** give each task its own git worktree ([3109982](https://github.com/yeyo11/agentry/commit/3109982d67979079d05c5c132d4febb33b3ded1e))
* **orchestration:** pre-authorise the tools workers may use ([b3e0cfd](https://github.com/yeyo11/agentry/commit/b3e0cfdb40420621072246509313bcb10d9ebd48))
* **orchestration:** record planner drafts and let the UI watch and recover them ([2b3c0eb](https://github.com/yeyo11/agentry/commit/2b3c0eb6148fccd73e11bfb4fe9e652ebc13672e))
* **orchestration:** remove the worktrees a graph left behind ([a6e76eb](https://github.com/yeyo11/agentry/commit/a6e76ebb0e63f1041f8a0cdca6c7b2b0897c0fc0))
* **orchestration:** resume a graph that was interrupted ([a6f993f](https://github.com/yeyo11/agentry/commit/a6f993f702700df54b8b6a3f5410c1ec72a094ce))
* **orchestration:** resume with corrected settings, delete, honest progress ([afabe9c](https://github.com/yeyo11/agentry/commit/afabe9cdb941581596368bbf4f480c190f9931b1))
* **orchestration:** resume with corrected settings, delete, honest progress ([51b23e7](https://github.com/yeyo11/agentry/commit/51b23e7f626518b714f25f2936cb3741cbc540db))
* **orchestration:** run a graph as a Claude Code workflow ([#44](https://github.com/yeyo11/agentry/issues/44)) ([63442bc](https://github.com/yeyo11/agentry/commit/63442bcfa19c560563c837cad2765a131d1c9394))
* **orchestration:** run verification checks in parallel groups and tell the fixer which specs failed ([#134](https://github.com/yeyo11/agentry/issues/134)) ([59c00d4](https://github.com/yeyo11/agentry/commit/59c00d4f3818bb1b290e80ba5c377eea4a3517b3))
* page long transcripts from the API and window them in the UI ([3f79a06](https://github.com/yeyo11/agentry/commit/3f79a0690588418405afbf0d455b86fb9a1ad040))
* project ecosystem with boards, team and flow, documents and the project assistant ([#118](https://github.com/yeyo11/agentry/issues/118)) ([1eac40b](https://github.com/yeyo11/agentry/commit/1eac40b8ced0a0525771b6f9ded690e5b4a94dad))
* **projects:** nest worktrees under their repository and show where work happens ([c99075d](https://github.com/yeyo11/agentry/commit/c99075d95c006b7bf2bd3702fe13b225ca876e89))
* **projects:** nest worktrees under their repository and show where work happens ([f60fce3](https://github.com/yeyo11/agentry/commit/f60fce3f2f51bc1c1d8866096f6159cb477c3003))
* **prompts:** follow the Opus 5.5 and Sonnet 5.5 prompting guides in every prompt Agentry writes ([#131](https://github.com/yeyo11/agentry/issues/131)) ([7d8ed6c](https://github.com/yeyo11/agentry/commit/7d8ed6cc433d1b7debf89fac69cb89742da35c9c))
* **runs:** let a run name who answers its permission prompts ([13d5a42](https://github.com/yeyo11/agentry/commit/13d5a42a7bbe36c2ca1668a0c922917195aed7ee))
* **sessions:** open a transcript on its newest message and add a jump control ([2438cae](https://github.com/yeyo11/agentry/commit/2438cae062b6f6f03a4781182dd2ed0a90787251))
* show the background agents of sessions started from a terminal ([243e8af](https://github.com/yeyo11/agentry/commit/243e8af76e335b9d71b8fbc59b18c2e6f41c56d5))
* show the background agents of sessions started from a terminal ([a258c85](https://github.com/yeyo11/agentry/commit/a258c85a35e5f87fc1d53a87fb806bc09d5f3e07))
* tell Claude Code's tasks apart and show its workflows ([#42](https://github.com/yeyo11/agentry/issues/42)) ([da0339d](https://github.com/yeyo11/agentry/commit/da0339d5d25ee9581cb5bd30fdab361dc854b334))
* use the CLI for background sessions, project state and budgets ([a801cb9](https://github.com/yeyo11/agentry/commit/a801cb9bd1aeef809edb9ee9d14d8ec1842136c6))
* **web:** add Radix-based form control primitives ([66a2451](https://github.com/yeyo11/agentry/commit/66a245138e7fbaf18e82dc1afe454f4272e724d9))
* **web:** lists keep their filters until reset, and phone layout polish ([#113](https://github.com/yeyo11/agentry/issues/113)) ([71d693b](https://github.com/yeyo11/agentry/commit/71d693b5dfd812323949ca903432425e6073486b))
* **web:** move every native control onto the Radix primitives ([7717d71](https://github.com/yeyo11/agentry/commit/7717d719ef7e0bce090ae84eeeec491fefa32b7b))
* **web:** offer the slash commands when a message starts with / ([#99](https://github.com/yeyo11/agentry/issues/99)) ([1e77220](https://github.com/yeyo11/agentry/commit/1e77220e8bae970d29c79565606e076b35c88416))
* **web:** render Claude's answers as markdown with highlighted code ([#38](https://github.com/yeyo11/agentry/issues/38)) ([47ad9f8](https://github.com/yeyo11/agentry/commit/47ad9f889a2d5bff7f9e4c1d438128f3443fcaf3))
* **web:** the chat on a phone, and the models the CLI really offers ([e4d6064](https://github.com/yeyo11/agentry/commit/e4d6064943e799307daa03e34290dc2408110867))
* **work-items:** an approved card opens its pull request, and a merged one reaches Done ([#130](https://github.com/yeyo11/agentry/issues/130)) ([e58ea57](https://github.com/yeyo11/agentry/commit/e58ea57a1d9edbf14c41f25c7aec1dce0cad6a7b))


### Bug fixes

* **agents:** locate isolated subagents in their own worktree ([d048284](https://github.com/yeyo11/agentry/commit/d048284a18a2dd45e16ba6a8606ddc04e4ad2922))
* **api:** an allowed host may be a `*.domain` pattern ([#80](https://github.com/yeyo11/agentry/issues/80)) ([3e5d21c](https://github.com/yeyo11/agentry/commit/3e5d21c1ea96939c15081a20f6bfeb4056fed307))
* app-updates follow-up — AppImage relaunch, Docker commands, .deb elevation, ELECTRON_RUN_AS_NODE ([#97](https://github.com/yeyo11/agentry/issues/97)) ([306d605](https://github.com/yeyo11/agentry/commit/306d6054b9000f262a2bebe27b6a70a89867d415))
* bind to loopback, refuse an unknown Host, and stop handing out the credentials ([#77](https://github.com/yeyo11/agentry/issues/77)) ([17e76d1](https://github.com/yeyo11/agentry/commit/17e76d132f8e90eaeb3af8924185c946d238b3e5))
* chat inspector drawer flush to the edge, and the chat stream opens at once ([#67](https://github.com/yeyo11/agentry/issues/67)) ([015bc51](https://github.com/yeyo11/agentry/commit/015bc51d11e28ad36a9dae34e9cb848aeaf79364))
* **core:** judge a command by the stage that does the work, not a trailing echo ([#63](https://github.com/yeyo11/agentry/issues/63)) ([d130694](https://github.com/yeyo11/agentry/commit/d130694c47ac00b422bf117c8b44f7fdb48aef4e))
* **core:** list monitors started by CLI sessions as background tasks ([#52](https://github.com/yeyo11/agentry/issues/52)) ([f645950](https://github.com/yeyo11/agentry/commit/f64595085bd7c10f96003903705f43057c2ba3ba))
* **core:** move a pinned chat off the account that hit its limit ([#106](https://github.com/yeyo11/agentry/issues/106)) ([2614ef1](https://github.com/yeyo11/agentry/commit/2614ef1eee6ee0a36ca3f8a757e6f044fb673248))
* **core:** restore the Core facade the 0.7.0 release commit reverted ([b05b2ee](https://github.com/yeyo11/agentry/commit/b05b2ee76ebccf02b620280c010921e5a489ad5c))
* **core:** restore the Core facade the 0.7.0 release commit reverted ([e357fdd](https://github.com/yeyo11/agentry/commit/e357fdda9814a1ff43514d70c465e4e85030494a))
* **desktop:** keep the port the app listened on, instead of a new one each launch ([#82](https://github.com/yeyo11/agentry/issues/82)) ([0bd7cea](https://github.com/yeyo11/agentry/commit/0bd7cea035564a1edc21df4123176328ece009c5))
* **desktop:** show the app icon on the running window ([22123ea](https://github.com/yeyo11/agentry/commit/22123eae5c07cac9158f9f1607b7115ef52f2986))
* **flow:** bring an item's tied documents into its worktree before a flow run ([#124](https://github.com/yeyo11/agentry/issues/124)) ([b45538d](https://github.com/yeyo11/agentry/commit/b45538dd61b5a7341dfd3c753b209e7d277d66db))
* **flow:** let QA run the project's check scripts in their short form ([#132](https://github.com/yeyo11/agentry/issues/132)) ([cf353ab](https://github.com/yeyo11/agentry/commit/cf353ab08ecf389d1e24be757fa343f8d997b813))
* **push:** a VAPID subject Apple accepts, and the reason when it does not ([#85](https://github.com/yeyo11/agentry/issues/85)) ([3981af3](https://github.com/yeyo11/agentry/commit/3981af36f833255a1fed4aa6f1b08538a6e3432b))
* read background work from disk so no screen depends on the live stream ([df9ae76](https://github.com/yeyo11/agentry/commit/df9ae76bf47319822897f0a179603613a3e6cd83))
* read background work from disk so no screen depends on the live stream ([56a203c](https://github.com/yeyo11/agentry/commit/56a203cb08d2ba2405c304984405dd97bdcf7fe8))
* **release:** attach the packages before publishing an immutable release ([#40](https://github.com/yeyo11/agentry/issues/40)) ([25386ac](https://github.com/yeyo11/agentry/commit/25386acdfde87aff61de9e8608c4944c7a018175))
* **release:** publish the version tags on the image ([b5097be](https://github.com/yeyo11/agentry/commit/b5097be79148ed54e2ee6ba16f8e05f28c71a25a))
* **release:** stop the release PR from rewriting source to bump the version ([1b8a738](https://github.com/yeyo11/agentry/commit/1b8a738328db41446a467376ca47ec94e931a27b))
* **release:** stop the release PR from rewriting source to bump the version ([0697b9d](https://github.com/yeyo11/agentry/commit/0697b9d503304e7d16e871c0ae4442f0836ac20f))
* resolve waitForResult for a run that already ended ([7f92a5d](https://github.com/yeyo11/agentry/commit/7f92a5dc2bfb1b21e255449993804c5a05a9ca54))
* **runs:** keep internal runs across a restart so the planner stops vanishing ([2ca484e](https://github.com/yeyo11/agentry/commit/2ca484ef5c832457b6ab857d3194faf6b1b0132a))
* show the output of slash commands and keep the chat's model ([#98](https://github.com/yeyo11/agentry/issues/98)) ([aaa771a](https://github.com/yeyo11/agentry/commit/aaa771a1ba4ed3fc9447fa10ddc77aa734c5ae79))
* stop the desktop tray from locking the owner out of a token-guarded server ([#129](https://github.com/yeyo11/agentry/issues/129)) ([fefd386](https://github.com/yeyo11/agentry/commit/fefd386cbfd680b07ff47c8599865cfce53d5919))
* the recovery paths, which the happy path had been hiding ([#83](https://github.com/yeyo11/agentry/issues/83)) ([cc939f7](https://github.com/yeyo11/agentry/commit/cc939f75141a2212ad6b5cdf5bb2e7dfe010fe1b))
* **web:** colour code blocks the way shiki does, measured ([#56](https://github.com/yeyo11/agentry/issues/56)) ([d6560e1](https://github.com/yeyo11/agentry/commit/d6560e19a390704d538a883167bd6deff94bfa98))
* **web:** count live sessions on the Sessions nav item ([c51923e](https://github.com/yeyo11/agentry/commit/c51923e6918b0b042011ed323996546b2b54d13c))
* **web:** give the changes review its own cache key for a work item ([#122](https://github.com/yeyo11/agentry/issues/122)) ([aec6b38](https://github.com/yeyo11/agentry/commit/aec6b38a7ecb6bf86cdcfb2d1054421b6879755c))
* **web:** keep the changes summary inside its panel and make the lens switch keyboard-reachable ([#116](https://github.com/yeyo11/agentry/issues/116)) ([d85446e](https://github.com/yeyo11/agentry/commit/d85446eaa57ea73ce80208ce9c421aafbd6d8770))
* **web:** let a tooltip come and go without remounting its child ([4a9fe0c](https://github.com/yeyo11/agentry/commit/4a9fe0c255a8d7629885e399ff529407c0c9dce9))
* **web:** show pushes on iOS and test pushes while the app is open ([#111](https://github.com/yeyo11/agentry/issues/111)) ([9a087b6](https://github.com/yeyo11/agentry/commit/9a087b6289c499b43db7780d4be9620d9c49e345))
* **web:** sticky bars flush with the page's edges, chat header under the top bar, logo on phones ([#69](https://github.com/yeyo11/agentry/issues/69)) ([2868ed4](https://github.com/yeyo11/agentry/commit/2868ed437784f3febf02ccab2835338f3c0793df))
* **web:** stop the run view freezing while typing a message ([#50](https://github.com/yeyo11/agentry/issues/50)) ([0209347](https://github.com/yeyo11/agentry/commit/020934737f9c2ab98b70b5c5520e674f26fb2710))
* **web:** the chat takes the whole width, so its drawer reaches the edge ([#71](https://github.com/yeyo11/agentry/issues/71)) ([0e179c7](https://github.com/yeyo11/agentry/commit/0e179c7884e26614d244d7ac98299b7e0fe0ab09))
* **web:** the pages of a chat read back survive leaving it ([#87](https://github.com/yeyo11/agentry/issues/87)) ([695bccb](https://github.com/yeyo11/agentry/commit/695bccbf2408f555f36a62e3c7b0b6ea5819e867))


### Performance

* **core:** chats list and chat detail stop re-reading the machine on every request ([#72](https://github.com/yeyo11/agentry/issues/72)) ([73aca06](https://github.com/yeyo11/agentry/commit/73aca06b17ad4ad51631fbfe30c03950a87d4d53))
* **web:** keep the lazy form controls out of the first paint ([9f2668e](https://github.com/yeyo11/agentry/commit/9f2668e82775efa3e5c7b427d0458ccee9efff98))
* **web:** merge highlighted tokens into coloured runs ([dea38a3](https://github.com/yeyo11/agentry/commit/dea38a33ad8421e214b784bda21350eba76a65d4))
* **web:** render answers with @tanstack/markdown instead of react-markdown ([e7c2c25](https://github.com/yeyo11/agentry/commit/e7c2c2543a8699072499fcb5ea918f9844f461fe))
* **web:** the chat view streams without re-rendering or re-reading the page ([#73](https://github.com/yeyo11/agentry/issues/73)) ([567c045](https://github.com/yeyo11/agentry/commit/567c0452955b9e1c970dd6851f385cfec3d07694))
* **web:** the chats list stops rereading itself on every event ([#74](https://github.com/yeyo11/agentry/issues/74)) ([7ea9407](https://github.com/yeyo11/agentry/commit/7ea9407f52f73606d39799a11d3449d8982b7be4))


### Refactoring

* **core:** keep the upload store wiring apart from neighbouring changes ([7d7f743](https://github.com/yeyo11/agentry/commit/7d7f7435323cd153e9ba1b6db80dc812824684d6))
* **orchestration:** let the CLI create the worktrees ([684799f](https://github.com/yeyo11/agentry/commit/684799fe8b58bb6188356d8b78274b6477c6f784))
* **web:** build the scope picker on the Radix popover ([b213ba6](https://github.com/yeyo11/agentry/commit/b213ba67d9adcbc97112c235f5b82d752a818567))


### Documentation

* describe the themed form controls and when to use each one ([e8a515f](https://github.com/yeyo11/agentry/commit/e8a515f518346b406842ebace40955bd8730e157))
* describe what landed since the first release ([0e17de3](https://github.com/yeyo11/agentry/commit/0e17de3bb83ba3f9750cc38c8710090cffb5ae0b))
* **desktop:** document the Linux desktop app ([8f99700](https://github.com/yeyo11/agentry/commit/8f9970014ca0b26d1b749e3d446d58daf73892fa))
* note what 0.11.0 left for the observability work ([#49](https://github.com/yeyo11/agentry/issues/49)) ([0d38623](https://github.com/yeyo11/agentry/commit/0d38623990aada865b7f5a67c551cd3c311fa1a8))
* note which modules may import the controls barrel ([f96c9b8](https://github.com/yeyo11/agentry/commit/f96c9b8dcbe6d406c92c517d5c10b23e1eaecf59))
* plan agent observability and make it the top roadmap priority ([#46](https://github.com/yeyo11/agentry/issues/46)) ([c25acd3](https://github.com/yeyo11/agentry/commit/c25acd372206097210ca28151aa09cd3f285162d))
* plan the decision engine on main, and add its bounded exception to the one rule ([#138](https://github.com/yeyo11/agentry/issues/138)) ([e7519f8](https://github.com/yeyo11/agentry/commit/e7519f86765b8f497bc5f4d5e1e5e6a6801590b1))
* **plans:** plan code hosts and issue trackers through their CLIs ([#149](https://github.com/yeyo11/agentry/issues/149)) ([6dcb3b2](https://github.com/yeyo11/agentry/commit/6dcb3b253a37d0fb679b78577b12b01775f90692))
* **plans:** plan multiple agent providers ([#147](https://github.com/yeyo11/agentry/issues/147)) ([4735d55](https://github.com/yeyo11/agentry/commit/4735d55673185920f48dea3a340e04c062d254a1))
* **plans:** record the owner's answers to the three open questions of faster orchestrations ([#137](https://github.com/yeyo11/agentry/issues/137)) ([a9919e2](https://github.com/yeyo11/agentry/commit/a9919e288261e3c2a08d26f0731528de26b43809))
* re-record the tour and the accounts still with the themed controls ([a545f3f](https://github.com/yeyo11/agentry/commit/a545f3ff051718b6215d464e6731f9e0f5fab71a))
* record the project ecosystem as merged in [#118](https://github.com/yeyo11/agentry/issues/118) ([#125](https://github.com/yeyo11/agentry/issues/125)) ([51a6c3a](https://github.com/yeyo11/agentry/commit/51a6c3a3abdf6ada1b222884b626a1e9f6cac78e))
* record the queued plans and the English-language decision ([#120](https://github.com/yeyo11/agentry/issues/120)) ([6412c44](https://github.com/yeyo11/agentry/commit/6412c44ce3cd57522d556b3356c298c298f07c0c))
* **reports:** Jev in shadow, first measurements ([#143](https://github.com/yeyo11/agentry/issues/143)) ([75a6664](https://github.com/yeyo11/agentry/commit/75a6664a98d01d8f9fe4487035c3de79356635e6))
* sync the documentation with the code ([#35](https://github.com/yeyo11/agentry/issues/35)) ([b93e0fa](https://github.com/yeyo11/agentry/commit/b93e0fa55526fe5d98fecabafef005ce1da96fe2))
* where the project stands, and the knowledge base that keeps it ([#89](https://github.com/yeyo11/agentry/issues/89)) ([90f46c0](https://github.com/yeyo11/agentry/commit/90f46c0746046b1c96628d7913cb0b7c4ccc851c))


### Build and packaging

* automate releases with release-please ([85f4d4b](https://github.com/yeyo11/agentry/commit/85f4d4b10e66cff545112b9a25e9ecdf2b1e539d))
* **deps:** bump actions/attest-build-provenance from 2 to 4 ([45df85c](https://github.com/yeyo11/agentry/commit/45df85cd4f70193f52e8524380469d2dd91429c6))
* **deps:** bump actions/attest-build-provenance from 2 to 4 ([443b605](https://github.com/yeyo11/agentry/commit/443b6054bcda5519e15ce6f35fbd6f13c6f80441))
* **deps:** bump actions/checkout from 4 to 7 ([02aa7f6](https://github.com/yeyo11/agentry/commit/02aa7f6ae367d51ddd07561301c2835b5354157b))
* **deps:** bump actions/checkout from 4 to 7 ([77c3abe](https://github.com/yeyo11/agentry/commit/77c3abe9a21b7d69ae470ecd004760a9b6f20518))
* **deps:** bump docker/build-push-action from 6 to 7 ([8439b6c](https://github.com/yeyo11/agentry/commit/8439b6c16ee7197093e4621571f01bc8a52984c3))
* **deps:** bump docker/build-push-action from 6 to 7 ([4600a72](https://github.com/yeyo11/agentry/commit/4600a7234889db6dd92cd29250ff3e5e85fa1e60))
* **deps:** bump docker/metadata-action from 5 to 6 ([d526aa3](https://github.com/yeyo11/agentry/commit/d526aa3f6f4922646d7b3e9ef7f0b596c46d6e65))
* **deps:** bump docker/metadata-action from 5 to 6 ([180aa2b](https://github.com/yeyo11/agentry/commit/180aa2bd9a419d62194df33ca1b80a866f17957c))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([7ee9ef9](https://github.com/yeyo11/agentry/commit/7ee9ef9b51034fb1786ca1a2c866f3f454770733))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([3b7495f](https://github.com/yeyo11/agentry/commit/3b7495f1a2fff0b7a0d5e5ac8f3a8837b4cbb43a))
* grant the image permissions on the calling jobs ([a213867](https://github.com/yeyo11/agentry/commit/a213867d8f60b416854cec3d125bc227e8fc2fbf))

## [0.28.0](https://github.com/yeyo11/agentry/compare/v0.27.0...v0.28.0) (2026-09-30)


### Features

* detect agent providers, with a first-run step and Settings → Providers ([#150](https://github.com/yeyo11/agentry/issues/150)) ([48bd066](https://github.com/yeyo11/agentry/commit/48bd066f933109dc8211840847ce403bdff25187))


### Documentation

* **plans:** plan code hosts and issue trackers through their CLIs ([#149](https://github.com/yeyo11/agentry/issues/149)) ([6dcb3b2](https://github.com/yeyo11/agentry/commit/6dcb3b253a37d0fb679b78577b12b01775f90692))
* **plans:** plan multiple agent providers ([#147](https://github.com/yeyo11/agentry/issues/147)) ([4735d55](https://github.com/yeyo11/agentry/commit/4735d55673185920f48dea3a340e04c062d254a1))

## [0.27.0](https://github.com/yeyo11/agentry/compare/v0.26.0...v0.27.0) (2026-09-30)


### Features

* **decisions:** shadow-accuracy resolvers for palette.intent, notification.urgency and orchestration.model ([#144](https://github.com/yeyo11/agentry/issues/144)) ([b1c29ec](https://github.com/yeyo11/agentry/commit/b1c29ec26191eb8b01b0f4d21a98802c6d3fa79b))


### Documentation

* **reports:** Jev in shadow, first measurements ([#143](https://github.com/yeyo11/agentry/issues/143)) ([75a6664](https://github.com/yeyo11/agentry/commit/75a6664a98d01d8f9fe4487035c3de79356635e6))

## [0.26.0](https://github.com/yeyo11/agentry/compare/v0.25.1...v0.26.0) (2026-09-30)


### Features

* decision engine with TypeSafe's Jev (beta) ([#141](https://github.com/yeyo11/agentry/issues/141)) ([6eec081](https://github.com/yeyo11/agentry/commit/6eec081b9769c1dac5e8bf2c50662ae503953730))

## [0.25.1](https://github.com/yeyo11/agentry/compare/v0.25.0...v0.25.1) (2026-09-30)


### Documentation

* plan the decision engine on main, and add its bounded exception to the one rule ([#138](https://github.com/yeyo11/agentry/issues/138)) ([e7519f8](https://github.com/yeyo11/agentry/commit/e7519f86765b8f497bc5f4d5e1e5e6a6801590b1))

## [0.25.0](https://github.com/yeyo11/agentry/compare/v0.24.0...v0.25.0) (2026-09-30)


### Features

* **chats:** give every chat Agentry starts its own API token ([#133](https://github.com/yeyo11/agentry/issues/133)) ([8c1406d](https://github.com/yeyo11/agentry/commit/8c1406dad92ee0dfad6a4bcbabd8ea3f53a51095))
* **orchestration:** run verification checks in parallel groups and tell the fixer which specs failed ([#134](https://github.com/yeyo11/agentry/issues/134)) ([59c00d4](https://github.com/yeyo11/agentry/commit/59c00d4f3818bb1b290e80ba5c377eea4a3517b3))
* **prompts:** follow the Opus 5.5 and Sonnet 5.5 prompting guides in every prompt Agentry writes ([#131](https://github.com/yeyo11/agentry/issues/131)) ([7d8ed6c](https://github.com/yeyo11/agentry/commit/7d8ed6cc433d1b7debf89fac69cb89742da35c9c))
* **work-items:** an approved card opens its pull request, and a merged one reaches Done ([#130](https://github.com/yeyo11/agentry/issues/130)) ([e58ea57](https://github.com/yeyo11/agentry/commit/e58ea57a1d9edbf14c41f25c7aec1dce0cad6a7b))


### Bug fixes

* **flow:** let QA run the project's check scripts in their short form ([#132](https://github.com/yeyo11/agentry/issues/132)) ([cf353ab](https://github.com/yeyo11/agentry/commit/cf353ab08ecf389d1e24be757fa343f8d997b813))


### Documentation

* **plans:** record the owner's answers to the three open questions of faster orchestrations ([#137](https://github.com/yeyo11/agentry/issues/137)) ([a9919e2](https://github.com/yeyo11/agentry/commit/a9919e288261e3c2a08d26f0731528de26b43809))

## [0.24.0](https://github.com/yeyo11/agentry/compare/v0.23.1...v0.24.0) (2026-09-29)


### Features

* **flow:** offer to start the cards already waiting when the flow is switched on ([#123](https://github.com/yeyo11/agentry/issues/123)) ([faaa7f9](https://github.com/yeyo11/agentry/commit/faaa7f9c8b9641c18eb3e54d4497d09c02ce90bd))


### Bug fixes

* **flow:** bring an item's tied documents into its worktree before a flow run ([#124](https://github.com/yeyo11/agentry/issues/124)) ([b45538d](https://github.com/yeyo11/agentry/commit/b45538dd61b5a7341dfd3c753b209e7d277d66db))
* stop the desktop tray from locking the owner out of a token-guarded server ([#129](https://github.com/yeyo11/agentry/issues/129)) ([fefd386](https://github.com/yeyo11/agentry/commit/fefd386cbfd680b07ff47c8599865cfce53d5919))
* **web:** give the changes review its own cache key for a work item ([#122](https://github.com/yeyo11/agentry/issues/122)) ([aec6b38](https://github.com/yeyo11/agentry/commit/aec6b38a7ecb6bf86cdcfb2d1054421b6879755c))


### Documentation

* record the project ecosystem as merged in [#118](https://github.com/yeyo11/agentry/issues/118) ([#125](https://github.com/yeyo11/agentry/issues/125)) ([51a6c3a](https://github.com/yeyo11/agentry/commit/51a6c3a3abdf6ada1b222884b626a1e9f6cac78e))

## [0.23.1](https://github.com/yeyo11/agentry/compare/v0.23.0...v0.23.1) (2026-09-28)


### Documentation

* record the queued plans and the English-language decision ([#120](https://github.com/yeyo11/agentry/issues/120)) ([6412c44](https://github.com/yeyo11/agentry/commit/6412c44ce3cd57522d556b3356c298c298f07c0c))

## [0.23.0](https://github.com/yeyo11/agentry/compare/v0.22.1...v0.23.0) (2026-09-28)


### Features

* project ecosystem with boards, team and flow, documents and the project assistant ([#118](https://github.com/yeyo11/agentry/issues/118)) ([1eac40b](https://github.com/yeyo11/agentry/commit/1eac40b8ced0a0525771b6f9ded690e5b4a94dad))

## [0.22.1](https://github.com/yeyo11/agentry/compare/v0.22.0...v0.22.1) (2026-09-28)


### Bug fixes

* **web:** keep the changes summary inside its panel and make the lens switch keyboard-reachable ([#116](https://github.com/yeyo11/agentry/issues/116)) ([d85446e](https://github.com/yeyo11/agentry/commit/d85446eaa57ea73ce80208ce9c421aafbd6d8770))

## [0.22.0](https://github.com/yeyo11/agentry/compare/v0.21.1...v0.22.0) (2026-09-27)


### Features

* **web:** lists keep their filters until reset, and phone layout polish ([#113](https://github.com/yeyo11/agentry/issues/113)) ([71d693b](https://github.com/yeyo11/agentry/commit/71d693b5dfd812323949ca903432425e6073486b))

## [0.21.1](https://github.com/yeyo11/agentry/compare/v0.21.0...v0.21.1) (2026-09-27)


### Bug fixes

* **web:** show pushes on iOS and test pushes while the app is open ([#111](https://github.com/yeyo11/agentry/issues/111)) ([9a087b6](https://github.com/yeyo11/agentry/commit/9a087b6289c499b43db7780d4be9620d9c49e345))

## [0.21.0](https://github.com/yeyo11/agentry/compare/v0.20.0...v0.21.0) (2026-09-27)


### Features

* **core:** tell every chat which wrapper runs it ([#107](https://github.com/yeyo11/agentry/issues/107)) ([3bd4c04](https://github.com/yeyo11/agentry/commit/3bd4c04ce2384d6b6bab61a6b7287fbd08777744))


### Bug fixes

* **core:** move a pinned chat off the account that hit its limit ([#106](https://github.com/yeyo11/agentry/issues/106)) ([2614ef1](https://github.com/yeyo11/agentry/commit/2614ef1eee6ee0a36ca3f8a757e6f044fb673248))

## [0.20.0](https://github.com/yeyo11/agentry/compare/v0.19.0...v0.20.0) (2026-09-27)


### Features

* install a pinned claude-swap from the app for multiple accounts ([#104](https://github.com/yeyo11/agentry/issues/104)) ([815d9bd](https://github.com/yeyo11/agentry/commit/815d9bdfd70c235fe015705716dd4a4f6d71c81c))

## [0.19.0](https://github.com/yeyo11/agentry/compare/v0.18.0...v0.19.0) (2026-09-25)


### Features

* **web:** offer the slash commands when a message starts with / ([#99](https://github.com/yeyo11/agentry/issues/99)) ([1e77220](https://github.com/yeyo11/agentry/commit/1e77220e8bae970d29c79565606e076b35c88416))


### Bug fixes

* show the output of slash commands and keep the chat's model ([#98](https://github.com/yeyo11/agentry/issues/98)) ([aaa771a](https://github.com/yeyo11/agentry/commit/aaa771a1ba4ed3fc9447fa10ddc77aa734c5ae79))

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
