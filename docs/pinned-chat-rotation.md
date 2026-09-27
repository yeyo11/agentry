---
created_at: 2026-09-27T11:30:00Z
updated_at: 2026-09-27T11:30:00Z
tags:
    - accounts
    - rotation
    - claude-swap
    - decision
    - fix
---
# A pinned chat that hits its limit leaves its account

A chat can be pinned to one claude-swap account (`account` on a new chat, a resume or a fork). A
pinned chat runs through `cswap run <account> --share-history -- claude …`, or plain `claude` when
that account is the active one, so it ignores the active credential.

## The bug

With `rotateOnLimit`, a run that dies against its limit is rotated and its turn replayed
(`rotateAndResume` in `packages/core/src/index.ts`). For a pinned chat the rotation moved the
**active** credential, which the chat does not use, and the replay respawned it on the account
that had just run out. And when the active account already had headroom, `cswap switch` answered
`below-threshold`: the chat got "no account with quota left", while another account had 98 % left.
The user saw "You've hit your session limit" on every message, with no way out but waiting for
the reset. The API could not remove a pin either: `account` only accepted a string.

## The decision

A pin says "run on this account", not "run on it even when it is out". When a pinned chat hits its
limit, `AccountManager.rotatePinned` handles it:

1. The pinned account is set aside for a while (the same `exhausted` set a policy uses).
2. The chat is offered where it would run with no pin: its project's (or the loose chats') policy's
   pick, or the active credential.
3. If that is the account it was pinned to (it is the active one), the global rotation
   (`cswap switch --strategy best`) moves the credential. It is the only case that switches.
4. On a switch, the runtime drops the pin (`unpin`) before the replay, so the chat follows the
   rotation from then on. A policy with no account left reports `no-switch`, as for unpinned chats.

The move is recorded in the rotation log as `rotate` with reason `pinned account exhausted`, and
the chat gets the usual "switched to … and resuming" notice.

To remove a pin by hand, resume or fork the chat with `account: null`.

Related: [[managed-claude-swap]], [[post-roadmap]] (rotation policies and loose chats).
