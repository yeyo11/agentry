# Changes review: before and after

Screens of the [changes review](../../plans/changes-review.md) as the `consistency` task left them,
for the docs task and the pull request.

- **Desktop** is 1440 × 1024 and **phone** is 390 × 844, in Spanish, `motion=full` unless the name
  says `subtle`.
- **`-before` / `-after` pairs** are the screens the consistency pass changed. Before is the
  `worktree-0b7c31d9-consistency` branch at `f593881` (every earlier task merged), after is the
  same branch with the consistency fixes. Names are `<screen>-<desktop|phone>-<dark|light>-<before|after>.webp`.
- **Single files** (`<screen>-<desktop|phone>-<dark|light>.webp`) are the screens it compared
  against the reference and left alone.
- They ran against one isolated sandbox with the fake CLI, nothing live:
  - a worktree chat (`agentry/b67aa3`, three commits and two files not committed) built from this
    repository's own history: `git.ts`, `changes.ts`, `types.ts` and `chats.ts` before and after
    the `api` task, `diff.ts` added, `editor.ts` deleted, and seven edits in its transcript;
  - an orchestration (`shop-pricing`) with two task branches merged into an integration branch;
  - a chat outside git that wrote and edited two files;
  - a chat whose branch rewrites a generated file of 20 000 lines, a change every fourth line.

| Pair | What changed |
| --- | --- |
| `review-large-diff-desktop` | The 20 000-line diff drew no rows at all; it now draws them and scrolls at 17–33 ms a frame. |
| `summary-inspector-desktop` | The edit chips sit on the step's line, as in `DesktopChatCambios`. |
| `summary-integration-card-desktop`, `summary-task-panel-desktop` | "Review the changes" is a plain button there: the page already spends its gradient on relaunching and the pull request. |
| `review-reading-desktop`, `review-file-phone` | The why line shows Claude's backticks as code, in the language's quotes. |
| `review-steps-desktop`, `review-steps-phone` | A step's patch starts at its change, without an "N unchanged lines" row above it. |

Not in a picture: the file map's legend no longer animates its spinner when nothing is live
(compare `review-reading-desktop-dark-after` with `review-reading-desktop-subtle`).
