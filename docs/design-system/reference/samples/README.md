# Sample diffs

The raw `git diff` output behind the prototypes of the **Changes** section: a worktree branch
(`agentry/b67aa3`) that adds `?context=` to the per-file diff. The prototypes draw these exact
diffs, so they are the fixtures for `lib/diff.ts`: `git.ts.diff` has three hunks, five change
blocks and gaps of 21 and 19 unchanged lines between its hunks; the file has 70 lines.

| File | Scope |
|---|---|
| `git.ts.diff` | committed |
| `types.ts.diff` | committed |
| `changes.ts.diff` | committed |
| `Changes.tsx.diff` | not committed yet (the working tree against the base) |
