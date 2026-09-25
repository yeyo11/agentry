---
created_at: 2026-09-25T14:26:57Z
updated_at: 2026-09-25T18:00:00Z
tags:
    - plan
    - updates
    - desktop
    - pwa
    - releases
---
# Plan: knowing about a new release, and taking it

Tell every Agentry — Docker, desktop, a browser tab, a phone — that a newer release exists, and let
the desktop app install it from inside the app. Make a page that outlived a deploy notice and
reload itself on request, instead of running last week's code against this week's server.

This plan is the source of truth for the `app-updates` orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins.

## Why

Nothing in Agentry today knows that a release came out.

- **The desktop app** has no update check at all. [desktop.md](../desktop.md) says to re-run
  `install.sh` to update, which works only if you already know there is something to update to.
  Nothing in the app tells you, and no menu entry offers to check.
- **The PWA has no releases of its own.** It is the bundle the server it points at serves, so
  "updating the PWA" means updating that server and having the open page notice. It does not
  notice. `sw.js` takes over a new build with `skipWaiting()` and `clients.claim()`, but the page
  already in memory keeps running the old JavaScript until something reloads it. On a phone,
  where an installed app stays alive in the background for days, that can be a long time, and the
  first lazy chunk it asks for under a renamed hash fails.
- **Docker** has the same blind spot. Settings already has **Check for updates** for the Claude
  Code CLI (`packages/core/src/cli-version.ts`), but nothing like it for Agentry itself.

## Direction

Three pieces, and each one does a different job:

1. **The server says whether a newer release exists.** One check against GitHub's latest release,
   once a day and on demand, built the same way as the CLI check: a JSON document in the data
   directory, never a network call while serving a page, and off with an environment variable. It
   is the single source of truth for "is there a newer Agentry", for every deployment and every
   client connected to it.
2. **The page notices that the server changed under it.** The server puts its version in the
   `stream.hello` it already sends on every connection to `GET /api/events`. A page whose own
   build version differs offers a reload. This works with or without a service worker, and so on
   `http://<lan-ip>:8787`, where most people run Agentry and where there is no service worker at
   all.
3. **The desktop app installs the release itself**, through `electron-updater`. Version 6.x has an
   updater for each Linux package: `AppImageUpdater` replaces the file in place, and `DebUpdater`
   downloads the `.deb` and installs it through `pkexec`, which asks for your password. (This was
   checked in 6.8.9: `out/DebUpdater.js`, and `out/main.js` reads `resources/package-type`.) The
   app never installs without being asked: it downloads when you say so and restarts when you say
   so.

The desktop app does **not** run a second check of its own. The server's check says a release
exists, and `electron-updater`'s `checkForUpdates()` runs only when the person asks to download.
There is one timer, one daily request to GitHub, and one answer every surface agrees on.

## The one rule, again

Agentry reaches Claude Code **only through its CLI**, and nothing here goes near that boundary. The
release check talks to `api.github.com`, about Agentry's own repository. The CLI check stays exactly
as it is, and the two are separate cards in Settings.

## Not in this orchestration

- **An apt repository of our own.** Updates would arrive through the system's updater like any
  other package, but it costs a GPG key, signing in CI and a hosted repository to keep alive.
  `DebUpdater` gets a `.deb` user most of the way there. Revisit if people ask for unattended
  updates.
- **Flatpak and Snap.** Their sandbox is the opposite of what the desktop app does: run the user's
  own `claude`, with their `PATH`, on their real files. Making that work means escaping the sandbox
  (`flatpak-spawn --host`, classic confinement), and then all that is left is a second packaging
  pipeline.
- **Installing without asking.** A restart of the desktop app restarts its server, and that kills
  every chat and orchestration in flight. The person decides when.
- **A notification kind for updates, or a Web Push for one.** A release is not an event worth
  waking a phone for. It shows up as an indicator in the app, not in the bell.
- **Updating the Docker image from the UI.** The container cannot replace its own image. The UI
  says which command to run.
- **macOS, Windows and arm64 builds.** There is still only a Linux x86_64 package to update.
- **Signing releases.** `electron-updater` checks every download against the SHA-512 in
  `latest-linux.yml`, which is fetched over HTTPS from the same GitHub release. GitHub is the trust
  root, just as it is for `install.sh` today.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects,
   in English, with a body explaining why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Code, comments, docs and UI strings in English** (Spanish goes only in the `es` locale files).
4. **Checks you run:** `pnpm typecheck` and `pnpm test`. You may *write or update* e2e specs, but
   **do not run `pnpm e2e`**: the verification phase runs the suite once, on the integrated branch.
5. **Every long command under `timeout`**, e.g. `timeout 300 pnpm test`. If a command hits its
   timeout twice, stop retrying it and report it in your result.
6. **After touching `packages/shared/src/types.ts`**, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the regenerated schemas.
7. **Every new route** needs a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in
   the README REST API tables.
8. **TypeScript strict, no `any`**, respect `noUncheckedIndexedAccess`. Comments explain why.
9. **Persistence:** what the last release check learned is a settings-shaped document
   (`release.json` in the data directory), like `cli-version.json`.
10. **UI controls come from `apps/web/src/components/controls`.** Icon-only buttons carry an
    `aria-label`, status is never shown by colour alone, and `e2e/specs/a11y.spec.mjs` stays green.
11. **Every UI string has a key in `apps/web/src/i18n/locales/en` and `es`**, and the two stay in
    parity.
12. **Do not touch files outside your scope.** `README.md` (except the REST rows of rule 7),
    `ROADMAP.md` and `docs/*.md` are written by the `docs` task: put your documentation notes in
    your result.
13. If something in your scope turns out to be impossible, or much larger than it looks, **do the
    rest and say what you left out**.

## Stage 0 — in parallel

### `release-watch` (shared, core, api, docker)

- **The check.** `packages/core/src/release-watch.ts`, built like `CliVersionWatch`: it reads
  `https://api.github.com/repos/yeyo11/agentry/releases/latest` (which never returns a draft or a
  pre-release), or `AGENTRY_RELEASES_URL` when that is set. It stores
  `{ latest, publishedAt, url, checkedAt }` in `release.json`, runs 60 s after start and then once
  a day, and is turned off with `AGENTRY_UPDATE_CHECK=off` (the button keeps working). It sends
  `accept: application/vnd.github+json` and a `user-agent`, which GitHub requires. Unauthenticated
  requests are limited to 60 an hour, and one a day stays far below that. Share the timer and
  storage machinery with `CliVersionWatch` rather than copying it, and reuse `compareVersions`. The
  tag `v0.18.0` compares as `0.18.0`.
- **What kind of install this is.** `AGENTRY_DISTRIBUTION`: `docker`, `appimage`, `deb` or unset
  (from source). The image's `docker/Dockerfile` sets `docker`. The desktop main process sets
  `appimage` when `process.env.APPIMAGE` is set, and otherwise `deb` when `resources/package-type`
  says so. The UI uses it to decide which action to offer.
- **Types** in `packages/shared/src/types.ts`: `AgentryReleaseInfo { current, latest, publishedAt,
  url, checkedAt, updateAvailable, distribution, error? }`, and a `version` field on
  `StreamHelloEvent`.
- **An event** on the bus, `system.release`, published only when a check finds a version newer
  than the last one it announced. Connected pages update without polling. It is not a notification
  kind (see *Not in this orchestration*), so `notificationsFor` ignores it.
- **Routes:** `GET /api/system/release` (reads the stored answer, never the network) and
  `POST /api/system/release/check`, next to `/system/cli-version`.
- **`stream.hello` carries `version`**, which is `AGENTRY_VERSION`.
- **Tests** in core with an injected `fetch` and clock: the daily timing, a failure that keeps the
  previous answer, the `v` prefix, a pre-release current version, and the event published once per
  new version.

### `desktop-updater` (desktop, CI)

- **Dependency and bundling.** `electron-updater` as a runtime dependency of `@agentry/desktop`,
  bundled into `main.cjs` by `scripts/build.mjs` like everything else (only `dist/` ships, see
  `electron-builder.yml`). Check that the bundle loads in the packaged app, not only in
  `desktop:dev`.
- **Publishing metadata.** Add `publish: { provider: github, owner: yeyo11, repo: agentry }` to
  `electron-builder.yml` so it writes `latest-linux.yml`, the AppImage `.blockmap` and
  `resources/package-type` in the `.deb`. electron-builder must **not** publish on its own, so pass
  `--publish never`: `desktop.yml` stays the only thing that uploads. Extend its upload step and
  its `upload-artifact` list with `latest-linux.yml` and `*.blockmap`. Releases become immutable
  once published, so these files have to go up while the release is still a draft, in the same
  step as the packages. **Verify** that the generated `latest-linux.yml` lists the `.deb` as well
  as the AppImage. If it does not, the `.deb` path falls back to "download the release" and you
  say so in your result.
- **The updater, in `apps/desktop/src/updater.ts`.** `autoDownload = false`,
  `autoInstallOnAppQuit = false`, and logging to `desktop.log`. It is a state machine the rest of
  the shell reads: `idle | checking | available(version) | downloading(percent) | ready(version) |
  unsupported(reason) | error(message)`. It is `unsupported` in `desktop:dev`, when the AppImage's
  file is not writable, and when neither `APPIMAGE` nor `package-type` identifies the package. The
  state machine is tested against an injected fake of the updater's events.
- **Preload.** `window.agentryDesktop.updates`: `state()`, `onState(listener)`, `download()`,
  `install({ whenIdle })`. Like `setTitleBarTheme`, the main process accepts these only from the
  local server's page.
- **Restarting without losing work.** Before `quitAndInstall`, look at what the tray already knows
  (`live-monitor.ts`). If chats are working or orchestrations are running, `install` does not
  restart. It answers with what is live, so the UI can ask. `install({ whenIdle: true })` sets
  `autoInstallOnAppQuit = true`, so the update applies the next time the person quits. Check that
  the quit path stops the server child before the updater replaces the files.
- **Menus.** Help → **Check for updates…**. When a download is ready, the tray menu gets a line
  **Restart to update to X** (in English, like the rest of the tray).
- **AppImage file names.** `install.sh` installs `Agentry.AppImage`, a name with no version in it,
  so the updater replaces the file in place and the launcher entry keeps working. A hand-downloaded
  `Agentry-<version>-x86_64.AppImage` is replaced by a file under the new name. Leave a note about
  that for the `docs` task.

## Stage 1

### `web-reload` (web; deps `release-watch`)

- **The page knows its own version.** A Vite `define` from the root `package.json`, which
  release-please keeps in step with every package.
- **A mismatch offers a reload.** The page compares its version with `stream.hello.version` on
  every connection, so a reconnection after a server restart is the moment it notices. When they
  differ, it shows a non-blocking banner, **Agentry was updated to X. Reload**. It never reloads on
  its own, because a half-written message in the composer is worth more than being current. A
  failed dynamic import (`Failed to fetch dynamically imported module`, or `ChunkLoadError`) shows
  the same banner instead of a broken route.
- **Reloading through the worker.** With a service worker in control, a plain `location.reload()`
  can be answered from the *old* cache, because the worker serves navigations from the shell of
  its own build, and the page would come back just as stale. Call `registration.update()` first,
  wait for `controllerchange` (the new worker already calls `skipWaiting()` and `clients.claim()`)
  with a timeout of a few seconds, and only then reload. Without a worker, reload directly.
- **Tests:** unit tests for the comparison and the chunk-error matching. In e2e, a spec that sends
  a `stream.hello` with a different version and expects the banner. If the harness cannot fake
  that, say so and cover it as a unit test.

### `update-ui` (web; deps `release-watch`, `desktop-updater`)

- **Settings → About** (or wherever the redesign keeps the version today): a card built like
  `apps/web/src/pages/config/CliCard.tsx`. It shows the version in use, the newest release with its
  date and a link to its notes, when it was last checked, and **Check for updates**.
- **The action depends on `distribution` and on where the page runs:**
  - In the desktop window, with `window.agentryDesktop.updates` available: **Download** with its
    progress, then **Restart to update**. When something is live, the restart asks first: *N chats
    are working and will be stopped — restart now, or update when you quit?*
  - When the desktop updater is `unsupported`: the reason, and a link to the release.
  - `docker`: the commands, `docker compose pull && docker compose up -d`.
  - From source: `git pull`, then rebuild.
  - A browser or phone connected to a server it does not run is shown the same instructions,
    addressed to whoever runs that server.
- **An indicator** that is visible without opening Settings: a dot with an accessible label on the
  Settings entry of the sidebar and the bottom tab bar, while `updateAvailable` is true. It never
  goes in the bell.
- **e2e:** point `AGENTRY_RELEASES_URL` at a fixture the harness serves, press **Check for
  updates**, and expect the newer version, the Docker instructions and the indicator.

## Stage 2 — documentation

### `docs` (deps all)

- **README:** `AGENTRY_UPDATE_CHECK`, `AGENTRY_RELEASES_URL` and `AGENTRY_DISTRIBUTION` in the
  environment table, `release.json` in the volumes table, and the two REST rows checked against the
  code.
- **`docs/desktop.md`:** an *Updating* section covering the menu entry, the download, the restart
  that waits for idle, `pkexec` on a `.deb`, the AppImage name, and what `unsupported` means. Replace
  "Run it again to update" with a pointer to that section.
- **`docs/deploy.md`:** how a Docker install learns of a release and what it runs to take it.
- **ROADMAP:** move what landed to Done, and put the apt repository and Flatpak/Snap under
  *Decided against, for now*, with the reasons given here.
- **This file:** an *Outcome* section covering what shipped and what did not.
- **The knowledge base:** store this document with `kb_add_document` as `plans/app-updates.md`.

## Launch settings

```
engine        graph
worktree      true
concurrency   2
model         opus
maxAttempts   2
synthesize    true
limits        maxMinutes 120
verification  pnpm install --frozen-lockfile · pnpm typecheck · pnpm test · pnpm build · pnpm e2e
              fixer on, maxAttempts 2, timeoutMinutes 25
```

## What "done" means

- A Docker install, a desktop app and a phone pointed at either show that a newer release exists,
  within a day of it being published or at once when someone asks.
- The desktop app downloads and installs a release from inside the app, AppImage and `.deb`, and
  never restarts over running work without asking.
- A page that stays open while its server is updated offers to reload, and after the reload runs
  the new build, with a service worker or without one.
- `pnpm e2e` is green, and the next release carries `latest-linux.yml` and the blockmap next to the
  packages.

## Outcome

All five tasks shipped. What was built differs from the plan in a few places, each for a reason
found while building it.

### What shipped

- **The release check** (`release-watch`). `packages/core/src/version-check.ts` holds what the CLI
  check and the release check share — the JSON document, one request in flight for simultaneous
  callers, the timer (first look 60 s after start, then hourly, fetching only once the answer is a
  day old) and `compareVersions`. `CliVersionWatch` sits on it unchanged in behaviour, and
  `ReleaseWatch` (`release-watch.ts`) asks GitHub's latest release, strips the tag's `v`, refuses a
  tag that is not a version and keeps `{ latest, publishedAt, url, checkedAt }` in `release.json`.
  `AGENTRY_UPDATE_CHECK=off`, `AGENTRY_RELEASES_URL` and `AGENTRY_DISTRIBUTION` work as planned;
  an unset or unknown distribution is `'source'` rather than null, so the UI never handles a missing
  value. `system.release` goes out once per newer version, and the memory of what was announced
  starts from `release.json`, so a restart does not repeat it. `GET /api/system/release` and
  `POST /api/system/release/check` are documented, `stream.hello` carries `version`, and the image
  sets `AGENTRY_DISTRIBUTION=docker`.
- **The desktop updater** (`desktop-updater`). electron-updater 6.8.9, bundled into `main.cjs`;
  `apps/desktop/src/updater.ts` is the planned state machine, with three `unsupported` reasons
  (`development`, `read-only`, `unknown-package`) that carry the message the UI shows.
  `window.agentryDesktop.updates` (`state`, `onState`, `download`, `install`) is accepted only from
  the local server's page. Help → **Check for updates…** walks through dialogs, and the tray gets
  **Restart to update to X**. A restart stops the tray's monitor and the server child, installs
  silently and relaunches after the old process exits, so the new one gets the single-instance lock;
  a failed install starts the server again. The main process passes `appimage` or `deb` to its server
  as `AGENTRY_DISTRIBUTION`. `desktop.yml` attaches `latest-linux.yml` to the draft release with the
  packages, and electron-builder runs with `--publish never`.
- **The reload offer** (`web-reload`). The build knows its version (`__AGENTRY_VERSION__` from the
  root `package.json`) and compares it with `stream.hello.version` on every connection. The banner
  (**Agentry was updated to X. Reload**) blocks nothing, never reloads by itself, stays dismissed
  until the server moves to yet another version, and is withdrawn if the server goes back. Every lazy
  route goes through `lazyPage()`: a missing chunk raises the banner and renders "this page belongs to
  an older version" instead of breaking, and `vite:preloadError` and unhandled chunk rejections are
  caught too. Reload calls `registration.update()` and waits up to 5 s for `controllerchange` when a
  newer worker is coming, and reloads at once otherwise.
- **The Updates card and the indicator** (`update-ui`). The card is at the top of Settings →
  Account, where the CLI version already lived: there is no About tab. It shows the version in use,
  the newest release with its date and notes, when it was last checked and **Check for updates**,
  then the action for this install — Download with progress and Restart to update in the desktop
  window (asking *restart now or update when you quit* over live work), the unsupported reason and
  the release link, the Docker or source commands with a copy button, or "use Help → Check for
  updates…" for a desktop app's server seen from a browser. A page on a non-loopback host is told
  that whoever runs that server does the update. The shell's answers are parsed defensively, so an
  older or newer shell cannot break the card. A dot with an accessible label marks Settings in the
  sidebar, and More plus Settings inside its sheet on a phone; the bell is untouched.
- **Documentation** (`docs`). The README's environment, volumes, REST and events rows, an Updating
  section in [desktop.md](../desktop.md), Updating Agentry in [deploy.md](../deploy.md), and the
  ROADMAP.

### Where it differs from the plan

- **Install on quit is Agentry's, not electron-updater's.** Setting `autoInstallOnAppQuit = true`
  after a download does nothing: electron-updater registers its quit handler only if the flag is
  already on when the download finishes. So the flag stays off, and `install({ whenIdle: true })`
  makes the app's own quit path install the update once the server child has stopped, which is also
  the order the plan asked for.
- **`install()` takes `force`.** Without it, "Restart now" after the warning about live work could
  never go through. Chats waiting for a permission answer count as live, since their CLI process is
  still running.
- **No `.blockmap` file.** The AppImage's blockmap is embedded in the AppImage, and electron-builder
  writes no separate file, so `desktop.yml` uploads only `latest-linux.yml` next to the packages.
  Listing `*.blockmap` would have made `gh release upload` fail on the unmatched pattern. The
  generated `latest-linux.yml` does list the `.deb` as well as the AppImage, each with its SHA-512,
  so the `.deb` path needs no fallback.

### What did not ship, and why

- **Everything under *Not in this orchestration*** — an apt repository, Flatpak and Snap (both now
  under *Decided against, for now* in the [ROADMAP](../../ROADMAP.md)), installing without asking, a
  notification kind or push for releases, updating the Docker image from the UI, other platforms, and
  signing.
- **A real download and install.** The in-app update has never taken a real release, because none
  carries `latest-linux.yml` yet: the first release built with this change is the first one an
  installed app can find, and the first in-app update is from that release to the next.
- **No check for a graphical `pkexec` agent on a `.deb`.** Without one, electron-updater falls back
  to plain `sudo`, which fails without a terminal; [desktop.md](../desktop.md#updating) says to
  install the `.deb` by hand then.

### Noticed and not fixed

- **The Docker command on the card** (`docker compose pull && docker compose up -d`) is right for a
  compose file that uses the published image, but the repository's own `docker-compose.yml` builds
  `agentry:dev` locally and the README's quick start uses `docker run`, and that command updates
  neither. [deploy.md](../deploy.md#updating-agentry) gives the right command for each; the card
  should name the setup its command is for, or offer one per setup. Listed in the ROADMAP.
- **`ELECTRON_RUN_AS_NODE=1` leaks into chats started from the desktop app**, apparently inherited
  through the server child, so an Electron app launched from such a chat runs as plain Node. Found
  while smoke-testing the packaged app, which needed it unset.
- **The Spanish card names the desktop menu path in English** ("Help → Check for updates…"), because
  the desktop menus are English-only.

### How it was checked

- `pnpm typecheck` and `pnpm test` in every package on the integrated branch. New unit tests: the
  release check (11, injected `fetch` and clock with mock timers: the daily timing, a failure that
  keeps the previous answer, the `v` prefix, a pre-release current version, the event once per
  version and not again after a restart, the distribution values, the off switch, the URL override
  and headers), `GET /system/release` making no network call and the Dockerfile setting `docker`,
  `stream.hello` carrying `version`, the updater state machine against a fake engine, the reload
  rules and the worker handover (16), and the card's parsers and route choice (7).
- **e2e specs**, run once in the verification phase on the merged branch: `reload.spec.mjs` fakes a
  `stream.hello` with another version through a new `page.onNewDocument()` and expects the banner,
  its role, no axe violations, no reload by itself, dismiss and a real reload; `updates.spec.mjs`
  checks for a release against a fixture the harness serves (`AGENTRY_RELEASES_URL`, with
  `AGENTRY_UPDATE_CHECK=off` and `AGENTRY_DISTRIBUTION=docker` for every spec) and expects the newer
  version, the Docker commands, the notes link, the dot on Settings and on More at phone width, the
  bell unchanged, and a server-side check reaching the open page through `system.release`.
- **The packaged desktop app**, built with `pnpm desktop:dist` and started headless under
  `xvfb-run` with a separate config folder: the bundle with electron-updater loads, the server starts
  with `AGENTRY_DISTRIBUTION=appimage`, and the AppImage's `AppRun` honours
  `APPIMAGE_EXIT_AFTER_INSTALL`, so a silent install exits instead of starting the new version twice.
- **Not covered automatically:** the chunk-error path (the harness cannot make a chunk go missing;
  unit tests cover the matching), `lazyPage`'s fallback rendering (no React renderer in the web unit
  tests), and the card's desktop branch in a real Electron window.

## Related

[[desktop.md]] · [[deploy.md]] · [[plans/mobile.md]] · [[status.md]]
