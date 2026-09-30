---
created_at: 2026-09-30T14:05:47Z
updated_at: 2026-09-30T14:05:47Z
tags:
    - plan
    - git
    - code-hosts
    - pull-request
    - issues
    - planned
---
# Code hosts and issue trackers

Status: **planned** (2026-09-30). Nothing here is built yet. It runs beside
[plans/multi-provider.md](multi-provider.md) and follows the same shape: one manifest per
integration, a readiness state with a reason and a remedy, declared capabilities, and detection that
runs by itself.

## Where Agentry stands

- **git is already host-neutral.** Everything in `packages/core/src/git.ts` (worktrees, the
  `task/<key>` and `agentry/*` branches, merges, conflicts, diffs), `changes.ts`,
  `change-watcher.ts` and `verification.ts` works on any remote.
- **The host is GitHub, through `gh`, in two places that do not share code.**
  - `PullRequestService` (`packages/core/src/pull-requests.ts`): readiness (`not-git`, `no-remote`,
    `no-gh`, `not-github`, `gh-unauthenticated`, `no-default-branch`), commit → fetch → merge base →
    push → `gh pr create` → `gh pr view`, polling every 60 s for `MERGED`/`CLOSED` and a rolled-up
    `ci` from `statusCheckRollup`. See [work-items.md](../work-items.md) and
    [plans/work-item-pull-requests.md](work-item-pull-requests.md).
  - `Orchestrator.pullRequest()` pushes the integration branch and runs `gh pr create` with no
    readiness check, no base and no polling; only the URL is kept.
- **Missing:** a host abstraction, GitLab, a list of CI checks with their logs, review comments,
  merging from Agentry, issue import, and anything but polling.

## Decisions (owner, 2026-09-30)

1. **Only through each host's CLI.** GitHub through `gh`, GitLab through `glab`, with the session the
   person already has in each. The CLIs' own `api` subcommands (`gh api`, `glab api`) count as the
   CLI: they reach the host's documented API with the CLI's login. No REST client of Agentry's own,
   and no token of Agentry's own for a code host. Rejected: a REST client for hosts without a CLI;
   REST everywhere.
2. **Two hosts: GitHub and GitLab**, both complete, including GitHub Enterprise and self-managed
   GitLab when the person's `gh` or `glab` is signed in to that host. Bitbucket, Azure DevOps and
   Gitea/Forgejo are not supported.
3. **Every feature below:** CI checks and fixing them, reviews, merging from Agentry, and issues as
   work items.
4. **Issue trackers: GitHub Issues, GitLab Issues, Jira and YouTrack, each through a CLI.**
   - Jira through Atlassian's official CLI, `acli` (`acli jira workitem search --jql … --json`;
     [reference](https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem-search/)).
     `acli` targets Jira Cloud; Server and Data Center are out unless the CLI covers them.
   - YouTrack through JetBrains' official `youtrack-app` CLI (`@jetbrains/youtrack-apps-tools`): its
     `project` and `user` commands and `rest request --path /api/...`, which calls YouTrack's
     documented REST API and prints JSON. It authenticates with `YOUTRACK_HOST` and `YOUTRACK_TOKEN`
     (a permanent token from the person's profile), so Agentry stores that token encrypted and passes
     it only to the `youtrack-app` process it starts, never to its own environment.
   - Linear is left out: its official CLI (`@linear/cli`) only creates an issue and checks out its
     branch, which is not enough to import or sync. Revisit if Linear ships more.
5. **Events: polling, with optional webhooks.** Polling stays the source of truth, paced by activity
   and by each host's rate limit. When Agentry has a public URL (the tunnel, or a deployment),
   webhooks make it hear about a merge, a finished check or a new comment at once.
6. **GitHub and GitLab come complete in the first delivery.**

## Design

### 1. Manifests, readiness and detection

The same pattern as agent providers ([plans/multi-provider.md](multi-provider.md), and
`docs/providers.md` once that lands), reusing its pieces: the PATH
resolution in `packages/core/src/providers/path.ts`, the readiness states and reason codes, one
cache, and a `…changed` event.

- **Code host manifests** (`packages/core/src/hosts/<id>/manifest.ts`): `github` (`gh`) and `gitlab`
  (`glab`); the version range tested; how to read auth (`gh auth status --hostname <h>`,
  `glab auth status --hostname <h>`); the hosts it knows by default (`github.com`, `gitlab.com`).
- **Tracker manifests** (`packages/core/src/trackers/<id>/manifest.ts`): `github-issues` and
  `gitlab-issues` (the host's CLI), `jira` (`acli`), `youtrack` (`youtrack-app`).
- **A project's host is detected from its remote.** Parse `origin` (HTTPS and scp-style SSH),
  resolve SSH host aliases with `ssh -G`, and ask the CLI whether it is signed in to that host. A
  host the person's CLI does not know is never sent to that CLI, so no token goes to a host nobody
  chose. Enterprise and self-managed instances work the moment `gh` or `glab` is signed in to them.
- **Readiness per project**, replacing today's GitHub-only reasons with neutral ones: `ready`,
  `not-git`, `no-remote`, `unsupported-host`, `cli-missing`, `cli-signed-out`, `cli-incompatible`,
  `no-default-branch`. Each with its remedy (install page, sign-in page, the command's docs).
- **Where it shows:** Settings → Integrations (hosts and trackers, with their state), the project's
  settings (which host and tracker it uses), the board and item page as today, and a line in the
  first-run step after Providers.

### 2. A neutral model

Types say what things are, not which host said it:

- `ChangeRequest` (a PR or an MR): number and the host's own label for it (`#12` or `!12`), title,
  state (`open | draft | merged | closed`), base, head, URL, mergeable, review decision,
  auto-merge, the check rollup.
- `Check`: name, state, conclusion, started and finished, the tail of its log, and whether it can be
  re-run. A GitHub check run and a GitLab pipeline job both map to it.
- `ReviewThread` and `ReviewComment`: file, line range, side, body, author, resolved, and the reply
  chain.
- `IssueRef`: tracker, key (`#12`, `group/project#12`, `PROJ-12`, `ABC-12`), title, state, URL.

Host-specific details live in a typed `extra` section of each, never as fields named after a host.
Capabilities are declared per host (`draft`, `autoMerge`, `mergeMethods`, `checkLogs`, `rerun`,
`reviewThreads`, `resolveThreads`, `suggestions`) and the UI renders from them.

### 3. Pull and merge requests

- `PullRequestService` moves behind a `CodeHost` interface with a `gh` and a `glab` adapter.
- `Orchestrator.pullRequest()` uses the same service: readiness before pushing, a base branch,
  polling, and a `ChangeRequest` stored like a work item's.
- The `work_item_pull_requests` table gains the host, and keeps working for existing rows.
- The body closes the linked issue with the tracker's own words: `Closes #N` on GitHub,
  `Closes #N` / `Closes group/project#N` on GitLab, the Jira key in the title and body, and
  YouTrack's issue key.

### 4. CI checks, and fixing them

- The item page and the orchestration page list every check: state, duration, the last lines of
  its log, and **Re-run** (`gh run rerun --failed`, `glab ci retry`).
- **Fix failing checks** starts a run in the item's worktree (the flow's Developer, or a chat for an
  orchestration) with a prompt built from the failing checks' log tails. It never pushes: the fix
  reaches the PR through Agentry's own push, after the person approves, as today.
- A decision point `checks.fix` (act, project, `off` by default) can start that run on its own when
  checks fail, within the attempts the person allows.

### 5. Reviews

- **Read:** review threads appear on the item page and inside `DiffView`, on their lines.
  **Address with an agent** hands the chosen threads (all unresolved, by default) to a run in the
  item's worktree, with each comment's file, lines and body.
- **Write:** notes a person leaves in `DiffView` form a draft review, posted as one real review
  (comment, approve or request changes) through `gh api` / `glab api`. Threads can be answered and
  resolved from Agentry.
- A decision point `review.triage` (suggest, project) proposes which comments an agent should take
  and which need a person.

### 6. Merging from Agentry

- **Merge** with the methods the repository allows (squash, merge, rebase), or **Auto-merge** when
  the host supports it. Branch protection and required checks are the host's to enforce; Agentry
  shows why a merge is blocked, in its words.
- Merging stays a person's action. Nothing merges on its own unless the person turned auto-merge on
  for that change request.
- After a merge, what happens today still does: the item moves to Done, its worktree goes, and the
  checkout moves forward.

### 7. Issues as work items

- **Import:** from Settings → Integrations or the board, pick issues by a query (the tracker's own:
  GitHub/GitLab search, JQL, YouTrack query) and turn them into work items, linked both ways. A
  project can have one tracker.
- **Work:** the item's branch carries the issue key (`task/PROJ-12-short-title`), its prompt carries
  the issue's text, and its pull request closes the issue.
- **Sync:** when the PR merges, the issue moves to the tracker's done state (a mapping per project:
  which Agentry column maps to which tracker status or transition). Comments are not mirrored.
- **Links, not fields per tracker:** a work item has `links: IssueRef[]`.
- A decision point `issue.triage` (suggest, project) proposes which imported issues are ready to
  start and which need refining.

### 8. Events

- **Polling** as today, improved: pace by activity (an open change request with checks running is
  read more often than one waiting for review), respect each CLI's rate limit with a breaker per
  host, and never run two reads of the same change request at once (the `claimed_until` column
  already does this).
- **Webhooks** when Agentry has a public URL: `POST /webhooks/github` and `POST /webhooks/gitlab`,
  each verifying the host's signature or token with a secret Agentry generates. Agentry offers to
  register the hook on the repository through `gh api` / `glab api`, after the person confirms. A
  webhook only triggers an early read; it never changes state on its own, so a missed or forged
  delivery cannot do harm.

### 9. The rule

The generalised rule (decision 1 of [plans/multi-provider.md](multi-provider.md), which reaches
`CLAUDE.md` with that plan's first phase) already covers this: Agentry reaches each tool
through the interface its vendor ships for programs. For code hosts and trackers that means the
vendor's CLI. The one new thing Agentry stores is the YouTrack token that `youtrack-app` needs; it
lives encrypted in the data directory, like the decision engine's credentials.

## Phases

Prototypes come first for every new screen, and the owner validates them, as for providers.

1. **Hosts and readiness.** Manifests, detection per project, neutral readiness, Settings →
   Integrations, `PullRequestService` behind `CodeHost` with the `gh` adapter, the orchestration PR
   on the same service, and the `glab` adapter at parity.
2. **Checks.** The `Check` model, the list with logs and re-run, **Fix failing checks**, and
   `checks.fix`.
3. **Reviews.** Threads on the item page and in `DiffView`, **Address with an agent**, posting a
   review, answering and resolving, and `review.triage`.
4. **Merging.** Merge methods, auto-merge, and why a merge is blocked.
5. **Trackers.** GitHub and GitLab issues, Jira through `acli`, YouTrack through `youtrack-app`;
   import, links, branch names, closing words, status sync, and `issue.triage`.
6. **Webhooks.** The two endpoints, signature checks, registration through the CLIs, and the
   paced polling.

Each phase keeps `pnpm typecheck`, `pnpm test` and `pnpm e2e` green, with a fake `gh`, `glab`,
`acli` and `youtrack-app` for the tests (a fake `gh` already exists in
`packages/core/test/fixtures/fake-gh.sh`).

## Open

- Whether the multi-provider first-run step and this one's integrations line ship together, or
  this one waits for its own delivery.
- Jira Server and Data Center, if `acli` does not reach them.

## Related

[[plans/multi-provider.md]] · [[work-items.md]] · [[plans/work-item-pull-requests.md]] · [[team-and-flow.md]] · [[decision-engine.md]]
