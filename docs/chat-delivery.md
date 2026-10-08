---
created_at: 2026-10-08T18:00:00Z
updated_at: 2026-10-08T18:00:00Z
tags:
    - chats
    - providers
    - api
    - decision
---
# Chat delivery: every message tracked by id

How a message a person (or Agentry, as a hint) sends to a chat is identified, sent, held, delivered
or reported undelivered. Built for CW-37 from the fix plan of the chat message audit
([reports/chat-audit/README.md](reports/chat-audit/README.md)). Before it, nothing said which message
the agent had read, so the page guessed from the words and a clock, and both symptoms of the audit
followed from the guesses.

## The id

- Every message has an id, a UUID. The page chooses it (`POST /chats/:id/messages` with `id`) and
  sends it again unchanged when it retries the same words and files after a failure, so a send that
  timed out after the server took it reaches the agent once: a second request with an id already
  taken writes nothing and answers as the first did (`message.duplicate: true`). Without one the
  server picks an id. The page builds it with `crypto.getRandomValues`, since `randomUUID` exists only
  in a secure context and the app is often opened over plain http on the local network.
- The id is the message's everywhere: the `uuid` of the entry the server streams for it, the id the
  agent is given, and the id its transcript keeps.

## Sending, per provider

- **Claude Code.** The id goes as the stream-json `uuid` of the stdin line, and the CLI runs with
  `--replay-user-messages`. The CLI reads each message back (`isReplay: true`, same `uuid`) the moment
  it takes it: when its turn starts, or right after the tool result at which it absorbs it into the
  running turn. The transcript keeps the id: the message's `user` line has it, and a message read
  mid-turn, which the CLI writes only as an `attachment` line of type `queued_command`, carries it as
  `source_uuid`; the transcript reader turns that line into the person's entry under that id. When an
  interrupt merges several queued messages into one prompt, each is read back, and the merged line
  takes the last one's id. All of it was confirmed on CLI 2.1.288
  ([reports/chat-audit/server.md](reports/chat-audit/server.md), "Confirmed on the CLI").
- **Codex and ACP** (Gemini, Copilot, OpenCode). The driver queues turns itself and reports a message
  taken when it starts its turn (`turn/start`, `session/prompt`). While it holds a turn the chat's
  input is not ended, even for a `keepAlive: false` chat (`DriverSession.holdsTurns`). For Gemini and
  Copilot, whose transcript Agentry keeps in `chat_entries`, the person's own entry is recorded there
  under the id.

## What the server keeps

`LiveChat.pending` holds every message the agent has not taken, in the order sent:

- `written`: in the agent's own queue. It leaves the list when the driver reports it taken (the
  `delivered` driver event).
- `held`: it arrived while the process was on its way out (stopped, its stdin closed, messages
  already held, or exited with its pipes still open). It is streamed at once, and the one process
  that replaces the old one gets every held message, in order. A send that has to start a process
  goes through the concurrent-run limit.

The chat lists them as `pending` (`GET /chats/:id`), with the messages lost since (`undelivered`, with
a reason), until the person sends again. They are written with the chat's record, so a restart turns
whatever was pending into `undelivered` ("Agentry restarted before the agent read it").

A CLI that never reads a message back (an old one, or a test double) is found out at its first
result: from then on what is written to it is not followed, as before this change.

## What the page hears

- The POST answers with the chat and `message: { id, taken }`. `taken` is `written` (into the running
  turn), `started` (it starts a turn now) or `held`.
- The chat's stream carries one `delivery` event per message: `delivered` when the agent takes it,
  `undelivered` with the message when it is lost (stop, crash, a refused respawn), `carried` when a
  move or a limit replay sends it on. A merged prompt yields one `delivered` per id it holds.
- The status stays `busy` while the agent has messages of ours to read, so a chat working on a queued
  message never reads idle.

## The page

- A message the server answered `written` or `held` is a card over the composer, keyed by chat and
  id, with its files. It clears on `delivered` or `carried`, when the transcript holds an entry with
  its id, or when a read made well after it no longer lists it as pending. It turns lost only on
  `undelivered`, and Restore hands back its words and its files. There is no clock.
- A reload rebuilds the cards from `chat.pending`.
- "Send now" is `POST /chats/:id/interrupt` with the `messageId` of the oldest card still waiting.
  The server interrupts only while that message is in the agent's queue, and answers 409 once the
  agent has read it, so it never cuts the turn that is answering the message. It is one button in the
  card's foot rather than one per card: ending the turn has the agent read everything that waits.
- The streamed copy of a message is confirmed by id, or by its words against the part of a read the
  page had not confirmed yet, once (a merged prompt confirms the run of messages it was made of). An
  unconfirmed message keeps its place in the conversation instead of sinking under the answers, and
  is never dropped by a clock.
- The composer clears only the words and files that were sent: what was typed or attached while the
  request was out stays in the box.

## Edge cases the server handles

- `interrupt` reaches the CLI whenever a process is up, whatever the status says, and answers at once
  when the process's input is already closed.
- An ACP interrupt that times out fails the turn, and the next prompt waits for the agent's late reply
  instead of running beside it; each prompt is numbered, so a reply ends only its own turn.
- A limit replay sends the turn that died again: its first message and every message written during
  it, the ones still pending under their own ids.
- Sends to one chat are serialized, so two quick ones reach the agent in the order sent.

Related: [[providers.md]], [[reports/chat-audit/README.md]], [[reports/chat-audit/server.md]],
[[reports/chat-audit/client.md]], [[design-system.md]]
