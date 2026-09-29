---
created_at: 2026-09-28T16:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - plan
    - spec
    - language
    - english
    - i18n
    - prompts
    - flow
    - team
    - assistant
---
# Spec (CW-2): write the English-only rule down and apply it to the ecosystem's prompts

Carries out the three steps of [[decisions/english-technical-language.md]] now that the ecosystem is merged (PR #118, 2026-09-28). The decision is not reopened here; this spec only says where the rule lands and how it is checked.

> **English, always**: code, comments, docs, commit messages, prompts Agentry sends to Claude, schemas, agent files, and **the technical records agents write**: the project journal, memory entries, acceptance criteria and QA comments, even when the person chats in Spanish.
> **The person's language**: UI copy, through i18n with en/es parity, and whatever a person writes (work items, comments, chat messages). A chat's title stays in the person's language.

## State today (checked on main)

- The prompts are already written in English, but none of them *tells* Claude to answer in English. A Spanish work item (a person's text, quoted into the prompt by `workItemPrompt`) or a Spanish chat pulls the model into Spanish summaries, criteria notes and memory proposals.
- Titles already follow the person's language: `flowTitle` (`packages/core/src/flow.ts`) uses `roleTitleIn(role, language)`; `assistantTitle` (`packages/core/src/assistant-answer.ts`) switches on `brief.language`. Both come from `Accept-Language` (`agentryLanguage`, `assistantLanguage`). They must not change.
- `packages/core/src/project-templates.ts` holds only role data (`role`, `model`, `responsibility`), already English. It needs no instruction of its own: its roles reach Claude through `agentFileContent` and `assistantPrompt`.
- The assistant's prompt lives in `assistant-answer.ts` (`assistantPrompt`), not in `assistant.ts`, which launches it.
- No Spanish string exists in `packages/core`, `packages/shared` or `apps/api`.

## Changes

### 1. The rule in CONTRIBUTING.md and CLAUDE.md

- **CONTRIBUTING.md**: a "Language" rule (its own short section, or in the conventions it already has) stating both halves above, with a link to `docs/decisions/english-technical-language.md`.
- **CLAUDE.md** › Conventions: one bullet, e.g. *"Everything technical is English (code, comments, docs, commits, prompts, agent files, and what agents record: journal, memory, acceptance criteria, QA comments), even when the person writes in Spanish. The exception is UI copy, through i18n with en/es parity, and what a person writes; a chat's title is in the person's language."* The existing Copy bullet in Design system stays as it is.

### 2. One shared sentence, used by every prompt

Add one exported constant in `packages/core` (for example `RECORDS_IN_ENGLISH` in `team.ts` or a small `language.ts`), so the three prompts say the same thing and tests can assert on it:

> Write everything you record in English, whatever language the work item, the chat or the person uses: summaries, descriptions, acceptance criteria, criteria notes, journal entries, memory proposals, documents and agent files. Quote a person's words as they wrote them.

The quoting clause keeps a person's text (an item's title, a comment) unaltered when a record cites it.

### 3. Where it goes

| Prompt | File · function | Placement |
|---|---|---|
| Flow stage prompt | `flow.ts` · `flowPrompt` | After the stage's instructions, before the closing "End with the structured result…" line; for every stage (refine backlog, refine todo, work, verify). Not before the first line: `flowTitle` must stay line 1. |
| Starting agent file | `team.ts` · `agentFileContent` | In "## How a flow run ends", after the list of fields. |
| Assistant | `assistant-answer.ts` · `assistantPrompt` | In "## What to propose", for every kind (project, work-items, resources), naming what it proposes: team members' responsibilities, agent/skill/command files, work items (title, description, acceptance criteria) and reasons. After `assistantTitle`, which stays line 1. |

Optional, same PR: the `description` of `summary`, `criteria[].note` and `memoryProposals[].text` in the flow's JSON schema (`flow.ts`, near `TARGET_KINDS`) may say "in English". The schema is Agentry's own, not a route type, so no OpenAPI regeneration is triggered. If `packages/shared/src/types.ts` is touched, regenerate with `pnpm --filter @agentry/api openapi:schemas`.

### Out of scope

- Agent files already written in a project's `.claude/agents/`: `agentFileContent` only writes a member's *starting* file. Existing files are the project's; they are not rewritten.
- Translating journal entries, memory or criteria already stored.
- UI copy and `GLOSSARY.md`: unchanged.
- Anything that is not CLI: the rule is carried by prompt text only (the one rule holds).

## Tests (`packages/core/test`)

- `flow.test.ts`: for each stage, `flowPrompt(...)` contains the shared sentence; with `language: 'es'` its first line equals `flowTitle(item, role, 'es')` (Spanish role title) and the sentence is still present, in English.
- `team.test.ts`: `agentFileContent(member)` contains the sentence under "## How a flow run ends", for a template role and for a custom role without guidance.
- `assistant.test.ts`: for each kind (`project`, `work-items`, `resources` with a description), `assistantPrompt(brief)` contains the sentence; with `language: 'es'` the first line is the Spanish `assistantTitle` (e.g. `Asistente de <name>`) and the rest stays English.

Checks: `pnpm typecheck`, `pnpm test`. No UI, route or e2e change.

## Implementation (CW-2)

- `RECORDS_IN_ENGLISH` is exported from `packages/core/src/team.ts` (and the `@agentry/core` barrel), because both `flow.ts` and `assistant-answer.ts` already import `team.ts`.
- `flowPrompt` puts it on its own line right before the closing "End with the structured result…" line, for every stage; `flowTitle` stays line 1.
- `agentFileContent` puts it in "## How a flow run ends", after the list of result fields.
- `assistantPrompt` puts it at the end of "## What to propose" for every kind, followed by one sentence that names what the assistant proposes (team members' responsibilities, agent, skill and command files, work items with their title, description and acceptance criteria, and each reason); `assistantTitle` stays line 1.
- The flow's result schema says "in English" on `summary`, `criteria[].note`, `memoryProposals[].text` and `.reason`. `packages/shared/src/types.ts` is unchanged, so no OpenAPI regeneration.
- Tests: `flow.test.ts`, `team.test.ts` and `assistant.test.ts` each assert the shared constant, and that a Spanish run keeps only its first line in Spanish.

### The root documents

The Developer's write scope is `packages/`, `apps/`, `e2e/`, `scripts/` and `docs/`, so it could not edit `CONTRIBUTING.md` or `CLAUDE.md`. The text to add follows, word for word. The CLAUDE.md bullet was also proposed through the run's `memoryProposals` (target `instructions`, section Conventions).

**CONTRIBUTING.md**, a new bullet at the end of "House style":

```markdown
- **Language.** Everything technical is English: code, comments, docs, commit messages, the
  prompts Agentry sends to Claude, schemas, agent files, and the records agents write (the project
  journal, memory entries, acceptance criteria and QA comments), even when the person chats in
  Spanish. The person's language is kept for UI copy, through i18n with en/es parity, for whatever
  a person writes (work items, comments, chat messages), and for a chat's title. Prompts carry this
  through `RECORDS_IN_ENGLISH` (`packages/core/src/team.ts`); the reasoning is in
  [docs/decisions/english-technical-language.md](docs/decisions/english-technical-language.md).
```

**CLAUDE.md** › Conventions, a new bullet:

```markdown
- Everything technical is English (code, comments, docs, commits, prompts, agent files, and what
  agents record: journal, memory entries, acceptance criteria, QA comments), even when the person
  writes in Spanish. The exception is UI copy, through i18n with en/es parity, and what a person
  writes; a chat's title is in the person's language
  ([decision](docs/decisions/english-technical-language.md)).
```

## Related

- [[decisions/english-technical-language.md]]
- [[plans/project-ecosystem.md]]
- [[plans/decision-engine.md]]
- [[plans/spanish-copy.md]]
