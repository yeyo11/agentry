---
created_at: 2026-09-30T21:00:00Z
updated_at: 2026-10-08T12:00:00Z
tags:
    - plan
    - mcp
    - assistant
    - tokens
    - built
---
# Plan: the format of what Agentry hands to a model

Status: **built on 2026-10-08** (CW-33): compact JSON and chosen fields shipped, TOON not adopted. See
[Outcome](#outcome). It belongs to the Agentry MCP server
([[plans/agentry-mcp-server.md]], not yet on `main`), whose rule today is "one `text` content
holding compact JSON", and to anything else Agentry writes into a prompt: the orchestration
planner's context, a worker's dependency results, the assistant's sources.

## The question

Formats designed to save tokens when data goes into a model's context have appeared: **TOON**
(Token-Oriented Object Notation, `@toon-format/toon`) and **ZON**. They drop the repeated keys of a
list of objects by writing a header once and one row per item. Should Agentry's tools answer in one
of them instead of JSON?

This is not about the browser. Between the UI and the API, JSON with compression is the answer
([api-wire.md](../api-wire.md)).

## What was measured

Real data from the dev server on 2026-09-30 (50 chats, 17 orchestrations), encoded four ways.
Tokens were counted with `o200k_base` (`gpt-tokenizer`) as a **proxy**: Claude's tokenizer is not
the same, and the bench below is what gives the real figures. The percentage is against compact
JSON.

| Data | JSON pretty | JSON compact | TOON | ZON |
| --- | --- | --- | --- | --- |
| Chats, six flat fields | 5,403 | 4,319 | 3,694 (−14 %) | 3,614 (−16 %) |
| Chats, the whole `ChatSummary` | 53,541 | 39,491 | 43,739 (+11 %) | 33,016 (−16 %) |
| Orchestration tasks, seven flat fields | 11,914 | 8,868 | 6,569 (−26 %) | 6,038 (−32 %) |
| Orchestration summaries, nested | 51,855 | 41,085 | 45,442 (+11 %) | 37,671 (−8 %) |

What this says:

1. **Choosing the fields is worth ten times the format.** The whole chat list costs 39k tokens as
   compact JSON; the six fields a model needs to pick a chat cost 4.3k. No encoding comes near that
   factor.
2. **TOON only wins on flat, uniform lists**, by 14 to 26 % here, and **loses on nested data**
   (+11 %), where its indentation costs more than the keys it saves.
3. **Pretty-printed JSON is the one clear waste**: 25 to 35 % over compact JSON, whatever the data.
4. **ZON is not a candidate.** Its npm package (`zon-format` 1.3.1) depends at run time on
   `openai`, `@azure/openai` and `dotenv`: a model SDK inside a serialisation library is a supply
   chain Agentry does not take, and the one rule rules out an SDK anyway. TOON has no dependencies.

## Proposal

1. **Every tool answers compact JSON by default**, as the MCP plan says, and every list tool
   returns **only the fields a model needs to choose**, with the id to fetch the rest. This is the
   same move as the orchestration list's summaries, and it is where the savings are.
2. **List tools whose rows are flat may answer TOON**, behind a constant per tool rather than a
   parameter the model has to learn. Detail tools and nested results stay JSON.
3. **Only if the bench says so.** TOON is adopted for a tool when, on real data, it saves at least
   15 % of the tokens **and** the model answers the bench questions as well as with JSON.
4. **Never pretty-print** anything Agentry puts in front of a model.

## The bench

A script, `scripts/wire-format-bench.mjs`, against a running Agentry (`AGENTRY_API_URL`):

- For each list tool, it reads the real data and encodes it as compact JSON and as TOON.
- It asks a set of questions whose answers are in the data ("which chats are waiting?", "which task
  of graph X failed, and why?") through `claude -p --output-format stream-json`, once per format,
  with the data in the prompt.
- It reads `usage.input_tokens` from the CLI's `result` event, which counts with Claude's own
  tokenizer, and checks each answer against the data.
- It writes a table like the one above, with real token counts and the share of right answers.

It goes through the CLI and nothing else, as the one rule requires: no SDK and no call to a
tokenizer endpoint.

## Not in this plan

- Changing the REST API's format. JSON stays the contract.
- Changing what the CLI's stream-json looks like, which is not Agentry's to choose.

## Outcome

Built on 2026-10-08 (CW-33). Steps 1, 2 and 4 of the proposal are in `packages/mcp`
(`fields.ts` picks the fields of the nine list tools; nothing is indented, and a test checks it).
The bench, `scripts/wire-format-bench.mjs`, ran once on the real data of the dev server with
`claude -p --output-format stream-json --model sonnet`, three questions per tool, once per format.
Tokens are the CLI's own input count (`input_tokens` plus cache creation and reads), minus the
CLI's fixed preamble per call, summed over the three questions of a tool. The run cost 0.36 USD.

| Tool | Rows | JSON tokens | TOON tokens | Saving | JSON right | TOON right |
| --- | --- | --- | --- | --- | --- | --- |
| `list_chats` | 50 | 19,220 | 19,922 | +4 % (worse) | 3/3 | 3/3 |
| `list_projects` | 5 | 1,834 | 1,897 | +3 % (worse) | 3/3 | 3/3 |
| `list_orchestrations` | 30 | 15,827 | 16,334 | +3 % (worse) | 3/3 | 3/3 |
| `list_providers` | 5 | 588 | 567 | −4 % | 3/3 | 3/3 |

Decision per tool: **no tool answers TOON**; every one stays compact JSON.

- The 15 % bar was not reached by any tool; the best, `list_providers`, saves 4 % on 5 rows.
- Answers were equally right in both formats, so the deciding factor was size alone.
- `list_chats` and `list_projects` are flat but their rows are ragged, because absent and null
  fields are left out and chats then have three different key sets. TOON writes its one-header
  table only for uniform rows, so it falls back to a per-item layout there. `list_orchestrations`
  nests its task counts. Making rows uniform to favour TOON would spend tokens on nulls, which
  field selection exists to save.
- `@toon-format/toon` (4.1.1, no dependencies) is therefore **not** a dependency of any package.
  To rerun the bench, add it to `packages/mcp` for the run (`pnpm --filter @agentry/mcp add -D @toon-format/toon`)
  and drop it afterwards.
- Limits of the measure: one run, three questions per tool, one model, the data of one day. It is
  enough to say TOON does not clear 15 % here, not to rank the formats.

## Related

[[api-wire.md]] · [[plans/agentry-mcp-server.md]] · [[plans/agentry-assistant.md]] · [[prompts.md]]
