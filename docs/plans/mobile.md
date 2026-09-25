---
created_at: 2026-09-23T18:28:14Z
updated_at: 2026-09-23T23:12:12Z
tags:
    - plan
    - mobile
    - pwa
    - push
    - shipped
---
# Plan: Agentry on a phone

Make Agentry installable on Android and iPhone, and able to tell you that a chat is waiting for
you while the app is closed — without a native shell, without an app store, and without leaving
the one rule.

This plan is the source of truth for the `mobile-pwa` orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins.

## Why

The UI redesign made the phone a first-class width: a bottom tab bar under 900 px, a chat at
`100dvh` whose composer follows `visualViewport`, touch targets of 44 px, safe-area insets. What it
did not do — and deliberately so — is make the thing an *app*. Two gaps are left:

- **It lives in a browser tab.** No icon on the home screen, no standalone window, the URL bar
  eating 60 px of a screen that has none to spare, and a cold start that shows a blank page until
  the bundle arrives.
- **You only find out while you are looking.** A chat stopped on a permission prompt is the one
  event worth interrupting someone for, and today it reaches a person through an in-page toast, a
  bell, or a browser notification that fires *only while the tab is hidden but the page is alive*.
  Close the tab and the wrapper has no way to reach you. On a phone, "close the tab" is what the
  operating system does to you after a minute in the background.

Both are solved by the same thing, and it is not a native app: a web app manifest and a service
worker, which is also the only way to receive Web Push.

## Direction: a PWA, self-hosted end to end

- **Installable, not packaged.** `Add to Home Screen` on iOS, the install prompt on Android. The
  app that starts is the same bundle the API already serves at the same origin, so every relative
  `/api` call, the `Authorization` header and the two `EventSource` streams keep working exactly as
  they do in a tab. Nothing about the client/server contract changes.
- **Push over VAPID, with no third party of ours.** The server signs its own JWT with its own
  keypair and posts the encrypted payload to whatever push endpoint the browser handed us
  (Mozilla's, Apple's, Google's). There is no Firebase project, no account to create, no key of
  Anthropic's or ours in anyone else's console. A self-hosted Agentry behind a NAT can still send:
  the connection is outbound.
- **One source of truth for what is worth a notification.** `notificationsFor(event)` in
  `apps/web/src/lib/notifications-model.ts` is already a pure function from an `AgentryEvent` to a
  list of drafts. It moves to `packages/shared`, and the server calls the same function on the same
  event bus it already publishes to. The browser and the push sender can never disagree about what
  "waiting for you" means, because they run the same code.

## The one rule, again

Agentry reaches Claude Code **only through its CLI**. Nothing in this plan goes near that boundary:
a push subscription is a row, a VAPID key is a file, and the events being pushed are the ones the
wrapper already derives from the CLI's stream-json output. If a piece of a task cannot be expressed
without inventing a surface on Claude Code, leave it out and say so in your result.

## Not in this orchestration

- **A native shell (Capacitor, or a WebView of our own), and the app stores.** Considered and
  deferred: a WebView pointing at the server URL is what Apple's review guideline 4.2 rejects, a
  Play personal account needs 12 testers for 14 days before production, and both cost a signing
  pipeline we would then maintain forever. A PWA reaches both operating systems today for nothing.
  If push on an installed PWA turns out to be unreliable in practice, that is the moment to revisit
  this — not before.
- **Offline use.** The service worker caches the app shell so a cold start paints immediately; it
  never caches `/api`. A wrapper you cannot reach is a wrapper with nothing to say, and a stale
  chat transcript is worse than an honest "cannot reach the server".
- **Per-user push.** Agentry has one credential for everyone who holds it and no per-user
  isolation (README, "Known limitations"). A subscription belongs to an install, not to a person,
  and every install that subscribed gets the same notifications. Do not invent an identity model
  here; document the consequence.
- **New notification kinds.** The seven kinds in `NotificationKind` are what gets pushed. Choosing
  *which* of them are worth waking a phone for is a preference, not a new taxonomy.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects,
   in English, body explaining why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Code, comments, docs and UI strings in English** (Spanish goes only in the `es` locale files).
4. **Checks you run:** `pnpm typecheck` and `pnpm test`. You may *write or update* e2e specs, but
   **do not run `pnpm e2e`**: the verification phase runs the suite once on the integrated branch.
   Running it in parallel with other workers hangs it.
5. **Every long command under `timeout`**, e.g. `timeout 300 pnpm test`. If a command hits its
   timeout twice, stop retrying it and report it in your result.
6. **After touching `packages/shared/src/types.ts`**, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the regenerated schemas. CI fails on
   drift.
7. **Every new route** needs a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in
   the README REST API tables, which you add yourself.
8. **TypeScript strict, no `any`**, respect `noUncheckedIndexedAccess`. Comments explain why.
9. **Persistence:** settings-shaped documents in JSON files; streams and accumulating records as
   rows in SQLite (`packages/core/src/db.ts`). The VAPID keypair is a document; subscriptions are
   rows.
10. **UI controls come from `apps/web/src/components/controls`**, never native
    `select`/`checkbox`/`range`. Icon-only buttons carry an `aria-label`, status is never colour
    alone, and `e2e/specs/a11y.spec.mjs` stays green.
11. **Mobile is the point.** Check at 390×844: nothing scrolls sideways, touch targets ≥ 44 px
    under `@media (pointer: coarse)`, sticky bars respect `env(safe-area-inset-*)`. You are
    building on the redesigned UI — read the shell and Settings as they now are before assuming a
    layout.
12. **Do not touch files outside your scope.** Shared notification code lands once, in
    `push-model`; the service worker is created once, in `pwa-shell`, and only `push-web` adds
    handlers to it. `README.md` (except the REST rows of rule 7), `ROADMAP.md` and `docs/*.md` are
    written by the `docs` task: put your documentation notes in your result.
13. **Every UI string has a key in `apps/web/src/i18n/locales/en` and `es`**, with parity; the
    untranslated-text guard in the web tests must stay green.
14. **Update the e2e specs your change breaks** and add specs for what you build, without loosening
    an assertion to make it pass. Say in your result which specs you touched.
15. If something in your scope turns out to be impossible, or much larger than it looks, **do the
    rest and say what you left out** in your result. Do not silently narrow the scope.

## What every task must know about Web Push

Get these wrong and the feature looks broken rather than absent. They are not negotiable details.

- **Secure context or nothing.** `navigator.serviceWorker` and `window.PushManager` are `undefined`
  on an insecure origin. `https://` and `http://localhost` qualify; `http://192.168.1.10:8787` —
  how most people run Agentry — does not. The UI must **say this**, naming the origin it is on,
  instead of showing a switch that silently does nothing.
- **iOS needs the app installed.** Safari 16.4+ supports Web Push only from a PWA added to the
  Home Screen — never from a browser tab. An iPhone in a tab must be told to install first, in
  those words.
- **Permission is asked once, and only when asked for.** Keep today's behaviour: never prompt on
  load, only when the person turns the switch on. A denied permission is terminal until they change
  it in system settings; say so rather than re-prompting.
- **Subscriptions rot.** A push endpoint answers `404` or `410` when it is gone, and the
  subscription must be deleted on the spot. Anything else and the sender slowly becomes a pile of
  dead endpoints.
- **The payload is small and it is not private.** Push payloads travel through a third-party relay,
  encrypted per RFC 8291, but keep them to what a lock screen shows anyway: kind, title, the chat
  or orchestration id, and the path to open. No prompt text, no tool arguments, no secrets.

## Stage 0 — foundations, in parallel

### `push-model` (shared: the event → notification mapping)

Move the pure part of `apps/web/src/lib/notifications-model.ts` into `packages/shared` so the
server can reach it. **No behaviour change, and this is the whole point of the task**: it is a move
plus tests, and it must be a reviewable diff.

- New `packages/shared/src/notifications.ts` exporting `NotificationKind`, `NotificationPriority`,
  `NotificationTone`, `NotificationDraft`, `KINDS`, `notificationsFor`, `waitingDrafts` and
  `settlesWaiting` — everything that is a pure function of an `AgentryEvent` and nothing else.
- What stays in the web: `AppNotification`, `NotificationPrefs`, storage, dedupe, read state,
  `isRedundant` — the browser's own bookkeeping. `notifications-model.ts` re-exports the moved
  names so no import in the web has to change; the web's own tests keep passing untouched.
- `packages/shared/src/index.ts` exports the new module. Check that nothing in the moved code
  reaches for `localStorage`, `window` or `document`: it has to run in Node.
- Tests for `notificationsFor` over a representative event of each of the seven kinds, in the
  shared package. Today that logic is only covered through the web's tests; after the move the
  server depends on it too.

### `pwa-shell` (web: manifest, icons, service worker, install)

Everything that makes it an app, with no push in it yet.

- `apps/web/public/manifest.webmanifest`: name, short name, `display: standalone`,
  `start_url: "/"`, `scope: "/"`, `background_color` and `theme_color` matching the two
  `theme-color` metas already in `index.html`, `orientation: any`.
- Icons generated from the existing `favicon.svg` — the brand mark does not change. 192 and 512 px
  PNGs, a `purpose: maskable` variant with the safe-area padding Android needs, and an
  `apple-touch-icon` (180 px, no transparency: iOS composites it on black otherwise).
- `index.html`: the manifest link, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style` and `apple-mobile-web-app-title`. The existing
  `viewport-fit=cover` and the pre-paint theme script stay exactly as they are.
- A service worker at `apps/web/public/sw.js`, registered from the app after first paint — never
  blocking it. Its cache holds the app shell (`index.html`, the built JS/CSS, the bundled fonts)
  and is keyed by build so a new deploy takes over instead of serving last week's bundle. It
  **must not** intercept `/api`, `/docs` or `/openapi.json`: leave those to the network, with no
  `respondWith` at all, so SSE is untouched. Write the request-matching as an allowlist of what it
  handles, not a denylist of what it skips.
- Wire it into the Vite build so the hashed asset names reach the worker; keep it plain — a
  hand-written worker with a generated asset list is preferable to a plugin that hides what ships.
- An install affordance in Settings → Appearance (or wherever the redesign put it): on Android,
  catch `beforeinstallprompt` and offer the button; on iOS, say what to tap, because there is no
  API. Hide it once `display-mode: standalone` matches.
- e2e: extend or add a spec that the manifest is served and valid JSON, that the worker registers,
  and — the regression that matters — that `/api/events` still streams with the worker active.

## Stage 1 — the server side

### `push-server` (deps `push-model`)

The sender, the store and the routes. No UI in this task.

- **VAPID keypair**, generated on first use and kept as a document in the data directory
  (`push.json`, mode 600 in the mode 700 directory, like the MCP config files). The public key is
  readable; the private key never leaves the server and is never returned by a route.
- **`push_subscriptions` table** in `packages/core/src/db.ts`: endpoint (unique), the `p256dh` and
  `auth` keys, when it was created, when it was last seen, and a label for the user agent so the
  Settings list can say "Pixel, Chrome" instead of a URL. Rows, because they accumulate.
- **The sender** in core, subscribed to the same event bus that feeds `GET /api/events`. For each
  event it calls the shared `notificationsFor`, filters by the kinds the install asked for, and
  posts to every subscription. Use the `web-push` package rather than hand-rolling RFC 8291 and the
  VAPID JWT; it is a well-trodden dependency and the crypto is not where we add value. Delete a
  subscription on `404`/`410`. Never let a failing endpoint throw into the event path — a push that
  cannot be delivered is a log line, not a broken feed.
- **Throttle and collapse.** Use the notification `key` that already exists for dedupe as the push
  `tag`, so a chat that asks twice replaces its own notification instead of stacking two.
- **Routes**, all guarded like everything else (`apps/api/src/security.ts` needs no new exception —
  these are `fetch` calls and carry the header):
  - `GET /api/push/key` — the VAPID public key, and whether push is configured at all.
  - `POST /api/push/subscriptions` — register or refresh one; the body is the browser's
    `PushSubscription` JSON plus the kinds this install wants.
  - `DELETE /api/push/subscriptions` — unregister by endpoint.
  - `GET /api/push/subscriptions` — what is registered, for the Settings list. Endpoints are
    truncated in the response: a full endpoint URL is a capability to notify that install.
  - `POST /api/push/test` — send one notification to the caller's subscription, so a person can
    prove it works without waiting for a real event.
- Route summaries and tags in `apps/api/src/openapi/routes.ts`, the README REST rows, and the
  regenerated OpenAPI schemas (rules 6 and 7). Types in `packages/shared/src/types.ts`.
- Tests in `@agentry/core` for the sender: the right subscriptions are picked for an event, a `410`
  prunes, and a throwing endpoint does not take the bus down.

## Stage 2 — the client side

### `push-web` (deps `push-server`, `pwa-shell`)

- The service worker gains `push` and `notificationclick` handlers: show what the payload says,
  and on click focus an existing client at that path or open one. A `waiting` notification opens
  the prompt it refers to (`?prompt=<id>`), exactly as the bell does today.
- Subscription lifecycle in the web: subscribe with the key from `GET /api/push/key`, re-register
  when the browser rotates the subscription (`pushsubscriptionchange`), unsubscribe when the switch
  goes off.
- Settings → Notifications: the existing per-kind preferences gain a "also push to this device"
  switch, the list of registered devices with the current one marked and a way to remove any, and
  the **Send a test notification** button. When the origin is insecure, or the page is an iOS tab
  rather than an installed app, replace the switch with the sentence that explains it — naming the
  origin. That sentence is the difference between a feature and a bug report.
- **No double notification.** While the page is open and visible, the in-page toast is the right
  surface and a push for the same `key` must not also appear; the worker checks for a visible
  client before showing one. Keep the existing rule that browser notifications only fire for a
  hidden tab.
- e2e: the subscription round-trip against the fake CLI, the insecure-origin message, and the
  Settings list. The push delivery path itself is not reachable from the harness — test the
  handlers as units and say so in your result.

## Stage 3 — documentation

### `docs` (deps `push-web`)

- **README**: the install section (how to add it to a home screen on both systems), push in the UI
  table, the new REST rows checked against what the tasks actually built, a line in "Securing it"
  about push payloads travelling through a third-party relay and what we therefore put in them, and
  an entry in "Known limitations" for the two real ones: push needs HTTPS, and a subscription
  belongs to an install rather than a person.
- **`docs/deploy.md`**: that push requires a TLS-terminating proxy, pointing at the Caddy profile
  that already exists, and that a LAN install over plain HTTP gets the app but not the push.
- **ROADMAP**: move what landed to Done; add the native shell and per-user push to the section they
  belong in, with a sentence on why they were deferred.
- **This file**: an Outcome section, what shipped and what did not.

## Launch settings

```
engine        graph
worktree      true
concurrency   2
model         opus
maxAttempts   2
synthesize    true
limits        maxMinutes 150
verification  pnpm install --frozen-lockfile · pnpm typecheck · pnpm test · pnpm build · pnpm e2e
              fixer on, maxAttempts 2, timeoutMinutes 25
```

**Launch only once the UI redesign is merged into `main`**, and rebase this branch onto it first.
Every task here builds on the redesigned shell, Settings and notification surfaces; started against
today's `main` it would write against a UI that is about to be replaced, and its integration branch
would fight the redesign's.

## What "done" means

- Agentry installs to the home screen on Android and iPhone and starts standalone, with its own
  icon, no URL bar and an immediate first paint.
- With the app closed, a chat that stops for a permission prompt puts a notification on the phone,
  and tapping it opens that prompt.
- Nothing about the existing tab experience changes: the same bundle, the same streams, the same
  bell, and `pnpm e2e` green.
- An insecure origin explains itself instead of failing quietly.

## Outcome

All five tasks shipped. Agentry installs to a home screen on Android and iPhone and, with the app
closed, a chat that stops for a permission prompt reaches the phone over Web Push this server signs
itself. Written from what the tasks built, not from what this plan proposed.

### What shipped

- **`push-model`** — `packages/shared/src/notifications.ts` holds the mapping (`NotificationKind`,
  `KINDS`, `notificationsFor`, `waitingDrafts`, `settlesWaiting`) and `packages/shared/src/detail.ts`
  the `?detail=` encoding its links are built with. The web's `notifications-model.ts` re-exports
  them, so no import changed. Beyond the plan: the words could not simply move, since a server has no
  i18next — the mapping takes a `NotificationText`, the web passes the active language's strings and
  the shared package carries built-in English for the sender. A web test runs one event per sentence
  through both and fails if they drift. `@agentry/shared` gained tests and joined `pnpm test`.
- **`pwa-shell`** — `manifest.webmanifest` (standalone, root scope, `id: "/"`), icons rasterised from
  `favicon.svg` by `pnpm --filter @agentry/web icons` and committed as PNGs (192, 512, a maskable 512
  and a 180 px `apple-touch-icon`), the four Apple metas in `index.html`, and a hand-written
  `public/sw.js` whose asset list and build id are stamped in by a Vite plugin at `closeBundle`, read
  back from what the built `index.html` asks for before it can paint. What the worker answers is an
  allowlist — the app's own first path segments and the shell's own files — so `/api`, `/docs` and
  `/openapi.json` are left to the network with no `respondWith` at all. Install lives in a **Settings
  → Install** tab (the redesign has no Appearance tab): the held `beforeinstallprompt` as a button,
  the two taps named on iOS, and the origin named on an insecure one.
- **`push-server`** — `push.json` (mode 600) made on first use, `push_subscriptions` rows keyed by
  endpoint, a sender that `observe`s the event bus, reads each event through the shared
  `notificationsFor`, filters by the kinds each install asked for, collapses on the draft's own key
  and deletes a row on `404`/`410`; every failure is caught inside it, so a dead endpoint is a log
  line. The five routes, their OpenAPI entries and the regenerated schemas. Beyond the plan:
  `AGENTRY_PUSH_SUBJECT` sets the VAPID `sub` claim, stored beside the keypair and re-read on start.
- **`push-web`** — `push`, `notificationclick` and `pushsubscriptionchange` in the same worker. A
  push with a visible window of ours shows nothing (the page is already showing the toast for that
  event, which is also what Chrome's `userVisibleOnly` bargain allows); a click prefers an open page
  and hands it the path over a `MessageChannel`, falling back to `navigate()` and then to a new
  window. The subscription is the state — `pushManager.getSubscription()` is asked rather than a flag
  stored — and `pushBlocker()` decides, with no browser in it, why push cannot work here: insecure
  origin, iOS tab, unsupported, unconfigured, denied. **Settings → Notifications** holds the per-kind
  preferences (one component, shared with the bell's popover), the push switch, every registered
  install with this one marked, and **Test** and **Remove** on each.
- **`docs`** — this section, the README (an *On a phone* section, the push routes checked against the
  code, `AGENTRY_PUSH_SUBJECT`, `push.json` in the volumes table, the relay bullet under *Securing
  it* and two entries in *Known limitations*), `docs/deploy.md` (*Notifications on a phone*),
  `docs/desktop.md` (why the desktop app has no push) and the ROADMAP.

### What did not ship, and why

- **A native shell and the app stores**, **offline use** and **per-user push** — out of scope by this
  plan, and now recorded in the ROADMAP's *Decided against, for now* with the reason.
- **Push in the Linux desktop app.** It registers no service worker: its API listens on a port the
  operating system picks anew every launch, so every start would leave one more registration under an
  origin that never comes back. Push is for a browser or a phone pointed at a served wrapper.
- **A credential on the worker's repair.** `pushsubscriptionchange` re-registers without one — a
  worker cannot read the browser's stored token, and caching a copy to make a rare repair work is a
  bad trade. On a guarded wrapper the server answers `401` and the next page load puts it right.
- **A badge icon** — there is no monochrome brand mark, and a wrong badge is a grey blob.
- **Translated words in the worker.** A push with no payload shows the fallback title and body the
  page cached in its language; a browser that never subscribed from this build falls back to
  "Agentry".
- **Rotating the VAPID keypair.** Every subscription was taken out against that public key, so
  replacing it would silently orphan all of them. It is made once; losing the data directory means
  every install subscribes again.

### Known limitations, as documented

- **Push needs a secure origin.** On `http://<lan-ip>:8787` the browser gives the page no service
  worker at all — no push, no cached shell — and the UI says so, naming the origin. On iPhone and
  iPad, only an app on the Home Screen is ever pushed to.
- **A subscription belongs to an install, not to a person.** Agentry has one credential for everyone
  who holds it, so every device that turned push on is sent the same notifications, and anyone who
  can reach Settings can test or remove another device's registration.

### How it was checked

`pnpm typecheck` and `pnpm test` on every task. The delivery path itself is not reachable from the
browser harness — it would need a real push service signing a real delivery into the browser under
test — so the worker is driven event by event as a unit against the file that ships
(`apps/web/test/pwa.test.ts`), and the sender against an injected transport
(`packages/core/test/push.test.ts`). `e2e/specs/pwa.spec.mjs` checks the manifest, the icons, the
stamped worker and that `GET /api/events` still streams with it active; `e2e/specs/push.spec.mjs`
does the subscription round-trip against an endpoint on `.invalid` that can never be delivered to.
The suite runs once on the integrated branch, in the verification phase.

## Related

[[plans/ui-redesign.md]] · [[deploy.md]] · [[status.md]]
