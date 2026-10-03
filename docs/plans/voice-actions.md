---
created_at: 2026-09-28T11:47:49.567228489Z
updated_at: 2026-09-28T11:47:49.567228489Z
tags:
    - plan
    - voice
    - siri
    - mobile
    - security
    - proposed
---
# Plan: starting an orchestration by voice

"Hey Siri, create an orchestration", say what it is about, and Agentry starts planning it. The
plan is ready on the phone a couple of minutes later, to be reviewed and launched. No native app,
no app store, and nothing for the person to build by hand.

Status: **proposed on 2026-09-28**. Nothing is built yet.

## Why

Agentry is a PWA ([mobile.md](mobile.md)), and a PWA cannot register anything with Siri or
Gemini. Both only take voice commands from native apps: App Intents on iOS, and App Actions or
AppFunctions on Android. A native shell was considered again for this and set aside again:

- **iOS.** App Intents need a Mac with Xcode, an Apple Developer account at 99 $ a year, and
  either App Store review (guideline 4.2 rejects a WebView of a server) or TestFlight builds that
  expire every 90 days. Apple also puts the app's name in the phrase ("…in Agentry").
- **Android.** App Actions belong to Google Assistant, which Gemini is replacing. Its successor,
  [AppFunctions](https://developer.android.com/ai/appfunctions), was a private preview for
  trusted testers in May 2026, on Android 16 and later only. A third-party app cannot ship it today.

What does work without a native app is the Shortcuts app on iOS. Siri runs any shortcut by its
name, and a shortcut can call an HTTP API. The shortcut's name is the whole phrase, so "Hey Siri,
create an orchestration" works without "in Agentry". This plan is about making that shortcut
something a person installs in two taps, never something they build.

## What the person does

1. Settings → **Voice**, on the iPhone, with authentication on. Press **Set up on this iPhone**.
2. Agentry copies a setup code to the clipboard and opens the shortcut's iCloud link. Shortcuts
   shows **Add Shortcut**. Tap it.
3. Say "Hey Siri, create an orchestration" once. The shortcut finds the code on the clipboard,
   stores it, and clears the clipboard. iOS asks once for permission to save the file.

Nothing is typed at any step. From then on:

1. "Hey Siri, create an orchestration."
2. Siri asks "What should it do?", and the person dictates the objective.
3. Siri answers with what Agentry sent back, e.g. "Planning *add dark mode to the invoices page* in
   *billing-web*. I'll let you know when the plan is ready."
4. When the planner finishes, a push notification ("Plan ready") opens the draft in Agentry. There
   the person reviews it and launches it, as with any other plan.

On a desktop, the Voice section shows a QR code that opens the same page on the phone, because
the clipboard step has to happen on the iPhone itself.

## Decisions

- **Voice drafts, it never launches.** A dictated objective can be misheard, and an orchestration
  spends money. Voice ends in the planner, which is the same `startPlanAndRecord` the UI uses, and
  a person launches the draft. This also keeps the one rule: the voice path reaches Claude Code
  through the same CLI runs as everything else.
- **The logic lives on the server, not in the shortcut.** The shortcut is built by hand in the
  Shortcuts app and shared through iCloud, so every change to it means publishing a new link and
  asking people to add it again. It stays deliberately dumb: it sends the dictated text to one
  endpoint and speaks the `say` it gets back. Choosing the project, wording the answer and
  refusing are all done by the API, and can change without touching the shortcut.
- **A voice token, not the panel's credential.** Today there is one credential (`token` mode) or an
  OIDC login, and whoever holds it owns the machine. A shortcut stored on a phone must not carry
  that. The voice section mints **voice tokens**: 32 random bytes, stored as a hash beside the main
  one in `auth.json`, one per phone, each with a label, a creation date and a last use, and
  revocable one by one. The guard gives a voice token the actor `voice:<id>` and lets it reach
  `/api/voice/*` and nothing else. Voice tokens work in `oidc` mode too, because a shortcut cannot
  run an OIDC login. The Voice section is disabled while the mode is `none`, with the same
  warning the tunnel uses.
- **The setup code travels through the clipboard.** Shortcuts' import questions cannot be
  pre-filled from outside, so they would mean typing a URL and a token on a phone keyboard. The
  code is `agentry-voice:v1:` followed by base64 JSON `{ url, token }`. On every run the shortcut
  checks the clipboard for that prefix first. If it is there, the shortcut saves the code to
  `Shortcuts/agentry-voice.json` in iCloud Drive and clears the clipboard; if not, it reads the
  file. So **Set up again** after the tunnel changes address is the same two steps, without adding
  the shortcut again. That matters because the anonymous localhost.run address changes on every
  open ([tunnel.md](../tunnel.md#the-address-changes)). A stable address (a domain, Tailscale)
  never needs it.
- **One shortcut per language.** The name is the phrase, so there are two iCloud links: "Crea una
  orquestación" and "Create an orchestration". Settings offers the one for the UI language, and
  says the person can rename it to any phrase they prefer.
- **The project comes from the words, or from a default.** If the dictated text starts or ends
  with "in <project>" / "en <proyecto>" and that name matches an imported project (case- and
  accent-insensitive), the plan runs there. Otherwise it runs in the **voice default project**,
  which is chosen in the Voice section. Without one, it runs in the workspace directory, which is
  what `PlanRequest` does today with no `cwd`. The answer always names where it went.

## Android

Android gets no "Ok Google" phrase: there is nothing to register it with (see [Why](#why)). What it
gets:

- **A mic in the objective field.** A `DictationButton` in `components/controls` uses the Web
  Speech API. That works in Chrome on Android and in Safari on iOS, where the audio goes to
  Google's or Apple's recognizer, which the button's tooltip says. It is hidden where the API is
  missing, as in Firefox and in Electron.
- **App shortcuts in the manifest.** Long-pressing the installed icon offers **New orchestration**,
  which opens the planner with dictation already listening, and **New chat**.
- **A documented Tasker recipe**, not a supported feature. Tasker's HTTP Request action can call
  the same `/api/voice/orchestrations` with a voice token, and AutoVoice or Tasker's own voice
  trigger provides the phrase. `docs/voice.md` shows how, and says it is outside what Agentry tests.

## API

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/api/security/voice-tokens` | The voice tokens: id, label, created, last used. Never the token |
| `POST` | `/api/security/voice-tokens` | Mints one for `{ label }`. Returns the token and the setup code **once** |
| `DELETE` | `/api/security/voice-tokens/:id` | Revokes one |
| `POST` | `/api/voice/orchestrations` | `{ text, locale? }`. Starts the planner. Returns `{ say, planRunId, url }` |

- The three `security` routes refuse a voice token, like every route outside `/api/voice/`.
- `POST /api/voice/orchestrations` answers in under a second. It only resolves the project and
  starts the planner. `say` is written in `locale` (`es` or `en`, from the shortcut), and so is
  an error: an empty text, an unknown project named explicitly, or an account limit reached. For
  those it returns `200` with `say` explaining what went wrong, so the shortcut speaks it instead
  of Siri saying "there was a problem running the shortcut".
- Voice requests are audited like any write, under the actor `voice:<id>`.

## Plan ready

Today a planner run notifies nothing (`notifications.ts` leaves housekeeping runs out on purpose).
When a planner finishes and its draft is recorded, Agentry emits an `orchestration`-kind
notification, "Plan ready: <name>", with `href` `/orchestration?draft=<runId>`. That is the
existing kind, so no new taxonomy ([mobile.md](mobile.md#not-in-this-orchestration)), and it
reaches the phone through the push already built. It is emitted for every plan, not only
voice ones: a plan started from the UI and left in a background tab needs the same signal. A
planner that fails notifies "Plan failed" with the reason. The Orchestration page opens the draft
named by `?draft=` in the editor.

## The shortcut itself

An agent cannot build it: shortcuts are made in the Shortcuts app and signed by Apple, and
`shortcuts sign` only runs on macOS. The maintainer builds each of the two once on an iPhone,
following the action list in `docs/voice.md`:

1. Get Clipboard → if it starts with `agentry-voice:v1:`, save it to `agentry-voice.json` and set
   the clipboard to empty.
2. Get File `agentry-voice.json` → if missing, speak "Set it up from Agentry → Settings → Voice
   first" and stop.
3. Decode the base64 part into a dictionary (`url`, `token`).
4. Dictate Text (language fixed per shortcut, stop after a pause).
5. Get Contents of URL: `POST {url}/api/voice/orchestrations`, `Authorization: Bearer {token}`,
   JSON `{ text, locale }`.
6. If it fails (no network, 401, 421), speak a fixed sentence per case.
7. Otherwise speak `say`.

The signed `.shortcut` files are committed under `docs/voice/` for reference, and the two iCloud
links are constants in the web app. A new version of the shortcut means a new link and a line in
the changelog.

## Tasks

| Task | Scope | Size |
| --- | --- | --- |
| `voice-tokens` | `security/auth.ts`: hashed voice tokens in `auth.json`; guard scope in `apps/api/src/security.ts`; the three routes; tests | 1 day |
| `voice-api` | `POST /api/voice/orchestrations`: project matching, default project, `say` in en/es, error answers; OpenAPI, README tables; tests | 0.5 day |
| `plan-ready` | planner notifications in `shared/notifications.ts`, `?draft=` on the Orchestration page; tests | 0.5 day |
| `voice-settings` | Settings → Voice: set up, set up again, QR on desktop, token list with revoke, default project; i18n en/es; design system; e2e for everything but Siri | 1 day |
| `dictation` | `DictationButton` in controls, on the objective field and the chat composer; manifest `shortcuts`; motion rules for its listening state | 0.5 day |
| `shortcut` | Build and sign the two shortcuts on an iPhone, publish the links, write `docs/voice.md` and the Tasker recipe. **Done by hand by the maintainer** | 0.5 day |

About four days, of which the last half day needs an iPhone and a person.

## Open questions

- **Does `Save File` into iCloud Drive work from a shortcut run by Siri with the phone locked?** If
  it asks for Face ID every time, the config moves into the shortcut's own storage via
  `Set Variable` plus import questions, and re-setup means adding the shortcut again. Check
  on the prototype before building `voice-settings`.
- **Siri dictation length.** Dictate Text stops after a pause. If objectives are routinely cut
  short, switch to "stop on tap" and accept one more touch.
- **Status by voice** ("Hey Siri, how are my orchestrations?") would reuse the same token, file and
  endpoint prefix. It is left for a second round, once the first one is in use.

Related: [[plans/mobile.md]], [[tunnel.md]], [[notifications.md]].
