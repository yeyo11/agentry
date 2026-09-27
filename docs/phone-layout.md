---
created_at: 2026-09-27T18:00:00Z
updated_at: 2026-09-27T18:00:00Z
tags:
    - web
    - mobile
    - ios
    - design-system
    - decision
---
# The phone layout: keyboard, FAB and the end of a page

How the web UI behaves on a phone around the on-screen keyboard, the floating button and the bottom
of a page, and why. Checked on an iPhone (Brave, WebKit) against the dev server.

## The iOS keyboard

The shell is exactly the screen (`100dvh`) and scrolls inside `.main` or the chat's `.run-scroll`,
because the windowed transcript needs a real viewport to measure ([[plans/ui-redesign.md]]).
Android honours `interactive-widget=resizes-content` and shrinks the page for its keyboard. iOS
ignores it: every browser there lays the keyboard over the page and scrolls the window to reveal
the focused field. No component library changes that (Radix, under `components/controls`, handles
component behaviour, not the page's layout), so `lib/viewport.ts` measures the keyboard:

- **The inset** is `innerHeight − visualViewport.height × scale`, over 80 px, and only while a field
  that takes typing has the focus. The focus rule is what makes it reliable: iOS may send its last
  resize halfway through the keyboard's closing slide, and a keyboard cannot be up without a
  focused field anyway.
- **While it is up**, `--keyboard-inset` shortens the shell and `data-keyboard="open"` on `<html>`
  drops what the keyboard covers: the home indicator's inset, the tab bar, the FAB and the room kept
  under the composer. Without that, iOS scrolled a focused field that far above the keyboard.
- **When it closes**, the scroll iOS made to reveal the field is undone, at once and again through
  the slide (120, 350 and 700 ms after the field lets go of the focus). Before, the page stayed
  scrolled: the top bar off screen and an empty band where the keyboard was.
- Nothing is undone while the page is pinch-zoomed, nor where no keyboard was measured (Android,
  where that scroll is the browser keeping the field in view).

If this ever needs replacing, the alternative is a phone layout where the document scrolls, with
the bars and the composer sticky, so iOS handles the keyboard itself. It is a large change, mostly
for the chat's stick-to-bottom scrolling, and was left for its own branch.

## The FAB

- The same round "+" on Home, Chats, Projects and Orchestrations, named by `aria-label`. The
  labelled "New chat" variant on Home is gone: it read as a different control.
- It hides while the page scrolls down and comes back on scrolling up or near the top, as floating
  buttons do on iOS and Android. So the page keeps no room for it at its end: `.main` only keeps the
  tab bar's height. Keeping 72 px for it left an empty band at the end of every page that had one.
- It steps aside (`<FabStandIn />`) where the page already offers what it starts: an empty list
  whose own primary action is New chat or New orchestration, the new orchestration form while it
  is open, and a Home where nothing can start (offline, no CLI, no credential).

## Related

[[persistent-filters.md]] · [[design-system.md]] · [[plans/mobile.md]]
