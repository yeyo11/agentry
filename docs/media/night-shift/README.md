# Night Shift: before and after

Pairs of the main screens before and after the [Night Shift redesign](../../plans/redesign-night-shift.md),
for the docs task and the pull request. Names are `<screen>-<desktop|phone>-<dark|light>-<before|after>.webp`.

- **Desktop** is 1440 × 1024 and **phone** is 390 × 844, in Spanish, with `motion=full`.
- **Before** is the UI of Agentry 0.17.1, the installed release before the redesign. **After** is
  the `worktree-e9acede9-consistency` branch with every redesign task merged.
- Both ran against the same isolated sandbox that `scripts/record-media.mjs` builds: the fake CLI,
  a stub claude-swap with three accounts, three imported projects and six chats. One chat and one
  orchestration (`invoices`) keep working the whole time. There is also a finished orchestration,
  one stopped by hand, and three schedules. `chats-empty` comes from a second sandbox with nothing
  seeded.
- Every figure, name and path in frame is invented.
