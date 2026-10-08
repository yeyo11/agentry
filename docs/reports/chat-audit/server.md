---
created_at: 2026-10-08T12:00:00Z
updated_at: 2026-10-08T18:00:00Z
tags:
    - report
    - audit
    - chats
    - providers
---
# Chat message audit: the server side

What happens to a message from `POST /chats/:id/messages` until the agent reads it, on commit
`359e59fd5` (0.36.0). The question behind it: people report that (1) a message is sent, disappears,
and the agent seems never to get it, and (2) queued messages (sent while a turn runs) and "Send now"
(which ends the turn so the queued message is read) misbehave. This is an audit: no product code
changed. The reproductions are in `packages/core/test/chat-delivery-audit.test.ts`, each marked
`{ todo: 'S-n' }` so the suite stays green while the bug stands; they use a new fake,
`packages/core/test/fixtures/fake-claude-queue.mjs`, that keeps the CLI's message queue the way the
CLI's own transcripts show it.

## How a message travels

1. `apps/api/src/routes/chats.ts:176` calls `ChatService.send` (`packages/core/src/chat-service.ts:1128`).
2. `ChatService.send` reads the chat's summary (async: process table, CLI sessions, transcript
   summary). Unless `control.mode` is `interactive`, which means only "a process of ours is up", it
   answers **409** (`ChatConflictError`): "resume it to continue", or the read-only reason.
3. `ChatManager.send` (`packages/core/src/chats.ts:684`) then does one of three things:
   - no live process: spawns one with `--resume` (`chats.ts:690`). Only a race reaches this, because
     step 2 refuses a dead chat;
   - process on its way out (`stopRequested`, stdin ended, or messages already held): pushes the
     message on `LiveChat.queued` (`chats.ts:694`), in memory, with no event;
   - otherwise `writeUserMessage` (`chats.ts:1056`): `session.send` writes it to the process
     (Claude: one stream-json `user` line on stdin, `providers/claude-code/driver.ts:54`; Codex and
     ACP: a queue inside the driver, `providers/codex/session.ts:156`, `providers/acp/session.ts:355`),
     then pushes a `message` event with a fresh uuid and sets the status `busy` (`chats.ts:1061-1078`).
4. The answer is **200** with the chat summary in all three cases. Nothing in it says which case
   happened.
5. The page sees the message only through that `message` event on `GET /chats/:id/stream`. The event
   lives in `LiveChat.events`, in memory, at most 5000 per chat (`live-chat.ts:33`). The transcript
   the page reads on load comes from the CLI's JSONL for Claude, from the provider's store for Codex
   and OpenCode, and from the `chat_entries` table for Gemini and Copilot.

Nothing confirms delivery. The Claude driver does not pass `--replay-user-messages`
(`providers/claude-code/args.ts:7-10`), so the CLI never echoes a message it read, and the server
cannot tell "written into a pipe" from "read by the agent".

## What the CLI does with a message that arrives during a turn

Read from the transcripts this machine's CLI wrote (`~/.claude/projects/*/*.jsonl`). The CLI writes
its own queue to the transcript as `queue-operation` lines.

- Every stream-json `user` line is `enqueue`d. Across this machine's transcripts there are 3702
  enqueues, 2412 dequeues and 1262 removes. 1261 of the removes have the reason `absorbed_mid_turn`.
- **Absorbed mid-turn.** When the running turn reaches a tool boundary, the CLI takes the queued
  message into that turn. It writes an `attachment` line of type `queued_command` with the text in
  `attachment.prompt`, and no `user` entry. Example: session `b21c160b…`, lines 459 to 463
  (`enqueue`, `tool_result`, `attachment/queued_command`, `hook_additional_context`, `remove`).
  In stream-json (`entrypoint: sdk-cli`) sessions on this machine, 262 messages from a person or a
  hint were absorbed this way, across 149 sessions.
- **Dequeued after the turn.** If no tool boundary comes, the message is read as the next turn and
  written as an ordinary `user` entry.
- **On an interrupt, all queued messages become one prompt.** Session `f7ddba36…`, lines 884 to 890:
  two messages were enqueued at 17:07:44 and 17:08:02. The interrupt came at 17:08:09. There are two
  `dequeue` lines, then **one** `user` entry whose content is both texts joined by `\n`.

## Confirmed on the CLI

Run by hand on 2026-10-08 against the real CLI (2.1.288), `--model haiku`, in a throwaway directory
under `/tmp`, with `-p --input-format stream-json --output-format stream-json --verbose`, each stdin
line carrying a `uuid` of our own. Five short sessions, each read back from stdout and from the
transcript the CLI wrote.

- **The stream-json `uuid` comes back.** The CLI keeps the id a stdin line carries as the message's
  own: the `user` line of a message read as a turn has that `uuid`; a message read mid-turn is the
  `attachment/queued_command` line with `source_uuid` set to it, and its `queue-operation remove` line
  carries it as `commandUuid`. When an interrupt merges two queued messages into one prompt, the
  merged `user` line takes the **last** message's id.
- **With `--replay-user-messages` the CLI reads each message back the moment it takes it**, as a
  `user` line with `isReplay: true` and the id it was sent with: at the start of the turn it starts,
  or, for a message absorbed mid-turn, right after the tool result it was absorbed at. A merged
  prompt reads back every message in it (the first with its own text, the last with the merged
  text). Slash commands read back too (as `<command-name>…` text), so nothing that is taken goes
  unreported.
- **Without `--replay-user-messages` an absorbed message is not reported as a `user` line on
  stdout.** This CLI also writes `command_lifecycle` lines (`queued`, `started`, `completed`,
  `cancelled`, by `command_uuid`) with or without the flag, but they are not in `--help`, so the fix
  does not depend on them.
- **When stdin closes, the CLI keeps its queue.** A message written just before the end of input is
  still read, as a mid-turn absorption or as its own turn after the running one, and the process
  exits only once it has answered it. So only the RPC drivers (Codex, ACP) can lose a turn to an
  early end of input (S-7); for Claude, what dies with the process is what was still queued when the
  process was stopped or crashed (S-2).
- The interrupt control response lists what is still queued, by id (`still_queued`), and the CLI
  reads that queue as its next turn at once.

The design kept its shape: the server sends every message under an id of its own, runs the CLI with
`--replay-user-messages`, and treats a read-back as the delivery. It does not read the transcript's
`queue-operation` lines to follow deliveries: the read-back says the same thing on the stream, as it
happens. [[chat-delivery.md]] describes the result.

## Findings

### S-1 — The chat reads idle while the CLI works on a queued message, and "Send now" does nothing then

- **Severity:** blocker
- **Symptom:** a message sent during a turn is read by the CLI as the next turn, but the chat shows
  idle ("waiting for you") until the agent's first whole message arrives. That can take many seconds
  while the model thinks. "Send now" or Interrupt in that window answers 200 and nothing happens. The
  queued card on the page decides after 8 s that the message was lost (`queued.ts`), because the chat
  is not `working`.
- **Root cause:** `foldResult` sets the status to `idle` on every `result` (`chat-fold.ts:249`). It
  goes back to `busy` only when an assistant `message` arrives (`chat-fold.ts:158`). Partials
  (`stream_event`, `--include-partial-messages`) and `init` do not change it. `ChatManager.interrupt`
  returns early unless the status is `busy` or `starting` (`chats.ts:776`), so it never sends the
  control request. The CLI's interrupt response has `still_queued` (the fixture
  `fake-claude-control.mjs` records it), and Agentry ignores it. Codex and ACP have the same window:
  their drivers start the next queued turn right after emitting the result
  (`codex/session.ts:203-204`, `acp/session.ts:411` → `idle()` → `pump()`), and the manager has
  already set the chat `idle`.
- **Sequence:** turn 1 is running → `POST /messages` M2 (the CLI enqueues it) → turn 1 ends with no
  further tool call → `result` → status `idle` → the CLI dequeues M2 and starts turn 2, streaming only
  partials → `POST /interrupt` → `interrupt()` sees `idle` → returns the summary and writes nothing.
- **Reproduction:** `S-1: a chat whose CLI is working on a message it queued is busy, not idle`
  (status is `idle`), and `S-1: "send now" (an interrupt) reaches the CLI while it works on a queued
  message` (no `interrupt` control request reaches the fake).
- **Fix:** leave `idle` only when nothing is pending. Count messages written since the last result,
  or use `--replay-user-messages` to see the CLI take each one, and stay `busy` on `init` or
  `message_start`. Let `interrupt()` always send the control request when a process is up: the CLI
  answers harmlessly between turns.

### S-2 — A message the CLI still held dies with its process, and the page still shows it as sent

- **Severity:** major
- **Symptom:** the person sends a message during a turn. Then the chat is stopped, the process
  crashes, the chat is moved to another provider, a usage limit replays the turn, or the server
  restarts. The message was on the page as sent, the agent never read it, nothing says so, and after
  a reload it is gone.
- **Root cause:** `writeUserMessage` pushes the `message` event the moment the line is written
  (`chats.ts:1061`), before any sign that the CLI read it. The CLI holds the line in its own queue.
  `stop()` (`chats.ts:740`), `replayLastTurn` (`chats.ts:1164`), `continueOn` (`chats.ts:1184`) and
  `stopAll()` on shutdown kill the process with that queue in it. Write errors on stdin are swallowed
  (`chats.ts:1028`). Nothing compares what was written with what the CLI read, though the CLI journals
  an `enqueue` without a later `dequeue` or `remove` in the transcript. The page's own copy of the
  message is the streamed entry, which no stored transcript backs.
- **Sequence:** `POST /messages` M2 during a turn → 200, `message` event → the CLI enqueues M2 →
  `POST /stop` (or a crash, a move, a restart) → the process exits → the execution ends `stopped` →
  M2 exists only in the in-memory event buffer and in the CLI's `enqueue` line.
- **Reproduction:** `S-2: a message the CLI still held when its process went away is reported as not
  delivered`.
- **Fix:** keep the messages written but not yet acknowledged (from `--replay-user-messages`, or from
  the transcript's `queue-operation` lines). When the process ends with any of them still unread,
  push a notice naming each one as not delivered, and say so in the summary, so the page can offer to
  send it again. A move or a limit replay should carry those messages into the next turn.

### S-3 — A message held for the replacement process has no trace, and stop drops it silently

- **Severity:** major
- **Symptom:** a message sent while the process is on its way out answers 200 and shows nowhere
  until the next process starts. The process can be on its way out because the 10-minute idle timer
  closed stdin, because the chat has `keepAlive: false` and its turn just ended, or because stop was
  pressed and the process takes up to 5 s to go. If stop is pressed meanwhile, or the respawn fails,
  the message is gone with no event. A server restart loses it too.
- **Root cause:** `send` pushes to `LiveChat.queued` with no event (`chats.ts:694`). `stop()` empties
  it (`chats.ts:745`). `drainQueue`'s spawn failure keeps only the error text (`chats.ts:716-721`).
  `queued` is not persisted, and `LiveChat.restore` has no place for it.
- **Sequence:** a `keepAlive: false` chat ends a turn → `endInput` → the CLI lingers on background
  work → `POST /messages` M2 → 200, `queued`, no event → `POST /stop` → `queued = []` → the process
  exits `stopped` → no new process, and nothing records M2.
- **Reproduction:** `S-3: a message held for the next process shows in the stream at once` and
  `S-3: stopping a chat that holds a message says the message was not delivered`.
- **Fix:** push the held message as an event at once, marked as waiting for a process, and persist
  it with the chat record. When `stop()` or a failed respawn drops held messages, push a notice per
  message saying it was not sent, so the page can put the text back in the composer.

### S-4 — A message the CLI absorbed into the running turn is missing from the transcript

- **Severity:** blocker
- **Symptom:** the reported "the message disappears": a message sent during a turn shows while the
  page is open, the agent acts on it, and after a reload, a new device or a page of history it is not
  in the conversation. The page's queued card never finds it in the transcript and marks it as not
  delivered, though the agent read it.
- **Root cause:** the CLI writes an absorbed message only as an `attachment` line of type
  `queued_command` (see above), and `normalizeMessage` returns null for every line that is not `user`
  or `assistant` (`packages/shared/src/normalize.ts:72`). No code in `packages/` or `apps/` reads
  `queued_command` or `queue-operation`. The CLI took 262 messages from people or hints this way in
  149 stream-json sessions on this machine.
- **Sequence:** `POST /messages` M2 during a turn that still has tool calls ahead → the CLI enqueues
  M2 → at the next tool result it writes `attachment/queued_command` and `remove`
  (`absorbed_mid_turn`) → the transcript Agentry serves has no entry for M2.
- **Reproduction:** `S-4: a message the CLI absorbed into the running turn is in the transcript
  Agentry serves` (a JSONL in the CLI's shape; `GET /chats/:id` returns the first prompt only).
- **Fix:** in the Claude transcript reader, read `attachment` lines whose type is `queued_command`
  (with `commandMode: 'prompt'`) as the person's `user` entries, in place, with their own uuid.
  `task-notification` prompts follow the rule that already applies to them. The export, the search and
  the handoff all read the same entries, so a move carries the message too.

### S-5 — Nothing tells the client which message the agent read, and an interrupt merges them

- **Severity:** major
- **Symptom:** "Send now" with two queued messages delivers both, but the page cannot tell. The
  transcript holds one `user` entry with both texts, so neither card matches its text, and both are
  shown as lost. A message written into the pipe looks the same as one the agent read.
- **Root cause:** the server's only per-message signal is the `message` event it makes up at write
  time, with a uuid of its own (`chats.ts:1061-1064`), which no transcript entry ever has. The CLI is
  not asked to acknowledge (`--replay-user-messages` is not in `args.ts`). The stdin line carries no
  uuid, which the CLI would keep as `source_uuid` on a `queued_command`. On an interrupt the CLI joins
  every queued prompt into one entry (session `f7ddba36…`, lines 884-890).
- **Reproduction:** from the CLI's own transcripts, as cited. The queueing fake models the merge, but
  no test asserts it, because the matching is the page's (see the client report).
- **Fix:** send each message with a uuid Agentry chooses, and run the CLI with
  `--replay-user-messages`, both documented stream-json features. Emit a `delivered` event for each
  uuid the CLI echoes or absorbs, and serve that uuid on the transcript entry. Then the page matches
  by id, not by text, and a merged prompt resolves every card in it.

### S-6 — Gemini and Copilot chats never record the person's messages

- **Severity:** major
- **Symptom:** in a chat on a provider whose transcript Agentry keeps itself (Gemini, Copilot), every
  message the person wrote, the first prompt included, vanishes after a reload. Only the agent's side
  and the tool results remain.
- **Root cause:** `recordEntry` (`chat-fold.ts:16-25`) runs only for the `message` events a driver
  reports (`chat-fold.ts:156`). `writeUserMessage` pushes the person's message straight to the stream
  (`chats.ts:1061`) and never records it, and the ACP and Codex drivers report no `user` entry for the
  prompt (`acp/updates.ts:182` and `codex/events.ts:176` are tool results only). `ChatService` reads
  `chat_entries` for these providers (`chat-service.ts:600-608`).
- **Reproduction:** `S-6: a Gemini or Copilot chat's transcript holds the person's own messages`
  (the user entries read back are the two tool results).
- **Fix:** have `writeUserMessage` record the person's entry through the same `recordEntry`, for every
  provider that is not Claude. A provider with a store of its own already has it there, and only the
  fallback rows need it.

### S-7 — On Codex and ACP, a turn queued behind a `keepAlive: false` turn is written into a closed stdin

- **Severity:** major
- **Symptom:** a hint, or the person's message, sent while a flow run, orchestration worker or decision
  chat on Codex, Gemini, Copilot or OpenCode works is never run. The process exits after the first
  turn, and the chat shows the message as sent.
- **Root cause:** the driver emits the turn's `result` synchronously, and `foldResult` calls
  `endInput()` on it for `keepAlive: false` (`chat-fold.ts:246-247`). Only after that does the driver
  start its queued turn (`codex/session.ts:203-204`, `acp/session.ts:411` → `idle()` → `pump()`), which
  writes `turn/start` or `session/prompt` after the end of stdin. The error is swallowed
  (`chats.ts:1028`). `ChatManager.queued` never saw the message: the manager wrote it while the
  process looked healthy.
- **Reproduction:** `S-7: an ACP chat that ends its input after a turn still runs the turn queued
  behind it` (one result instead of two).
- **Fix:** do not end input while the driver holds a queued turn. Give `DriverSession` a "has queued
  turns" query and check it in `foldResult`, or let the driver report "idle" only when its queue is
  empty. The Claude CLI keeps reading its own queue after EOF, so only the RPC drivers need it.

### S-8 — An ACP interrupt that times out starts the next prompt beside the one still running

- **Severity:** minor
- **Symptom:** after "Send now" on a Gemini, Copilot or OpenCode chat whose agent is slow to cancel,
  two answers can interleave, and the second turn's result is reported when the first one's reply
  arrives.
- **Root cause:** `AcpSession.interrupt` calls `idle()` after 10 s whether or not the agent ended the
  prompt (`acp/session.ts:451`). `idle()` pumps the next queued turn. The first `session/prompt`
  reply then calls `endTurn` for a turn it does not own (`acp/session.ts:387-411`).
- **Reproduction:** not written. It needs a fake agent that ignores `session/cancel`.
- **Fix:** on timeout, fail the turn and the session (or the process) instead of pretending it is
  idle, or tag each prompt with a sequence number and ignore a reply for a turn that is not current.

### S-9 — A limit replay sends only the last message written, not the turn that died

- **Severity:** minor
- **Symptom:** after a usage-limit wait, the chat goes on with the person's latest message or hint,
  and the task message whose turn died is not sent again.
- **Root cause:** `lastUserTurn` is overwritten by every write (`chats.ts:1057`), including messages
  and hints written while the turn runs. `replayLastTurn` re-sends just that one (`chats.ts:1167`).
- **Reproduction:** not written. Code reading only.
- **Fix:** record the turn's prompt when a turn starts (the first write after a result), plus any
  messages written during it, and replay them all in order.

### S-10 — Two messages sent close together can arrive in the other order

- **Severity:** minor
- **Symptom:** two quick sends (two tabs, or a hint and a message) reach the agent swapped.
- **Root cause:** `ChatService.send` awaits a summary (process table, CLI sessions, transcript
  summary) before the synchronous write (`chat-service.ts:1129-1134`). Two requests resolve their
  awaits in any order.
- **Reproduction:** not written. Code reading only.
- **Fix:** check the gate synchronously against the runtime (`runtime.get(id)?.pid`) and write before
  any await, or serialize sends per chat.

### S-11 — A respawn between a process's exit and its close drops the old process's last lines

- **Severity:** minor
- **Symptom:** rare. A message sent in the instant a process exits starts a new process. The old
  execution then never ends, its last stdout lines (possibly its `result`) are ignored, and after a
  restart it reads as "interrupted".
- **Root cause:** `alive` turns false on `exit` (`live-chat.ts`, `processUp`), but finalizing and
  draining wait for `close` (`chats.ts:1040-1048`). A `send` in between spawns a new process
  (`chats.ts:690`), so `current()` is false for the old one. Its remaining lines and its `close` are
  ignored (`chats.ts:1020`, `1041`), and `beginExecution` opens a new execution beside the unfinished
  one.
- **Reproduction:** not written. It needs a timing-controlled exit.
- **Fix:** treat a process that has exited but not closed as "on its way out" (queue, as for
  `stopRequested`), so the respawn happens in `close`, after the old execution is finalized.

### S-12 — An interrupt on a process whose stdin is closed waits 15 s and fails

- **Severity:** minor
- **Symptom:** Interrupt on a `keepAlive: false` chat after its result, or after the idle timer,
  while the CLI is still finishing background work: the button spins for 15 s and then shows "the CLI
  did not answer interrupt in time" (400).
- **Root cause:** for `keepAlive: false` the status stays `busy` after the result
  (`chat-fold.ts:246`), so `interrupt()` goes ahead and writes a control request into an ended stdin.
  The write error is swallowed (`chats.ts:1028`), and `ControlChannel.request` waits for its 15 s
  timeout (`claude-code/control.ts:5`, `39-42`).
- **Reproduction:** not written.
- **Fix:** refuse, or answer at once, when `proc.stdin.writableEnded`. Better, give a
  `keepAlive: false` chat a status of its own after its result, so the page does not offer an
  interrupt.

### S-13 — A send that spawns a process skips the concurrent-run limit

- **Severity:** minor
- **Symptom:** a hint or a message to a chat that needs a new process starts it even when
  `maxConcurrentRuns` is reached.
- **Root cause:** `start`, `resume` and `fork` call `admit()`, but `ChatManager.send` (`chats.ts:690`)
  and `drainQueue` (`chats.ts:715`) spawn without it. `ChatService.hint` sends to any chat
  (`chat-service.ts:766`).
- **Fix:** call `admit()` before spawning in `send`, and for a refused drained message, push the
  "not delivered" notice from S-3.

## What each state does with a message

| State of the chat | API answer | Where the message goes | In the stream | In the transcript | Can be lost |
|---|---|---|---|---|---|
| Running a turn (Claude) | 200 summary | stdin, then the CLI's queue | `message` at once | `queued_command` attachment (not read, S-4), or a `user` entry after the turn | process dies first (S-2) |
| Running a turn (Codex, ACP) | 200 | the driver's in-memory queue | `message` at once | Codex and OpenCode: their store; Gemini and Copilot: never (S-6) | `keepAlive: false` (S-7), process dies |
| Idle, process alive (keepAlive) | 200 | stdin, read as a turn | `message` | `user` entry | no |
| Starting (handshake) | 200 | stdin (Claude) or the driver queue | `message` | as above | handshake failure ends the chat, visibly |
| On its way out (stdin ended, stop pressed, held messages) | 200 | `LiveChat.queued`, memory only | nothing (S-3) | after respawn | stop, failed respawn, restart (S-3) |
| Exited | **409** "resume it to continue" | refused; the client must call `/resume` | — | — | no, but the client has to act |
| At a usage limit, process alive | 200 | stdin; the turn dies on the limit again | error `result` | as running | replay sends only the last message (S-9) |
| Waiting for a permission answer | 200 | stdin, then the CLI's queue; absorbed after the tool result | `message` | `queued_command` (S-4) | as running |
| Being interrupted | 200 | the CLI's queue, then read with every other queued message as one prompt | `message` | one merged `user` entry (S-5) | no, but the page cannot match it |
| Moved to another provider | 409 on the old chat once its process is gone | — | — | the handoff is built from a transcript without absorbed messages (S-4) | held messages die with the old process (S-2) |
| After a server restart | 409 until resumed | — | the in-memory events are gone | only what the CLI wrote | everything held or queued (S-2, S-3) |

## Checked and sound

- `ChatManager.queued` keeps arrival order, and one replacement process takes every held message
  (`drainQueue`, `chats.ts:702-722`). Three messages no longer make three processes.
- `stop()` kills the process it captured, not a replacement started within the 5 s grace
  (`chats.ts:757-765`).
- The `close` and stdout handlers ignore a process that is no longer the chat's (`current()`,
  `chats.ts:1018-1048`), so a late exit cannot mark a live chat failed. S-11 is the gap this leaves.
- An answer to a permission prompt is dropped when the process is gone (`control.ts:89`), and
  `finalize` denies whatever was pending (`chats.ts:1093`). An interrupt with a prompt pending
  withdraws it (`control_cancel_request`, `stream.ts:109-114`; Codex and ACP answer `cancel` first).
- The SSE route subscribes before it replays and the client dedupes by `seq`
  (`routes/chats.ts:221-223`), so no event is lost between the replay and the live stream. Partials
  carry no id, so `Last-Event-ID` always names a stored event.
- `resume` refuses a chat with a live execution, and `send` refuses one without (both 409, with a
  sentence the page can show). Attachments are resolved before anything is written, so a bad upload
  id fails the request (404) and never half-sends a turn (`chats.ts:687`, `resolveAttachments`).
- With `keepAlive` on, Codex queues turns sent while one runs and starts them in order. Its interrupt
  waits for the turn id before calling `turn/interrupt` (`codex/session.ts:254-269`).
- The Claude interrupt is a documented control request (`subtype: 'interrupt'`). The CLI answers it
  between turns too, so sending it when the chat looks idle is safe. Only Agentry's own status gate
  is wrong (S-1).

## Not covered

- The real CLI was not run (the project's rule for tests). What the CLI does with a queued message at
  EOF, and whether its stream-json stdout reports an absorbed message without
  `--replay-user-messages`, are not confirmed here. The queue behaviour above comes from its
  transcripts.
- The web client's handling of the 409 from `POST /messages` and of the queued cards is the client
  report's subject.

Related: [[providers.md]], [[chat-environment.md]], [[status.md]]
