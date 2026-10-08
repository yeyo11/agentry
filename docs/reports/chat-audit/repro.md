---
created_at: 2026-10-08T13:00:00Z
updated_at: 2026-10-08T13:00:00Z
tags:
    - report
    - audit
    - chats
    - reproduction
---
# Chat message audit: reproductions

This report turns every major or blocker finding of [[client.md]] and [[server.md]] into a
reproduction, or says plainly that it did not reproduce. It also tries the two reported symptoms end
to end, on a built app driven in a browser against a fake CLI. No product code changed. File
references are to this branch (`main` at 0.36.0 plus the audit commits). The product code is the
same as at `359e59fd5`.

## Verdict

| Finding | Severity | Reproduction | Result |
|---|---|---|---|
| C-1 / S-4 (symptom 1) | blocker | e2e scenario A; unit `C-1`; core `S-4` | **reproduced** end to end |
| S-1 | blocker | core `S-1` ×2 (existing) | **reproduced** (re-run) |
| C-2 (symptom 2) | major | e2e scenario B1 | **reproduced** |
| C-3 | major | e2e scenario C | **reproduced** |
| C-4 | major | e2e scenario D | **did not reproduce**: the finding's root cause is wrong |
| C-5 | major | e2e scenario E | **reproduced** |
| C-6 | major | unit `C-6` (existing) | **reproduced** (re-run) |
| C-7 | major | unit `C-7` ×2 (existing) | **reproduced** (re-run) |
| C-8 | major | e2e scenario F; core `C-8` (new) | **reproduced**, both halves |
| S-2 | major | core `S-2` (existing) | **reproduced** (re-run) |
| S-3 | major | core `S-3` ×2 (existing) | **reproduced** (re-run) |
| S-5 | major | core `S-5` (new); unit `S-5` (new) | **reproduced** |
| S-6 | major | core `S-6` (existing) | **reproduced** (re-run) |
| S-7 | major | core `S-7` (existing) | **reproduced** (re-run) |
| "Send now" on a message still queued | (sound path) | e2e scenario B2 | works: the CLI reads it next and the card clears |

All 15 todo tests, old and new, fail on the assertion their finding predicts. None of them fails on a
timeout or a setup error. Each was run with its `todo` mark in place, and the runner listed each as
`not ok … # TODO`.

## How to run them

- **Unit (web):** `apps/web/test/chat-audit-client.test.ts` (from the client worker) and
  `apps/web/test/chat-audit-repro.test.ts` (new). Both run in `pnpm --filter @agentry/web test`.
- **Core:** `packages/core/test/chat-delivery-audit.test.ts` (from the server worker) and
  `packages/core/test/chat-audit-repro.test.ts` (new). Both run in `pnpm --filter @agentry/core test`.
- **Browser, end to end:** `e2e/specs/chat-audit-delivery.spec.mjs` (new, `fakeCli`). It is a no-op
  unless `E2E_CHAT_AUDIT=1`, so the suite on the merged branch stays green while the bugs stand. Each
  scenario prints `REPRODUCED` or `NOT REPRODUCED` with its evidence instead of failing; `check`
  guards only the setup. To run it:

  ```bash
  timeout 900 pnpm build
  E2E_CHAT_AUDIT=1 E2E_SHARDS=1 E2E_PORT=8955 timeout 600 node e2e/run.mjs chat-audit-delivery.spec
  ```

  `E2E_CHAT_AUDIT_ONLY=A,C` runs only some scenarios (A, B1, B2, C, D, E, F), and
  `E2E_CHAT_AUDIT_OUT=<file>` writes the findings as JSON. One whole run takes about 60 s.

### What the fake CLIs gained (additive knobs only)

- `e2e/fake-cli/claude`:
  - **Transcript.** `AGENTRY_FAKE_CLI_TRANSCRIPT=1`, or `"@transcript": true` in the scripts file (a
    spec cannot set the server's environment), with `CLAUDE_CONFIG_DIR` set. The fake then writes
    `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl` in the shape CLI 2.1 uses: `user` and
    `assistant` lines, `tool_result` lines under the uuids it streamed, `queue-operation` lines, and a
    message read mid-turn as an `attachment` of type `queued_command` with no `user` line, as the
    reports measured on this machine. Without this knob the fake writes no transcript, so no reload
    could show a loss.
  - **`ask: <command>` step.** A `can_use_tool` control request that the turn waits on. It makes the
    chat `waiting` for C-8.
  - **New log events:** `absorbed` (messages read inside the turn), `asked` and `answered`. These are
    documented in `e2e/fake-cli/README.md`, and the fake's own test (`node --test
    e2e/fake-cli/claude.test.mjs`, 15 tests) passes.
- `packages/core/test/fixtures/fake-claude-queue.mjs`: `FAKE_QUEUE_LOG_IDS=1` logs every stdin user
  line with the `uuid` it carried (S-5).

## The two reported symptoms, end to end

### Symptom 1: "a message is sent and it disappears, and the agent seems never to get it" (scenario A)

Steps: start a chat whose turn runs `sleep 4` then `sleep 2`. Wait until the page shows it working.
Type "also list the files" in the composer and send it.

| Observation | Value |
|---|---|
| Queued card shown | yes |
| The CLI read it inside the running turn (fake log `absorbed`) | yes |
| The agent's answer to it ("Heard: also list the files") on the page | yes |
| The transcript has `attachment/queued_command` for it, and no `user` line | yes, and no `user` line |
| 8 s after the turn, the card says "never read" and offers Restore | **yes** |
| On the page after a reload | **no** |
| In `GET /chats/:id` | **no** |

This is the reported symptom. The agent got the message and acted on it. The page then calls it
undelivered and offers to send it again. After a reload it is gone from the conversation: the agent
answers something nobody said. The cause is C-1 / S-4: `normalizeMessage` drops every line that is
not `user` or `assistant` (`packages/shared/src/normalize.ts:72`), and the card waits for a `user`
entry with its text (`packages/chat-ui/src/composer/queued.ts:60`, lost timer at `:70`).

### Symptom 2: "queued messages and Send now misbehave" (scenarios B1, B2, F, C)

- **B1 (C-2), reproduced.** The turn runs `sleep 2` then `sleep 30`. A message sent during the
  first command is read at the next step, and the second command is the work on it. The card still
  shows, still offering "Send now" (C-1 keeps it there). Pressing it interrupts the turn that is
  answering the message: the fake logs `command-ended` for `sleep 30` with `interrupted: true`.
  "Send now" is a plain `POST /interrupt` (`apps/web/src/pages/ChatView.tsx:424`), and the server
  interrupts whatever runs (`packages/core/src/chats.ts:776`).
- **B2, works.** A message sent while the turn is past its last tool call (a `hold:`) stays in the
  CLI's queue. "Send now" ends the turn, the CLI reads the message as the next turn, its `user` line
  lands in the transcript, and the card clears. So "Send now" works when the message really is still
  waiting. It misbehaves when the message was already read (B1), when the chat looks idle while the
  CLI works on it (S-1, core), and when the CLI merges several (S-5).
- **F (C-8), reproduced.** The chat waits on a permission prompt (state `waiting`). A message sent
  then reaches the CLI but gets no card: the page queues only when `chat.state === 'working'`
  (`ChatView.tsx:448`, `queued.ts:44`). It shows as a plain row. The CLI reads it after the answer
  (`absorbed`), and after a reload it is gone.
- **C (C-3), reproduced.** A message with a pasted file, sent while the CLI still holds the turn,
  shows as a row and as a card at the same time. The CLI reads it as its own turn, but the text it
  received ends with the `<attached-files>` list, so the card never matches and is called lost. Restore
  puts back the words ("look at this file, please") with 0 files.

## Findings that had no reproduction

### C-2: "Send now" interrupts the turn that is already answering the message, reproduced

- **Test:** e2e scenario B1 (`chat-audit-delivery.spec.mjs`, `want('B1')`).
- **Evidence:** `{"agentHadReadIt":true,"sendNowStillOffered":true,"turnAnsweringItInterrupted":true}`.
- **Not covered:** the "late second click" variant, which needs the click to land after a dequeue.
  It is the same server path (`chats.ts:776`), so B1 covers the root cause.

### C-3: a message with files never matches its card, reproduced

- **Test:** e2e scenario C.
- **Evidence:** `{"readByCli":true,"rowAndCardAtOnce":true,"cardCalledLost":true,"restoredText":"look at this file, please","restoredFiles":0}`.
  Both of the finding's claims hold: the message shows twice while waiting (`queued.ts:80` cannot
  hide the streamed copy), and Restore drops the files (`ChatView.tsx:409` hands back `message.text`
  only).

### C-4: queued cards and restored words leak into the next chat, did not reproduce

- **Test:** e2e scenario D. Chat A, working, holds a queued card. The person moves to chat B,
  working too, inside the app (`history.pushState` + `popstate`, as a sidebar link does, with no
  reload).
- **Evidence:** `{"cardOfFirstChatShownOnSecond":false,"interruptHit":"none"}`. B shows no card, so
  there is no "Send now" on B to press.
- **Why:** the finding says the route renders `<ChatView />` without a key (`App.tsx:341`). That is
  true, but its parent is `<PageTransition key={pathname}>` (`apps/web/src/App.tsx:334`), so every
  change of `/chats/:id` remounts the whole page. `useQueuedMessages`' state and `ChatView`'s
  `restore` start empty for each chat. The restored-words half fails the same way, since `restore`
  is `ChatView` state. Nothing in this finding stands. A change that drops that `key`, for a
  transition between chats, would bring it back, so a fix of the other findings should key the
  cards by chat anyway.

### C-5: words typed while a message is being sent are erased, reproduced

- **Test:** e2e scenario E. The page's `fetch` is slowed by 2 s for `POST …/messages`, standing in
  for a slow network or a resume that spawns a process. The person sends "first message", types
  "second thought" and pastes a file while the request is out.
- **Evidence:** `{"boxWhileSending":"first messagesecond thought","chipsWhileSending":1,"boxAfter":"","chipsAfter":0}`.
  When the request comes back, both the typed words and the pasted file are gone, and the file was
  never sent (`packages/chat-ui/src/composer/Composer.tsx:175`, `:177`).

### C-8: whether a message gets a card is guessed from the cached state, reproduced

- **Tests:** e2e scenario F (the `waiting` half), and core `C-8: a message held for a replacement
  process that cannot start is reported as not delivered` (the server half).
- **Evidence (e2e):** `{"chatState":"waiting","cardShown":false,"rowShown":true,"readByCli":true,"onPageAfterReload":false}`.
- **Evidence (core):** in a `keepAlive: false` chat whose CLI lingers after its result, a message
  is held in `chat.queued` (`chats.ts:694`). The replacement is then refused: a test driver reports
  an untracked holder of the session, one of the refusals `spawnProcess` throws (`chats.ts:958-965`).
  The chat fails with the refusal's reason, and no event anywhere names the message
  (`drainQueue`, `chats.ts:712-720`). An `error` from `spawn` itself, such as a missing binary, takes
  another path: `spawnProcess` has already streamed the first message there, so the page at least
  shows it.

### S-5: nothing tells the client which message the agent read, and an interrupt merges them, reproduced

- **Tests:**
  - core `S-5: the id the page knows a queued message by reaches the CLI, so a merged prompt can be
    told apart`. Two messages are queued behind a held turn, then interrupted. The fake reads them as
    one prompt, `"also check the lint\nand the types"`. The streamed entries carry the wrapper's uuids
    (`chats.ts:1064`), but the stdin line has none (`providers/claude-code/driver.ts:54`). The fake
    received `[]`.
  - unit `S-5: two queued messages the CLI read as one prompt are shown once, not twice`.
    `spliceTail` keeps both streamed copies, because neither text equals the merged entry
    (`packages/chat-ui/src/lib/chat-stream.ts:102`, `:108`). It puts them after the answer (`:112`),
    so the page shows the two messages twice: merged where the CLI read them, then each again at the
    bottom.

## Existing reproductions, re-run

`S-1` ×2, `S-2`, `S-3` ×2, `S-4`, `S-6` and `S-7` in core, and `C-1`, `C-6` and `C-7` ×2 in web, all
fail on their own assertion. For example, S-1 fails with "the interrupt was answered without being
sent: the status said idle". S-4 fails with "the person's second message is not on the page:
["run the tests",""]". S-7 fails with one result instead of two.

## Corrections to the reports

- **C-4** is refuted; see above.
- **Line references.** The client report cites `chat-stream.ts:319`, `:359-372` and `:393-403` for
  `spliceTail`, `SENT_GRACE_MS` and `appendStreamed`. That file has 192 lines on this commit;
  `spliceTail` is at `packages/chat-ui/src/lib/chat-stream.ts:91-113`. The text match is `:102`,
  unconfirmed entries kept as `late` are `:108`, and appended after the read at `:112`. The
  behaviour the report describes is right, as its tests show.
- **C-8's second half:** only a refusal thrown by `spawnProcess` loses the held message without a
  word. A spawn error goes through `proc.on('error')` after the message was streamed (see above).

## What was checked and found sound

- "Send now" on a message the CLI still holds (scenario B2): the CLI reads it as the next turn, the
  transcript gets its `user` line, and the card clears within a few seconds.
- Moving between chats inside the app resets the queued cards and the restored words (scenario D,
  `App.tsx:334`).
- The text in the composer is kept while the request is out: what is lost is only what was typed
  after sending (C-5), never the message itself before a success.

## Not covered

- S-8 to S-13 and C-9 to C-14 are minor and were not asked for here. They keep the status their
  reports give them.
- No scenario used the real CLI (the project's rule). The fake's `queued_command` and merge
  behaviour copy what the reports measured in this machine's real transcripts. Two things remain
  unconfirmed against the CLI itself: what it does with its queue at EOF, and whether it echoes an
  absorbed message on stdout without `--replay-user-messages`.
- S-1 was not tried in the browser. The e2e fake starts a dequeued turn with an assistant message at
  once, so the idle window that the core test shows does not open there.

Related: [[client.md]], [[server.md]]
