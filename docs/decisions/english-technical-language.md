---
created_at: 2026-09-28T13:20:05.451659371Z
updated_at: 2026-09-28T13:20:05.451659371Z
tags:
    - decision
    - language
    - english
    - i18n
    - prompts
    - jev
    - project-ecosystem
---
# Decision: everything technical is in English, including what agents record

Decided by the owner on 2026-09-28 (option B of three), while discussing the [[plans/decision-engine.md|decision engine with Jev]]. Not yet written into CONTRIBUTING.md or CLAUDE.md: that happens after `feat/project-ecosystem` is merged into main.

## The rule

- **English, always**: code, comments, docs, commit messages, prompts Agentry sends to Claude (planner, supervisor, verification fixer, assistant, team roles, templates), schemas, Jev questions and rubrics, agent files, and **the technical records agents write**: the project journal, memory entries, acceptance criteria and QA comments, even when the person chats in Spanish.
- **The person's language**: UI copy, through i18n with en/es parity (CLAUDE.md), and whatever a person writes (work items, comments, chat messages). A chat's title stays in the person's language (`assistant-answer.ts` `assistantTitle`).

## Why

Jev reads English best, and the records agents write are exactly the state it will read (journal relevance, memory triage, QA bounces). English records also keep agents consistent with each other. The cost accepted: the person reads those records in English inside a Spanish UI.

Options rejected: A) keep records in the conversation's language and measure in shadow; C) translate the state to English before asking Jev (an LLM in the middle defeats Jev's cost and latency).

## State on 2026-09-28

`packages/core`, `packages/shared` and `apps/api` hold no Spanish strings on main or on the ecosystem branch; internal prompts are already English. No rule says so yet.

## To do after the ecosystem merges

1. Write the rule into CONTRIBUTING.md and CLAUDE.md.
2. Instruct the ecosystem's role, journal, memory and QA prompts to write their records in English.
3. Check the assistant's proposals and generated agent files follow it.

Related: [[plans/decision-engine.md]], [[plans/spanish-copy.md]], [[plans/project-ecosystem.md]].
