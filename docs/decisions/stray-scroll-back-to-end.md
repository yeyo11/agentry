---
created_at: 2026-10-09T12:00:00Z
updated_at: 2026-10-09T12:00:00Z
tags:
    - decision
    - chat
    - transcript
    - scrolling
    - e2e
    - flaky
---
# Decision: a scroll up that is not the reader's is taken back to the end

A chat's transcript follows its end until the reader scrolls up (`useStickToBottom`, in
`packages/chat-ui/src/composer/stick-to-bottom.ts`). Only the reader lets go of the end: a scroll
counts as theirs when it comes within 1.2 s of their wheel, key, pointer or finger.

Until 2026-10-09 the hook put the view back at the end only when something in the scroller changed
size (a `ResizeObserver` and a `MutationObserver` on its children). A scroll up that was *not* the
reader's was ignored: it did not let go of the end, and nothing brought the view back either. When
every row on screen was already measured, nothing resized afterwards, and the chat stayed short of
its end for good, still "following", so with no "Jump to latest" button to get back.

## The decision

While the end is followed, a scroll up that does not follow the reader's input is undone at once:
`onScroll` calls the same pin a resize does. The rule is the pure function `scrollVerdict`, tested in
`packages/chat-ui/test/stick-to-bottom.test.ts`:

| The scroll | Verdict |
| --- | --- |
| up, by the reader, away from the end | let go of the end |
| down, ending near the end | follow it again |
| up, not by the reader, while following | back to the end |
| up, by the reader, still near the end | nothing (a scrollbar drag must not be fought) |

What can scroll the view on its own: the windowed list re-anchoring when a page of rows is swapped
for another (a chat that grew past what was held), the browser's own scroll anchoring, and a smooth
glide cut short.

## Why: paging-held in CI

`e2e/specs/paging-held.spec.mjs` failed once in CI (2026-10-07, shard 2 of 4, commit `f7ce38388`):
after the chat grew by 300 entries behind the reader's back, the view did not reach its end within
20 s. It was never reproduced locally: 3 runs in CI's shard order, 3 more under ten busy loops on 12
cores, and a 12-iteration loop of the growth step all passed. What was reproduced is the state the
failure needs. In a 400-entry chat at its end, `scrollTop -= 40` (or 150, or 600) with no input left
the view short of the end 2.5 s later, with no button back. With the fix it returns at once, and
`paging-held` now checks that.

Ruled out as the cause: state left by the earlier specs in the shard (`mobile.spec` puts the
viewport back to 1440 × 900; the theme and the changes review keys are removed; the inspector is
open by default and none of them closes it), a stored scroll position (there is none: the chat
page remounts and starts following), and the `@tanstack/virtual-core` version (3.17.11 in CI and now).

## For specs

A spec that scrolls a transcript up by setting `scrollTop` is a reader, and has to say so: it
dispatches a `wheel` with a negative `deltaY` first, as `paging.spec.mjs` and `paging-held.spec.mjs`
do. Otherwise the scroll is taken back to the end.

## Related

[[plans/paging-long-tasks.md]] · [[phone-layout.md]] · [[plans/web-packages.md]]
