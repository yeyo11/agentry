---
created_at: 2026-09-30T18:00:00Z
updated_at: 2026-09-30T15:32:53Z
tags:
    - plan
    - web
    - packages
    - architecture
    - chat
    - refactor
    - planned
---
# The web UI in two workspace packages

Status: **landed** in #156. Planned on 2026-09-30. It is built on **`feat/web-packages`** (`main` plus
phase 1 of [multiple providers](multi-provider.md), at `41c7063b`) and squash-merged once.

On 2026-09-30 the owner decided to take the chat UI out of `apps/web` and into a workspace package
of its own. The chat leans on about twenty app-wide building blocks (buttons, dialogs, toasts,
controls, icons, the motion helpers, the formatters), so those go first, into a primitives package.
The result is two internal packages that nothing outside this repository consumes:

- **`@agentry/ui`** — the primitives: tokens and the shared stylesheets, the controls, dialogs,
  toasts, icons, motion, spinners and progress, the illustrations, the formatters, and the
  renderers every screen shares (Markdown, code blocks, syntax highlighting).
- **`@agentry/chat-ui`** — the conversation: the transcript and its search, the composer, the
  permission prompts, attachments and media, the chat badges, the stream and transcript hooks, and
  the pure chat models. It reaches the server only through a client the app hands it.

This is a refactor. **No screen changes**, so there are no prototypes; every class name the e2e
specs select and every English string stays byte for byte what it is today.

## Why

1. **The owner's decision.** The chat is the largest and most reused part of the web UI: the chat
   page, the detail panel, orchestration tasks, work item runs and Home all draw pieces of it. As a
   package it gets a boundary a test can hold, instead of a convention in a 400-file `src/`.
2. **Multiple providers.** From phase 2 of [multiple providers](multi-provider.md) the server gives
   the web provider-neutral data: `RunEvent` drops `type`, `subtype` and raw `data`, and a chat
   carries its `provider`. A chat package that cannot import anything naming one vendor, and gets
   the agent's name from the app, is how the web keeps rendering neutral data neutrally when a
   second provider starts running chats (phase 3).
3. **Primitives first.** A chat package that imported `../components/ui` from the app would not be
   a package. The primitives have no reason to know about chats, work items or the API, so they are
   the first boundary and the cheapest to prove.

## Principles

- **Seam first, move second.** Every file is made independent of the app *while it is still in
  `apps/web`* (a behaviour-preserving edit, reviewed as code). Only then is it moved, with
  `git mv`, in a task that changes nothing but paths (reviewed as renames). No task both rewrites
  and moves a file.
- **Shims make the move atomic.** The move leaves a one-line re-export at every old path, so no
  importer changes in the same commit. Later tasks rewrite importers area by area, in disjoint
  directories, and the last task deletes the shims.
- **The dependency direction is a test.** `apps/web` → `@agentry/chat-ui` → `@agentry/ui` →
  `@agentry/shared`. Never the other way, and never into `apps/`.
- **One module, one path.** A module is reachable under exactly one import path once the shims are
  gone. There is no root barrel: each package exports one subpath per public module, so a lazy
  chunk stays lazy and the bundle keeps its shape.
- **Consumed from source, like `@agentry/shared`.** No build step, `workspace:*`, `exports` pointing
  at `.ts`/`.tsx`, compiled by Vite and `tsx` as today.
- **Compatible with phase 2 of multiple providers**, which runs at the same time on
  `feat/multi-provider-2` (see "Living beside phase 2").

## What was verified

The survey this plan starts from was checked against the code at `41c7063b`:

- `packages/shared/package.json` has `"exports": { ".": "./src/index.ts" }` and no build.
  `tsconfig.base.json` has `moduleResolution: Bundler`, `allowImportingTsExtensions`,
  `verbatimModuleSyntax`, `noEmit`. `pnpm-workspace.yaml` already globs `packages/*`.
- Root `test` lists packages by `--filter`; `typecheck` is `pnpm -r typecheck`. `docker/Dockerfile`
  copies each `package.json` before `pnpm install --frozen-lockfile` (lines 11–14).
  `release-please-config.json` bumps every `package.json` through `extra-files`.
- `apps/web/test/design-tokens.test.ts` and `hardcoded-strings.test.ts` walk `apps/web/src` only
  (`SRC`), and the tokens test reads `styles/tokens.css` relative to it. The hard-coded strings
  test parses with Vite's `parseSync` and fails on an `ALLOWED` entry that no longer matches.
- i18n: `resources.ts` builds `en` and `es` (typed with `satisfies Shape<typeof en>` and a
  no-extra-keys check); `i18n/index.ts` declares `CustomTypeOptions` and initialises the global
  `i18next` instance. Unknown keys fail `pnpm typecheck`.
- 105 of the web's test files import `../src/...` directly; 34 of them import a module that moves
  to `@agentry/ui`.
- Import graph (every relative import of `apps/web/src`, 418 modules): the primitives set is closed
  except for seven edges back into the app, and the chat set except for fifteen; both lists are in
  "The seams" below. 216 app files import a primitive (760 import edges); 24 of them are chat files.

Two corrections to the survey: `ChatToolsPicker` is not a chat-package file (only app screens and a
type in the composer use it), and `pages/chat/Header.tsx`, `Inspector.tsx` and `Side.tsx` stay in
the app (see "What stays in the app").

## The boundaries

Paths are relative to `apps/web/src`. **The layout inside each package mirrors the app's**
(`components/`, `lib/`, `styles/`), so relative imports between two files that move together do not
change.

### `@agentry/ui` (≈ 73 files, ≈ 10.5k lines with its CSS)

| Group | Files |
|---|---|
| Primitives | `components/ui.tsx` (all but the model block, see seam S1), `icons.tsx` (all but the work item icons, S2), `motion.tsx`, `Spinner.tsx`, `ProgressBar.tsx`, `Stepper.tsx`, `VirtualList.tsx`, `AnimatedNumber.tsx`, `Toast.tsx`, `Dialog.tsx`, `modal-stack.ts`, `ActivityTicker.tsx`, `SplitButton.tsx`, `ListToolbar.tsx`, `ScrollJump.tsx` |
| Controls | `components/controls/*` except `ModelPicker.tsx` (S3): `Collapsible`, `Combobox`, `DatePicker`, `Menu`, `MoreActions`, `NumberInput`, `Select`, `Sheet`, `Slider`, `Toggle`, `Tooltip`, `layer.ts`, `index.ts` |
| Illustrations | `components/illustrations/*` (all 17 files) |
| Renderers | `components/Markdown.tsx`, `CodeBlock.tsx`, `highlight.ts`, `highlight/*` (9 files), `lib/markdown-autolink.ts`, `lib/markdown-blocks.ts` |
| Libraries | `lib/format.ts`, `media.ts`, `lru.ts`, `motion.ts`, `live.ts`, `progress.ts`, `calendar.ts` (S4) |
| i18n | `i18n/language.ts`; locales `common.json` and `primitives.json` (en, es) |
| Styles | `styles/tokens.css`, `primitives.css`, `feedback.css`, `motion.css`, `illustrations.css`; `controls.css` |

The renderers go here, not into the chat package, because the app uses them without a chat:
`DiffView` highlights with `highlight.ts`; documents, work items and memory proposals render
`Markdown`; `DetailPanel`, `WorkflowCard`, `VerificationCard` and `OrchestrationDetail` use
`CodeBlock` (decision 1 below).

### `@agentry/chat-ui` (≈ 23 files, ≈ 7.4k lines with its CSS)

| Group | Files (from) | In the package |
|---|---|---|
| Transcript | `components/Transcript.tsx`, `TranscriptSearch.tsx` | `components/` |
| Composer | `pages/chat/Composer.tsx`, `queued.ts`, `stick-to-bottom.ts`; `components/SlashMenu.tsx` | `composer/` (the first three), `components/` |
| Prompts and files | `components/PermissionPrompts.tsx`, `Attachments.tsx`, `MediaViewer.tsx` | `components/` |
| Badges | `components/ChatBadges.tsx`, `ContextRing.tsx`, `ChatDelete.tsx` | `components/` |
| Hooks | `lib/chats.ts` (the transcript, stream, permissions, tasks, subagent and output hooks) | `lib/` |
| Models | `lib/chat-steps.ts`, `chat-notice.ts`, `chat-stream.ts`, `chat-live.ts`, `chat-model.ts`, `chat-pages.ts`, `slash-commands.ts` | `lib/` |
| New | `lib/context.tsx` (provider, client, keys; seam C1), `lib/edit-chips.ts` (C2), `lib/permission-param.ts` (C3) | `lib/` |
| i18n | locale `chat.json` (en, es) | `locales/` |
| Styles | `styles/chat.css`, `styles/transcript.css`; `chats.css` | `styles/`; `chats.css` at the root, as in the app |

### What stays in the app

- **Route pages, as wiring:** `pages/ChatView.tsx`, `pages/Chats.tsx`, `pages/NewChat.tsx`.
- **The chat page's chrome:** `pages/chat/Header.tsx`, `Inspector.tsx`, `Side.tsx`, `ToolsCard.tsx`,
  `PartOf.tsx`, `WorkItemLinks.tsx`, `FailedFlowRun.tsx`. They draw Agentry-wide things — the
  observe cards (`components/observe/*`), `EnvironmentPanel`, `WorkflowCard`, work items,
  orchestration steps, the detail panel — and `ChatView` already composes them, so they need no
  slots (decision 2).
- **Provider-specific start options:** `pages/chat/Controls.tsx` (model, permission mode) and
  `components/ChatToolsPicker.tsx` (tool presets, MCP servers). They reach the composer as slots.
- **The model block of `components/ui.tsx`** (`PERMISSION_MODES`, `MODEL_OPTIONS`,
  `useModelOptions`, `ModelCombobox`), byte for byte, and `ModelPicker` (moved to
  `components/ModelPicker.tsx`). They list Claude's models and modes, and phase 2 rewrites them.
- `api.ts`, `lib/events.ts`, `lib/feed.ts`, `lib/auth.ts`, `lib/changes-summary.ts` (without
  `editChips`), `lib/notifications-model.ts`, `components/changes/*`, `DetailPanel`, every other
  page and component.
- **The web's tests stay in `apps/web/test`**, importing from the packages. That keeps
  `pnpm --filter @agentry/web test` the one drift net, and keeps phase 2's edits to web tests where
  they are (see "Living beside phase 2"). The packages' own `test/` hold their guard tests.

## The seams

Every edge from a moving file back into the app, and how it is cut. Each is a task of its own below.

| Seam | Edge today | Cut |
|---|---|---|
| S1 | `ui.tsx` → `api.ts` (`useOverview`), `@agentry/shared` `MODEL_ALIASES` | The generic primitives move to a new `components/primitives.tsx`; `ui.tsx` keeps the model block unchanged and re-exports `primitives.tsx` until the shims go |
| S2 | `icons.tsx` → `lib/work-items.ts` | `WorkItemStatusIcon`, `WorkItemTypeIcon`, `PriorityMark`, `WorkItemKey`, `EpicLabel` move to `components/work-item-icons.tsx` (stays); their importers are updated |
| S3 | `controls/index.ts` → `ModelPicker.tsx` → `ui.tsx` | `ModelPicker` moves to `components/ModelPicker.tsx`; `controls/index.ts` stops exporting it |
| S4 | `calendar.ts` → `usage-view.ts` (`parseDay`, `toDay`) | The two functions move into `calendar.ts`; `usage-view.ts` imports them from there |
| S5 | `ui.tsx`, `format.ts`, `Markdown.tsx` → `i18n/index.ts` (the instance) | `import i18n from 'i18next'`: the same global instance the app initialises |
| S6 | `format.ts`, `DatePicker.tsx` → `i18n/language.ts` | `language.ts` moves with the primitives; `i18n/index.ts` re-exports `LANGUAGES` and `Language` from it |
| C1 | `chats.ts`, `Composer`, `PermissionPrompts`, `ChatDelete`, `Attachments` → `api.ts` (`api`, `keys`, `BASE`, `enc`); `lib/auth.ts` (`withToken`); `lib/feed.ts` (`useFallbackInterval`) | `ChatUiProvider` with an injected `ChatClient`, `chatKeys`, and the fallback interval as a value (below) |
| C2 | `Transcript.tsx` → `changes-summary.ts` (`editChips`, `reviewLink`, `reviewPath`) | `editChips` and `EditChip` move to `lib/edit-chips.ts` (chat set; `changes-summary.ts` re-exports them); the review link comes from `paths.chatChangeStep` |
| C3 | `PermissionPrompts.tsx` → `notifications-model.ts` (`PROMPT_PARAM`) | The constant moves to `lib/permission-param.ts` (chat set); `notifications-model.ts` imports it |
| C4 | `Composer.tsx` → `Controls.tsx` (lazy), `ChatToolsPicker.tsx` (type `ToolChoices`) | `StartOptions`/`LiveOptions` become slots, lazy on the app side; `StartChoices` is declared in the composer from shared types (`McpSelection`, `PermissionMode`) |
| C5 | `chat-model.ts`, `Attachments.tsx`, `PermissionPrompts.tsx` → `i18n/index.ts` | As S5 |
| C6 | `Transcript.tsx` renders the literal `'Claude'` as the author (two places) | `agentName` from the provider; the app passes `'Claude'` |

## The interfaces

### `@agentry/chat-ui/lib/context`

```ts
/** What the chat package asks of the server. `api` in apps/web satisfies it, plus two URL builders. */
export interface ChatClient {
  chat(id: string, sidechains: boolean, page?: { limit?: number; before?: number }, o?: { signal?: AbortSignal }): Promise<ChatDetail>;
  chatPermissions(id: string): Promise<PermissionRequest[]>;
  chatTasks(id: string): Promise<ChatBackgroundTask[]>;
  answerPermission(id: string, requestId: string, decision: PermissionDecision): Promise<unknown>;
  sendMessage(id: string, req: ChatMessageRequest): Promise<ChatSummary>;
  resumeChat(id: string, req: ResumeChatRequest): Promise<ChatSummary>;
  forkChat(id: string, req: ForkChatRequest): Promise<ChatSummary>;
  deleteChat(id: string): Promise<{ ok: true }>;
  uploadFile(file: File): Promise<Attachment>;
  subagent(chatId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  workflowAgent(chatId: string, workflowId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  taskOutput(chatId: string, taskId: string, offset?: number): Promise<TaskOutputPage>;
  /** The SSE URL of one chat's stream, with the token when the wrapper is guarded. */
  streamUrl(chatId: string, since: number): string;
  /** Where an upload's bytes are served (`/api/uploads/:id/content` today). */
  contentUrl(uploadId: string): string;
}

export interface ChatUiConfig {
  client: ChatClient;
  /** The agent's name as the transcript shows it: 'Claude' today, the chat's provider in phase 3. */
  agentName: string;
  /** The app's polling fallback while its event feed is down (useFallbackInterval), as a value. */
  fallbackInterval: number | false;
  paths: {
    chat(id: string): string;                               // '/chats/:id', after a fork
    chatChangeStep(chatId: string, stepId: string): string; // the review screen at one step
  };
  slots: {
    StartOptions: ComponentType<{ chat: Chat; value: StartChoices; onChange(next: StartChoices): void; forking: boolean }>;
    LiveOptions: ComponentType<{ chat: Chat }>;
  };
}

export function ChatUiProvider(props: { value: ChatUiConfig; children: ReactNode }): ReactElement;
/** Throws outside the provider: a chat component without a client is a wiring bug, not a state. */
export function useChatUi(): ChatUiConfig;
```

- The signatures are **copied from `api.ts`**, not invented: the task that writes them checks
  `api` against `Omit<ChatClient, 'streamUrl' | 'contentUrl'>` with `satisfies`, so a drift in
  either fails `pnpm typecheck`. The exact return types (`TaskOutputPage` above stands for whatever
  `api.taskOutput` returns) are the ones in `api.ts`.
- The app's wiring lives in **`apps/web/src/lib/chat-ui.tsx`**: `chatClient` (`api`'s methods,
  `streamUrl` and `contentUrl` built with `BASE`, `enc` and `withToken`), and an `AppChatUi`
  component that calls `useFallbackInterval()` and renders `ChatUiProvider`. It is mounted **in
  `main.tsx`, inside `QueryClientProvider` and the router, around `<App />`**, because the detail
  panel, orchestration pages, work items and Home use chat hooks, not only `ChatView`.
- The slots are `lazy(() => import('../pages/chat/Controls')…)` in the wiring file, so `Controls`
  stays its own chunk.
- `react-router-dom` is a peer dependency of the chat package: `Link`, `useNavigate`,
  `useLocation` and `useSearchParams` come from the app's router as today; only the *paths* are
  injected.
- `useConfirm` and `useToast` need no injection: they are primitives, and their providers (from
  `@agentry/ui`) are already mounted in `main.tsx`.

### Query keys

```ts
/** The keys the chat package reads and writes. apps/web spreads them into `keys`, unchanged. */
export const chatKeys = {
  chats: ['chats'] as const,
  chatScope: (id: string) => ['chat', id] as const,
  chat: (id: string, sidechains: boolean) => ['chat', id, sidechains] as const,
  chatEarlier: (id: string, sidechains: boolean) => ['chat', id, sidechains, RUN_TAG] as const,
  chatPermissions: (id: string) => ['chat', id, 'permissions'] as const,
  chatTasks: (chatId: string) => ['tasks', 'chat', chatId] as const,
  agentDetail: ['agent-detail'] as const,
  agent: (chatId: string, workflowId: string, agentId: string) => ['agent-detail', chatId, workflowId, agentId] as const,
  taskOutput: ['task-output'] as const,
  output: (chatId: string, taskId: string) => ['task-output', chatId, taskId] as const,
};
// apps/web/src/api.ts
export const keys = { ...chatKeys, overview: ['overview'] as const, /* the rest, unchanged */ };
```

The entries are **moved verbatim** out of `api.ts`'s `keys`, each prefix with its full key
(`agentDetail` with `agent`, `taskOutput` with `output`), because `lib/events.ts` invalidates by
prefix and a prefix left behind in the app would be a key that no longer matches. `events.ts` keeps
reading `keys.*`, which are now the same function objects.

### i18n

- **Namespaces keep their names; ownership moves.** `@agentry/ui` owns `common` and `primitives`;
  `@agentry/chat-ui` owns `chat`. The app may read a package's namespace (it already reads
  `common:` everywhere); a package never reads the app's.
- **Subtrees the moved files read from app namespaces move with them, under the same sub-key:**
  - into `primitives`: `components.{ui, controls, dialog, toast, combobox, datePicker,
    illustrations, markdown, codeBlock}` and any other `components` subtree a moved file reads;
  - into `chat`: `components.{transcript, permissions, find, attachments, viewer, slashMenu}`,
    `chats.model` (as `chat.model`) and `work.{shared, sessionView, runView}`.

  None of these collide with the keys already there (checked: `primitives` has `activity progress
  step menu splitButton sheet toolbar`; `chat` has `view composer controls tools badges side delete
  head pill status inspector newChat launch messageMenu edits`). App callers of a moved subtree
  change their prefix (`components:toast.…` → `primitives:toast.…`); the typed `t` fails the build
  on any caller left behind.
- **One key is renamed:** `components.permissions.claudeIsAsking` becomes
  `chat:permissions.agentIsAsking`, same English and Spanish values, so the chat package names no
  vendor in its code. The seven `chat.json` values that say "Claude" or "Claude Code" keep their
  words (decision 3).
- **Each package exports its locales** (`@agentry/ui/i18n/resources`: `uiEn`, `uiEs`;
  `@agentry/chat-ui/locales`: `chatUiEn`, `chatUiEs`). `apps/web/src/i18n/resources.ts` spreads them
  into `en` and `es`; the `Shape` and no-extra-keys checks, the many-plural derivation and
  `test/i18n.test.ts` keep working over the whole tree. `GLOSSARY.md` stays in the app and governs
  the packages' Spanish too.
- **Typing without two `CustomTypeOptions` in one program.** The app keeps the only declaration
  that its compile sees (`i18n/index.ts`, `resources: typeof en`, the full tree). Each package
  declares its own in `types/i18next.d.ts` — `@agentry/ui` with `typeof uiEn`, the chat package
  with `typeof uiEn & typeof chatUiEn` — listed in the package's `tsconfig.json` `include` and
  imported by no module, so the app's compile never sees it. Package code therefore typechecks
  twice: against its own namespaces alone (which proves it reads nothing of the app's) and inside
  the app. Both use `defaultNS: 'common'`.
- `i18n/index.ts`'s header comment (the namespace map) is updated to say which package owns which
  namespace.

### Styles

- The CSS files move into the packages' `styles/` and are exported as `@agentry/ui/styles/*.css`
  and `@agentry/chat-ui/styles/*.css`. **`apps/web/src/styles.css` stays the only manifest of the
  cascade:** it keeps every `@import`, in the same order, with the moved ones now naming package
  paths. `main.tsx` imports `@agentry/ui/controls.css` where it imported `./controls.css`, and
  `ChatBadges.tsx` keeps its side-effect import of `../chats.css`, which moves to the same relative place.
- Still **tokens only**: `design-tokens.test.ts` walks `apps/web/src`, `packages/ui/src` and
  `packages/chat-ui/src`, and reads the tokens from `packages/ui/src/styles/tokens.css`. The
  `#fff`-on-gradient exception is unchanged. `hardcoded-strings.test.ts` walks the same three roots,
  with paths in its report relative to the repository.
- The desktop shell's two comments naming `apps/web/src/styles/tokens.css`
  (`apps/desktop/src/pages.ts`, `title-bar.ts`) point to the new path.

### The packages

```json
{
  "name": "@agentry/ui",
  "version": "0.27.0",
  "private": true,
  "type": "module",
  "exports": {
    "./components/Toast": "./src/components/Toast.tsx",
    "./lib/format": "./src/lib/format.ts",
    "./styles/tokens.css": "./src/styles/tokens.css",
    "…": "one entry per public module, generated from the files; no \".\" barrel"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": { "@agentry/shared": "workspace:*", "…": "libraries only it imports, same ranges as apps/web" },
  "peerDependencies": { "react": "…", "react-dom": "…", "i18next": "…", "react-i18next": "…", "@tanstack/react-query": "…" },
  "devDependencies": { "…": "the same peers, same ranges; vite; @types/react" }
}
```

- **Subpaths mirror file paths** (`@agentry/ui/components/Toast`), so every rewrite from a
  relative import is mechanical and the module graph keeps its shape. `@agentry/chat-ui` adds
  `react-router-dom` to its peers and `@agentry/ui` to its dependencies.
- **No `sideEffects` field.** The app's modules count as side-effectful today, and
  `lib/motion.ts` stamps the motion level on import (`main.tsx` imports it for that alone); a
  `sideEffects: false` would let the bundler drop it.
- `tsconfig.json` mirrors `apps/web/tsconfig.json` (`DOM` libs, `jsx: react-jsx`,
  `types: ["vite/client"]`), with `include: ["src", "types"]`.
- **One instance of each stateful library.** Every peer is also a devDependency with the same range,
  so pnpm links one copy. `apps/web/vite.config.ts` adds `resolve.dedupe` for `react`, `react-dom`,
  `i18next`, `react-i18next`, `@tanstack/react-query`, `react-router-dom` and `motion` as a second
  line of defence, and a test proves it (below).
- **Workers never add a dependency after `g2`**, so `pnpm-lock.yaml` is edited once. On a lockfile
  conflict at integration, take either side and run `pnpm install`.

### Build, Docker and release

- Root `package.json` `test`: add `--filter @agentry/ui --filter @agentry/chat-ui`.
  `typecheck` (`pnpm -r`) picks them up by itself.
- `docker/Dockerfile`: `COPY packages/ui/package.json packages/ui/` and the same for
  `packages/chat-ui`, beside the other `package.json` copies before `pnpm install`. The later
  `COPY packages packages` already carries the sources.
- `release-please-config.json`: two `extra-files` entries for the new `package.json` versions.
- `apps/web/scripts/sw-shell.ts` and the service worker's shell list need no change: the list is
  read back from the built `index.html`, so it follows whatever the build emits. The bundle-shape
  check below proves the shell did not grow.
- The desktop app bundles `apps/web/dist` as before.

## The guard tests

Written in `g2`, green from the start (the packages are empty), and never edited by a later task
except to extend a list the plan names.

- **`packages/ui/test/boundaries.test.ts`.** Parses every `.ts`/`.tsx` under `packages/ui/src` with
  the TypeScript compiler API (`ts.createSourceFile`; `typescript` is a root devDependency) and
  fails on any import or re-export specifier, static or dynamic, that is:
  - relative and resolves outside `packages/ui/src`;
  - `@agentry/web`, `@agentry/chat-ui`, `@agentry/core`, `@agentry/api`, `@agentry/desktop`, or
    any path containing `apps/`;
  - a named import of `MODEL_ALIASES` or `PERMISSION_MODES` from `@agentry/shared` (phase 2 moves
    the first; both are one provider's vocabulary).
  CSS `@import`s under `packages/ui/src` are checked the same way.
- **`packages/chat-ui/test/boundaries.test.ts`.** The same, allowing `@agentry/ui/*`, and also
  failing when:
  - an import specifier matches `/claude|anthropic/i`;
  - an identifier, a string literal or a template literal in code (comments excluded) matches the
    same pattern — so the chat package cannot branch on, label or import one vendor;
  - a `RunEvent` field other than `seq`, `ts`, `kind`, `entry`, `status`, `text` and `block` is read
    (a property access on a value typed `RunEvent`; a simple AST check on `event.type`,
    `event.subtype` and `event.data` is enough), which keeps it compatible with phase 2's neutral
    event.
  Locale JSON is outside the scan (decision 3).
- **`packages/ui/test/single-instance.test.ts`.** For `react`, `react-dom`, `i18next`,
  `react-i18next`, `@tanstack/react-query`, `react-router-dom`, `motion`, `lucide-react` and every
  `@radix-ui/*` the packages declare: the real path of `node_modules/<name>` is the same from
  `apps/web`, `packages/ui` and `packages/chat-ui` (where declared). Two copies of React Query
  would mean two caches; two of i18next, untranslated package text; two of the tooltip library, a
  tooltip with no provider.

## How each task proves there is no drift

Written in `g1`, **against today's code, before anything moves**, committed green, and kept green
by every task after it.

1. **Strings snapshot** — `apps/web/test/strings-snapshot.test.ts` and
   `test/fixtures/strings.json`: the sorted multiset of every English value and, separately, every
   Spanish value, across all namespaces `resources.ts` registers. Moving a key keeps the multiset;
   changing or duplicating a string breaks it. No task may update this fixture.
2. **Class inventory** — `apps/web/scripts/class-inventory.ts` and `test/fixtures/class-names.json`,
   checked by `test/class-inventory.test.ts`: every class selector in every stylesheet under
   `apps/web/src` and `packages/*/src`, every static token of a `className` (string and template
   literal parts, parsed with `parseSync`), and the ordered list of stylesheet basenames as
   `styles.css` and `main.tsx` import them. Set equality for the first two, exact order for the
   third. No task may update this fixture.
3. **Module graph** — `apps/web/scripts/module-graph.ts` and `test/fixtures/module-graph.json`,
   checked by `test/module-graph.test.ts`. From `src/main.tsx`, it follows static and dynamic
   imports through relative paths and the packages' `exports`, **collapsing shims** (a module whose
   every statement is `export … from`). A node's identity is its file basename plus its sorted
   export names, so a moved file with the same surface is the same node. It records the node
   multiset and the dynamic-import edges (the lazy chunks), and fails on two reachable files with
   identical content (a copy instead of a move). A task that changes the graph on purpose (a new
   wiring file, a split) updates the fixture in the same commit and lists the added and removed
   lines in its summary; the expected changes are named in each task below.
4. **Bundle shape** — `apps/web/scripts/bundle-shape.ts --check`, run after `pnpm build` by the
   tasks that move files: the JS chunk names without hashes, and the assets `index.html` references
   (the service worker's shell), compared with `test/fixtures/bundle-shape.json`. A lazy chunk that
   became eager, or a primitive that dragged the highlighter into the shell, shows up here.
5. **Query keys** — `apps/web/test/chat-keys.test.ts`: the output of each key in "Query keys" for
   fixed arguments, pinned from today's `keys`. From `c1` on, it also asserts
   `keys[name] === chatKeys[name]` for each of them. The existing `events` tests
   (`work-item-events`, `team-events`, `project-events`, `assistant-events`) stay unedited.
6. **Renames are renames.** A move task's diff, read with `git diff -M90 --stat`, shows every moved
   file as a rename, and the shims as new one-line files; `git diff -M --color-moved` for the rest.
7. **Existing tests stay unedited** except for import paths (and, in `u2`/`c3`, key prefixes).
   Every such edit is listed in the task's summary.
8. **The e2e run at the end**, once, with every spec unchanged: `git diff 41c7063b -- e2e/specs`
   is empty.

## Living beside phase 2

Phase 2 of multiple providers (`feat/multi-provider-2`) is mostly core; its web contact points are
three, and this plan keeps each compatible:

| Phase 2 task | Web contact | Here |
|---|---|---|
| `n2`, neutral `RunEvent` | Drops `type`, `subtype`, `data`; the web reads `kind`, `entry`, `status`, `text`, `block` (`lib/chats.ts`) | The chat package's guard forbids reading anything else, so the type change compiles against it unchanged |
| `n3`, models from the catalog | Edits `MODEL_OPTIONS` in `apps/web/src/components/ui.tsx` | The model block stays in that file, at that path, byte for byte (`u1` may change the imports above it and nothing inside it). Whichever branch lands second re-applies the other's hunk by hand if git does not |
| `n2`/`n3`, tests | May edit a web test that builds a `RunEvent` with `type`, or imports `MODEL_ALIASES` | The web's tests stay in `apps/web/test`, so those edits land in the same files |

`n4` adds `Chat.provider`, which the chat package does not read yet (the provider is shown in
phase 3; phase 2's decision 3). When it does, `agentName` comes from it.

Merge order: whichever branch reaches `main` second merges `main` in and runs the full checks
again. Neither waits for the other.

## Orchestrations and task graph

One delivery on **`feat/web-packages`**, squash-merged once. Four orchestrations, each landing on
that branch. Every code-writing worker runs on `claude-sonnet-5-5` (the exact id, never the
`sonnet` alias), in its own git worktree, and is merged into the orchestration's integration
branch. **No worker runs `pnpm e2e`.** Every task runs `pnpm typecheck` and
`pnpm --filter @agentry/web --filter @agentry/ui --filter @agentry/chat-ui test`; the tasks that
move files also run `pnpm build` and the bundle-shape check. The full `pnpm test`, `pnpm build` and
`pnpm e2e` run once, at the end, on the branch.

Rules every worker follows, stated in each prompt:

- Touch only the files the task names. A file outside the list that needs a change is a finding for
  the summary, not an edit.
- No new dependency after `g2`. No visible change: no class name, no English or Spanish string, no
  layout.
- Seam tasks change code in place; move tasks change paths only. A move task that finds it must edit
  a moved file's logic stops and reports it.
- Shims are re-exports only (`export * from '…'`, plus `export { default } from '…'` where the
  module has a default export). Never a copy.

### W0 · `web-packages-groundwork`

- `g1` (drift nets), dependsOn none.
  - The strings snapshot, class inventory, module graph, bundle shape and chat keys tests of "How
    each task proves there is no drift", with their scripts and fixtures, generated from today's
    code and green on it.
  - Files: `apps/web/scripts/class-inventory.ts`, `module-graph.ts`, `bundle-shape.ts`;
    `apps/web/test/strings-snapshot.test.ts`, `class-inventory.test.ts`, `module-graph.test.ts`,
    `chat-keys.test.ts`; `apps/web/test/fixtures/strings.json`, `class-names.json`,
    `module-graph.json`, `bundle-shape.json`.
  - Checks: web tests; `pnpm build` then `bundle-shape.ts --check`; each new test fails when its
    fixture is edited by one entry (tried locally, not committed).
- `g2` (scaffolding and guards), dependsOn none.
  - `packages/ui` and `packages/chat-ui`: `package.json` (as above, empty `exports`),
    `tsconfig.json`, `test/tsconfig.json`, `types/i18next.d.ts` (over empty resources for now),
    `src/.gitkeep`; the boundaries tests and the single-instance test; `apps/web/package.json`
    gains both as `workspace:*`; `apps/web/vite.config.ts` gains `resolve.dedupe`; root
    `package.json` `test`; `pnpm-lock.yaml`; `docker/Dockerfile`; `release-please-config.json`.
  - Files: exactly those.
  - Checks: `pnpm install --frozen-lockfile` after the lockfile is written; `pnpm typecheck`;
    `pnpm test` for the two new packages and web; `pnpm build`; `docker build` is **not** run by the
    worker (the final check does).

### W1 · `ui-package`, dependsOn W0

- `u1` (code seams S1–S6), dependsOn g1, g2.
  - S1: `components/primitives.tsx` (new) with everything of `ui.tsx` but the model block;
    `ui.tsx` keeps the block, its imports, and `export * from './primitives'`. S2:
    `components/work-item-icons.tsx` (new) and its importers. S3: `components/ModelPicker.tsx`
    (moved from `controls/`), `controls/index.ts`, its importers. S4: `lib/calendar.ts`,
    `lib/usage-view.ts`. S5: `ui.tsx`/`primitives.tsx`, `lib/format.ts`, `Markdown.tsx`. S6 needs
    no edit yet (`language.ts` moves in `u3`).
  - Files: `components/ui.tsx`, `primitives.tsx`, `icons.tsx`, `work-item-icons.tsx`,
    `ModelPicker.tsx`, `controls/index.ts`, `controls/ModelPicker.tsx` (removed), `lib/calendar.ts`,
    `lib/usage-view.ts`, `lib/format.ts`, `components/Markdown.tsx`; the importers of the five work
    item icons and of `ModelPicker` (import lines only); `test/module-graph.json` (expected: two new
    nodes, `ui.tsx` and `icons.tsx` with smaller surfaces, `ModelPicker` re-parented).
  - Checks: typecheck; web tests; the lines of `ui.tsx` from `export const PERMISSION_MODES` to the
    end are byte-identical to `41c7063b` (`git diff 41c7063b -- apps/web/src/components/ui.tsx`
    shows no hunk inside them).
- `u2` (i18n seams), dependsOn u1.
  - Move the `components` subtrees the primitive files read into `primitives` (the list in "i18n",
    completed by reading every `t(` of the primitive files), in en and es; update the primitive
    files' namespaces and every app caller of a moved subtree.
  - Files: the primitive files of "The boundaries" that call `t`; `i18n/locales/{en,es}/components.json`
    and `primitives.json`; app callers of moved keys (key prefix edits only); `i18n/index.ts`
    (header comment).
  - Checks: typecheck (the typed `t` catches a missed caller); web tests, strings snapshot unchanged.
- `u3` (the move, with shims), dependsOn u2.
  - `git mv` every file of the `@agentry/ui` table into `packages/ui/src/` at the same relative path
    (`components/primitives.tsx` goes as `components/ui.tsx`: the app's `ui.tsx` keeps its path for
    phase 2 and re-exports from `@agentry/ui/components/ui`); a shim at each old path; the `exports`
    map, generated from the moved files; `packages/ui/src/i18n/resources.ts` (`uiEn`, `uiEs`) and
    the locale files; `apps/web/src/i18n/resources.ts` spreading them; `i18n/index.ts` re-exporting
    from the moved `language.ts`; `styles.css` and `main.tsx` naming the package CSS in the same
    order; `packages/ui/types/i18next.d.ts` on `uiEn`; `design-tokens.test.ts` and
    `hardcoded-strings.test.ts` walking the three roots.
  - Files: the moved files and their shims; `packages/ui/package.json` (`exports` only),
    `packages/ui/src/i18n/resources.ts`, `packages/ui/types/i18next.d.ts`,
    `apps/web/src/i18n/resources.ts`, `i18n/index.ts`, `styles.css`, `main.tsx`,
    `apps/web/test/design-tokens.test.ts`, `hardcoded-strings.test.ts`.
  - Checks: typecheck (both packages' own compiles included); all three test suites; `pnpm build`
    and bundle shape; module graph unchanged but for one expected line (the `primitives.tsx` node
    is now named `ui.tsx`, same exports; shims collapse); `git diff -M90 --stat` shows renames.
- `u4a`–`u4f` (importers off the shims), each dependsOn u3, in parallel, **import lines only**:
  - `u4a`: `pages/config/**`, `pages/accounts/**`, `pages/Settings.tsx`, `Usage.tsx`,
    `Connectors.tsx`, `Accounts.tsx`, `Schedules.tsx`, `ScheduleEditor.tsx`, `pages/schedules/**`
    (41 files).
  - `u4b`: `pages/tasks/**`, `pages/team/**`, `pages/assistant/**` (60 files).
  - `u4c`: `pages/home/**`, `pages/projects/**`, `pages/dashboard/**`, `pages/documents/**`,
    `pages/Home.tsx`, `Projects.tsx` (33 files).
  - `u4d`: `App.tsx`, `main.tsx`, `lib/**` and `components/**` outside the chat set and the moved
    set, `pages/Orchestration.tsx`, `OrchestrationDetail.tsx`, `ChangesReview.tsx` (56 files).
  - `u4e`: the chat set of "The boundaries" plus `pages/ChatView.tsx`, `Chats.tsx`, `NewChat.tsx`
    and `pages/chat/**` (24 files).
  - `u4f`: `apps/web/test/**` (34 files).
  - Checks: typecheck; web tests; module graph unchanged; `grep` finds no import of an old path in
    the task's directories.
- `u5` (shims gone), dependsOn u4a–u4f.
  - Delete every shim. `apps/web/src/components/ui.tsx` is left with the model block, its imports
    and nothing else.
  - Files: the shim files; `apps/web/src/components/ui.tsx` (its re-export line).
  - Checks: typecheck; all three suites; `pnpm build` and bundle shape; module graph unchanged;
    `packages/ui` boundaries green; no file in `apps/web` imports `components/controls/`,
    `components/illustrations/` or a moved `lib/` module by relative path.

### W2 · `chat-ui-package`, dependsOn W1

- `c1` (the client, keys and provider; C1), dependsOn u5.
  - `lib/chat-context.tsx` (new, in the chat set; moves as `lib/context.tsx`): `ChatClient`,
    `ChatUiConfig`, `ChatUiProvider`, `useChatUi`, `chatKeys` moved verbatim out of `api.ts`;
    `api.ts`'s `keys` spreads them, and `api` is checked with `satisfies`. `lib/chat-ui.tsx` (new,
    app wiring) with the full config — client, `agentName: 'Claude'`, the fallback interval, both
    paths and both slots — so later tasks only consume it. `main.tsx` mounts `AppChatUi`.
    `lib/chats.ts` reads the client, keys, stream URL and interval from the context.
  - Files: `lib/chat-context.tsx`, `lib/chat-ui.tsx`, `api.ts` (the moved keys and one
    `satisfies`), `main.tsx`, `lib/chats.ts`, `test/chat-keys.test.ts` (the identity half),
    `test/module-graph.json` (expected: two new nodes; `api.ts`'s surface unchanged).
  - Checks: typecheck; web tests (events tests unedited); chat keys identity.
- `c2a` (the composer; C4), dependsOn c1.
  - `Composer.tsx` uses `slots.StartOptions`/`LiveOptions`, `paths.chat`, and the client;
    `StartChoices` declared from shared types; `ChatToolsPicker`'s `ToolChoices` becomes
    `Pick<StartChoices, 'toolPreset' | 'mcp'>`-compatible (type-only).
  - Files: `pages/chat/Composer.tsx`, `components/ChatToolsPicker.tsx` (the type only),
    `pages/chat/Controls.tsx` (its `StartChoices` import), `test/module-graph.json` (the lazy edge to
    `Controls` now leaves `chat-ui.tsx`).
  - Checks: typecheck; web tests; bundle shape unchanged (`Controls` still its own chunk).
- `c2b` (the transcript; C2, C6), dependsOn c1.
  - `lib/edit-chips.ts` (new) with `editChips` and `EditChip`, re-exported by `changes-summary.ts`;
    `Transcript.tsx` uses it, `paths.chatChangeStep` and `agentName`.
    `hardcoded-strings.test.ts`: the `'Claude'` entry of `ALLOWED` stays only if something still
    matches it (the test fails on a stale entry).
  - Files: `lib/edit-chips.ts`, `lib/changes-summary.ts`, `components/Transcript.tsx`,
    `apps/web/test/hardcoded-strings.test.ts` (`ALLOWED` only), `test/module-graph.json`.
  - Checks: typecheck; web tests (`changes-summary.test.tsx` unedited).
- `c2c` (prompts, files, delete; C1, C3, C5), dependsOn c1.
  - `Attachments.tsx` uses `client.uploadFile` and `client.contentUrl` (the hard-coded
    `/api/uploads` goes); `PermissionPrompts.tsx` the client, `chatKeys`, `i18next`, and
    `PROMPT_PARAM` from `lib/permission-param.ts` (new), which `notifications-model.ts` now imports;
    `ChatDelete.tsx` the client and keys; `chat-model.ts` imports `i18next`.
  - Files: `components/Attachments.tsx`, `PermissionPrompts.tsx`, `ChatDelete.tsx`,
    `lib/permission-param.ts`, `lib/notifications-model.ts` (import only), `lib/chat-model.ts`
    (import only), `test/module-graph.json`.
  - Checks: typecheck; web tests (notifications tests unedited).
- `c3` (i18n seams), dependsOn c2a, c2b, c2c.
  - Move into `chat` the subtrees of "i18n"; rename `claudeIsAsking` to `agentIsAsking`; update the
    chat files and every app caller (`ChatView`, `Header`, `Side`, `Controls`, `Chats`, `NewChat`
    and any other the compiler names).
  - Files: the chat set's `t` calls; app callers (prefix edits only);
    `i18n/locales/{en,es}/chat.json`, `components.json`, `chats.json`, `work.json`.
  - Checks: typecheck; web tests; strings snapshot unchanged.
- `c4` (the move, with shims), dependsOn c3.
  - `git mv` the chat set into `packages/chat-ui/src/` (layout in "The boundaries";
    `lib/chat-context.tsx` as `lib/context.tsx`); relative imports of primitives become
    `@agentry/ui/…` (the one non-rename edit allowed, mechanical); shims at old paths; `exports`;
    `packages/chat-ui/src/locales/index.ts` and `chat.json`; `resources.ts` spreading them;
    `styles.css` naming the package CSS in the same order; `types/i18next.d.ts`; the tokens and
    hard-coded strings tests' third root.
  - Files: the moved files and shims; `packages/chat-ui/package.json` (`exports` only),
    `packages/chat-ui/src/locales/index.ts`, `packages/chat-ui/types/i18next.d.ts`,
    `apps/web/src/i18n/resources.ts`, `styles.css`, the two tests' root lists.
  - Checks: typecheck; three suites (the chat package's boundaries test now scans real files:
    no `apps/`, no vendor name, no `RunEvent` field outside the list); `pnpm build` and bundle shape;
    module graph unchanged; renames.
- `c5a`–`c5c` (importers off the shims), each dependsOn c4, in parallel, **import lines only**:
  - `c5a`: `pages/ChatView.tsx`, `Chats.tsx`, `NewChat.tsx`, `pages/chat/**`, `lib/chat-ui.tsx`.
  - `c5b`: every other importer under `apps/web/src` (`App.tsx`, `CommandPalette`, `DetailPanel`,
    `OrchestrationBoard`, `WorkflowCard`, `VerificationCard`, `lib/{notifications-model,
    shell-live, changes-summary, events}.ts`, `api.ts`, `pages/tasks/item/{Links, WorkOn}.tsx`,
    `pages/dashboard/widgets/{live, QuickStart}.tsx`, `pages/OrchestrationDetail.tsx`).
  - `c5c`: `apps/web/test/**`.
  - Checks: typecheck; web tests; module graph unchanged.
- `c6` (shims gone), dependsOn c5a–c5c.
  - Delete the chat shims.
  - Checks: typecheck; three suites; `pnpm build` and bundle shape; module graph unchanged.

### W3 · `web-packages-docs`, dependsOn W1 (runs beside W2)

- `d1` (the docs follow the code).
  - `CLAUDE.md` and `CONTRIBUTING.md`: the layout lists both packages; "UI controls come from
    `packages/ui/src/components/controls`"; tokens in `packages/ui/src/styles/tokens.css`;
    illustrations in `packages/ui/src/components/illustrations`. `docs/design-system.md`: the same
    paths, and a short "Where the code lives" note. `apps/desktop/src/pages.ts` and `title-bar.ts`:
    the tokens path in their comments.
  - Files: exactly those.
  - Check: no path named in them is missing (`grep` each against the tree).

When W2 and W3 are merged into the branch: the full `pnpm typecheck`, `pnpm test`, `pnpm build`,
`docker build -f docker/Dockerfile .`, and `pnpm e2e` (every spec unchanged); the plan's Outcome;
`docs/status.md`; then one pull request to `main`.

## Risks

| Risk | Where | What holds it |
|---|---|---|
| A query key drifts, or a prefix stays behind, so an SSE event stops invalidating the chat | `c1` | Keys moved verbatim with their prefixes; `chat-keys.test.ts` pins outputs and identity; `events` tests unedited |
| Two copies of React Query, i18next or the tooltip library | `g2`, every move | Peers plus devDependencies with one range; `resolve.dedupe`; the single-instance test |
| Two `CustomTypeOptions` in one compile, or a package that silently reads the app's keys | `u3`, `c4` | Package declarations in `types/`, imported by nothing; each package compiles against its own namespaces alone |
| A string or class name changes in passing | every task | Strings snapshot and class inventory, which no task may update |
| A lazy chunk becomes eager, or the shell grows | `u3`, `c2a`, `c4` | Subpath exports without a barrel; module graph's lazy edges; bundle shape after `pnpm build` |
| The cascade order changes | `u3`, `c4` | `styles.css` stays the only manifest; the class inventory checks the order |
| Tests stop covering moved files | `u3`, `c4` | The tokens and hard-coded strings tests gain the package roots in the same commit as the move |
| Parallel tasks collide | W1, W2 | Seams before moves; area tasks own disjoint directories and edit import lines only; `lib/chat-ui.tsx` written whole by `c1` |
| Phase 2 lands a change on a moved file | `u1`, merge | The model block keeps its path; web tests stay in `apps/web/test`; whoever lands second re-runs the full checks |
| A stale `ALLOWED` entry, or a hard-coded `/api/uploads` left in the package | `c2b`, `c2c` | The hard-coded strings test fails on stale entries; the chat boundaries test forbids `apps/`, and the client builds every URL |

## Decisions (owner, 2026-09-30)

All three as recommended:

1. **`Markdown`, `CodeBlock` and the highlighter go into `@agentry/ui`**, as their own subpaths.
   Rejected: `@agentry/chat-ui`, which the diff view would then import to colour code; a third
   package for nine files.
2. **Only the conversation moves**: transcript, composer, prompts, hooks and models. The header,
   inspector and side cards stay in the app. Rejected: the whole page with a dozen render props;
   the conversation now and the chrome after phase 3.
3. **The chat copy that names Claude keeps its words** for now: the package's code names no vendor,
   the author comes from `agentName`, and the copy is revisited in phase 3. Rejected: interpolating
   `{{agent}}` now; keeping those keys in the app and passing sentences as props.

## Related

[[plans/multi-provider.md]] · [[design-system.md]] · [[knowledge-base.md]] · [[status.md]] ·
[[plans/ui-redesign.md]] · [[plans/spanish-copy.md]] · [[providers.md]] · [[phone-layout.md]]
