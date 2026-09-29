---
created_at: 2026-09-28T23:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - work-items
    - flow
    - git
    - pull-request
    - decision
    - plan
---
# CW-22 · An approved card opens its pull request, and a merged one reaches Done

**Status**: built (CW-22, see [As built](#as-built)). **Decision**: the owner's, 2026-09-28, option A.

## Why

Every card works on its own branch and worktree (`task/<key>`), cut from the project checkout's
HEAD ([work-items.md](../work-items.md#work-on-it)). `git push` is denied to every flow run
([team-and-flow.md](../team-and-flow.md#what-a-run-may-do)). QA's pass leaves the card in In review
with `waiting: 'approval'`, and moving it to Done merges nothing: "There is no automatic pull
request". With several cards running in parallel, nothing reaches `main` unless a person pushes and
opens each PR by hand. Branches never see each other's work, and new worktrees are cut from a
checkout that falls further behind `origin/main` after every merge.

## Decision

Option A (owner, 2026-09-28): **approving a card opens its pull request**. The person merges it on
GitHub as always (squash). **A merged PR moves the card to Done and brings the checkout forward.**

Rejected:

- **B**, a local merge queue: it changes `main` without a PR or CI.
- **C**, warnings only.

## The one rule, and who pushes

Everything goes through `git` and `gh`, both run by Agentry's core process **on the person's
request**, exactly as `Orchestrator.pullRequest()` (`packages/core/src/orchestrator.ts`) already
pushes an integration branch and runs `gh pr create`. No GitHub REST call from Agentry, no SDK, no
call to Anthropic.

**No flow run ever pushes.** `stageRules` in `packages/core/src/flow.ts` keeps `Bash(git push)` and
`Bash(git push *)` denied in every stage, and that includes the Developer run that resolves a
conflict. The push is Agentry's own, after the person approved.

## Terms

- **Default branch**: `git symbolic-ref --short refs/remotes/origin/HEAD` in the main checkout, with
  the `origin/` prefix dropped. When that ref is missing, it falls back to
  `gh repo view --json defaultBranchRef`.
- **Remote**: `origin`. Only GitHub, through `gh`. Other hosts get the reason `not-github`.
- **Main checkout**: `mainCheckout(projectPath)` in `packages/core/src/git.ts`.
- **Item worktree**: `itemWorktree()` in `packages/core/src/work-links.ts`.

## Readiness: can this project open a PR?

`pullRequestReadiness(project)` in core answers either `ready` or one reason. Every reason has a
code the web words in en/es, and the raw detail in mono:

| Code | When |
| --- | --- |
| `not-git` | The project is not a git repository. |
| `no-remote` | The project has no `origin` remote. |
| `not-github` | `origin` is not a GitHub host that `gh` knows. |
| `no-gh` | `gh` is not on the PATH. |
| `gh-unauthenticated` | `gh auth status --hostname <host>` fails. |
| `no-default-branch` | Neither way above finds the default branch. |

The answer is cached per project for 60 s. `gh auth status` must not run on every board read.

When the project is not ready, the approval does what it does today: the person moves the card to
Done. The card and the waiting panel say **why no PR is offered**, in the warn colour with its
words, and never fail silently.

## Approving: `POST /work-items/:itemId/pull-request`

**Who can call it.** The existing approval ("Aprobar y pasar a Hecho" on the card's strip
`WorkItemStrip.tsx` and in the waiting panel `pages/tasks/item/Waiting.tsx`) and a new explicit
**"Abrir PR"** both call this route. "Abrir PR" is on the item page and panel, for any item in
`in_review`, even with no flow. In a ready project, the approval becomes **"Aprobar y abrir PR"**,
and "Mover a Hecho" stays available as the person's manual way out.

**Refusals:**

| Answer | When |
| --- | --- |
| 400 | The item is an epic. |
| 409 | The item is not in `in_review`. |
| 409 | A chat or a flow run is working on the item. |
| 409 | The project is not ready. The body carries the reason code. |
| 409 | The branch has no commit ahead of the default branch and nothing uncommitted: nothing to propose. |
| 200 | An open PR already exists for the item. The route answers it and does nothing else (idempotent). |

**Otherwise it answers 202 at once** with the item, whose `pullRequest.phase` is `preparing`. The
work runs in the background, because a push can take minutes, and each step reaches the feed as
`workitem.updated` naming `pullRequest`. These are the steps:

1. **Commit what is left.** Uncommitted changes in the item's worktree are what QA verified. They
   are committed as `chore(<key>): keep the work QA verified`, as the orchestrator's fixer does with
   `commitAll`.
2. **Update the branch.** `git fetch origin <default>`, then `git merge --no-edit origin/<default>`
   in the item's worktree. Use a merge, not a rebase: the PR is squash-merged anyway, and the
   history already pushed stays valid.
3. **On a conflict**, see [Conflicts](#conflicts). Nothing is pushed.
4. **Push.** `git push -u origin task/<key>` (timeout 180 s).
5. **Open the PR.** `gh pr create --head task/<key> --base <default> --title … --body-file -`, with
   the body on stdin (no 128 KiB argument limit). The PR's number and URL are read back with
   `gh pr view task/<key> --json number,url,state`.
6. **Record it** on the item, with `phase: 'open'`, and set `waiting: 'merge'`. The item stays in
   `in_review`.

**A failure at any step** records `phase: 'failed'` with a code (`fetch`, `push`, `create`, or the
readiness codes) and git's or gh's first stderr line. It then leaves the item in `in_review`,
waiting for approval as before. Git or gh output is never shown raw as the only message.

### The PR's content

- **Title**: `<type>: <item title> (<KEY>)`, in Conventional Commits format, trimmed to 72
  characters before the key.
  - The type is the first item label that is a Conventional type (`feat`, `fix`, `docs`, `chore`,
    `refactor`, `perf`, `test`, `build`, `ci`).
  - Otherwise: `bug` → `fix`, and `story` or `task` → `feat`.
- **Body** (Markdown, headings in English, the item's own text as written), cut at 60,000 characters
  like the orchestrator's:
  1. the item's description;
  2. `## Acceptance criteria`: each criterion as `- [x]` or `- [ ]`, followed by QA's note from the
     item's newest passing `verify` flow run. An item with no such run lists the criteria with their
     checked state only;
  3. `## Work item`: the key and a link to the card, `<web origin>/tasks/<KEY>`, built from the
     origin Agentry serves its web UI on (the configured public URL when there is one).

## Conflicts

When step 2 leaves conflicted paths (`conflictedPaths()` in `git.ts`):

- **The merge stays in progress in the item's worktree**, markers included, so the Developer
  resolves the real conflict.
- The item gets `pullRequest.phase: 'conflict'` with the conflicting paths.
- The item moves to `in_progress` as the person's move (the approval was theirs), with the cause
  `pr.conflict`. The history names the files.
- **With the flow on and a Developer**, that move starts the Developer's `work` run as any move
  does. Its prompt adds one section, **"Resolve the merge of `<default>` into this branch"**, that
  lists every conflicting path and asks the Developer to resolve the conflicts and commit the merge.
  The Developer continues its own chat, as after a bounce. The rules stay the same, and `git push`
  stays denied.
- **When the Developer's run ends**, Agentry checks the worktree:
  - no conflicted path left and the merge still open: Agentry commits the merge (`commitAll`);
  - conflicts left: the run ends `failed` with the new cause `conflict-unresolved`, which the web
    words;
  - otherwise the run ends normally, and the item moves to `in_review` and QA verifies as usual.
- **The approval is remembered** (`pullRequest.phase: 'awaiting-verify'`). When QA passes that
  round, steps 2 to 6 run with no second click. A person's own move of the item in the meantime
  drops the remembered approval, because a person's move wins. A QA rejection bounces as usual, and
  used-up bounces wait for the person.
- **Without the flow or a Developer**, the item waits in `in_progress` with the conflict on its page.
  The person resolves it with "Trabajar en ella" and approves again.

## After the PR is open: the watcher

GitHub cannot push events to a local CLI, so this is the **one deliberate poll** in the work-item
automation. The docs say the automation never polls, and they must name this exception.

- `PullRequestWatcher` in core runs `gh pr view <number> --json state,mergedAt,statusCheckRollup,url`
  for each item whose PR is `open`.
- It runs every 60 s, on start (after the runtime restores its chats), and on demand through
  `POST /work-items/:itemId/pull-request/refresh`, which the item page calls when it opens.
- It checks one PR at a time. After a `gh` error it backs off to 5 min for that project.
- **CI state** comes from `statusCheckRollup`:
  - `none`: no checks;
  - `pending`: any check queued or in progress;
  - `failing`: any check failed, cancelled or timed out;
  - `passing`: all checks succeeded or were skipped.
  Only a change is written, as `workitem.updated`.
- Several wrapper processes share one database, so claiming a PR's check and writing its outcome use
  `BEGIN IMMEDIATE`, and the same merge is never handled twice.

### Merged

1. **The item moves to Done** from whatever column it is in, except Done itself. The actor is
   `person`, because the merge on GitHub was the person's act and decision 29 still holds. The cause
   is `pr.merged`, and the history carries the PR number and URL. `waiting` clears. The journal's
   `closed` entry follows as for any move to Done.
2. **Its worktree is removed.** Remove the lock (`git worktree unlock`), then `git worktree remove`,
   but only if the worktree has no uncommitted change. Otherwise it is kept, and the item says why.
   The local branch `task/<key>` is kept, so the item's Changes still read it by name.
3. **The checkout is brought forward.** Run `git fetch origin <default>` in the main checkout. Then,
   **only when it is on the default branch and has no staged or unstaged change to a tracked file**,
   run `git merge --ff-only origin/<default>`. Otherwise, or when the fast-forward fails (diverged),
   nothing is touched, and the reason is recorded.

### Closed without merging

- The PR is recorded with `state: 'closed'`, and the item stays in `in_review` with
  `waiting: 'approval'`.
- The card says "PR #N cerrada sin fusionar" and offers the approval again, which opens a new PR.
  The closed one stays in the item's history.

## The checkout's state on the board

`GET /projects/:id/work-items/board` gains `checkout`, computed from local git only (no fetch on
read):

```ts
checkout: {
  defaultBranch: string;
  branch: string | null;
  behind: number;
  reason: 'not-on-default' | 'dirty' | 'diverged' | null;
} | null
```

It is `null` for a project that is not ready.

When `behind > 0`, the board shows one quiet line under its toolbar, with the warn colour and its
words, for example:

> La copia de trabajo va 3 commits por detrás de origin/main: tiene cambios sin confirmar

It names the reason. It never offers a command to copy (design system: never hand out a command).

## Contract (`packages/shared/src/types.ts`)

```ts
type WorkItemPullRequestPhase = 'preparing' | 'conflict' | 'awaiting-verify' | 'open' | 'merged' | 'closed' | 'failed';
type WorkItemPullRequestCi = 'none' | 'pending' | 'passing' | 'failing';
interface WorkItemPullRequest {
  phase: WorkItemPullRequestPhase;
  number: number | null;
  url: string | null;
  branch: string;
  base: string;
  ci: WorkItemPullRequestCi | null;
  conflicts: string[];
  error: { code: string; detail: string } | null;
  openedAt: string | null;
  closedAt: string | null;
  checkedAt: string | null;
}
```

- `WorkItem.pullRequest: WorkItemPullRequest | null` is the item's newest PR.
- `WorkItemWaiting` gains `merge`.
- `FlowRunCause` gains `conflict-unresolved`.
- The history cause codes gain `pr.opened`, `pr.conflict`, `pr.merged` and `pr.closed`.
- `pullRequestReadiness` comes back as `WorkItemPage.pullRequestReadiness`, with the reason code or
  `ready`.

**Storage.** A PR is an accumulating record, so it goes in a SQLite table
`work_item_pull_requests`: one row per PR (item id, phase, number, url, branch, base, ci, conflicts
JSON, error, timestamps), added by one migration at the end of `MIGRATIONS` in
`packages/core/src/db.ts`. The item reads its newest row.

## Routes

| Method | Path | What |
| --- | --- | --- |
| `POST` | `/work-items/:itemId/pull-request` | Approve: update, push and open the item's PR (202; 200 when one is open) |
| `POST` | `/work-items/:itemId/pull-request/refresh` | Ask `gh` for the PR's state and CI now |

Each route needs a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in the README's
Work items table. Regenerate the OpenAPI schemas with
`pnpm --filter @agentry/api openapi:schemas`.

## Screens

There is no reference screen for a PR yet. The card follows `DesktopTableroEquipo` and
`MobileTablero` (the strip), and the item follows `DesktopTarea` and `MobileTarea` (the waiting
panel `.item-wait` and the properties). The new variant (the PR row and its CI badge) goes into
`docs/design-system.md` and `agentry-ds.css` in the same PR.

**The strip** (`workItemStrip()` in `apps/web/src/lib/work-items.ts`) gains the PR states. Each is
worded in en/es with the number in mono and tabular figures:

- "Preparando la PR";
- "Conflicto con main · 2 archivos";
- "PR #123 · esperando fusión", with the CI badge;
- "PR #123 cerrada sin fusionar";
- "No se pudo abrir la PR", with the reason.

**Status colours** mean one thing each, always with a word:

| State | Colour |
| --- | --- |
| CI passing, PR merged | ok |
| CI pending | neutral, with no loop and no `--live`, because no agent is working |
| CI failing, failed to open | bad |
| Conflict, a readiness reason, checkout behind | warn |
| Waiting for merge | idle |

**The item page** shows a PR row under Changes: number, a link to the PR (a normal external link,
`target="_blank" rel="noreferrer"`), branch → base in mono, and the CI state. The actions are
"Aprobar y abrir PR", "Abrir PR" and "Mover a Hecho". The waiting panel explains `merge`.

**On a phone**: 44 px targets, and the PR link as a full row.

**Checks**: tokens only, dark and light, the axe spec, and `motion.spec.mjs` green. No gradient is
added: the page already has its primary action.

## Out of scope

- Updating the branches of other open items when `main` moves (only the approved item's branch is
  updated, at approval).
- Hosts other than GitHub, and webhooks.
- Deleting the remote branch after a merge (GitHub's own setting decides that).
- Merging from Agentry: the person merges on GitHub.

## Docs to update in the same PR

- **[work-items.md](../work-items.md)**:
  - drop "There is no automatic pull request" and describe approving, conflicts, the watcher
    (named as the one poll), merged and closed;
  - add the `pr.*` causes to the automation;
  - add the board's checkout line.
- **[team-and-flow.md](../team-and-flow.md)**:
  - add the approval's PR to "What a run's end moves";
  - add the remembered approval after a conflict;
  - add `conflict-unresolved` to the causes;
  - add that the push is Agentry's own, while `git push` stays denied to every run.
- **README**: add the two routes to the Work items table.

## As built

Where the build settled what the plan left open, or read it more narrowly:

- **The module.** `PullRequestService` and `PullRequestWatcher` live in
  `packages/core/src/pull-requests.ts`; `Core.pullRequests` holds the service and the watcher starts
  once the runtime has restored its chats. git and gh run asynchronously (`execFile`, arguments, no
  shell), with `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`, so nothing waits for a password.
- **Readiness** is on the item's page (`WorkItemDetail.pullRequestReadiness`, where the plan said
  `WorkItemPage`, the list's page type) and on a project's board (`Board.pullRequestReadiness`), as
  `{ status: 'ready' | <reason>, detail, defaultBranch }`. A host other than `github.com` is
  `not-github` unless `gh auth status --hostname <host>` knows it.
- **The history** gains the change `pull_request`, whose value is `{ phase, number, url, conflicts }`,
  for opened, conflicted, merged and closed; the `pr.*` causes are on it and on the moves and
  `waiting` changes they make (`WORK_ITEM_PR_CAUSE` in `packages/shared/src/work-items.ts`). A cause
  of the PR's own carries no chat.
- **409s carry `code`**: `not-in-review`, `busy`, `nothing-to-propose`, or the readiness reason. The
  API's error handler adds `code` to a deliberate refusal that names a `reason`.
- **Step codes**: `commit`, `fetch`, `merge` (a merge that failed without a conflict, which is
  aborted), `push`, `create`. On a merged PR, `worktree-kept` says the worktree had uncommitted work.
- **QA's notes** are kept on the verify run (`flow_runs.criteria`, added by the same migration as
  `work_item_pull_requests`), since the plan's body quotes them and runs kept only their summary.
- **A remembered approval dropped** by a person's move deletes that attempt's row (no PR was ever
  opened for it); its `pull_request` and status entries stay in the history.
- **Without a flow**, a person who resolves the conflict by hand approves again; a conflicted path
  still there sends the item back to `conflict` without committing anything.

## Related

[[work-items.md]] · [[team-and-flow.md]] · [[plans/project-ecosystem.md]] · [[design-system.md]]
