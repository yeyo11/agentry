---
created_at: 2026-10-08T14:00:00Z
updated_at: 2026-10-08T18:00:00Z
tags:
    - report
    - chat
    - audit
---
# Chat message audit: summary and fix plan

This audit looks at why chat messages get lost, and why queued messages and "Send now" misbehave. It
was done on `main` at 0.36.0 (`359e59fd5`), and no product code changed. There are three detailed
reports: [[client.md]] (the browser, C-n), [[server.md]] (API, core and the provider drivers, S-n)
and [[repro.md]] (a reproduction of every major finding, plus both symptoms end to end in a browser).

## Summary for the owner

- **Symptom 1 ("the message disappears and the agent never gets it") is mostly a display bug: the
  agent did get the message.**
  - When a message arrives during a turn, the CLI usually takes it into that turn at the next tool
    result. It records the message only as an `attachment` line of type `queued_command`, never as a
    `user` line, and Agentry's transcript reader throws away every line that is neither `user` nor
    `assistant` (`packages/shared/src/normalize.ts:72`).
  - Three things follow. The queued card never clears and, 8 s after the turn, calls the message
    "never read". The row sinks to the bottom of the page and is dropped after 10 minutes. After a
    reload the message is gone from the page and from `GET /chats/:id`, while the agent's answer to it
    stays.
  - This path is common: 262 messages in 149 sessions on this machine took it. Reproduced end to end
    (C-1 / S-4).
- **Some messages really are lost, always without a word.**
  - A message the CLI still holds dies with its process (stop, crash, provider move, limit replay,
    restart).
  - A message held for a replacement process is dropped when that process is stopped or refused.
  - On Codex and ACP, a turn queued behind a `keepAlive: false` turn is written into a closed stdin.
  - Gemini and Copilot chats never record the person's own messages.
  - Words typed while a send is in flight are erased.
- **Symptom 2 ("queued messages and Send now do not work well") comes from the page guessing.**
  Nothing tells the page which message the agent read, so it guesses from text equality and the
  cached chat state, and the guesses go wrong:
  - "Send now" is a bare interrupt. It cuts off the turn that is already answering the message
    (C-2).
  - The chat looks idle while the CLI works on a queued message, so "Send now" does nothing (S-1).
  - Two messages merged by an interrupt match no card (S-5).
  - A message with files never matches its card (C-3).
  - A message sent during a permission prompt gets no card at all (C-8).
  - "Send now" works when the message really is still waiting in the CLI's queue (scenario B2).
- **The root fix is to give each message an id.** Agentry chooses the id and the CLI keeps it. The
  server reports when the CLI takes the message and keeps a list of what is still pending. The page
  then matches cards by id instead of by words. Everything this needs is documented CLI behaviour:
  the stream-json `uuid`, `--replay-user-messages`, the transcript's `queued_command` and
  `queue-operation` lines. So it stays within the one rule.
- **Reproductions.** 15 todo tests (core and web) and a browser spec,
  `e2e/specs/chat-audit-delivery.spec.mjs`, which runs only with `E2E_CHAT_AUDIT=1`. Every todo test
  fails on its own assertion today. One finding, C-4, was refuted.

## Every finding

Duplicates are merged: C-1 and S-4 are one bug, seen from the page and from the transcript reader.
Line references are to this branch. [[repro.md]] corrects the `chat-stream.ts` lines given in
[[client.md]]: `spliceTail` is at `packages/chat-ui/src/lib/chat-stream.ts:91-113`.

"Core" means a todo test in `packages/core/test/chat-delivery-audit.test.ts` or
`chat-audit-repro.test.ts`, and "web" one in `apps/web/test/chat-audit-client.test.ts` or
`chat-audit-repro.test.ts`. "e2e X" is scenario X of the browser spec.

| Id | Title | Severity | Reproduced | Where |
|---|---|---|---|---|
| C-1 / S-4 | A message the CLI took mid-turn is missing from the transcript, and the page calls it lost | blocker | yes: core `S-4`, web `C-1`, e2e A (symptom 1 end to end) | `shared/src/normalize.ts:72`; `chat-ui/src/composer/queued.ts:60`, `:68-72` |
| S-1 | The chat reads idle while the CLI works on a queued message, and "Send now" does nothing then | blocker | yes: core `S-1` ×2 (not tried in a browser: the e2e fake opens no idle window) | `core/src/chat-fold.ts:249`, `:158`; `core/src/chats.ts:776` |
| C-2 | "Send now" interrupts the turn that is already answering the message | major | yes: e2e B1 | `web/src/pages/ChatView.tsx:422-427`; `core/src/chats.ts:772-785` |
| C-3 | A message with files never matches its card: it shows twice, is called lost, and Restore drops the files | major | yes: e2e C | `queued.ts:47`, `:60`, `:80`; `core/src/uploads.ts:97-110`; `ChatView.tsx:409` |
| C-5 | Words and files added while a send is in flight are erased | major | yes: e2e E | `chat-ui/src/composer/Composer.tsx:174-178` |
| C-6 | A new message is dropped when the same words were said recently | major | yes: web `C-6` | `chat-stream.ts` `spliceTail` text match (`:102`) |
| C-7 | A streamed message no read confirms sinks under later entries, then disappears | major | yes: web `C-7` ×2 | `chat-stream.ts:108`, `:112`; `chat-ui/src/lib/chats.ts:160-164` |
| C-8 | Whether a message gets a card is guessed from the cached state, and a held message can vanish | major | yes: e2e F (no card while `waiting`), core `C-8` (held message lost when the replacement is refused) | `ChatView.tsx:448`; `core/src/chats.ts:694`, `:712-720` |
| S-2 | A message the CLI still held dies with its process, and the page still shows it as sent | major | yes: core `S-2` | `core/src/chats.ts:1061`, `:740`, `:1164`, `:1184`, `:1028` |
| S-3 | A message held for the replacement process has no trace, and stop drops it silently | major | yes: core `S-3` ×2 | `core/src/chats.ts:694`, `:745`, `:716-721` |
| S-5 | Nothing tells the page which message the agent read, and an interrupt merges them | major | yes: core `S-5`, web `S-5` | `core/src/chats.ts:1061-1064`; `providers/claude-code/driver.ts:54`, `args.ts:7-10` |
| S-6 | Gemini and Copilot chats never record the person's messages | major | yes: core `S-6` | `core/src/chat-fold.ts:16-25`, `:156`; `chats.ts:1061` |
| S-7 | On Codex and ACP, a turn queued behind a `keepAlive: false` turn goes into a closed stdin | major | yes: core `S-7` | `core/src/chat-fold.ts:246-247`; `providers/codex/session.ts:203-204`; `providers/acp/session.ts:411` |
| C-9 | A files-only card is cleared by the next tool result | minor | no: code reading, manual steps in [[client.md]] | `queued.ts:38`, `:60` |
| C-10 | Matching by text clears the wrong card, or every card with those words | minor | no: code reading | `queued.ts:55-61`, `:79-82` |
| C-11 | A queued slash command never matches, and is offered to run again | minor | no: code reading | `queued.ts:60`; `spliceTail` |
| C-12 | "Lost" comes from a client clock on the cached state, and is final | minor | no: code reading | `queued.ts:68-72`; `ChatView.tsx:421-422` |
| C-13 | Nothing on a reloaded page says a message is still waiting | minor | no: code reading | `queued.ts:43`; `chat-ui/src/lib/chats.ts:329` |
| C-14 | A send that timed out can be sent again with no guard against duplicates | minor | no: code reading | `web/src/api.ts:275`, `:505` |
| S-8 | An ACP interrupt that times out starts the next prompt beside the one still running | minor | no: needs a fake agent that ignores `session/cancel` | `providers/acp/session.ts:451`, `:387-411` |
| S-9 | A limit replay sends only the last message written, not the turn that died | minor | no: code reading | `core/src/chats.ts:1057`, `:1167` |
| S-10 | Two messages sent close together can arrive in the wrong order | minor | no: code reading | `core/src/chat-service.ts:1129-1134` |
| S-11 | A respawn between a process's exit and its close drops the old process's last lines | minor | no: needs a timed exit | `core/src/chats.ts:690`, `:1020`, `:1040-1048` |
| S-12 | An interrupt on a process whose stdin is closed waits 15 s, then fails | minor | no: code reading | `core/src/chat-fold.ts:246`; `providers/claude-code/control.ts:5`, `:39-42` |
| S-13 | A send that spawns a process skips the limit on concurrent runs | minor | no: code reading | `core/src/chats.ts:690`, `:715` |
| C-4 | Queued cards and restored words leak into the next chat | refuted (was major) | no: e2e D shows no leak | `<PageTransition key={pathname}>` at `web/src/App.tsx:334` remounts the page for every chat |

C-4 has no live bug today. The cards and the restored words still live in page state, though, so a
change that drops that `key` would bring it back. The fix in work item 3 keys them by chat anyway.

## Which findings explain which symptom

### Symptom 1: "the message disappears and the agent never gets it"

The agent got the message, and the page loses it:

- **C-1 / S-4** is the main cause. The CLI takes the message mid-turn and acts on it. The transcript
  Agentry serves has no entry for it, so the card says "never read" and a reload erases it.
- **C-7** makes the row sink under the answers, and drops it after 10 minutes or at a whole-page read.
- **C-6** drops a message whose words match an earlier one ("ok", "continue").
- **C-3** calls a message with files lost, and Restore gives back the words without the files.
- **C-13**: after a reload, a message still waiting in the CLI's queue shows nowhere, so the person
  sends it again.

The agent really never got the message:

- **S-2**: the CLI's queue dies with its process (stop, crash, provider move, limit replay, restart).
- **S-3** and the server half of **C-8**: a message held for a replacement process has no trace, and is
  dropped when the chat is stopped or the replacement is refused.
- **S-7**: on Codex and ACP, a turn queued behind a `keepAlive: false` turn is written after stdin is
  closed.
- **C-5**: what was typed or pasted while a send was in flight is erased, so it was never sent.
- **S-6** (Gemini, Copilot): the person's messages are never recorded, so every one vanishes on
  reload, though the agent read them.
- Minor contributors: **S-9** (a limit replay leaves the turn's task out), **S-13**, and **C-14**
  (a timeout looks like a failure, so the message is sent twice rather than lost).

### Symptom 2: "queued messages and Send now do not work well"

- **C-2**: "Send now" interrupts the turn that is answering the message. Because of C-1, the card
  stays and keeps offering the button after the message was read.
- **S-1**: after the turn's result the chat reads idle while the CLI works on the queued message. In
  that window "Send now" is ignored, and the card's 8 s timer calls the message lost.
- **S-5**: "Send now" with two queued messages makes the CLI merge them into one prompt. No card
  matches, and the page shows both messages twice.
- **C-8**: a message sent during a permission prompt, or while the cached state lags, gets no card and
  no "Send now".
- **C-3**, **C-9**, **C-10**, **C-11**: matching by text clears the wrong card, clears one too early,
  or never clears it (files, slash commands, repeated words).
- **C-12**: "lost" comes from a client clock and is final. One lost card hides "Send now" for every
  card.
- **S-8** (ACP: an interrupt that times out runs two prompts at once) and **S-12** (an interrupt on a
  closed stdin spins for 15 s).

## Fix plan

There are four work items, in this order. Items 1 and 2 are on the server and make the facts exist,
item 3 makes the page use them, and item 4 picks up what is left. Each item is done when the todo
tests it names lose their `todo` mark and pass, and when the browser spec, run with
`E2E_CHAT_AUDIT=1`, prints `NOT REPRODUCED` for the scenarios it names.

### 1. The transcript holds every message the agent read (C-1 / S-4, S-6)

- In the Claude transcript reader, read `attachment` lines whose `attachment.type` is
  `queued_command` and whose `commandMode` is `prompt` as the person's `user` entries. Keep them in
  place, with the line's uuid and timestamp.
- For providers whose transcript Agentry keeps itself, `writeUserMessage` records the person's
  entry through `recordEntry`.

Acceptance criteria:
- Core `S-4` and `S-6`, and web `C-1`, pass.
- e2e A: after a reload, the message is on the page, where the agent read it, and in
  `GET /chats/:id`. The card clears without "never read".
- The export, the search and the provider handoff include an absorbed message. Each gets a test over
  a JSONL in the CLI's shape.
- Gemini and Copilot chats show the person's messages, the first prompt included, after a reload.

### 2. The server tracks every message until the agent takes it (S-1, S-2, S-3, S-5, S-7, C-8 server half)

- Give each message an id. The client sends it with `POST /chats/:id/messages`, which also gives
  sends idempotency (C-14), or the server picks one.
- Write the id as the stream-json `uuid`, and run the CLI with `--replay-user-messages`.
- Emit a `delivered` event when the CLI echoes or absorbs the id. Absorbing is a `queued_command`
  carrying it as `source_uuid`, or a `queue-operation` line.
- Keep the ids written but not yet delivered.
- Answer the POST with how the message was taken (`written`, `started`, `held`) and its id.
- Stream held messages at once, and persist them with the chat.
- When stop, a crash, a refused respawn, a move or a restart drops pending messages, emit an
  `undelivered` event per message. A move and a limit replay carry pending messages into the next
  turn.
- Status stays `busy` while anything is pending. `interrupt()` sends the control request whenever a
  process is up.
- Do not end input while a Codex or ACP driver holds a queued turn.

Acceptance criteria:
- Core `S-1` ×2, `S-2`, `S-3` ×2, `S-5`, `S-7` and `C-8` pass.
- A merged prompt yields one `delivered` event per id it holds.
- `POST /chats/:id/messages` documents its new answer: `packages/shared/src/types.ts`, the
  regenerated OpenAPI schemas, and the summary in `routes.ts`.
- Sending the same client id twice writes the message once.
- `--replay-user-messages` and the uuid are documented flags of the CLI. Record that in
  `docs/providers.md`.

### 3. The page tracks queued messages by id, not by words (C-2, C-3, C-6, C-7, C-8 client half, C-9, C-10, C-11, C-12, C-13; keeps C-4 refuted)

- Add the card from the POST answer, not from the cached `chat.state`. Key it by chat and message
  id, and keep the attachment ids on it.
- Clear the card on `delivered`, and mark it lost only on `undelivered`. That removes the 8 s clock.
- Make "Send now" per card. It carries the id, and the server refuses it once that id is delivered or
  a newer turn has started.
- `spliceTail` confirms streamed entries by id, consumes each match once, and keeps an unconfirmed
  entry where it was.
- The chat detail returns the pending messages, so a reload rebuilds the cards.

Acceptance criteria:
- Web `C-6`, `C-7` ×2 and `S-5` pass.
- e2e B1: "Send now" is gone, or refused, once the agent has read the message, and the turn
  answering it is not interrupted. e2e B2 keeps working.
- e2e C: a message with a file shows once, clears when read, and Restore gives back the files.
- e2e F: a message sent during a permission prompt gets a card.
- After a reload, a message still waiting shows as a queued card.
- e2e D still shows no leak between chats.
- New copy goes through i18n with en/es parity, and the card follows Night Shift in both themes and
  at phone width.

### 4. The composer and the remaining edge cases (C-5, C-14 client side, S-8, S-9, S-10, S-11, S-12, S-13)

- When a send succeeds, clear only the text and the attachment ids that were sent.
- Generate the client id and reuse it on a retry.
- ACP fails the turn when an interrupt times out instead of pumping the next prompt.
- A limit replay re-sends the turn's prompt and every message written during it.
- Sends to the same chat are serialized.
- A process that has exited but not closed counts as on its way out.
- An interrupt on an ended stdin answers at once.
- Sends that spawn a process go through `admit()`.

Acceptance criteria:
- e2e E: words and files added while a send is in flight stay in the box.
- A retried send after a timeout reaches the agent once.
- Each minor server finding gets a core test that fails before the fix and passes after it. S-8
  needs a fake ACP agent that ignores `session/cancel`; S-11 needs a fake with a controlled gap
  between exit and close.

## Fixed

Every finding was fixed on branch `audit/chat-messages` (CW-37), by the four work items of the fix
plan. The design is in [[chat-delivery.md]]; what the CLI was confirmed to do is in [[server.md]],
"Confirmed on the CLI". Every todo test lost its mark and passes.

| Id | Fixed in | Proved by |
|---|---|---|
| C-1 / S-4 | `3011f4ec8` (item 1) | core `S-4`, web `C-1`, `packages/core/test/chat-absorbed.test.ts` (page, export, search, handoff), e2e A |
| S-6 | `3011f4ec8` (item 1) | core `S-6` |
| S-1 | `2939b8a65` (item 2) | core `S-1` ×2 |
| S-2 | `2939b8a65` (item 2) | core `S-2` |
| S-3 | `2939b8a65` (item 2) | core `S-3` ×2, `chat-delivery.test.ts` (held, answered so) |
| S-5 | `2939b8a65` (item 2), `112e6b79c` (item 3) | core `S-5`, `chat-delivery.test.ts` (one delivered per id), web `S-5` |
| S-7 | `2939b8a65` (item 2) | core `S-7` |
| C-8 | `2939b8a65` (server half), `112e6b79c` (client half) | core `C-8`, e2e F |
| C-2 | `2939b8a65`, `112e6b79c` | `chat-delivery.test.ts` ("Send now" refused once read), e2e B1; B2 keeps working |
| C-3 | `112e6b79c` (item 3) | e2e C and C2 (Restore keeps the files) |
| C-6 | `112e6b79c` (item 3) | web `C-6` |
| C-7 | `112e6b79c` (item 3) | web `C-7` ×2 |
| C-9, C-10, C-11 | `112e6b79c` (item 3): cards match by id | `apps/web/test/queued-cards.test.ts` |
| C-12 | `112e6b79c` (item 3): no clock, lost only on `undelivered` | `queued-cards.test.ts` |
| C-13 | `2939b8a65` (`chat.pending`), `112e6b79c` (cards rebuilt) | `queued-cards.test.ts`, e2e G |
| C-4 (refuted) | `112e6b79c`: cards are kept by chat | e2e D |
| C-5 | `112e6b79c` (item 4) | e2e E |
| C-14 | `2939b8a65` (server dedupes by id), `112e6b79c` (the page reuses the id on a retry) | `chat-delivery.test.ts` (an id sent twice is written once), API test (a bad id is a 400) |
| S-8 | `2939b8a65` | `chat-delivery.test.ts` `S-8` (fake ACP agent that ignores `session/cancel`) |
| S-9 | `2939b8a65` | `chat-delivery.test.ts` `S-9` |
| S-10 | `2939b8a65` | `chat-delivery.test.ts` `S-10` |
| S-11 | `2939b8a65` | `chat-delivery.test.ts` `S-11` (fake with a gap between exit and close) |
| S-12 | `2939b8a65` | `chat-delivery.test.ts` `S-12` |
| S-13 | `2939b8a65` | `chat-delivery.test.ts` `S-13` |

The server's minor fixes (S-8 to S-13) share code with work item 2 and went in with its commit.

## Coverage and limits

What was checked and found sound is listed in each report: composer failure handling, double
submit, stream reconnect and dedupe, pagination merge, the server's held-queue order, `stop()`
targeting, the SSE subscribe-then-replay, and "Send now" on a message still in the CLI's queue
(e2e B2). No test ran the real CLI. Two behaviours are taken from its transcripts and not confirmed
on the CLI itself:
- what the CLI does with its queue when stdin closes;
- whether it reports an absorbed message on stdout without `--replay-user-messages`.

Work item 2 confirmed both against the real CLI by hand before it was built: see "Confirmed on the CLI" in [[server.md]].

Related: [[client.md]], [[server.md]], [[repro.md]], [[providers.md]], [[chat-delivery.md]]
