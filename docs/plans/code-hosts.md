---
created_at: 2026-09-30T14:05:47Z
updated_at: 2026-09-30T18:00:00Z
tags:
    - plan
    - git
    - code-hosts
    - pull-request
    - issues
    - planned
---
# Code hosts and issue trackers

Status: **planned** (2026-09-30). Nothing here is built yet; phase 1 is designed as a task graph below ([Phase 1: orchestrations and task graph](#phase-1-orchestrations-and-task-graph)). It runs beside
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

## Phase 1: orchestrations and task graph

Phase 1 is one delivery on one feature branch, **`feat/code-hosts`**, cut from `main` at
`9820eff3` (release 0.29.0, with multi-provider phase 1 merged) and squash-merged once. It is split
into three orchestrations, each landing on that branch: prototypes (P0), core (P1) and web (P2).
Every code-writing worker runs on `claude-sonnet-5-5` (the exact id, never the `sonnet` alias).
Every task runs `pnpm typecheck` and the tests of the packages it touches; **no worker runs
`pnpm e2e`**. The full `pnpm test`, `pnpm build` and one `pnpm e2e` run once, at the end, on the
branch, by the owner's assistant.

### What phase 1 delivers, and what it does not

In scope: the `github` and `gitlab` manifests; detection of each project's host from `origin`;
neutral readiness with remedies; the `CodeHost` interface with a `gh` and a `glab` adapter at parity
(create, view, state, rolled-up CI, default branch); `PullRequestService` behind it with no change
in behaviour for GitHub; `Orchestrator.pullRequest()` on the same service; the `host` column and
the orchestration's own rows; `/hosts` routes and `hosts.changed`; Settings → Integrations and the
project's host line; neutral copy (PR or MR, `#12` or `!12`, from the host); a fake `glab`, a
wider fake `gh`, and a conformance suite every adapter passes.

Out of scope, each for a later phase: the `Check` list, logs and re-run (phase 2); review threads
(3); merging from Agentry (4); trackers, issue links and closing words (5); webhooks and paced
polling (6); the first-run integrations line (still an open question above); drafts and
auto-merge; any host but GitHub and GitLab; a per-project choice of host or remote (see the owner
questions at the end). The watcher keeps polling every 60 s with the 5 min back-off, as today.

### Facts about the CLIs, and where they come from

The rule of multi-provider phase 1 holds: every fact is checked, and what cannot be confirmed is
left out and reported as `unknown`, never guessed. Each manifest and adapter cites its source in a
comment.

| Fact | `gh` | `glab` |
|---|---|---|
| Version | `gh --version`, first line `gh version 2.45.0 (…)`: checked on the owner's machine (gh 2.45.0) | `glab version` ([docs](https://docs.gitlab.com/cli/version/)); the **output format is not documented**, so the version is the first `x.y.z` in it, and none found reads as version `unknown` |
| Auth probe | `gh auth status --hostname <h>`, exit code (`gh auth status --help`; what `PullRequestService` runs today) | `glab auth status --hostname <h>` ([docs](https://docs.gitlab.com/cli/auth/status/)). The docs say nothing about the exit code. Older glab exited 0 on a failed login ([issue 911](https://gitlab.com/gitlab-org/cli/-/issues/911)), fixed by [MR !1453](https://gitlab.com/gitlab-org/cli/-/merge_requests/1453) in a **release that is not confirmed**. |
| Known hosts | top-level keys of `hosts.yml` in `GH_CONFIG_DIR`, else `~/.config/gh` (checked on the owner's machine) | the `hosts:` map of `config.yml` in `GLAB_CONFIG_DIR`, then `~/.config/glab-cli`, then `XDG_CONFIG_HOME/glab-cli` ([configuration](https://docs.gitlab.com/cli/configuration/)) |
| No prompts, no noise | `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1` (today's env) | `NO_PROMPT=1`, `GLAB_CHECK_UPDATE=false`, `GLAB_SEND_TELEMETRY=false`, `NO_COLOR=1` ([configuration](https://docs.gitlab.com/cli/configuration/)) |
| Create | `gh pr create --head --base --title --body-file -` (today) | `glab mr create --source-branch --target-branch --title --description-file - --yes` ([docs](https://docs.gitlab.com/cli/mr/create/): `--description-file -` reads stdin; `--yes` skips the confirmation). The glab release that added `--description-file` is **not confirmed**. |
| View | `gh pr view <n\|branch> --json number,url,state,mergedAt,statusCheckRollup` (today) | `glab mr view <id\|branch> -F json` ([docs](https://docs.gitlab.com/cli/mr/view/)) |
| Fields | GitHub's `state` `OPEN/MERGED/CLOSED`, `statusCheckRollup` (today's `ciOf`) | The [merge request API](https://docs.gitlab.com/api/merge_requests/) names `iid`, `web_url`, `state` (`opened`, `closed`, `merged`, `locked`), `merged_at` and `head_pipeline.status`. **Unconfirmed:** that `glab mr view -F json` prints that object with those names. |
| Default branch | `git symbolic-ref refs/remotes/origin/HEAD`, else `gh repo view --json defaultBranchRef` (today) | the same `git symbolic-ref`, else `glab repo view -F json` → `default_branch` ([docs](https://docs.gitlab.com/cli/repo/view/), field from the Projects API; the same caveat on the JSON shape) |
| Pipeline states | — | `created, waiting_for_resource, preparing, waiting_for_callback, pending, running, success, failed, canceling, canceled, skipped, manual, scheduled` ([pipelines API](https://docs.gitlab.com/api/pipelines/)) |

What this means for the code:

- `glab`'s manifest ships with `versions.range: null` and `minimum: null`. Its status is
  `degraded` with the reason `version-untested`, which does **not** stop a project from opening
  merge requests, and says so in Settings → Integrations.
- The glab adapter reads `glab mr view` JSON defensively. A missing `iid` or `web_url` fails the
  `create` step with the line glab printed. A missing `head_pipeline` reads as CI `none`, and an
  unknown pipeline status as `pending`, never as `passing`.
- It never matches glab's error text. After a failed `mr create`, it runs `mr view <branch>`, and an
  open MR for that branch is the one to watch, as gh's "already exists" is today.
- These gaps close with owner question 1: fixtures recorded from a real `glab`.

### The `CodeHost` interface

In `packages/core/src/hosts/code-host.ts`. An adapter is a stateless translator from these calls to
one CLI's arguments and JSON. Everything around it (git, rows, claims, the flow) stays in the
service.

```ts
/** One call to the host's CLI: what the service runs, with its own timeout, never a shell string. */
export interface HostCall { args: string[]; input?: string; timeout: number }

export interface CodeHostAdapter {
  readonly id: CodeHostId;                        // 'github' | 'gitlab'
  /** `#` or `!`: how the host writes a change request's number */
  readonly refPrefix: '#' | '!';
  /** Environment that keeps the CLI from prompting or phoning home */
  env(): Record<string, string>;
  version(): HostCall;
  parseVersion(stdout: string): string | null;
  authStatus(hostname: string): HostCall;          // exit code 0 = signed in
  defaultBranch(): HostCall;
  parseDefaultBranch(stdout: string): string | null;
  /** Whether a failed default-branch read means the remote is not this host's (gh names it) */
  notThisHost(detail: string): boolean;
  create(req: { head: string; base: string; title: string; body: string }): HostCall;
  /** After a create: by branch. When watching: by number. */
  view(ref: { branch: string } | { number: number }): HostCall;
  parseView(stdout: string): ChangeRequestView;    // throws HostParseError on a shape it cannot read
}

/** What a view says, in Agentry's words. */
export interface ChangeRequestView {
  number: number | null;
  url: string | null;
  state: 'open' | 'merged' | 'closed';
  mergedAt: string | null;
  ci: WorkItemPullRequestCi;                        // 'none' | 'pending' | 'passing' | 'failing'
}
```

Returning `HostCall`s instead of running them keeps the adapters pure. The conformance suite then
checks them without a process, and the service keeps one runner (today's `run()`, moved to
`hosts/exec.ts`) with today's timeouts, the process env and `GIT_TERMINAL_PROMPT=0`.

The rolled-up CI, per host:

| Agentry | GitHub (`statusCheckRollup`, today's `ciOf`, unchanged) | GitLab (`head_pipeline.status`) |
|---|---|---|
| `none` | no checks | no `head_pipeline` |
| `failing` | a conclusion or state of `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `ERROR` | `failed`, `canceled`, `canceling` |
| `pending` | a check run not `COMPLETED`, or a state of `PENDING`, `EXPECTED`, `QUEUED`, `IN_PROGRESS` | `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`, `running`, `scheduled`, `manual`, and any status not listed |
| `passing` | all succeeded or skipped | `success`, `skipped` |

`manual` reads as `pending` (the pipeline waits for a person), like GitHub's queued checks, and
not as `failing`. `locked` reads as `open`.

### Detection and neutral readiness

**The remote.** `git remote get-url origin`, as today (it expands `insteadOf`, so it is the URL
git really talks to). `hosts/remote.ts` parses:

- `https://[user[:secret]@]host[:port]/path[.git]`; the user and secret are dropped at once and
  never stored, logged or served;
- `ssh://[user@]host[:port]/path`;
- scp-style `[user@]host:path`, where the user is optional (today's regex required it);
- `git://host/path`;
- a local path or `file://`, which has no host.

An SSH host (from `ssh://` or scp-style) goes through `ssh -G <alias>`, which prints the
configuration after `Host` and `Match` are applied and exits without connecting ([ssh(1)]). Its
`hostname` line is the real host. `ssh` missing, a timeout (5 s) or no `hostname` line: the alias
is kept. One caveat goes into `docs/code-hosts.md`: a `Match exec` block in the person's SSH config
runs on `ssh -G`, as it does on every `git fetch`.

[ssh(1)]: https://man.openbsd.org/ssh#G

**Which CLI a host belongs to**, without ever sending an unknown host to a CLI:

1. `github.com` → `github`; `gitlab.com` → `gitlab` (each manifest's `defaultHosts`).
2. Otherwise the host is looked up in the CLIs' own config: the keys of gh's `hosts.yml`, and the
   `hosts:` map of glab's `config.yml`. Only the host names and `user` keys are read. A token line
   is never read into memory: the reader skips any key but those.
3. A host in both goes to `github`, and the detail says so. This case is expected to be rare; see
   owner question 3.
4. A host in neither, or no host at all: `unsupported-host`. No CLI is called.

**Readiness**, per project, cached 60 s as today, in this order:

| Old reason | New reason | When | Remedy (a link, never a command to copy) |
|---|---|---|---|
| `not-git` | `not-git` | the path is not a git repository | — |
| `no-remote` | `no-remote` | `origin` is missing | git's docs on remotes |
| `not-github` (host unknown to `gh`) | `unsupported-host` | no host, or a host neither CLI knows | Settings → Integrations, which says which hosts each CLI knows and links to signing in to another host |
| `not-github` (`gh repo view` says it is not a GitHub repository) | `unsupported-host` | the adapter's `notThisHost(detail)` | the same |
| `no-gh` | `cli-missing` | the host's CLI is not found (binary override, PATH, then the install directories of `providers/path.ts`), or `--version` fails | the CLI's install page |
| — (new) | `cli-incompatible` | the version is below the manifest's `minimum` | the CLI's install page |
| `gh-unauthenticated` | `cli-signed-out` | `auth status --hostname <h>` fails | the CLI's sign-in docs, with the host in the detail |
| `no-default-branch` | `no-default-branch` | neither `symbolic-ref` nor the CLI names it | the CLI's docs for its `repo view` command |
| `ready` | `ready` | — | — |

`PullRequestReadiness` gains `host` (`CodeHostId | null`), `hostname` (`string | null`) and
`remedy` (`{ kind: 'install' | 'sign-in' | 'docs' | 'settings'; url: string | null } | null`). The
old reason values leave the contract; nothing stored uses them, since failed rows record step codes
(`fetch`, `merge`, `push`, `create`, `commit`), so no data migration is needed. The web maps any
old value it receives to the new one, for a client that is newer than its server.

**The CLIs' own status** (Settings → Integrations) reuses the provider pieces: path resolution from
`providers/path.ts`, `satisfiesRange` from `providers/detector.ts`, one cache (TTL 5 min), a refresh,
watchers on the PATH directories and the CLIs' config directories (debounced), and `hosts.changed`
only when a status really changed. `CodeHostStatus`:

- `id`, `label`, `cli`, `binaryPath`, `version`, `range`, `minimum`;
- `state`: `ready | degraded | signed-out | incompatible | not-installed | unknown`;
- `reason`: `version-untested | below-minimum | no-hosts | probe-failed | timeout | null`;
- `hosts`: `{ hostname, default: boolean, signedIn: boolean | null, user: string | null }[]`, with
  `null` while it has not been probed;
- `checkedAt`.

A project's readiness does **not** read that cache. It runs its own `--version` and
`auth status --hostname`, as today, so the calls `gh` receives for a project are identical (see
the proof of parity below).

### Persistence

- `hosts.json` in the data directory: `CodeHostsSettings` = `{ hosts: Record<CodeHostId,
  { enabled: boolean; binaryPath: string | null }> }`. It is a settings-shaped document, like
  `providers.json`. A disabled host's projects read `unsupported-host`, with a detail that says the
  host is turned off.
- Change requests are rows, because they accumulate, and two processes share the data directory
  and watch them with claims. The migration, appended to `MIGRATIONS` in
  `packages/core/src/db.ts`:

```sql
-- Every existing row was opened by gh on a host gh knew: 'github' is true of all of them.
-- hostname stays null for them, and the watcher reads it from origin as it does today.
ALTER TABLE work_item_pull_requests ADD COLUMN host TEXT NOT NULL DEFAULT 'github';
ALTER TABLE work_item_pull_requests ADD COLUMN hostname TEXT;
-- An orchestration's change requests: the same lifecycle minus the flow's phases
-- (no conflict, no awaiting-verify). Cascades with the orchestration's row, which is upserted
-- and never deleted-and-reinserted, so a save cannot drop them.
CREATE TABLE orchestration_pull_requests (
  id               TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations (id) ON DELETE CASCADE,
  cwd              TEXT NOT NULL,
  host             TEXT NOT NULL,
  hostname         TEXT,
  phase            TEXT NOT NULL,          -- preparing | open | merged | closed | failed
  number           INTEGER,
  url              TEXT,
  branch           TEXT NOT NULL,
  base             TEXT NOT NULL,
  ci               TEXT,
  error_code       TEXT,
  error_detail     TEXT,
  opened_at        TEXT,
  closed_at        TEXT,
  checked_at       TEXT,
  claimed_until    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX orchestration_pull_requests_orch ON orchestration_pull_requests (orchestration_id, created_at);
CREATE INDEX orchestration_pull_requests_phase ON orchestration_pull_requests (phase);
-- Two clicks, or two processes, open one change request: the insert of the second fails
CREATE UNIQUE INDEX orchestration_pull_requests_live ON orchestration_pull_requests (orchestration_id)
  WHERE phase IN ('preparing', 'open');
```

An orchestration that already has `integration.pullRequestUrl` gets no row: it keeps its link, and
it is not watched (its number and host were never recorded). New ones write both the row and
`pullRequestUrl`, so `rerun()`'s guard (`orchestrator.ts` ~2213) and the web keep working
unchanged.

### The contract (`packages/shared/src/types.ts`)

- New: `CodeHostId` (`'github' | 'gitlab'`, a closed union: adding a host is a code change, unlike
  providers); `CodeHostState`; `CodeHostReason`; `CodeHostStatus`; `CodeHostsSettings`;
  `ProjectCodeHost` (`readiness`, `remote`: `{ hostname, path, protocol } | null`, never the URL
  with its user); `HostsChangedEvent` (`type: 'hosts.changed'`, `hosts: CodeHostStatus[]`), added
  to `AgentryEvent`; `OrchestrationPullRequest` (`phase`, `host`, `ref`, `number`, `url`,
  `branch`, `base`, `ci`, `error`, `openedAt`, `closedAt`, `checkedAt`); and
  `OrchestrationPullRequestEvent` (`type: 'orchestration.pull-request'`, `orchestrationId`,
  `pullRequest`).
- Changed: `PullRequestNotReadyReason` takes the neutral values; `PullRequestReadiness` gains
  `host`, `hostname` and `remedy`; `WorkItemPullRequest` and `WorkItemHistoryPullRequest` gain
  `host` (absent reads as `github`) and `ref` (`#12` or `!12`, null without a number).
  `Orchestration` read models gain `pullRequest?: OrchestrationPullRequest | null`.
  `POST /orchestrations/:id/pull-request` answers `{ branch, url, detail, pullRequest }`, which
  keeps today's three fields.
- Type names keep "PullRequest": renaming them across the contract is churn with no reader. In
  types, "pull request" means a PR or an MR, and the docs say so.
- Then `pnpm --filter @agentry/api openapi:schemas`.

### Routes

Following the providers pattern (`apps/api/src/routes/providers.ts`). Every route has a summary and
the `Integrations` tag in `apps/api/src/openapi/routes.ts`, and a row in the README's REST tables.

| Route | What it does |
|---|---|
| `GET /hosts` | every `CodeHostStatus`, from the cache |
| `GET /hosts/:id` | one, 404 for an unknown id |
| `POST /hosts/refresh` | detects again now; `hosts.changed` follows. A chat token gets 403 |
| `GET /hosts/settings` | `CodeHostsSettings` |
| `PUT /hosts/settings` | validated: known ids, `binaryPath` absolute or null. Re-detects in the background and clears every project's readiness cache. A chat token gets 403 (it names a binary Agentry runs) |
| `GET /projects/:id/code-host` | `ProjectCodeHost`: the readiness and the parsed remote |

### Orchestrations and tasks

#### P0 · `hosts-prototypes` (design; gates P2)

A new generator, `docs/design-system/reference/tools/hosts.py`, runs on its own, like
`providers.py`. It imports `common.py`, plus `projects.py`, `board.py` and `tasks.py` for the
screens it varies. Every screen comes dark and light; every desktop screen has its phone
counterpart.

- `p1`: **Settings → Integrations**, a new tab in the Agentry group after Providers.
  - One row per host (GitHub, GitLab): icon, name, CLI and version, and the state as a status
    colour **with** a word. The one action per state: Install page, Sign-in docs, Update, Retry,
    Choose binary. The reason in plain words under it.
  - The host names each CLI knows, each with its account, or "signed out" in warn.
  - States shown once each: GitHub `ready` with `github.com` and an enterprise host; GitLab
    `degraded` (version untested); GitLab `signed-out` on a self-managed host; `not-installed`;
    `incompatible`; `checking…`. Also the nothing-installed state (`Empty` with an illustration:
    the one per screen) and the binary override (a `Sheet` on the phone).
  - Files: `DesktopIntegraciones.html`, `DesktopIntegracionesEstados.html`,
    `MobileIntegraciones.html`, `MobileIntegracionesEstados.html`, `MobileIntegracionesBinario.html`,
    their screenshots, `reference/index.html` and `manifest.json`.
- `p2`: **the project's host line** in the project settings, added to `DesktopProyectoAjustes.html`
  and `MobileProyectoAjustes.html` through `projects.py`: host icon, `hostname/path` in mono, the CLI
  and its account, and the readiness word.
  - Four variants in a states sheet: GitHub `ready`; self-managed GitLab `ready`; `unsupported-host`
    with its link to Integrations; `cli-signed-out` with its remedy.
  - Files: those two screens, `DSIntegraciones.html` (the states sheet), and `projects.py`.
- `p3`: **readiness notes and MR wording.**
  - `DSIntegraciones.html` gains the board's quiet note and the item page's note for each of the
    seven not-ready reasons, with their remedy links, both themes.
  - On a GitLab project: `DesktopTareaMR.html` and `MobileTareaMR.html` (the item page with "MR !12
    · waiting for merge", "Open MR !12 on GitLab", "Approve and open MR", CI badge);
    `DesktopTableroMR.html` (the board card strip); and `DesktopOrquestacionMR.html` and
    `MobileOrquestacionMR.html` (the orchestration's "Open merge request" button, its push dialog,
    and the opened MR with its CI state).
  - Files: those screens, `tasks.py` and `board.py` (variants only).
- A new component variant, if any, goes into `docs/design-system.md` and `agentry-ds.css`.
- Check: `python3 lint.py` and `node check.mjs` on every new or changed screen, both clean; then
  **the owner validates** before P2 starts.

#### P1 · `hosts-core` (runs beside P0)

Merge conflicts are avoided by ownership: each file below has **one** writing task, except where a
dependency serialises the writers. `packages/shared/src/types.ts` is `c1`'s alone.
`pull-requests.ts` is `c8`'s alone. `orchestrator.ts` is `c9`'s alone, and only its
`pullRequest()` method and the read model. `packages/core/src/index.ts` is written by `c8`, then
`c9` (dependent). `apps/api/src/openapi/routes.ts` and `README.md` are `c10`'s alone.

- `c0` (the GitHub baseline), dependsOn none. **Merged first; it runs against today's code.**
  - `packages/core/test/pull-requests.golden.test.ts` runs today's `PullRequestService` through
    fixed scenarios and compares every call with a committed log:
    1. readiness `ready` on `github.com`;
    2. readiness with no `origin/HEAD` (`gh repo view`);
    3. signed out;
    4. `gh` missing;
    5. an enterprise host gh knows;
    6. an enterprise host gh does not know;
    7. approve → open;
    8. approve when a PR already exists;
    9. watch: open with CI pending, then failing, passing, merged (worktree removed, checkout
       forwarded) and closed;
    10. a `gh` failure and its back-off;
    11. a person's refresh.
  - The calls come from a logging `git` shim (it runs the real git) put first on the test's PATH,
    and from `fake-gh`, which learns to log the three env variables it must receive and every stdin
    body. `UPDATE_GOLDEN=1` rewrites the logs, and only `c0` may run it.
  - Files: the test, `packages/core/test/fixtures/git-shim.sh`, `fake-gh.sh` (logging only),
    `packages/core/test/fixtures/golden/*.log`, and one helper,
    `packages/core/test/fixtures/pr-harness.ts`, which builds the service. Later tasks change that
    helper, never the logs.
  - Check: core tests.
- `c1` (the contract), dependsOn none. Every type change above, `WORK_ITEM_PR_CAUSE` unchanged.
  - Files: `packages/shared/src/types.ts`, shared tests, `apps/api/src/openapi/schemas*`
    (regenerated).
  - Check: shared tests, `openapi:schemas` with no drift. Core and web will not typecheck against
    the renamed reasons until `c8` and `u0`. The task runs `pnpm --filter @agentry/shared
    typecheck` and states the known downstream errors in its result.
- `c2` (the remote), dependsOn c1.
  - `packages/core/src/hosts/remote.ts`: `parseRemote(url)` and `resolveSshHost(host, exec)`, with
    `ssh -G` injected. It also redacts the user and secret.
  - Files: that file, `packages/core/test/hosts-remote.test.ts` (a table of every URL form, IPv6,
    ports, `insteadOf`-expanded paths, an alias with and without `ssh`, a secret never surviving
    into any output).
  - Check: core tests.
- `c3` (manifests, registry, interface, conformance), dependsOn c1.
  - `hosts/manifest.ts` (`CodeHostManifest`: `id`, `label`, `cli`, `versions: { args, range,
    minimum }`, `auth`, `defaultHosts`, `configHome` with its variable, `install.url`,
    `signInUrl`, `docsUrl`, `refPrefix`, `changeRequestNoun: 'pull request' | 'merge request'`).
  - `hosts/registry.ts`, `hosts/github/manifest.ts`, `hosts/gitlab/manifest.ts`, every fact with
    the source from the table above.
  - `hosts/known-hosts.ts`: reads host names and users from the two config files. It never reads a
    token line: a test gives it a file whose token is a sentinel and checks that the sentinel is in
    no output and in no object it returns.
  - `hosts/code-host.ts`: the interface.
  - `packages/core/test/hosts/conformance.ts`: a suite exported as a function of an adapter and
    recorded outputs.
    - Every call's args are an array without a shell.
    - `env()` disables prompts.
    - Create carries the body only on stdin.
    - `parseView` maps each recorded state and each CI state as the tables say, and throws on
      malformed JSON.
    - `view({ branch })` and `view({ number })` differ.
    - `refPrefix` matches the manifest.
  - Check: core tests, including one that fails when two manifests share an id, a CLI or a default
    host.
- `c4` (`gh` adapter), dependsOn c0, c3.
  - `hosts/github/adapter.ts`: exactly today's arguments. It imports `ciOf` from `pull-requests.ts`
    for now; `c8` moves `ciOf` into the adapter and leaves a re-export behind, so no import breaks.
  - `fake-gh.sh` gains per-host auth (`$state/unauth-<host>`) and `repo view` failure texts. It
    keeps today's answers, byte for byte, for the golden scenarios.
  - Files: the adapter, `hosts/github/recorded/*.json` (outputs recorded from gh 2.45.0 on the
    owner's machine, with owner and token details removed), `fake-gh.sh`, and
    `packages/core/test/hosts-github.test.ts`, which runs the conformance suite and today's `ciOf`
    table unchanged.
  - Check: core tests, the golden test included.
- `c5` (`glab` adapter and fake), dependsOn c3.
  - `hosts/gitlab/adapter.ts` as specified above, the unconfirmed facts marked in comments.
  - `packages/core/test/fixtures/fake-glab.sh`, the same design as `fake-gh`: answers from
    `$FAKE_GLAB_STATE`, logs every call and its stdin. It answers `version`,
    `auth status --hostname`, `repo view -F json`, `mr create` and `mr view`.
  - `hosts/gitlab/recorded/*.json`: shaped on the documented API fields until owner question 1
    replaces them with real output. Each file says which it is in a `_source` key.
  - Files: those, and `packages/core/test/hosts-gitlab.test.ts` (the conformance suite, and every
    pipeline status of the table).
  - Check: core tests.
- `c6` (detection and readiness), dependsOn c2, c3.
  - `hosts/detector.ts`: `CodeHostStatus` per manifest, and the cache, watchers and
    `hosts.changed`, reusing `providers/path.ts` and `satisfiesRange`.
  - `hosts/settings.ts`: the `hosts.json` store, modelled on `providers/settings.ts`.
  - `hosts/readiness.ts`: `projectReadiness(path, deps)`, the ordered checks above, with the host
    map of step 2 and the adapter looked up by id, tested with stub adapters and fake binaries on a
    temporary PATH.
  - Files: those and their tests. `index.ts` is not touched here.
  - Check: core tests.
- `c7` (the store), dependsOn c1.
  - The migration above.
  - `work-item-rows.ts`: `PullRequestRow` gains `host` and `hostname`, and `pullRequestOf` fills
    `host` and `ref` from the manifest's prefix.
  - `orchestration-pr-rows.ts`: the new row type and its reader.
  - Files: `db.ts`, `work-item-rows.ts`, `orchestration-pr-rows.ts`, and a db test that upgrades a
    database holding PR rows from the version before and finds them `github`.
  - Check: core tests.
- `c8` (`PullRequestService` behind `CodeHost`), dependsOn c0, c4, c5, c6, c7.
  - `run`, `StepError` and `firstLine` move to `hosts/exec.ts`.
  - `computeReadiness` delegates to `hosts/readiness.ts`.
  - `prepare`, `check` and `refresh` build their calls with the project's adapter (`gh` today
    stays `gh`).
  - `approve` stores `host` and `hostname`.
  - The watcher takes a list of sources (work items now, orchestrations in `c9`), each with its
    rows, claim and outcome, so `c9` adds a source without touching the loop.
  - `index.ts` builds the hosts detector, the settings store, and the service with them; it exposes
    `core.hosts`, `core.hostsSettings` and `core.projectCodeHost(id)`; and it clears readiness on
    `hosts.changed`.
  - The existing `pull-requests.test.ts` and `apps/api/test/work-item-pull-requests.test.ts` change
    only their expected reason names, through the old → new table. The golden harness changes only
    in `pr-harness.ts`: see the parity proof.
  - Adds a GitLab run of the same scenarios against `fake-glab` (its own golden logs, written once
    here).
  - Files: `pull-requests.ts`, `hosts/exec.ts`, `index.ts`, `pr-harness.ts`,
    `pull-requests.test.ts`, `pull-requests.gitlab.test.ts`, the two API test files' reason names.
  - Check: core and API tests; the GitHub golden logs identical.
- `c9` (the orchestration's change request), dependsOn c8.
  - `packages/core/src/orchestration-pull-requests.ts`: `open(orch)` checks readiness before
    pushing. Not ready is refused with the reason and nothing is pushed.
    - Then it inserts the row under `BEGIN IMMEDIATE`, where the unique index answers a second
      click, and pushes the integration branch.
    - It creates the change request with `--base` the default branch (owner question 2), the title
      the orchestration's name, and the body as today (objective, verification, final result, cut
      at 60 000).
    - Then it views it and stores it. Everything runs async; today's `execFileSync` held the event
      loop for up to five minutes.
  - A watcher source polls its open rows (a merge or a close is recorded and announced; nothing
    else moves: an orchestration has no Done).
  - `orchestrator.ts`: `pullRequest()` becomes an `async` delegate that keeps today's refusals
    (verifying, checks failed, not integrated). The read model gains `pullRequest`.
    `integration.pullRequestUrl` is written as before.
  - `apps/api/src/routes/orchestrations.ts`: the handler awaits.
  - `index.ts`: one source and the event.
  - Files: those, and `packages/core/test/orchestration-pull-requests.test.ts` (against both fakes:
    readiness refused before any push, one row for two concurrent calls, merged and closed read back,
    the rerun guard still refusing).
  - Check: core and API tests.
- `c10` (routes), dependsOn c8. Can run beside `c9`.
  - `apps/api/src/routes/hosts.ts`, `app.ts`, `security.ts` (403 for chat tokens on the two
    writes), `routes/projects.ts` (`/projects/:id/code-host`).
  - `openapi/routes.ts`: every new route, and the new descriptions of the work item and
    orchestration PR routes, with their reasons.
  - The `README.md` REST tables, and the API tests (the summary-and-tag test included).
  - Check: API tests.
- `c11` (the docs), dependsOn none; finished after `c8`.
  - `docs/code-hosts.md`, a reference like `providers.md`: what a code host is, the adapters, the
    detection steps, the readiness reasons with remedies, the parity rules, how to add a host.
  - `docs/work-items.md` and `docs/plans/work-item-pull-requests.md`: the reason table, with a
    pointer.
  - `CONTRIBUTING.md`: `gh` and `glab` are reached as the one rule says, with the CLI's own
    config files read for host names only.
  - Check: docs only; `kb` re-sync per `docs/knowledge-base.md`.

#### P2 · `hosts-web`, dependsOn P0 (validated) and P1

- `u0` (the web's model), dependsOn none within P2.
  - `lib/work-items.ts`: neutral reasons, an old → new map for older servers, and
    `pullRequestErrorKey`.
  - `lib/code-hosts.ts`: `changeRequestWords(host)` gives the noun key (PR or MR), the prefix and
    the host's label.
  - `api.ts`: the host routes. `lib/events.ts`: `hosts.changed` and `orchestration.pull-request`.
  - Files: those, and `apps/web/test/work-item-pull-requests.test.tsx` and
    `apps/web/test/code-hosts.test.ts`.
  - Check: web tests.
- `u1` (Settings → Integrations), dependsOn u0, from the validated prototype.
  - Files: `pages/config/IntegrationsTab.tsx`, `settingsTabs.ts` (tab `integrations` in the Agentry
    group, after `providers`), `i18n/locales/{en,es}/integrations.json`, `i18n/resources.ts`.
  - Check: web tests.
- `u2` (the project's host line), dependsOn u0.
  - Files: `pages/home/ProjectSettings.tsx` (or `ProjectGeneral.tsx`, whichever the prototype
    places it in), and `i18n/locales/{en,es}/projects.json`.
  - Check: web tests.
- `u3` (neutral PR surfaces), dependsOn u0.
  - Files: `pages/tasks/board/PullRequest.tsx`, `pages/tasks/item/PullRequest.tsx`,
    `pages/OrchestrationDetail.tsx`, `lib/orchestration-v2.ts`,
    `i18n/locales/{en,es}/tasks.json`, `workItem.json` and `config.json`.
  - Every "GitHub" and "gh" in PR copy becomes the host's label and noun from `u0`: "Open
    {{noun}} {{ref}} on {{host}}", "its {{noun}} was merged on {{host}}", `pushBody` without `gh`.
  - The readiness notes carry their remedy link.
  - The release note that reads Agentry's releases on GitHub stays: it is about Agentry, not a
    project.
  - Check: web tests, the tokens test included.
- `u4` (e2e fakes and specs), dependsOn u1, u2, u3.
  - `e2e/fake-hosts/gh` and `e2e/fake-hosts/glab`, answering from
    `$AGENTRY_DATA_DIR/fake-hosts/<name>.json` like `fake-providers`, with a README.
  - `e2e/run.mjs` seeds `hosts.json` with their binary overrides.
  - Specs for Integrations (states, refresh, binary override), a GitLab project's item approved
    into "MR !7", and the orchestration's "Open merge request".
  - Written, **not run**.
  - Files: `e2e/fake-hosts/*`, `e2e/run.mjs`, `e2e/specs/integrations.spec.mjs`,
    `e2e/specs/merge-requests.spec.mjs`.
- Every string goes through i18n with `en`/`es` parity and the glossary. Phone layout, both themes
  and motion levels follow the design system.

When P2 is merged into the branch: the full checks and one e2e by the owner's assistant, the plan's
Outcome, `docs/status.md`, then one pull request to `main`.

### How each task proves there is no drift for GitHub

- **The golden logs.** Recorded by `c0` against today's code, they are the contract for `c4` and
  `c8`: git's and gh's calls, arguments, stdin bodies and the three gh env variables, in order.
  They must stay byte for byte identical, with two **intended** differences, each an edit of its
  expected log reviewed in `c8`'s result:
  1. Scenario 6: an enterprise host gh does not know no longer receives
     `gh auth status --hostname <host>`. Detection reads `hosts.yml` instead, which is the point of
     "never send an unknown host to a CLI".
  2. Today's fixtures use a local bare repository as `origin`, which has no host, and today that
     path ran `gh auth status` with no `--hostname`. In production a host-less `origin` is now
     `unsupported-host`. So `pr-harness.ts` (in `c8`) injects the remote as `github.com` for the
     tests only, and the auth line in scenarios 1 to 5 and 7 to 11 gains `--hostname github.com`.
     That is the one line allowed to change there, and `c8` lists it.
- **`ciOf`'s table** runs unchanged against the github adapter (`c4`).
- **The existing suites** (`pull-requests.test.ts`, the API's `work-item-pull-requests.test.ts`,
  the web's) pass with reason names changed through the table and nothing else (`c8`, `u0`).
- **Timeouts, TTLs and back-off** are constants moved unchanged: 60 s readiness, 60 s watch, 5 min
  back-off, 2 min claim, 60 000-character body, 72-character title. A test asserts their values.
- **Behaviour changes that are intended** are listed, not hidden:
  - the reason names;
  - the unknown enterprise host above;
  - the orchestration PR gaining readiness, `--base`, a row and polling;
  - an scp-style remote without a user is now recognised (today it read as host-less).

### Risks

- **`c1` breaks typecheck downstream until `c8` and `u0`.** They are dependents, and the
  integration branch checks the whole once at the end. A worker between them is told to expect it.
- **`pull-requests.ts` is large and central.** Only `c8` edits it. The adapters are written before
  it, beside it, and proved by the conformance suite, so `c8` is wiring, not new logic.
- **The GitLab facts are partly unconfirmed.** The glab adapter is built against documented API
  field names and marked `degraded: version-untested`. Owner question 1 turns this into recorded
  truth.
- **`ssh -G` runs `Match exec`.** It runs the person's own config, as `git fetch` does. It gets a
  5 s timeout, and its failure keeps the alias.
- **Reading the CLIs' config files could touch tokens.** The readers keep only host keys and `user`,
  and a sentinel test enforces it (`c3`).
- **Two processes open the same orchestration's change request.** The partial unique index and
  `BEGIN IMMEDIATE` guard it (`c9`).
- **Paid automation is untouched:** no flow run pushes (`stageRules` still denies `git push`); a
  change request is only opened on a person's approval or click; merging stays the person's, on
  the host.

## Open

- **Phase 1, for the owner** (asked 2026-09-30, answers go here):
  1. How the glab facts marked unconfirmed become confirmed: install `glab`, sign in to gitlab.com
     and record real outputs from a scratch project before `c5` (recommended), ship GitLab as
     `degraded: version-untested` and record later, or hold GitLab out of phase 1.
  2. The base of an orchestration's change request: the default branch, which is what `gh`
     picks today without `--base` (recommended for phase 1), the branch the checkout was on
     when the graph started, or a choice in the push dialog.
  3. A project's host: detected only, shown in its settings (recommended for phase 1), or also
     pinned there (host, and then remote) for a host both CLIs know or an alias `ssh -G` cannot
     resolve.

- Whether the multi-provider first-run step and this one's integrations line ship together, or
  this one waits for its own delivery.
- Jira Server and Data Center, if `acli` does not reach them.

## Related

[[plans/multi-provider.md]] · [[providers.md]] · [[work-items.md]] · [[plans/work-item-pull-requests.md]] · [[team-and-flow.md]] · [[decision-engine.md]]
