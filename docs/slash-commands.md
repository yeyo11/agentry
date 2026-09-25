---
created_at: 2026-09-25T18:45:00Z
updated_at: 2026-09-25T18:45:00Z
tags:
    - chat
    - composer
    - slash-commands
    - decision
---
# Slash commands in the message box

Typing `/` as the first character of a message opens a list of the slash commands Claude Code offers
for that directory. It works in a chat's composer and on New chat.

## Where the list comes from

Agentry doesn't keep its own list. It uses `slash_commands` from the CLI's `init` event, which
Agentry already stores per directory (`EffectiveEnvironment`, `GET /environments`) and attaches to
each chat as `chat.environment`. So the list shows exactly what the CLI loaded: skills, plugin and
project commands, and the built-ins that `claude -p` accepts. An interactive-only command (say,
`/login`) is never offered and then refused.

- **A chat's composer** uses `chat.environment.slashCommands`, the latest environment of the chat's
  directory.
- **New chat** asks `GET /environments?cwd=…` for the directory it will start in (the chosen one,
  or the wrapper's workspace).

A directory where no chat has started yet has no environment, so no list appears there; the command
typed by hand still works.

A name that also appears in the environment's `skills` gets a `skill` hint.

## How the list behaves

The logic is in `apps/web/src/lib/slash-commands.ts`, and the popover and its keys in
`apps/web/src/components/SlashMenu.tsx`.

- It opens only while the caret is in a first word that starts with `/`. A `/` later in a
  message is just text.
- Names that start with what was typed come first, then names that only contain it (`debug`
  finds `engineering:debug`). The list shows 50 at most.
- The arrow keys move through the list, and Tab or Enter picks. Picking replaces the first word
  with `/name ` and keeps anything written after it.
- Enter on a command already typed in full is left to the box, so it sends as before.
- Escape closes the list until the text changes.
- Focus never leaves the textarea, which points at the list with `aria-controls` and
  `aria-activedescendant`.

The popover reuses the `menu` and `menu-item` classes, plus `slash-menu`, which sets a minimum
width, 44 px rows on touch screens and mono names.

## Related fix

A slash command's output only shows once `normalizeMessage` reads the `system`/`local_command`
line newer CLIs write for it (PR #98).
