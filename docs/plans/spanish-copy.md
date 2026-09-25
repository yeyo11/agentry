---
created_at: 2026-09-25T15:10:00Z
updated_at: 2026-09-25T15:10:00Z
tags:
    - plan
    - i18n
    - spanish
    - copy
---
# Plan: Spanish that reads like Spanish

Rewrite the Spanish UI copy so a person in Spain reads it as written in Spanish, not translated
from English. That means every string in `apps/web/src/i18n/locales/es/` and the glossary that
produced them.

This plan is the source of truth for the `spanish-copy` orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins.

## Why

The Spanish copy reads badly, and much of the damage comes from the glossary. `GLOSSARY.md`
requires:

- **Buttons in the imperative**: "Guarda", "Elimina", "Exporta Markdown". In Spain, interface
  buttons and menu items use the **infinitive**: "Guardar", "Eliminar", "Exportar a Markdown". That
  is what Windows, macOS, Android and Google write in Spanish, and what anyone expects on a button.
  The files do not even follow the rule consistently: "Exporta Markdown" sits a few lines from
  "Copiar el id del chat" and "Enviar ahora".
- **English terms with Spanish articles** where Spanish has a normal word: "Reanuda la session",
  "los subagents", "Hueco" for a schedule slot. A developer in Spain says *sesión*, *subagente* and
  *herramienta*. Other words they really do say in English: *worktree*, *prompt*, *hook*, *commit*,
  *pull request*, *token*, *MCP*.

On top of that come literal calques, mistakes of gender and agreement, word order copied from
English, and long sentences that explain too much.

## Direction

1. **Fix the glossary first.** One task rewrites `apps/web/src/i18n/GLOSSARY.md`, and every other
   task writes against it.
2. **Then rewrite each file against the English**, in parallel, one group of files per task. Each
   task re-reads the English string for meaning and writes what a Spanish product would say. It
   does not polish the old translation.
3. **Then read everything in one pass** for consistency, because four writers drift apart.

### The rules the new glossary starts from

- **Spain's Spanish, "tú"** in sentences addressed to the person ("Tu cuenta", "¿Seguro que quieres
  eliminarlo?"). Never "usted", and no Latin American forms.
- **Buttons, menu items, links and actions use the infinitive**: Guardar, Cancelar, Eliminar,
  Reanudar, Enviar ahora, Copiar el id. Headings, tabs and labels are nouns: Ajustes, Cambios sin
  guardar.
- **An English term stays in English only if a developer in Spain actually says it that way**:
  worktree, prompt, system prompt, hook, commit, pull request/PR, token, MCP, plugin, skill,
  marketplace, slash command, thinking, effort. Everything else gets its normal Spanish word:
  sesión, subagente, herramienta, ejecución, flujo or workflow (the glossary task decides which,
  once, and says why). **`run`** is the hard case, because it is everywhere and the CLI calls it
  that: the glossary task decides between keeping "el run" and using "ejecución", records the
  reason, and every task follows the decision.
- **Short and direct.** A Spanish string may be shorter than its English one. It must never be a
  word-by-word copy of it.
- **Sentence case, `¿…?` and `¡…!`, the `…` character, and correct gender and number agreement**,
  including the plural forms `_one`/`_other`.
- Numbers, dates, durations and costs still go through `lib/format`. Anything from the CLI, from
  Claude or from the user is still never translated, and neither are literal names (flags,
  `/compact`, `acceptEdits`, file names, environment variables, product names).

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects
   (`fix(web): …`), in English, with a body explaining why. Never push, and never merge another
   task's branch.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Only the Spanish changes.** Do not touch the English files, the keys, the key order or the
   file formatting. Change only the values in `locales/es/`, so a parallel branch that adds keys
   merges cleanly. The exception is a real bug in an English string: report it in your result
   instead of fixing it.
4. **Keep everything the code relies on**: `{{placeholders}}`, `<tags>` such as `<anchor>`, the
   `_one`/`_other` plural keys, and trailing punctuation the UI concatenates. The parity and
   robustness tests in `apps/web/test` check part of this. Run them.
5. **Update the tests that assert Spanish text** (`apps/web/test/detail.test.ts`,
   `robustness.test.ts`, `server-strings.test.ts`, `e2e/specs/shell.spec.mjs`, and any others you
   find) so they assert the new text. Never loosen an assertion to make it pass.
6. **Checks you run:** `pnpm typecheck` and `pnpm --filter @agentry/web test`, each under
   `timeout`. Do not run `pnpm e2e`; the verification phase runs it once.
7. **Strings that are not in the locale files.** If you find Spanish or English hardcoded in a
   component that should be in the locale files, list it in your result. The `review` task decides
   what to do with it.

## Stage 0

### `glossary`

Rewrite `apps/web/src/i18n/GLOSSARY.md` from the rules above: the rules section, the table of
terms kept in English (much shorter now), the recurring words in the infinitive, the status names
and the chat model. Read `locales/en/` and `locales/es/` in full before deciding, so the glossary
covers what the UI actually says. For every term whose treatment changes, write the old form and
the new one, so the rewriting tasks can search for them. Record the `run` decision with its
reason. Change no locale file in this task.

## Stage 1 — in parallel, each depends on `glossary`

Each task rewrites every value in its files against the English and the new glossary:

- **`copy-config`**: `config.json`
- **`copy-shell`**: `components.json`, `common.json`, `primitives.json`, `shell.json`, `server.json`
- **`copy-chats`**: `chat.json`, `chats.json`, `home.json`, `work.json`, `projects.json`,
  `connectors.json`
- **`copy-orchestration`**: `orchestration.json`, `orchestrationV2.json`,
  `orchestrationDetail.json`, `observe.json`, `schedules.json`, `usage.json`,
  `accountsConfig.json`

## Stage 2

### `review` (deps all Stage 1 tasks)

One reader for the whole of `locales/es/`:

- The same term said the same way everywhere, and every button in the infinitive.
- No leftovers from the old forms the glossary lists.
- Strings that are assembled from pieces still read well once put together.
- The hardcoded strings the other tasks reported: move them into the locale files when that is
  simple, and list the rest.

Then write an *Outcome* section in this file: what changed, the decisions taken, and what was left
out. Do not edit `CHANGELOG.md`, and do not call `kb_add_document`: the knowledge-base entry is
added after merge.

## What "done" means

- Every value in `locales/es/` was rewritten against the English and follows the new glossary.
- Buttons use the infinitive, and English survives only where Spanish developers really use it.
- `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` are green.

## Outcome

Stage 0 rewrote `GLOSSARY.md`, Stage 1 rewrote every file under `locales/es/` against it in four
parallel groups, and this `review` task read the whole of `locales/es/` in one pass afterwards, file
by file against the English and against every other Spanish file, to catch what four independent
writers could not see in each other's work.

### What the review pass found and fixed

Four writers working from the same glossary still drifted in the small number of places a term
crosses a file boundary. Every fix below changes only Spanish values, never keys or order:

- **`la CLI` survived in five strings the Stage-1 search missed**: `server.json`'s
  `connectors.authorise.claudeAi`, `.refresh`, `.unavailable.webArtifacts`, `.unavailable.claudeAiMemory`,
  and `components.json`'s `projectExport.body`. The glossary task and `copy-shell` had already fixed
  the one instance each had found and reported fixing; these five were the same bug in strings
  neither had reason to open. All five are now "el CLI" / "del CLI".
- **A literal `run` survived in `config.json`'s `orchestration.askPermissionsHint`**: "la página del
  run del worker" → "la página de la ejecución del worker", per the glossary's `run` decision.
  `copy-config` rewrote the rest of that file but this one sentence was not on the search list it
  used.
- **The same concept, gendered two ways across two files**: `chat.json`'s `badges.outcome` (a chat's
  execution outcome, written by `copy-chats`) already used the feminine forms the glossary's status
  table calls for — Fallida, Detenida, Interrumpida — but `chats.json`'s `list.outcome`, which
  `pages/Chats.tsx` reads for the exact same value (confirmed in the component, not guessed), still
  had the previous revision's masculine Fallido/Detenido/Interrumpido. Both files were in the same
  task's scope, but only one of the two objects got the glossary's gender ripple. Now both agree.
- **The same "N running" count, two different words**: `home.json`'s
  `widgets.orchestrations.running` said "en marcha" while `shell.json`'s `live.running` and
  `primitives.json`'s `progress.running_one/other` — the same status, same English "running" — said
  "en curso", which is what the glossary's status table specifies. `home.json` now says "en curso"
  too. (Other uses of "en marcha" survive: they describe a process or the wrapper itself being
  underway — "el wrapper está en marcha", "la ejecución sigue en marcha" — a different, correctly
  distinct sense from the discrete `running` status badge, so they were left alone.)
- **The fork button, two phrasings**: the glossary records "Crear un fork" as the canonical phrase
  (`orchestration.json`'s `board.fork` already used it), but `chat.json`'s `view.fork` and
  `composer.fork` — the same action, opened from a different screen — said "Crear fork". Both now
  say "Crear un fork". (`chat.json`'s `status.forkTitle`, "Crear fork con", was left as is: it is a
  panel heading parallel to `status.resumeTitle`'s "Reanudar con", a different grammatical shape,
  not a button.)
- **A quote style mismatch**: `server.json`'s `health.loop.error` wrapped a literal CLI error string
  in guillemets («{{error}}»), where the English source deliberately uses straight quotes
  (`\"{{error}}\"`) because the text quoted is a literal message a program printed, not a phrase
  being emphasised. Changed to match.

Everything else searched for — the full "old → new" table in `GLOSSARY.md`'s "Terms that changed"
section, every recurring UI word, every status name, `sólo`/`éste`/`ésta`, `usted` or Latin American
forms, literal ellipses (`...` instead of `…`), and every imperative-form button reported by the four
Stage-1 tasks — turned up clean: each Stage-1 task had already done what it reported doing. The
`sendHint`/`sendAHint` (orchestration.json) vs. `sendHint` (observe.json) difference that looked like
drift on first read turned out to be correct: they translate three deliberately different English
strings ("Send hint" / "Send a hint" / "Send the hint"), and the Spanish already tracks the articles
correctly.

### Judgment calls left as the Stage-1 tasks made them

Three calls flagged by `copy-shell` for this review were re-examined and left unchanged, because
re-deciding them differently would have been arbitrary, not a correction:

- `components.json`'s `workflowCard.script`: "Script" stays. It is not in the glossary's
  kept-English list, but it is a bare label naming the workflow's own script file, and "el script" is
  as assimilated in Spanish developer speech as "el token" or "el wrapper", both of which the
  glossary does keep.
- `primitives.json`'s `progress.failed_one/other` ("con error") and `skipped_one/other` ("sin
  ejecutar"): still deliberately gender-neutral, because this component's `unit` varies (tasks,
  steps, agents — different genders) and a prepositional phrase sidesteps a mismatch that "fallida"
  would create for a masculine unit.
- The `palette.*Hint` strings whose Spanish verb form reads as either indicative or imperative: left
  alone, since Spanish -ar verbs make the two identical here and nothing is actually wrong.

### Hardcoded strings

None of the four Stage-1 tasks found user-visible English or Spanish hardcoded outside
`locales/es/`/`locales/en/` in the components they checked, and this pass's own scan of `apps/web/src`
for stray Spanish imperative text outside `t()` calls (the four leftover-form verbs from the
"Terms that changed" table, as literal JSX text) turned up nothing either. There is nothing to move
and nothing to list.

### Checks run

`pnpm typecheck` (all five packages) and `pnpm --filter @agentry/web test` (430/430), both under
`timeout`, after `pnpm install --frozen-lockfile` (this worktree had no `node_modules`). No test in
`apps/web/test` or spec in `e2e/specs` asserted any of the strings this pass changed, so none needed
updating. `pnpm e2e` was not run; that happens once, in the verification phase, on the merged branch.

### What "done" means, revisited

Every value in `locales/es/` was rewritten against the English and the new glossary, buttons are
infinitive throughout, and the one term-level inconsistencies a four-way parallel rewrite produces —
listed above — are now resolved. `pnpm typecheck` and `pnpm test` are green on this branch;
`pnpm build` and `pnpm e2e` are for the verification phase after every task's branch is merged.

## Related

[[plans/ui-redesign.md]] · [[status.md]]
