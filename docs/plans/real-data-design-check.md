---
created_at: 2026-09-28T22:00:00Z
updated_at: 2026-09-28T22:00:00Z
tags:
    - spec
    - design-system
    - audit
    - team
    - flow
    - board
    - CW-20
    - proposed
---
# Spec (CW-20): check on real data what the design audit could not

Status: **refined**, ready to start. This is a verification card: its output is a comparison, the
fixes or cards it leads to, and an updated audit document. It adds no feature.

## Why

The visual audit of orchestration 7 captured the built app on a **seeded** project and set each
screen beside its reference. Three things could not be produced by the seed, and the audit left them
open ([project-ecosystem-audit.md, "Stays open"](project-ecosystem-audit.md#audit-of-orchestration-7-the-design-pass)):

> Not verified in the capture, because the seed could not produce them: the team board view with the
> flow on, a member's model with its resolved name, and run links with real chats.

The flow now runs for real on `claude-wrapper` (CW cards refined, worked and verified by the team),
so all three exist on real data and can be checked.

## What is already decided (do not reopen)

- **Board with a team** ([work-items.md, "Worked by a team"](../work-items.md#worked-by-a-team);
  [ecosystem-review.md](../design-system/ecosystem-review.md), rows `DesktopTableroEquipo` and
  `MobileTableroEquipo`): each column's responsible role in its head while the flow is on; every
  state a card can be in as its strip (queued, at work with the braille spinner and `m:ss`, failed
  with its worded reason, QA's words on a sent-back card, "te espera" with "Aprobar y pasar a
  Hecho"); the flow's button leading the views; on a phone, one row under the view switch with the
  flow's state ("2 a la vez, 1 en cola · activado"), at 13 px.
- **A member's model** ([team-and-flow.md, Known gaps](../team-and-flow.md#known-gaps); decision 41
  of [project-ecosystem.md](project-ecosystem.md)): the member page writes the alias's name after
  the tag ("opus · Opus 5.5") once a chat started with that alias has reported its model id in
  `system/init` (`ModelAliasIds`, `model-aliases.json` in the data dir, `modelDisplayName`). Until
  then the tag shows alone. An id off the naming scheme stays unnamed. A tag alone is correct on
  a member **card** and in lists ([design-system.md, "Models"](../design-system.md)), so a bare tag
  there is not a finding.
- **Run links** ([work-items.md, "A work item"](../work-items.md#a-work-item);
  [team-and-flow.md](../team-and-flow.md), "A failed run keeps its cause as a code"): every flow run
  of an item is its own link, led by the role's squircle, with its state as a badge with its word;
  a failed run shows its reason worded from `FlowRunCause` in the person's language with the raw
  error under it in mono, and "Reintentar" while it can be retried. Each link opens the run's chat.
  A run that failed before its chat started shows "no chat" in place of a chat id (audit finding 2).
  The chat of a failed run carries the failure banner (`.chat-run-failed`, `DesktopChatFlujo`).
- **Left as the review left them** (not findings for this card): the phone's "⋯" on every card, the
  "Flujo automático" row, and the wider search field.

## How to check

1. **Where.** The Agentry instance where the flow runs on this project: read `AGENTRY_API_URL` from
   the environment (CLAUDE.md), never a guessed port. Check the dev server and the desktop app are
   not mixed up: the CW cards and their runs must be visible there.
2. **Read-only on real data.** Do not move, retry, edit or delete real cards or runs to produce a
   state. When a state is missing on real data (for example no failed run exists), say so in the
   audit and fall back to the existing e2e coverage for it; do not fabricate it on the real project.
3. **Capture.** Build and open the app (headless Chrome over CDP, as `e2e/` does, or the `run`
   skill), and capture each screen below at desktop size (1440 wide) and phone size (390 wide), in
   dark (default) and `[data-theme='light']`. Captures of real data stay out of the repository
   (they show real chats and paths); the audit describes what they showed.
4. **Compare** each capture with its reference in `docs/design-system/reference/` (the HTML and
   `screenshots/<Screen>-dark.webp` / `-light.webp`), and against the Night Shift rules in CLAUDE.md:
   tokens only, contrast ≥ 4.5:1 (≥ 3:1 for large numbers), at most two gradient surfaces, one
   energy border, status colours paired with a word, phone targets ≥ 44 px.

| What | Route | Reference |
| --- | --- | --- |
| Board with the flow on | `/tasks` on `claude-wrapper`, Board view | `DesktopTableroEquipo`, `MobileTableroEquipo` |
| A member with a resolved model | `/team/<member>` for a member whose alias has run | `DesktopMiembro`, `MobileMiembro` |
| A work item's run links | `/tasks/<CW key>` of an item with several runs, one failed if any exists | `DesktopTarea`, `MobileTarea` |
| A failed run's chat | the chat a failed run link opens | `DesktopChatFlujo`, `MobileChatFlujo` |

## What each difference becomes

- **A fix in this card** when it is small and inside the design system's rules. Each fix follows the
  project's checks: tokens only, both themes, en/es parity with `apps/web/src/i18n/GLOSSARY.md`,
  phone layout, `a11y.spec.mjs` and `motion.spec.mjs` green, and a test that would have caught it (a
  web unit test, or an e2e spec with a fake-CLI state). If a fix changes
  `packages/shared/src/types.ts` or a route, regenerate the OpenAPI schemas
  (`pnpm --filter @agentry/api openapi:schemas`), give the route a summary and a tag in
  `apps/api/src/openapi/routes.ts`, and add a row to the README's REST tables.
- **A new card in Backlog** when it is larger or needs a decision, with the finding, the capture's
  description, the reference and the route in its description.
- **A reference change** only when the owner decides the app is right; then the reference HTML (and
  its generator in `reference/tools/`, per its README) and the screenshots move in the same PR.

Anything that needs the SDK or a call to Anthropic to check (for example asking the API which model
an alias means) is out of scope: the model's name comes only from what the CLI reported.

## The audit document

Add a section "Orchestration 7 on real data (CW-20)" to
[project-ecosystem-audit.md](project-ecosystem-audit.md), before "Related": the date, the instance
checked (dev server or desktop app, version), a table with one row per screen × size × theme saying
"matches" or the finding, and for each finding its kind (Blocker / Polish) and its fix commit or
card key. Then rewrite the first bullet of "Stays open" to say what was checked and where, keeping
only what real data still could not show (with the reason). If the model's name still does not
appear with a chat already run on the alias, it is a Blocker finding, not a note.

## Related

[[plans/project-ecosystem-audit.md]] · [[plans/project-ecosystem.md]] · [[design-system.md]] ·
[[design-system/ecosystem-review.md]] · [[team-and-flow.md]] · [[work-items.md]]
