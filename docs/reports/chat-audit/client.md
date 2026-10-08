---
title: Chat audit — the browser side of sending
tags: [audit, chat, composer, queue, stream]
---

# Chat audit — the browser side of sending

Audit of every path a message takes in the browser, from the composer to the server and back into
the transcript, on `main` at 0.36.0 (`359e59fd5`). No product code was changed. File references
are to that commit.

Reproduction tests: `apps/web/test/chat-audit-client.test.ts`. Each test asserts the right
behaviour and is marked `{ todo: 'C-n' }`, so it fails today and the suite stays green until the
finding is fixed. All four reproduce (`# todo 4`).

## The CLI's own record of a message, measured

The findings below depend on what the CLI writes when a message reaches it, so it was measured on
this machine's real transcripts (read-only, `~/.claude/projects`, CLI 2.1.286). A message written to
the CLI's stdin while a turn runs is put in the CLI's input queue (`queue-operation enqueue`). It
then leaves the queue in one of two ways:

| How it left the queue | What the transcript gets | Count |
| --- | --- | --- |
| `dequeue`: read as a new turn once the turn ended (or was interrupted) | a `user` line with the text | 1,968 |
| `remove`: read **inside the running turn**, beside the next tool result | only an `attachment` line, `attachment.type: "queued_command"`, `prompt: <text>`; **no `user` line** | 272 of 282 |

The `remove` path is how the CLI now delivers mid-turn messages: the line's `rendered` content is a
system reminder that starts "The user sent a new message while you were working … Address the
message above as you continue this turn". Agentry's transcript reader drops every `attachment` line
(`packages/shared/src/normalize.ts:72`: `if (o.type !== 'user' && o.type !== 'assistant') return null`),
so a message read this way is never in any read of the transcript. In 15 transcripts a message
waited while the turn was interrupted; every one of them left the queue by `dequeue` and became the
next turn, so ending the turn does make the CLI read a waiting message.

---

## C-1 — A message read mid-turn never reaches the transcript, and the page calls it lost

- **Severity:** blocker
- **Symptom:** a message sent while Claude works shows as a queued card; Claude reads it and acts on
  it, but the card never clears. When the turn ends, 8 s later the card turns into "the chat never
  read it" and offers to put the words back in the box. Sending them again makes Claude read the
  message twice. After a reload (or 10 minutes, see C-7) there is no trace of the message anywhere:
  the conversation shows Claude answering something nobody said.
- **Root cause:**
  - The CLI records a message read inside the running turn only as a `queued_command` attachment
    line (measured above); `normalizeMessage` returns `null` for it
    (`packages/shared/src/normalize.ts:72`), so `GET /chats/:id` never returns an entry for it.
    *The fix is on the shared/server side; it is reported here because every client symptom below
    follows from it.*
  - The card clears only when "the transcript holds it": a non-streamed `user` entry with the same
    text after the anchor (`packages/chat-ui/src/composer/queued.ts:38`, `:55-61`). No such entry
    ever comes.
  - Once the chat is not `working`, every card still held is marked `undelivered` after
    `LOST_AFTER_MS` (`queued.ts:68-72`), and the card offers Restore
    (`apps/web/src/pages/ChatView.tsx:402-416`).
  - The wrapper's own streamed copy of the message (`packages/core/src/chats.ts:1056-1078`) is hidden
    while the card exists (`queued.ts:79-82`, `ChatView.tsx:91`) and, once the card is gone, sinks
    under later entries and disappears (C-7).
- **Sequence:**
  1. The chat is `working`, running a tool. The person sends "also run lint".
  2. `POST /chats/:id/messages` → `writeUserMessage` writes it to stdin and streams a `user` entry
     under a random uuid. The composer's `onSent` adds a card (`ChatView.tsx:448`).
  3. The tool finishes; the CLI hands the queued message to the model with the tool result and
     writes `attachment/queued_command`. Claude answers it within the same turn.
  4. Every tail read (`packages/chat-ui/src/lib/chats.ts:158-165`) returns the assistant entries
     and no `user` entry for the message. The card stays as "waiting".
  5. The turn ends → `working` goes false → 8 s later the card says the chat never read it.
- **Reproduce:** test `C-1: the line the CLI writes for a message it read mid-turn is an entry of the
  transcript` (shape copied from a real line). By hand: start a chat with "run `sleep 20` then say
  done", send "and then list the files" while the sleep runs; Claude lists the files, the card goes
  to "never read" after the turn, and a reload shows no message.
- **Proposed fix:** read `attachment` lines whose `attachment.type` is `queued_command` (and
  `commandMode` is `prompt`) as `user` entries carrying `attachment.prompt`, with the line's uuid and
  timestamp, in `normalizeMessage` or the transcript reader. Then the card clears through the normal
  path, the page shows the message where Claude read it, and C-7 stops happening for it.

## C-2 — "Send now" interrupts the turn that is already answering the message

- **Severity:** major
- **Symptom:** the person presses "Send now" on a queued card; the answer to that very message is cut
  off ("Request interrupted by user"), or Claude stops halfway through work it had just started on
  it.
- **Root cause:** "Send now" is a plain `POST /interrupt` (`ChatView.tsx:422-427` →
  `ChatView.tsx:162-165`). The server interrupts whatever turn is running when it lands
  (`packages/core/src/chats.ts:772-785`; it only skips when the status is not `busy`/`starting`,
  `:776`). The button is shown as long as the card is, and the card does not know whether the
  message has been read:
  - With mid-turn delivery (C-1) the running turn *is* the one answering the message for the rest
    of the turn; the button interrupts it.
  - With `dequeue` delivery, between the CLI starting the new turn with the message and the next tail
    read clearing the card (`CONFIRM_AFTER_MS` 1 s plus the read, `chats.ts:189-191`), the button
    still offers "Send now", and a click interrupts the turn that just started on the message.
  - A second click (or the composer's Stop next to it) whose request lands after the first interrupt
    let the CLI dequeue the message does the same: the status is `busy` again.
- **Sequence:** card shown → CLI starts turn 2 with the message → person clicks "Send now" (card not
  yet cleared) → `chats.interrupt` sees `busy` → turn 2 is interrupted with no answer.
- **Reproduce:** by hand, as in C-1: send a message during a tool call and press "Send now" after
  the tool call returns; the turn answering the message is interrupted.
- **Proposed fix:** make "Send now" interrupt only the turn the message was queued behind: send a
  turn token (the execution's turn count, or the seq of the last `result`) with the request, and have
  the server refuse when a newer turn has started or when the CLI already removed the message from
  its queue (the stream can carry `queue-operation` facts). Hide the button once the stream shows the
  message was read.

## C-3 — A message with files never matches its card: shown twice, then called lost

- **Severity:** major
- **Symptom:** a message with text and an attachment sent while Claude works shows twice (a row in
  the conversation and the card). The card never clears; after the turn it says the chat never read
  it, and Restore puts the words back **without the files**. Sending again delivers the text twice and
  the files once.
- **Root cause:** the card holds the trimmed typed text (`queued.ts:47`). What the stream and the
  transcript hold is the text the CLI received, which `composeContent` builds as
  `text + "\n\n<attached-files>…</attached-files>"` (`packages/core/src/uploads.ts:97-110`, returned
  as `shown` by `providers/claude-code/driver.ts:51-56`, streamed by `chats.ts:1060-1077`). Both
  comparisons are exact equality on the text (`queued.ts:60` for delivery, `queued.ts:80` for hiding
  the streamed copy), so neither ever matches. Restore hands back `message.text` only
  (`ChatView.tsx:409`); the attachment ids are not kept on the card.
- **Sequence:** working chat → attach a file, type "look at this", send → stream appends a user entry
  "look at this\n\n<attached-files>…" which `pending()` does not hide → row and card both shown →
  turn ends, CLI writes the same text → no match → 8 s → "never read".
- **Reproduce:** by hand, in any working chat, as above.
- **Proposed fix:** match on what the server says it delivered, not on typed text: have
  `POST /messages` return the streamed entry's uuid (or the `shown` text) and keep that on the card;
  failing that, compare the text with the `<attached-files>` block stripped (the regex already lives
  in `components/Attachments.tsx:23`). Keep the attachment ids on the card so Restore hands them back.

## C-4 — Queued cards and restored words leak into the next chat

- **Severity:** major
- **Symptom:** after moving from one chat to another (sidebar, a link, the phone's Chats tab), the
  cards of the first chat appear over the second chat's composer; 8 s later they turn "never read".
  "Send now" on them interrupts the *second* chat. Words restored in the first chat are typed again
  into the second chat's box when it mounts.
- **Root cause:** the route renders `<ChatView />` without a key (`apps/web/src/App.tsx:341`), so the
  same component instance serves every `/chats/:id`. `useQueuedMessages` keeps its `queued` state
  (`queued.ts:43`) and `ChatView` its `restore` state (`ChatView.tsx:89`) across ids. The card's
  anchor is not in the new chat's entries, so it searches the whole new transcript
  (`queued.ts:56`); the lost timer starts from the new chat's state (`queued.ts:68-72`); "Send now"
  calls `interruptChat()` bound to the current `id` (`ChatView.tsx:162-165`, `:424`). The composer
  *is* keyed by chat (`ChatView.tsx:441`), so the new one mounts with `restoredAt.current = 0` and
  applies the stale `restore` (`packages/chat-ui/src/composer/Composer.tsx:186-192`).
- **Sequence:** chat A working, card queued → open chat B (working) → A's card shows over B →
  "Send now" → `POST /chats/B/interrupt`.
  Or: in A, Restore a lost card → open B → B's box contains A's words.
- **Reproduce:** by hand, as above.
- **Proposed fix:** key the page by chat (`<ChatView key={id} />`, or a keyed inner component), or
  keep queued cards and `restore` in a map by chat id. Either way the card should carry its chat id
  and "Send now" should interrupt that chat.

## C-5 — Words typed while a message is being sent are erased

- **Severity:** major
- **Symptom:** the person sends a message and keeps typing the next one while the button says
  "Sending…"/"Resuming…"; when the request comes back, everything typed meanwhile disappears. Files
  pasted or dropped meanwhile disappear too, and were never sent.
- **Root cause:** the box stays editable during the request; `onSuccess` calls `setText('')` and
  `files.clear()` unconditionally (`Composer.tsx:174-178`). Only the attach button is disabled while
  pending (`Composer.tsx:246`); paste (`:250`) and drop (`:235`) still add files, and `files.ids` was
  read when the request started (`:168`). A resume or fork POST spawns a process
  (`kind !== 'send'`, `Composer.tsx:170-172`) and takes seconds.
- **Sequence:** type "A", Enter → `submit.mutate('A')` → type "B" (or paste an image) → response →
  text and files cleared → "B" is gone.
- **Reproduce:** by hand on a resumable chat (the resume request is the slow one): send, type at once.
- **Proposed fix:** clear only what was sent: in `onSuccess`, remove the sent text from the start of
  the box if it is still there (or snapshot the text at send time and clear only when unchanged), and
  remove only the attachment ids that were in the request.

## C-6 — A message just sent vanishes when the same words were said recently

- **Severity:** major
- **Symptom:** the person sends "ok" (or "yes", "continue", "sí") while the chat works; it shows and
  then disappears from the conversation at the next read, though nothing confirmed it. If Claude reads
  it mid-turn (C-1) it never comes back.
- **Root cause:** `spliceTail` counts a streamed user entry as read back when *any* user entry in the
  read tail (up to `TAIL_READ` = 50 entries) has the same text
  (`packages/chat-ui/src/lib/chat-stream.ts:393`, `:396`). An earlier message with the same words
  confirms the new one, which is then dropped (`:399-401`). The same text-only test hides it in the
  card code (`queued.ts:80`) and clears cards (C-10).
- **Sequence:** the transcript holds a user "ok" from a minute ago → the person sends "ok" → stream
  appends it → a tail read before the CLI writes it (it writes it only at the next turn, or never if
  read mid-turn) → `said.has('ok')` → dropped.
- **Reproduce:** test `C-6: a message just sent is not taken for an earlier one with the same words`.
- **Proposed fix:** match by text only against user entries of the read that are *after* the last
  entry the page already had confirmed (the read's new part), and consume each match once, so one
  transcript line confirms at most one streamed message.

## C-7 — A streamed message no read confirms sinks under later entries, then disappears

- **Severity:** major
- **Symptom:** a message sent while the chat works (with no card, see C-8, or after its card was
  dropped) moves to the bottom of the conversation, under Claude's answers to it, and stays stuck at
  the bottom as the conversation grows; ten minutes later, or at the first full re-read, it disappears.
- **Root cause:** in `spliceTail` the streamed entries a read does not confirm are kept as `late` and
  placed **after** every entry the read returned (`chat-stream.ts:395-403`), not where they were.
  They are kept only for `SENT_GRACE_MS` = 10 min (`:319`, `:398-399`); after that they are deleted. A
  read that cannot be spliced (the chat grew by more than 50 entries since the page was read, or the
  overlap disagrees) is replaced by a whole page (`packages/chat-ui/src/lib/chats.ts:160`, `:164`),
  which drops every streamed entry at once. With C-1, the message is never in a read, so it always
  ends this way.
- **Sequence:** page `[a]` → stream appends user U, then answers A1, A2 → tail read returns
  `[a, A1, A2]` (no U: read mid-turn) → page becomes `[a, A1, A2, U]` → each later read keeps U at
  the end → 10 min later (or a burst of > 50 entries, or a reconnect that forces a whole page) → U is
  gone.
- **Reproduce:** tests `C-7: a sent message no read confirms keeps its place instead of sinking below
  the answers` and `C-7: a sent message no read confirms is still on the page ten minutes later`.
- **Proposed fix:** keep an unconfirmed entry at its index relative to the confirmed entry before it
  (insert it after that entry's position in the read), instead of appending it. Fixing C-1 removes
  the main source of unconfirmable messages; the grace window can then stay as a safety net.

## C-8 — Whether a message gets a card is guessed from the cached chat state

- **Severity:** major
- **Symptom:** a message sent while Claude waits on a permission prompt, or while the page's idea of
  the chat lags behind the server, gets no card: it shows as a row (C-7) and never warns if it is
  lost. A message sent while the process is exiting is held by the server, shown nowhere, and, if the
  replacement process fails to start, lost without a word.
- **Root cause:** the card is added only when `composer === 'send' && working`, where `working` is
  `chat.state === 'working'` from the cached page at the moment the POST returns
  (`ChatView.tsx:448`, `:275`). The CLI queues a message during any running turn, including one
  `waiting` on a permission (the turn is not over). The POST answer does not say what happened to the
  message: `writeUserMessage` always sets `busy` (`packages/core/src/chats.ts:1078`), and a message the
  server holds in `chat.queued` (stop requested, stdin ended, respawn queued, `chats.ts:684-698`) gets
  the same answer with no stream echo; if the respawn fails, `drainQueue` fails the chat and the
  message "is lost" (`chats.ts:711-720`) with nothing on the page that it ever existed.
- **Sequence (waiting):** Claude asks to run a command → state `waiting` → person types a message
  instead of answering → no card → message read mid-turn after the answer (C-1) → row sinks and
  vanishes (C-7).
- **Reproduce:** by hand, as above, in a chat whose permission mode asks.
- **Proposed fix:** have `POST /chats/:id/messages` answer how the message was taken (`written` into a
  running turn, `started` a turn, `held` for the next process) and the streamed entry's uuid; add the
  card from that answer, not from the cached state. A held message should stream a notice and, if it
  is dropped, an event the page can turn into a lost card.

## C-9 — A files-only card is cleared by the next tool result

- **Severity:** minor
- **Symptom:** a message with only a file, sent while Claude works, loses its card at the next tool
  call, while it is still waiting; if it is then lost (process stopped), nothing says so.
- **Root cause:** a card with no text counts as delivered by *any* non-streamed user entry after the
  anchor (`queued.ts:60`, `: true`), and `delivered()` (`queued.ts:38`) does not exclude entries that
  are only `tool_result` blocks (which are `user` entries) or a slash command's output (also `user`,
  `normalize.ts:99-110`).
- **Sequence:** working chat → send an image alone → the next tool result is read back → card gone.
- **Reproduce:** by hand.
- **Proposed fix:** count as delivered only user entries with at least one text, image or document
  block and no `tool_result`, and for a files-only card require the `<attached-files>` list (or the
  uuid from C-3's fix).

## C-10 — Matching by text clears the wrong card, or every card with those words

- **Severity:** minor
- **Symptom:** two queued messages with the same words both clear when the first is read; a queued
  message clears at once when its anchor left the page and the same words were said earlier.
- **Root cause:** each card is tested on its own against the same entries, so one transcript line
  clears every card with that text (`queued.ts:55-61`); `pending()` likewise hides every streamed
  copy with the text, including ones sent before the card (`queued.ts:79-82`). The anchor is the
  uuid of the page's last entry when the POST returned (`ChatView.tsx:448`); when that entry is
  replaced (the wrapper's streamed copy of an earlier message is replaced by the CLI's line, which has
  another uuid) or dropped by a whole-page read, `findIndex` returns −1 and the search starts at
  entry 0 (`queued.ts:56`), so any earlier message with the same words clears the card.
- **Sequence:** send "go on" while idle (streamed copy is the last entry) → while the turn runs send
  "go on" again → card anchored on the streamed copy → read replaces it with the CLI's line → anchor
  lost → the first "go on" clears the card while the second still waits.
- **Reproduce:** by hand.
- **Proposed fix:** consume matches: walk the cards in order and let each transcript entry clear one
  card at most; anchor on a transcript position (index + total) rather than an entry uuid that a
  read can replace.

## C-11 — A queued slash command never matches and is offered to run again

- **Severity:** minor
- **Symptom:** "/compact" (or any slash command) sent while Claude works stays as a card, turns
  "never read" after the turn, and Restore runs it a second time. The streamed "/compact" row also
  sits at the bottom beside the CLI's own record (C-7).
- **Root cause:** the CLI writes a command as
  `<command-name>/compact</command-name>\n<command-message>…</command-message>\n<command-args>…</command-args>`
  (measured in local transcripts), never as the typed "/compact"; the card and the splice compare the
  typed text (`queued.ts:60`, `chat-stream.ts:393`).
- **Reproduce:** by hand.
- **Proposed fix:** normalise a `<command-name>` line to `/<name> <args>` before comparing, in one
  helper that `queued.ts` and `spliceTail` share.

## C-12 — "Lost" is decided by a clock on the cached state, and is final

- **Severity:** minor
- **Symptom:** after "Send now", a message Claude is reading can be shown as "never read" if the page
  saw the chat idle for 8 s; once one card is lost, "Send now" disappears for every card.
- **Root cause:** the lost timer runs whenever the cached `chat.state` is not `working`
  (`queued.ts:68-72`). The cached state follows the event feed and, with it down, the fallback poll
  (`chats.ts:169-174`); an interrupt → idle → next turn sequence the page sees late can last 8 s on
  the page while the server was idle for milliseconds. `undelivered` is never set back (a delivered
  match still removes the card, but the Restore offer was shown meanwhile). The foot hides "Send now"
  when any card is undelivered (`ChatView.tsx:421-422`).
- **Reproduce:** by hand, with the event feed stopped (fallback polling): press "Send now".
- **Proposed fix:** decide "lost" from a server fact (the turn's `result` followed by the process
  ending, or a `queue-operation` the stream forwards) instead of a client timer, and keep "Send now"
  per card.

## C-13 — Nothing on a reloaded page says a message is waiting

- **Severity:** minor
- **Symptom:** after a reload, a phone that slept, or opening the chat on another device, a message
  still waiting in the CLI's queue is invisible: no card, no row. The person concludes it was lost
  and sends it again.
- **Root cause:** cards are React state only (`queued.ts:43`); the stream starts past every stored
  event (`chats.ts:329`, `since = MAX_SAFE_INTEGER` on first open), so the wrapper's echo of the
  message is not replayed, and the transcript has no line for it until the CLI dequeues it (or ever,
  C-1).
- **Reproduce:** send a message during a long tool call, reload.
- **Proposed fix:** have the server keep what it wrote into the running turn and has not seen the CLI
  read (it can follow the CLI's `queue-operation` lines, or keep the list until the next `result`),
  return it with the chat detail, and build the cards from it.

## C-14 — A send that timed out is offered again with no protection against duplicates

- **Severity:** minor
- **Symptom:** on a slow or flaky connection the box says "not sent" though the message reached
  Claude; sending again makes Claude read it twice.
- **Root cause:** every request times out at 120 s (`apps/web/src/api.ts:275`, `:311-325`), and a
  network error after the server accepted the POST looks the same as a refusal. The text is kept
  (good, `Composer.tsx:174` clears only on success), but `POST /chats/:id/messages` has no
  idempotency key (`api.ts:505`).
- **Reproduce:** by hand, with the network dropped right after pressing Send.
- **Proposed fix:** send a client-generated id with the message; the server ignores a repeat of an id
  it already wrote, and the page can recognise the streamed echo by it (which also fixes C-3, C-6,
  C-10 and C-11 at the root).

---

## Checked and found sound

- **Composer on failure:** the text and files stay when the POST fails or times out
  (`Composer.tsx:174-178` runs only on success) and the error is shown under the box (`:287`).
- **Double submit:** `send()` returns while `submit.isPending`, and the button is disabled; a second
  Enter needs a render in between, which TanStack's notify schedules within milliseconds.
- **Interrupt then read:** at CLI level an interrupt makes the CLI read the waiting message as the
  next turn (15 of 15 measured cases). Codex (`providers/codex/session.ts:156-205`, `:254-268`) and
  ACP (`providers/acp/session.ts:355-366`, `:444-455`) queue turns in the driver and pump the next
  one when a turn ends or is interrupted, so "Send now" reads the message there too (C-2 still
  applies to a late or second click).
- **Server queue order:** messages held for a replacement process keep their order
  (`core/chats.ts:684-720`).
- **Stream reconnect:** an EventSource the browser reopens sends `Last-Event-ID`, which the server
  prefers to `?since` (`apps/api/src/routes/chats.ts:215`); one recreated after `CLOSED` passes
  `lastSeq`; on reopen the page reads the transcript back (`chats.ts:331-344`). Subscribe-then-replay
  on the server avoids a gap. Events missed while the stream was down are covered by that read, except
  for what the transcript itself lacks (C-1, C-13).
- **Hidden tab and back/forward cache:** the stream is closed and reopened with a read
  (`chats.ts:364-395`).
- **Pagination merge:** `joinRun`/`joinToPage`/`trimRun` (`chat-pages.ts`) replace by index and never
  drop an entry of the newest page; a page read for another chat goes to that chat's slot
  (`chats.ts:92-99`). Covered by `apps/web/test/chat-pages.test.ts`.
- **Stream dedupe:** `appendStreamed` dedupes by uuid within the last 50 entries and skips a replay
  older than the page's end (`chat-stream.ts:359-372`); the wrapper's user entries carry fresh uuids,
  so they are never mistaken for a stored entry. The timestamp skip could drop a replayed user echo
  only if a read with later entries landed before the replay, which the reopen order makes unlikely.
- **React Query races:** the tail read takes `streamMark()` before it starts and keeps whatever the
  stream appended during the read (`chats.ts:161-164`, `chat-stream.ts:399`); a newer invalidation
  cancels the older read, so a stale read cannot overwrite a newer page.
- **Resume and fork:** a resume or fork is not queued (`ChatView.tsx:447-448`); its first message is
  the process's first turn and the CLI writes it as a `user` line.
- **New chat:** the prompt stays in the box until the chat is created (`NewChat.tsx:95-109`).
- **Phone layout:** the queued card's buttons are `.btn-small` and `.icon-btn`, which are 44 px
  under `(pointer: coarse)` (`packages/ui/src/styles/tokens.css:205-210`,
  `primitives.css:158`, `:184-185`); on an empty box the one round button stops the turn
  (`Composer.tsx:229`); sending blurs the box on a touch screen (`Composer.tsx:208`). The phone has
  no path of its own through the send code, so every finding above applies to it unchanged.

## Not covered

- The server's event buffer size and whether a long gap can outrun it (server audit).
- The orchestration "hint" path, which writes through the same `writeUserMessage` and so has C-1's
  transcript gap (the measured `queued_command` lines are hints), but has no composer or card.
