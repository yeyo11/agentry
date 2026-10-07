---
created_at: 2026-10-01T09:00:00Z
updated_at: 2026-10-06T12:00:00Z
tags:
    - code-hosts
    - pull-request
    - detection
    - architecture
    - convention
    - checks
    - logs
    - reviews
    - merge
    - webhooks
    - pacer
---
# Code hosts

A **code host** is where a project's repository lives and where its change requests are opened:
GitHub, reached through `gh`, and GitLab, reached through `glab`. This document is the reference for
what a code host is, how Agentry decides whether a project can open a change request, what every
call to the CLIs goes through, and how to add a host. The reasons, the evidence behind each
argument and the order of work are in [plans/code-hosts.md](plans/code-hosts.md); if the code
differs from this page, the code wins and this page is stale.

Status: phase 1 is built (detection, neutral readiness, the execution layer, the `CodeHost`
interface with its two adapters, the work item and orchestration change requests on it, the
`/hosts` routes). Phase 2 is built in `packages/core` (checks, logs, re-run, cancel, manual jobs and
fixing failing checks, described in [Checks, logs and fixing](#checks-logs-and-fixing)); its routes
and screens come with the tasks that own them. Phase 3 is built in `packages/core` and the
contract (review threads, drafts, posting, reply and resolve, approval, reviewers, Address with an
agent), described in [Reviews](#reviews); its routes and screens come with the tasks that own them.
Phase 4 is built in `packages/core` and the contract (the merge state and its blockers, Merge,
Auto-merge, Update from base, the GitLab pipeline guard, auto-merge turned off before Agentry
pushes, the audit), described in [Merging](#merging); its routes and screens come with the tasks
that own them. Trackers (GitHub and GitLab Issues) are described in [trackers.md](trackers.md); phase 6, the pacer and webhooks, is described in [Events and paced polling](#events-and-paced-polling).

In shared types and in this document "pull request" means a PR or an MR: the host decides the word
(`#12` on GitHub, `!12` on GitLab).

## The rule a code host lives under

Agentry reaches each tool **only through the interface its vendor ships for programs**: for a code
host, its CLI and the CLI's own `api` subcommand, which calls the host's documented API with the
CLI's login. The rule is stated in [CLAUDE.md](../CLAUDE.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md). So:

- there is **no REST client of Agentry's own** and no token of Agentry's own for a code host;
- no second login: the session is the one the person already has in `gh` or `glab`;
- **no agent ever pushes.** `stageRules` in `packages/core/src/flow.ts` keeps `git push` denied; the
  push is Agentry's own process, after the person approved.

## What a code host is

One folder in `packages/core/src/hosts/<id>/`, made of:

- a **manifest** (`manifest.ts`): data, read by the registry, the detector and readiness;
- an **adapter** (`adapter.ts`): a stateless translator from `CodeHost` calls to one CLI's
  arguments and JSON. It runs nothing: it returns a `HostCall` and parses what came back.

The registry (`hosts/registry.ts`) is keyed by id. `CodeHostId` is a closed union
(`'github' | 'gitlab'`), unlike providers: adding a host is a code change. The manifest declares:

| Field | What it holds |
|---|---|
| `id`, `label`, `cli` | Identity and the one binary the host is reached through (`gh`, `glab`) |
| `versions` | The arguments that print the version, the `minimum` release Agentry works with, the `recorded` releases every fact comes from, and what a newer unrecorded release reads as (`untested`: `ready` or `degraded`) |
| `auth` | How the CLI says it is signed in: `hosts-json` (gh: one call lists every host, so it is also gh's list of known hosts) or `exit-code` (glab: one call per known host, read by its exit code only) |
| `defaultHosts` | Hosts matched without asking the CLI: `github.com`, `gitlab.com` |
| `configHome` | The CLI's own configuration directory and the variable that moves it, watched for sign-ins |
| `install`, `signInUrl`, `docsUrl` | The vendor's pages, the remedies readiness offers |
| `refPrefix`, `changeRequestNoun` | `#` and "pull request", or `!` and "merge request" |

| | GitHub | GitLab |
|---|---|---|
| CLI | `gh` | `glab` |
| Minimum | 2.92.0 (the owner's floor) | 1.120.0 |
| Recorded on | 2.92.0, 2.102.0 | 1.120.0 |
| Newer, not recorded | ready | degraded |
| Auth probe | `gh auth status --json hosts`: exits 0 in every case; a host's `state` is `success` or `error`, no token gives `{"hosts":{}}` | `glab auth status --hostname <known host>`: 0 signed in, 1 not; stdout is empty and the status is on stderr, which is never read |
| Hosts it knows | keys of that same output | host names of the `hosts:` map in `config.yml` |
| Change request | `#12` | `!12` |

Every fact is **checked, not guessed**: each manifest and adapter cites in a comment where it comes
from, and the recordings are committed as fixtures (below).

## The `CodeHost` interface

`packages/core/src/hosts/code-host.ts`. The adapter's methods build calls and parse answers:

- `env()`: what to set and what to remove in the CLI's environment;
- `version()`, `parseVersion()`;
- `authStatus(hostname)`, `parseAuth()`;
- `defaultBranch(repo)`, `parseDefaultBranch()`;
- `create(repo, { head, base, title, body })`;
- `find(repo, { head, base })` and `parseFind()`: the exact lookup after a create, and whenever a
  write's effect must be found;
- `view(repo, number)` and `parseView()`, which gives a `ChangeRequestView`: `number`, `url`,
  `state` (`open | merged | closed`), `mergedAt` and the rolled-up `ci`. A shape the parser cannot
  read throws `HostParseError`.

`HostRepo` is what pins every call: the host name, the path, the owner and the name, and GitLab's
numeric project id once known.

Returning calls instead of running them keeps the adapters pure: the conformance suite checks them
without a process, and the service runs them through the execution layer.

The rolled-up CI, per host:

| Agentry | GitHub (`statusCheckRollup`) | GitLab (`head_pipeline.status`) |
|---|---|---|
| `none` | no checks | no `head_pipeline` |
| `failing` | a conclusion or state of `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `ERROR` | `failed`, `canceled`, `canceling` |
| `pending` | a check run not `COMPLETED`, or a state of `PENDING`, `EXPECTED`, `QUEUED`, `IN_PROGRESS` | `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`, `running`, `scheduled`, `manual`, and any status not listed |
| `passing` | all succeeded or skipped | `success`, `skipped` |

A GitLab `manual` pipeline waits for a person, so it reads as `pending`, not as `failing`. `locked`
reads as `open`.

## The execution layer

Every call to `gh` and `glab` goes through `packages/core/src/hosts/exec.ts` (`runHostCall`). **No
other file spawns them.** A `HostCall` is `{ cli, args, input?, kind, class, host, bucket? }`; a
`HostResult` is `{ exitCode, stdout, stderrFirstLine, http, truncated, durationMs }`.

**Process.** `spawn` with `shell: false` and the arguments as an array, in its own process group so
the whole tree can be killed (a `gh` on PATH is often a shim). On a timeout the group gets
`SIGTERM`, then `SIGKILL` 5 s later. stdin is always given, empty and closed when there is no body,
so no CLI waits on a terminal. Timeouts per class: `probe` 15 s, `read` 60 s, `log` 60 s, `write`
120 s, `long-write` 180 s. stdout is read up to 32 MiB; a log keeps a tail of 512 KiB while
streaming; stderr keeps its first 8 KiB.

**Environment** (`hosts/env.ts`), on top of the process environment:

| | gh | glab |
|---|---|---|
| Set | `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `GH_PAGER=cat`, `GH_TELEMETRY=0`, `DO_NOT_TRACK=1` | `GLAB_NO_PROMPT=1`, `GLAB_CHECK_UPDATE=false`, `GLAB_SEND_TELEMETRY=false` |
| Both | `NO_COLOR=1`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` | same |
| Removed | `GH_HOST`, `GH_REPO`, `GH_FORCE_TTY`, `GH_DEBUG`, `DEBUG`, `CLICOLOR_FORCE` | `NO_PROMPT`, `GITLAB_HOST`, `GL_HOST`, `GITLAB_URI`, `DEBUG`, `GLAB_DEBUG` |

gh's telemetry is on by default and names the calling agent; `GH_HOST` overrides a host-less
`-R`. Tokens the person keeps in the environment (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
`GITLAB_TOKEN`) are left alone: they are the person's session, and pinning the host is what keeps
them from going anywhere else.

**Pinning the host.** Every repository call carries the host: gh's `-R <host>/<owner>/<repo>`,
glab's `-R https://<host>/<path>` (the URL form, because `group/sub/project` is ambiguous with a
host prefix), and `--hostname <host>` on `api` calls, with a relative path. **No absolute URL is
ever passed to `api`** (glab accepts one); a lint test fails on any adapter that builds one.

**stdout, stderr and the exit code are three things.**

- stdout is the data, parsed only when the exit code is 0; the exception is the host's documented
  error body, of which only the structured fields (HTTP status, `errors[]`, rate-limit headers) are
  read.
- **stderr is never parsed for a decision.** Its first line, redacted, is kept as the detail the
  person reads beside Agentry's own sentence.
- Decisions come from the exit code, structured stdout and a re-read of the state. A failed create
  is followed by `find` by head and base, and exactly one open result is adopted.

**Writes are never retried.** `hosts/classify.ts` says from the arguments alone whether a call is a
write (a porcelain verb such as `create`, `merge`, `close`; `api` with a method other than `GET`, or
with `-f`, `-F` or `--input`; a GraphQL `mutation`). Adapters declare `kind` themselves, and a test
fails when the two disagree. **Reads are retried** at most twice (1 s, then 4 s, 90 s in all) on a
timeout, a 5xx or a non-zero exit with no structured client error; never on 401, 403, 404 or 422,
and never while the host's breaker is open. Probes are not retried: a signed-out `glab auth status`
exits 1 like an unreachable host.

**Rate limits, per host.** Headers and `Retry-After` open a breaker for a (host, bucket) until the
reset, or for a doubling wait from 60 s up to 15 min on a secondary limit. Background polling
pauses below 50 remaining on GitHub's core and graphql buckets, 5 in search and 5 % on GitLab. The
breaker lives in SQLite (`host_rate_limits`) because two Agentry processes share the data
directory. A limit on one host never stops another. At most 4 processes per CLI run at once, queued
30 s (`busy`).

**Secrets.** `hosts/redact.ts` runs on every stderr line kept and every stored detail: token
patterns, `Authorization` headers, e-mail addresses except `noreply` ones. Secrets never enter
argv; bodies travel on stdin.

## How a project's host is detected

1. **The remote.** `git remote get-url origin` (which expands `insteadOf`). `hosts/remote.ts`
   parses `https://`, `ssh://`, scp-style `[user@]host:path` and `git://` URLs. The user and secret
   of a URL are dropped at once and never stored, logged or served. A local path has no host.
2. **SSH aliases.** An SSH remote goes through `ssh -G <alias>`, which prints the configuration
   without connecting; its `hostname` line is the real host (`ssh.github.com` folds to `github.com`,
   `altssh.gitlab.com` to `gitlab.com`). Without `ssh`, after 5 s, or with no `hostname` line, the
   alias is kept. A `Match exec` block in the person's SSH config runs on `ssh -G`, as it does on
   every `git fetch`.
3. **Which CLI.** `github.com` is GitHub and `gitlab.com` is GitLab. Any other host is looked up
   **locally** in the CLIs' own lists: the keys of `gh auth status --json hosts`, and the `hosts:`
   map of glab's `config.yml` (`GLAB_CONFIG_DIR`, then `~/.config/glab-cli`, then
   `XDG_CONFIG_HOME/glab-cli`). A host both know goes to GitHub. **A host in neither, a host with a
   port, or no host is `unsupported-host`, and no CLI is called**: a token in the environment must
   never go to a host nobody chose.
4. **glab's config file is read for host names only** (`hosts/known-hosts.ts`, plus the `user` of
   each host). A token line is never read into memory; a test gives it a file whose token is a
   sentinel and checks it appears in no output.

Enterprise and self-managed instances work the moment the person's `gh` or `glab` is signed in to
them.

## Readiness

`projectReadiness` (`hosts/readiness.ts`) answers `ready` or one reason, stopping at the first check
that fails. The answer is cached for 60 s per project, so a board read does not run an auth probe.
It runs its **own** `--version` and auth probe and never reads the detector's cache, so the calls a
CLI receives for a project are the same every time. It comes back as `PullRequestReadiness`: the
`status`, a raw `detail` line, the `defaultBranch`, the `host`, the `hostname` and a `remedy`.

| Order | Reason | When | Remedy (a link, never a command) |
|---|---|---|---|
| 1 | `not-git` | the path is not a git repository | none |
| 2 | `no-remote` | there is no `origin` | git's page on remotes |
| 3 | `unsupported-host` | no host, a ported host, a host neither CLI knows, or the host's CLI is turned off in Settings | Settings → Integrations |
| 4 | `cli-missing` | the host's CLI is not found (override, PATH, then install directories) or `--version` fails or is unreadable | the CLI's install page |
| 5 | `cli-incompatible` | the version is below the manifest's minimum | the CLI's install page |
| 6 | `cli-signed-out` | the auth probe says no for the host | the CLI's sign-in docs |
| 7 | `no-default-branch` | neither `git symbolic-ref --short refs/remotes/origin/HEAD` nor the CLI names it | the CLI's docs |
| 8 | `ready` | — | none |

The old reasons are replaced as follows; a web client newer than its server maps what it receives.

| Old | New |
|---|---|
| `not-github` (a host `gh` did not know) | `unsupported-host` |
| `not-github` (`gh repo view` refused) | `no-default-branch` |
| `no-gh` | `cli-missing` |
| `gh-unauthenticated` | `cli-signed-out` |

Nothing stored uses these values: failed rows record the step that failed (`fetch`, `merge`,
`push`, `create`, `commit`), so no migration was needed.

### The CLIs' own status

Settings → Integrations shows one `CodeHostStatus` per host (`GET /hosts`): state (`ready`,
`degraded`, `signed-out`, `incompatible`, `not-installed`, `unknown`), reason (`version-untested`,
`below-minimum`, `no-hosts`, `probe-failed`, `timeout`), version, minimum and recorded releases,
and the hosts the CLI knows with their signed-in user. `ready` here means the CLI is installed, in
range and signed in to at least one host; a project's readiness is a separate question. The
detector (`hosts/detector.ts`) reuses the provider pieces: `providers/path.ts` for the binary, one
cache with a 5 min TTL, debounced watchers on the PATH directories and the CLIs' config
directories, and `hosts.changed` only when a status really changed. Saving `hosts.json` (enabled
and a binary override per host) re-detects and clears every project's readiness cache.

## Parity rules

What the service guarantees for GitHub and GitLab alike:

- **One flow, two adapters.** `PullRequestService` (`packages/core/src/pull-requests.ts`) runs
  commit → fetch → merge base → push → create → find. Every `git` call stays git's; every host
  call goes through `runHostCall`. Nothing in the service names `gh` or `glab`.
- **GitHub behaves as it did, except where listed.** The golden logs under
  `packages/core/test/fixtures/golden/phase1/` pin every call of the GitHub scenarios (argv, the
  env variables the layer sets, stdin). They changed only by declared rewrites: the `-R
  <host>/<owner>/<repo>` pin on every `pr` call, the new env lines, `auth status --json hosts`,
  the default branch from `gh api --hostname <host> repos/<owner>/<repo>`, the lookup after a
  create as `pr list … --head --base --state all --limit 2`, and an unknown enterprise host
  receiving no call. A later change to those logs is an intended difference and is named in the
  change's description. GitLab has its own logs in `golden/phase1-gitlab/`.
- **A create is followed by a lookup.** One open result for the head and base is adopted; none
  records the `create` step with the CLI's first line.
- **GitLab accepts an empty merge request**, GitHub refuses one. Agentry checks the commits ahead
  of the base itself before it creates either.
- **The work item and the orchestration share the service.** Both open their change request through
  it, are watched by the same loop (a list of sources, each with its rows, claim and outcome), and
  announce a merge or a close.
- **A row records its host.** `work_item_pull_requests` and `orchestration_pull_requests` carry
  `host` and `hostname`; rows from before the column read as `github`. An orchestration that
  already had `integration.pullRequestUrl` gets no row and is not watched.
- **Copy follows the host.** The web words the noun, the number prefix and the host's label from
  the row, never "GitHub" or "gh" in a project's copy.

## Checks, logs and fixing

Phase 2 adds what a change request's CI says and what Agentry does about a failure. Every argument
below is one the recordings show (`k0-NOTES.md`, `gh/NOTES.md`, `glab/NOTES.md`); where a recording
disagreed with the plan's matrix, the recording won.

### The model

A `Check` (`packages/shared/src/types.ts`) is one row of a change request's CI, whatever the host
calls it: `id`, `name`, `group` (a GitHub workflow, a GitLab stage, or the bridge a child job hangs
from), `state` (`queued`, `running`, `passed`, `failed`, `cancelled`, `skipped`, `manual`,
`neutral`), `allowedToFail`, `required`, `startedAt`, `finishedAt`, `url`, `rerunnable`, `hasLog`
and `source` (`actions`, `app`, `status`, `job`, `bridge`). `ChangeRequestChecks` carries the head
commit, the `rollup` (`none`, `pending`, `passing`, `failing`), the checks, `truncated` (at most
1 000 checks) and `checkedAt`, plus `limitedUntil` when the host's rate limit was hit and the last
list is what is shown.

- **A failure the pipeline lets pass is not a failure.** A GitLab job with `allow_failure` that
  failed is `failed` with `allowedToFail`; a fix is made of the failures without it.
- **`required`** is marked from the base branch's rules on GitHub (`rules/branches/<base>` and
  `branches/<base>`, whichever the viewer can read; when neither can be read nothing is marked) and
  never on GitLab, where the whole pipeline is the requirement.

### What each host is asked

| Question | GitHub (`gh`) | GitLab (`glab`) |
| --- | --- | --- |
| The change request, for the watcher | `gh api -i graphql`, one query for state, head, mergeability, review decision and the rollup's contexts | `glab mr view -F json` |
| The list | `api --paginate --slurp repos/{o}/{r}/commits/<sha>/check-runs?per_page=100` and `…/status?per_page=100` | `api projects/<id>/pipelines/<pipeline>/jobs?per_page=100`, `…/bridges?per_page=100`, then the jobs of each bridge's child pipeline |
| A log | `api repos/{o}/{r}/actions/jobs/<id>/logs`, with `--allow-escape-sequences` from gh 2.97.0 (2.102 refuses a log with ANSI codes without it; 2.92 does not know the flag) | `api projects/<id>/jobs/<id>/trace` (never `glab ci trace`, which follows a running job) |
| Annotations | `api repos/{o}/{r}/check-runs/<id>/annotations?per_page=100` | none: the person reads `failure_reason` and the log |
| Re-run failed | `run rerun <run> --failed` per run (at most 20) | `ci retry <job>` per failed job, or `api -X POST jobs/<bridge>/retry` for a bridge (at most 100) |
| Re-run one | `run rerun --job <id>` | the same single retry |
| Run everything again | `run rerun <run>` per run | `api -X POST merge_requests/<iid>/pipelines` when the head pipeline came from a merge request event, else `ci run -b <branch>` |
| Cancel | `run cancel <run>` per live run | `api -X POST pipelines/<id>/cancel` |
| A manual job | none: the check links to its run page | `ci trigger <job>` |

- **GitLab walks bridges itself**, at depth 2 and for at most 20 child pipelines.
  `glab ci get --merge-request` has neither bridges nor child jobs, and the jobs endpoint lists
  neither. A bridge is a check with `source: 'bridge'` and no log; `downstream_pipeline` can be
  `null` when the child could not be created, and then the bridge is a failed check of its own.
- **"Re-run failed" on GitLab retries each failed job**, not the pipeline: a pipeline retry does not
  re-run a failed bridge, and a child's jobs are not in the parent pipeline.
- **A cancel is re-read, not waited for**: GitLab answers `running`, then `canceling`, never
  `canceled` at once. Cancelling a parent cancels its bridge and child.
- **Playing a manual job keeps its id**; only a retry creates a new one.
- **The watcher's GitHub read is `gh api -i`**, so a failed poll has a status line and the
  rate-limit headers on stdout (only the message is on stderr, exit 1). A GraphQL not-found is
  `HTTP/2.0 200` with `errors[]` and exit 1, so the status line never decides alone. GitLab's
  failures classify as `unreachable` unless the `{"error"}` body says more.

### The checks service

`hosts/checks-service.ts` runs the adapters' calls and owns the state around them.

- **The list is a snapshot of the head commit**, cached 30 s in `change_request_snapshots`, so the
  board and two tabs share one read, and two reads of one id in flight are one. A new head is a new
  list. A read that hits the host's rate limit serves the last list with `limitedUntil`.
- **Every write is one at a time per change request, never retried, and followed by a re-read.** What
  the CLI printed is never the new state. Re-run, cancel and play are writes; an exit 1 on a run
  still going or on an older attempt is `rerun-refused`; a cancel of a run that finished meanwhile is
  a success when the re-read says nothing is live.
- **The event** `change-request.checks` (`changeRequestId`, `rollup`, `headSha`) is sent when the
  rollup or the head changed, and after every write.
- **Reasons** this phase added to `HostReason`: `log-unavailable`, `rerun-refused`,
  `check-not-rerunnable`, `nothing-to-fix`, `fix-in-progress` and `fix-attempts-spent`. The fix's
  own refusals carry the codes listed below.

### Logs

`hosts/log-tail.ts` turns a job's log into what a person, and a fixing chat, reads. The execution
layer already bounds the log to its last 512 KiB; the tail keeps the last 200 lines (16 KiB), plus
20 lines either side of the first three error markers (GitHub `##[error]`, GitLab `ERROR:` and a
non-zero `exit code`), each line cut at 500 characters and then redacted.

- It strips the BOM, escape sequences (raw ESC and the `^[` rendering gh prints), other control
  characters, carriage-return overwrites (a progress bar leaves its last frame), GitLab's
  `section_start` and `section_end` markers and GitHub's layout markers (`##[group]`,
  `##[endgroup]`, `##[command]`, `##[section]`, `##[debug]`; a line that held only one goes with
  it). `##[error]` stays: it is what the tail and the page find errors by. It never depends on GitHub's step labels, which read
  `UNKNOWN STEP` a few hours after a run.
- **"No output yet" is not "log unavailable".** A running job's trace lags up to about a minute
  (only the runner's preamble first), and a manual job's trace is empty with exit 0. Both come back
  as `noOutputYet`. `log-unavailable` is a 404, or a check without a log (a bridge, or another
  app's check).

### Fixing failing checks

A work item's fix mirrors the conflict path. `PullRequestService.fixChecks(itemId, origin)` starts
it from an open change request:

1. It reads the failures through the service and builds the prompt with a log tail for each, at
   most 10. No failure is `no-failing-checks`.
2. The row stays `open` and gains `fix_state = 'fixing'`, `fix_origin` (`person` or `decision`),
   `fix_attempts` (counted per head) and `fix_head`. The item moves to In progress with the cause
   `pr.checks-fix`, as the person for a click and as the system for the decision. With the flow off
   nothing moves: the person gets the prompt for a chat of their own, in the item's worktree.
3. The Developer's run ending well makes it `awaiting-verify`; QA verifies as usual.
4. QA passing: a **person's** fix pushes at once, with no second click, unless a person moved the
   card since it started (that clears the fix state; the attempts stay counted). A **decision's**
   fix becomes `awaiting-push`, the item waits in In review, and the button reads **Push the fix**.
5. `pushFix` commits what the Developer left uncommitted and runs a plain `git push`, never forced.
   A failure leaves `awaiting-push` with `error_code: 'push'`, so the button retries. A success
   clears the fix state, drops the snapshot (the head moved) and sets `waiting: 'merge'`.

Refusals are a `PullRequestError` with a reason: `not-open`, `fix-under-way`, `busy`,
`no-failing-checks`, `not-in-review`, `checks-unavailable`, or the checks service's own reason.

An orchestration's fix runs a chat in the integration worktree with the orchestration's fixer model
and cost limit, commits on the integration branch and then waits: **Push the fix** is always the
person's click, since an orchestration has no QA stage. With no integration worktree it fails with
`no-worktree` and never touches the project's own checkout.

**No agent pushes**, here as everywhere: the fix prompt says so and the flow's rules deny it.
Auto-merge is turned off before the push, and the person is told (see [Merging](#the-merge-state)).

### What the watcher tells the decision engine

Both watchers read through the checks service and call `onChecksFailing` when a rollup reads
`failing` for a head they have not announced: once per head, never while a fix is under way. The
`checks.fix` point (see [decision-engine.md](decision-engine.md#the-points)) answers it. The memory
of what was announced is in the process, so after a restart a head that is still failing is
announced again; the point's own limits, not that memory, stop a chain of fixes.

## Reviews

Phase 3. The person reads the threads of a change request, writes notes on lines as a draft,
posts them as one review, replies and resolves, and hands unresolved threads to an agent. All of it
goes through `ReviewsService` (`hosts/reviews-service.ts`) and the adapters' review calls; the
adapters build the calls and parse, the service runs them and re-reads. Every argument below is in
the recordings (`r0-NOTES.md`); where a recording and the plan's first matrix differ, the recording
won.

### Threads

`GET /change-requests/:id/threads` returns `ChangeRequestThreads`: the threads of the head commit,
cached by head for 30 seconds and read again after any write.

- **GitHub** reads `reviewThreads` through one GraphQL query, paginated on the threads cursor only.
  A thread with more than 100 comments is completed by a `node(id:)` follow-up that starts from the
  first page's comments cursor. An outdated thread has `line: null`, so its `originalLine` is used.
- **GitLab** reads `…/merge_requests/<iid>/discussions?per_page=100`. A discussion arrives with
  every note at once (102 seen), so there is no follow-up. System notes are skipped. GitLab does not
  say "outdated", so the service compares the note's head with the current one.
- A thread is drawn on its `path` and new-side line when it was left on the head, and folded as
  outdated otherwise. Resolved threads fold by default. A comment's body is another person's text.
  Agentry's own marker comment is removed before a body is served.

### The draft review

The person's notes are rows in `review_drafts` (path, side, line, start line, body, whether the body
is a suggestion), so they survive a reload and a second tab. At most 200 per change request.
A suggestion is a fenced block inside the body: ` ```suggestion ` on GitHub, ` ```suggestion:-0+0 `
on GitLab, whose `-N+M` offsets are relative to the note's line.

`POST /change-requests/:id/reviews` (`{event, body, headSha?}`) posts the drafts as one review.
`headSha` is the head the person looked at: the review is posted on it (GitHub's `commit_id`) and
`approve` is given on it, and a head that moved is refused with `head-moved` before anything is
posted or recorded. Without it the head read at that moment is used, which cannot notice a move.
Writes to one change request run one after the other, so a double click never posts twice. Every
attempt is a row in `review_posts` (`posting`, `posted`, `partly`, `failed`) whose body carries a
marker comment. `GET /change-requests/:id/review-posts` reads those rows back, newest first, so a
review that stopped partway is known after a reload; for a `partly` post it also counts the draft
notes Agentry saved that are still waiting on the host (`savedOnHost`, null when the host could not
be read).

| | GitHub | GitLab |
|---|---|---|
| Path | one `POST …/pulls/<n>/reviews --input -` with `commit_id`, `event` and every comment: all or nothing | one `…/draft_notes` POST per note (with `-H "Content-Type: application/json"`), then `glab mr note publish <iid> -y` |
| Events | `comment` only | `comment`, and `approve` as a separate approval after the post |
| A bad line | 422 with `errors: ["Line could not be resolved"]` → `line-not-in-diff`; nothing posted | **accepted silently** by the draft POST and dropped silently by publish, so the service checks every line against the diff before creating the draft and counts the notes after publishing |
| A timeout | looks for the marker in the reviews list, then the threads | looks for the marker in note bodies (a published general draft is a resolvable discussion, `individual_note: false`, not a review) |
| Partial failure | none | a note that fails after others were saved → `review-partly-posted`; **Publish saved** (`…/reviews/:postId/publish-saved`) or **Discard saved** (`…/discard-saved`). `glab mr note publish` cannot publish selectively (it sends every draft note of the viewer), so Publish saved is refused with `pending-review-exists` while a draft Agentry did not save is waiting. A publish that sends fewer notes than were saved drops the rows of the notes that went out and keeps the rest |

A post is refused while a pending review is in the way: a GitHub review in state `PENDING` by the
viewer, or any GitLab draft note (`pending-review-exists`, whose detail names the count and the
host). Agentry deletes only the drafts it saved itself and only after the person chose Discard: a
`partly` post records the ids of the draft notes it saved (`detail.draftIds`), and Discard deletes
those and the note carrying the post's marker, never another draft note of the viewer's; it never
deletes a pending review of theirs.

**Request changes is not offered**, on either host. GitHub's `APPROVE` and `REQUEST_CHANGES` success
paths were never recorded (owner decision 1), so the review bar links to the host as "Open on
GitHub"; GitLab has no recorded CLI path for request changes. A `requested_changes` state is still
read, and still blocks a merge.

### Reply, resolve, approval, reviewers

| Action | Route | GitHub | GitLab |
|---|---|---|---|
| Reply | `POST …/threads/:threadId/reply` | `POST …/pulls/<n>/comments/<commentId>/replies --input -` | `POST …/discussions/<id>/notes --input -` with the JSON content type |
| Resolve, unresolve | `POST …/threads/:threadId/resolve`, `…/unresolve` | GraphQL `resolveReviewThread`, `unresolveReviewThread` | `glab mr note resolve` / `reopen <iid> <discussionId>` (iid first) |
| Approve, revoke | `POST` and `DELETE …/approval` | not offered | `glab mr approve <iid> --sha <head>`, `glab mr revoke <iid>` |
| Reviewers | `POST …/reviewers` (`{add, remove?}`) | `POST …/requested_reviewers --input -` | `glab mr update <iid> --reviewer +user,-user` |

- A reply carries a marker, so a timeout is settled by looking for it. On GitHub a 422 on a reply is
  the person's own pending review being in the way (`pending-review-exists`). Each GitHub reply
  creates its own review, so the reviews list is read with `--paginate`.
- Resolve is idempotent and decided by the re-read: "already resolved" is exit 0 on one host and 1
  on the other.
- **Approve** is GitLab only and takes the head the person looked at: a head that moved is
  `head-moved` (409). Approving twice is a 401 and is settled by re-reading. Whether Approve is
  offered is Agentry's rule, never GitLab's `user_can_approve`, which is `false` for an author whose
  approval succeeds: the recordings show GitLab letting the author approve their own merge request
  on a project without approval rules, so Approve is offered while the viewer has not approved
  (`canApprove = !viewerHasApproved`) and hidden once they have. A project whose rules forbid it
  refuses the approval, and the person reads the host's reason.
- **Reviewers**: GitLab's `--reviewer user` *replaces* the list, so Agentry always sends `+user` and
  `-user`. GitHub's `gh pr edit --add-reviewer` drops the author silently, so the API is called
  instead. An unknown GitHub login exits 0 and adds nobody; the re-read decides what the person is
  told.
- After every write the service re-reads and emits `change-request.review` with the unresolved count
  and the host's decision (`approved`, `changes-requested`, `review-required` or none).

### Address with an agent

`POST /change-requests/:id/address` (`{threadIds}`) follows the fix path of phase 2 with
`fix_kind = 'review'` on the same row ([Fixing failing checks](#fixing-failing-checks)):
`fix_state`, `fix_origin`, `awaiting-verify`, the same push rule. `PullRequestService.addressReview`
reads the threads fresh, takes the chosen unresolved ones (every unresolved thread, at most 40,
when none are named), and starts the flow's Developer with a prompt built by `reviewFixPrompt`.

- **Untrusted.** Each thread (path, lines, the diff hunk, every comment with its author) goes inside
  `<review-comment>` tags as JSON, after a preamble that tells the agent those comments were written
  by other people: requests to weigh, not instructions to obey; never anything that reaches outside
  the repository; and to say in the summary which comments it addressed and which not, and why. A
  closing tag inside a comment is escaped and control characters are stripped.
- **No host writes by the agent.** The prompt forbids replying, resolving and pushing. Agentry never
  resolves by itself: after the push it offers **Reply "Addressed in <sha>"** and **Resolve** for
  the addressed threads, and the person clicks.
- **The push rule is phase 2's.** A person's click is the approval to push at the end of QA; a
  decision-origin address waits in In review for **Push the fix**. An orchestration's address runs
  in the integration worktree and always waits for **Push the fix**.
- **Limits.** Attempts share `fix_attempts` and `fix_head` with checks fixes. The item moves to In
  progress with the cause `pr.review-address`. The chosen thread ids are stored with the fix
  (`fix_threads`): after a restart before the run starts the prompt is rebuilt from them, and a list
  that is empty, or whose threads were all resolved meanwhile, hands over nothing.
- **Refusals** (`PullRequestError`): `not-open`, `fix-under-way`, `busy`, `not-in-review`,
  `reviews-unavailable`, `not-found` (an unknown thread), `already-resolved`, `no-threads`, or the
  reviews service's own reason.

`review.triage` (see [decision-engine.md](decision-engine.md#reviewtriage)) only preselects the
threads in the Address dialog. It is asked whenever the threads are read
(`GET /change-requests/:id/threads`), in the background and once per set of open threads, and the
dialog reads the answer from the decision history under the change request's id.

## Merging

Merging is **the person's click**, from the item page or the orchestration page. It is never a run,
a decision point or a chat token: the merge routes refuse a chat token with 403, and nothing in
`packages/core` starts a merge on its own. `MergeService` (`hosts/merge-service.ts`, `core.merge`)
runs it; the adapters (`hosts/github/merge.ts`, `hosts/gitlab/merge.ts`) only build calls and parse.
The reasons and the evidence are in [plans/code-hosts.md](plans/code-hosts.md#phase-4-merging);
where the m0 recordings disagreed with the design notes, the recordings won, and this page follows
them.

### The merge state

`MergeState` (`GET /change-requests/:id/merge`) is read from the host when it is asked:

- **`methods` and `defaultMethod`**: what the repository's settings and rules allow, in the order
  squash, merge, rebase; the first is preselected. Empty means none is allowed.
- **`headSha`**: the full id of the head the person is looking at. A merge carries it back as
  `expectedHead`.
- **`blocker` and `others`**: why a merge is not offered (below). `canMerge` is true when there is
  no blocker and, on GitLab, the pipeline guard allows it.
- **`warning`**: `optional-checks-failing` on GitHub's `UNSTABLE`; Merge stays on.
- **`deleteBranchDefault`**: the repository's `delete_branch_on_merge` /
  `remove_source_branch_after_merge`, the default of the branch box.
- **`autoMerge`**: whether one may be armed (and the reason when not), and who armed it, when and
  with which method when one is.
- **`autoMergeOff`**: set when Agentry turned auto-merge off for a push of its own or for Update from
  base: `by` (`agentry` for a push, the person who clicked for an update), `at`, `why` (`push` or
  `update`) and `pushing` (the push is still going on). It is read from the audit and lasts until the
  person arms again (or the host shows it armed); the person's own disarm does not set it.
- **`waitingForPipeline`**, **`canRebaseOnHost`** and **`rebaseOnHostWhy`**: GitLab only (below).

The repository's settings, rules and required checks change rarely and are cached for 60 s.

**`computing`.** GitHub's `UNKNOWN` settles in 2–5 s, so the service re-reads after 5 s, three
times, before showing it. GitLab's `unchecked` does not: it stayed for minutes through every
`with_merge_status_recheck` read, and `has_conflicts: false` came back for a conflicting merge
request while it lasted. So on GitLab nothing is slept through: the read carries
`with_merge_status_recheck=true`, and for `unchecked` or `checking` the service reads
`mergeabilityChecks` through GraphQL and maps the `FAILED` identifiers with the same table.
`CONFLICT: CHECKING` lasts minutes to tens of minutes, so `computing` shows for 15 s after a head is
first seen and only when nothing else blocks; it is always listed after a real blocker. `unchecked`
or an unreadable GraphQL never disables Merge, and a click on a head GitLab is still checking is
tried: the attempt is what makes GitLab run the conflict check, and its refusal is explained by a
re-read. `glab mr merge` refuses in a box whose first line is `ERROR`: the adapter unwraps the whole
stderr, maps a `409` to `head-moved`, and stores the parsed message (never `ERROR`) in the audit row.

### What blocks a merge

Computed from the fields, never from a CLI's refusal text (gh computes its own refusal client-side
and glab's is a boxed stderr). The first that applies is `blocker`; the rest are `others`. The pure
functions are `githubBlockers` and `gitlabBlockers` in `hosts/merge-blockers.ts`, tested with every
recorded status, every documented `detailed_merge_status` and values nobody has seen: an unknown
value is `blocked-by-policy`. Every blocker ends in an Agentry action or a link, never a command to
copy.

| Code | Action |
|---|---|
| `not-open`, `not-yet` | none |
| `computing` | Refresh |
| `draft` | Mark ready |
| `conflicts` | Update from base |
| `behind` | Update from base; on a GitLab `ff` project, Rebase on GitLab |
| `nothing-to-merge` | Close |
| `checks-running` | Auto-merge, when allowed |
| `checks-failing` | Fix failing checks · Re-run |
| `checks-missing` | Re-run the whole run |
| `review-required` | Request reviewers |
| `changes-requested` | Address with an agent |
| `threads-unresolved` | Show unresolved threads |
| `tracker-key-missing`, `title-rejected` | Edit title |
| `external-checks`, `blocked-by-dependency`, `locked-files`, `merge-queue`, `blocked-by-policy` | Open on the host |

A conflicting merge request in a GitLab `ff` project reads `need_rebase` (`behind`), not
`conflict`. On GitHub the unresolved-thread count comes from the reviews' threads; on GitLab
`threads-unresolved` comes only from `discussions_not_resolved`.

### Merge

`POST /change-requests/:id/merge` takes `{ method, expectedHead, deleteBranch, subject?, body? }`.

1. The service writes the audit row `requested` **before** the host is called, as the person.
2. It reads the state and refuses with `head-moved` when `headSha` is not `expectedHead`,
   `method-not-allowed` when the repository does not allow the method, and the blocker when
   `canMerge` is false. A second click while one runs gets `busy`.
3. The adapter builds the call:
   - **GitHub:** `gh pr merge <n> -R <host>/<owner>/<repo> --squash|--merge|--rebase
     --match-head-commit <full id>`, with `--subject`, `--body-file -` (the body on stdin) and
     `--delete-branch` when asked. `-R` is always there; `--admin` and `--auto` are never built.
   - **GitLab:** `glab mr merge <n> -R <url> -y --sha <full id> --auto-merge=false`, plus
     `--squash` and `--squash-message`, `-m` or `-d`. `--auto-merge=false` is always passed, so
     glab's default can never turn a merge into an arming. The merge strategy (merge commit or
     fast-forward) is the project's; only squash is asked for.
4. **The re-read decides the outcome**, in this order: merged; `head-moved` (a different `sha`, or
   the 409 parsed out of glab's box); an infrastructure reason (`auth-failed`, `forbidden`,
   `not-found`, `rate-limited`, `server-error`); a blocker; `merge-failed`. Exit codes and refusal
   text are not trusted: `glab mr merge` refuses in a boxed stderr and its 405 never says why.
   `write-unconfirmed` means the host neither confirmed nor refused.
5. After a merge the service tells the owner of the row (`merged(id)`), and the existing `merged()`
   path moves the item to Done as the person ([work-items.md](work-items.md#merging-from-agentry)).
   The local branch stays. The remote branch goes only when the box was ticked or the project
   deletes it itself.

`--sha` and `--match-head-commit` take the **full** id: a short one is a 409 and would read as
`head-moved`. After a GitLab `ff` merge `merge_commit_sha` is null; the merged commit is `sha`.

### The GitLab pipeline guard

Merging a few seconds after a push merged before the pipeline attached, and the project's branch
deletion then failed the running job. So on GitLab **Merge now** is allowed only when:

- a pipeline for the head (`head_pipeline.sha` equal to the request's `sha`) exists and has
  finished; or
- there is no pipeline, the project has no CI file at the head (`git cat-file -e
  <sha>:<ci_config_path or .gitlab-ci.yml>`, after one fetch when the commit is missing), the
  project does not require a pipeline, and 90 s have passed since the last push Agentry saw.

A pipeline still running adds a `checks-running` blocker. With `only_allow_merge_if_pipeline_succeeds`
on and no pipeline the state is `checks-missing` and Merge never opens (glab refuses with
`ci_must_pass`). With a CI file present, an unreadable one or a remote `ci_config_path`, the guard
waits indefinitely and never merges ahead of the pipeline: `waitingForPipeline` is true and the
state is re-read every 10 s.

### Auto-merge

`POST /change-requests/:id/auto-merge` arms and `DELETE` turns it off; both are recorded.

- **Offered** only when the repository allows it (GitHub `allow_auto_merge`; GitLab always) and
  something is left to wait for. On GitHub that is when every blocker is one waiting clears
  (`checks-running`, `review-required`). On GitLab it is only while the head's pipeline runs. The
  reasons when it is not: `auto-merge-not-allowed`, `auto-merge-not-needed`,
  `waiting-for-pipeline`. GitHub's refusal says "not allowed" first, before a stale head, so the
  order of `head-moved` and `auto-merge-not-needed` applies only when the setting is on.
- **GitHub** arms through the `enablePullRequestAutoMerge` mutation with `expectedHeadOid`, never
  `gh pr merge --auto`, which merges at once when it can. It disarms with
  `gh pr merge --disable-auto`.
- **GitLab** arms through `glab mr merge --auto-merge --sha` and disarms through
  `POST …/cancel_merge_when_pipeline_succeeds`. glab's `status:error` answer is not trusted: the
  re-read decides whether it is armed.
- **Before Agentry pushes** to a branch (a fix, an address run, and the push that opens a change
  request onto a branch that already has one), `holdForPush(id)` reads the change request and, if
  armed, turns it off as `agentry` with the detail "arm it again". It **fails closed**: if the host
  still shows it armed or cannot be read, it throws and the push does not happen. It also **holds**
  the change request (arming, disarming, merging and updating are `busy`) until the caller calls
  `release()` when the push ends, well or not, so nobody can arm in the gap and have the host merge
  what the push brings. The person is told twice: a `change-request.auto-merge-off` event, and
  `autoMergeOff` in the state. `pull-requests.ts` (`pushFixRow`, `prepare`) and
  `orchestration-pull-requests.ts` (`pushFix`, `open`) call it. The two that open a request have no
  number yet, so they look for an open request by head and base first (one `find` call), name its
  number on the row and hold it; nothing found, or a host that cannot be asked, holds nothing.
- **Arming what is already armed** answers the state and writes no row: the audit never says the
  person armed what someone else did.

### Update from base

`POST /change-requests/:id/update-branch` is Agentry's own, in the item's checkout. It refuses with
`busy` while a chat or a run works in that checkout (an item's links, an orchestration's fixer). It
disarms first, as the person who clicked (the route passes `req.actor`; the disarm is recorded as
theirs, with the detail that Agentry updated the branch), merges the base into the branch and
pushes. A conflict aborts the merge, pushes nothing and returns the paths (409).

On a GitLab `ff` project Rebase on GitLab is the host's rebase, offered only when the checkout loses
nothing: no uncommitted changes and no commit that was never pushed (`reset --keep` after the host
rewrote the branch would drop both). When it would apply but does not, `rebaseOnHostWhy` says
`uncommitted-changes` or `unpushed-commits` and Update from base is Agentry's own merge. The rebase
polls `rebase_in_progress` with `include_rebase_in_progress=true` (the plain body does not carry it),
then fetches and `reset --keep`s. A rebase the host refuses about the content (its `merge_error`, a
conflict) falls back to Agentry's own update, which names the paths; a host that did not answer does
not. `POST …/ready` marks a draft ready.

The service returns the conflicting paths and leaves the worktree as it was; how they reach the
Developer is not decided in the service (see [work-items.md](work-items.md#merging-from-agentry)).

### The audit

`change_request_merges` has one row per click or arming: `action` (`merge`, `arm`, `disarm`),
`method`, `expected_head`, `delete_branch`, `requested_at`, `requested_by` (the person, or `agentry`
for the disarm before a push), `outcome` (`requested`, `merged`, `armed`, `disarmed`, `failed`),
`reason` and `detail`. They are rows because they accumulate. `core.merge.history(id)` returns them.

### Not recorded

`ci_still_running` and `draft_status` in REST, `not_approved`, `requested_changes`,
`status_checks_must_pass` and the other values that need Premium or Ultimate, the merge queue, and a
`glab` token with only `read_api` are documented, not recorded; the blockers map them anyway.

## Fakes and tests

- **Recordings** (`packages/core/test/fixtures/recordings/`): scrubbed captures of gh 2.92.0 and
  2.102.0 and glab 1.120.0, each with a `NOTES.md` that says what was run and what it showed. They
  are the only source for an argument or an output; a fact that is not there is documented as
  unrecorded.
- **The replay fake** `test/fixtures/fake-cli.mjs` answers as the CLI from `recordings/index.json`,
  matching the exact argv. A call it has no recording for exits 97 with `unrecorded call`, so a
  changed argument fails a test instead of being guessed. Redaction rules for new recordings are in
  `packages/core/scripts/redact-recordings.mjs`.
- **`fake-gh.sh` and `fake-glab.sh`** answer from a state directory and log every call and its
  stdin, for the golden scenarios.
- **The conformance suite** (`packages/core/test/hosts/conformance.ts`) takes an adapter and the
  recorded outputs. It checks that every call is argv without a shell and pinned, that no absolute
  URL reaches `api`, that `kind` agrees with the classifier, that a create carries its body only on
  stdin, that no view asks for `number` alone (gh 2.92 answers `{"number":N}` for a pull request
  that does not exist), that `find` asks for head and base, that `refPrefix` matches the manifest,
  and that `parseView` maps every recorded state and CI status and throws on malformed JSON.
- **Phase 2 recordings** (`k0-NOTES.md`): the GitLab jobs, bridges and the trace of a running job, a
  retry, a cancel and the merge request pipelines POST, and the `gh api -i` 404 on both gh releases.
  The checks section of the conformance suite and the checks service tests replay them, with golden
  logs under `golden/phase2/`.
- **Phase 3 recordings** (`r0-NOTES.md`): GitLab discussions, draft notes (create, list, delete,
  publish with a bad line), replies, resolve and reopen, approve and revoke, `--reviewer`; GitHub
  threads, the follow-up, reviews, replies and requested reviewers on both gh releases. The reviews
  sections of the conformance suite and the service tests replay them.
- **Phase 4 recordings** (`m0-NOTES.md`): `unchecked`, `discussions_not_resolved` and its refusal,
  `merge_time`, `--target-branch`, `ci_must_pass` without a pipeline, `--auto-merge=false` while a
  pipeline runs, `conflict`, `merge_method: ff` with `need_rebase` and a successful `mr rebase`;
  GitHub's arming refusal and `--body-file -` on merge. The merge section of the conformance suite
  checks that `--admin` and `--auto` are never built and that `-R` is always on `pr merge`;
  `hosts-merge-service.test.ts` replays both hosts, with golden logs under `golden/phase4/`.
- The registry test fails when two manifests share an id, a CLI or a default host.

## Events and paced polling

Phase 6 (step 1) replaces the fixed 60 s watch with a pacer and lets GitHub and GitLab tell Agentry
that something changed. The reasons are in [plans/code-hosts.md](plans/code-hosts.md#phase-6-webhooks-and-paced-polling);
a hook delivers to a public origin, which Agentry does not have today: the tunnel is tailnet-only
since it moved to Tailscale ([tunnel.md](tunnel.md#webhooks)), so registering answers
`no-public-url` and polling carries the rows. [deploy.md](deploy.md#webhooks-and-the-public-address)
says what a deployment must expose.

**A delivery never changes state by itself.** It only moves the next read of the change requests it
names to now; the read through the CLI is what updates a row. A forged or replayed delivery can
therefore cost one read, never a wrong state.

### The pacer

`hosts/pacer.ts` gives every open change request its next read, for both hosts. The constants are
exported and a test asserts them.

| Tier | Interval | When |
| --- | --- | --- |
| viewing | 20 s | its page is open in a browser (the claim lasts 60 s after the last view) |
| active | 30 s | checks running, or a merge waiting on a pipeline |
| waiting | 2 min | open, waiting for review or merge |
| quiet | 10 min | unchanged for an hour |
| webhook | 15 min | a healthy hook covers its repository, as a safety net |
| failure | 1, 2, 4, 8, then 15 min | each failure in a row |

A hook is *healthy* when a delivery or a successful ping arrived in the last 30 minutes
(`WEBHOOK_HEALTHY_MS`). The signal is `core.webhookService.covers(url)`, passed to
`PullRequestWatcher` as `signals.webhookHealthy`; a merge waiting on a pipeline is not signalled
yet, so that tier is not applied. While a host's breaker is open, background reads are paused and
the row is looked at again after a minute. The four-per-CLI cap and the per-row claim still hold.

### Receivers

`POST /api/webhooks/github/:registrationId` and `POST /api/webhooks/gitlab/:registrationId`, in
`apps/api/src/routes/webhooks.ts`, tag `Webhooks`. They are mounted under `/api`, so the address
registered on a host is `<public origin>/api/webhooks/<host>/<registrationId>`.

- **No bearer token, no audit row, and they work in read-only mode:** `security.ts` exempts exactly
  these two paths for `POST`. The host allowlist still applies, so the public name must be on it.
- **Raw body.** A content-type parser scoped to these routes keeps every body as bytes, up to 5 MiB.
  Larger is `413`, and polling covers it. The route looks the registration up from the path in an
  `onRequest` hook, before the body is read: an unknown, removed or other-host registration, or one
  with no stored secret, gets the empty `401` without the upload (`WebhookReceiver.knows`).
- **Verified before parsing, in constant time** (`hosts/webhook-receiver.ts`):
  - GitHub: `X-Hub-Signature-256` is `sha256=` plus the HMAC-SHA256 of the raw body with the secret.
    Recorded on a real signed ping (7 045 bytes).
  - GitLab: `X-Gitlab-Token` equals the secret, and a delivery that carries `webhook-signature` must
    carry a right one: `v1,` plus the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`,
    keyed with the bytes of the base64 part of the signing token, within five minutes (Standard
    Webhooks; recorded on a real signed delivery). A hook made before the signing token existed
    sends no signature, and the token alone decides.
  - An unknown or removed registration, a registration of the other host, no stored secret and a bad
    signature all answer the same empty `401`.
- **Answers:** `204` with no body, `401`, `429` with `Retry-After: 60`, `413`.
- **Rate limit:** 60 verified deliveries a minute per registration, counted after verification, so a
  stranger who knows the id cannot spend the real host's budget.
- **Dedupe:** two checks, both in `webhook_deliveries` (pruned after 7 days), and a replay is `204`
  and does nothing.
  - The id: `X-GitHub-Delivery` for GitHub, `Idempotency-Key` or `webhook-id` for GitLab.
  - The signed raw body: its SHA-256, per registration, for one hour. GitHub does not sign the id and
    whatever ends TLS in front of Agentry can see a signed body and send it again under a new id or none; the same
    bytes inside the window are a duplicate whatever id they carry. After the window they count again.
  - **A delivery with no id is not enough to mark a hook healthy.** It may still move the next read
    of the rows it names, but it does not stamp `lastDeliveryAt` or `lastPingAt`, clear `failing` or
    announce a change. The 60 a minute limit counts it like any verified delivery.
- **What a delivery names.** Rows carry no repository column, so they are matched by the host name
  and path of their own pull request URL (`/pull/N`, `/-/merge_requests/N`), by number, or by branch
  (GitHub's check suite deliveries arrive with an empty `pull_requests`, recorded). Closed rows are
  skipped. The matched ids go to `core.nudgeChangeRequests`.
- **Bookkeeping, not state:** a delivery sets the registration's `lastDeliveryAt` (a ping also
  `lastPingAt`), takes a `failing` registration back to `active`, and emits `webhook.changed`.

### Registration

`hosts/webhooks-service.ts` runs every host through a `HookDriver` (`hosts/hook-driver.ts`): the
GitHub calls are in `hosts/github/hooks.ts` and the GitLab ones in `hosts/gitlab/hooks.ts`. It is
the person's click; a chat's token is refused on the writes. The table is GitHub's; GitLab's is below it.

| Step | Call |
| --- | --- |
| Register (G1) | `gh api -X POST repos/{O}/{N}/hooks --input -`, the secret in the stdin JSON, never in argv |
| Adopt | only a hook whose URL carries the id of a registration this install made on the repository (`gh api --paginate --slurp repos/{O}/{N}/hooks?per_page=100`); another install's Agentry hook is left alone and the answer says so. Two clicks at once share one registration. Re-pointing and removing read the hook first and leave one that no longer carries the registration's id |
| Test (G2) | `gh api -X POST repos/{O}/{N}/hooks/<id>/pings`, then the hook's `last_response` is read |
| Remove (G3) | `gh api -X DELETE repos/{O}/{N}/hooks/<id>`; a removed registration stays listed until the repository is registered again |
| Re-point (G7) | `gh api -X PATCH repos/{O}/{N}/hooks/<id>/config --input -`, by id |

GitLab (`glab api -i --hostname <host> …`; `-i` because a failed call prints no status of its own
on stdout): `POST projects/<id>/hooks --input -` with `{url, token, signing_token, name: "agentry",
merge_requests_events, pipeline_events, note_events, issues_events: true, push_events, job_events:
false, enable_ssl_verification: true}`; the listing is `GET projects/<id>/hooks?per_page=100` (a
project holds at most 100); the test is `POST …/hooks/<id>/test/push_events`, the one test that
always delivers (the others answer 422 for a project with no merge request, issue, note or
pipeline); how a hook stands is `GET …/hooks/<id>` plus `GET …/hooks/<id>/events?per_page=1`, whose
newest `response_status` is the last response (a test waits for a *new* delivery id, so an old good
delivery is not taken for its answer); `alert_status` other than `executable` is GitLab's own
back-off and reads as failing; removing is `DELETE` and re-pointing is `PUT` with the URL and the
tokens, by id. The signing token is `whsec_` plus the base64 of 32 bytes (GitLab refuses any other
shape) and is derived from the registration's secret, so no second secret is stored. GitLab's
resend is recorded but not offered: a test is what a person asks for.

The events are `pull_request`, `pull_request_review`, `pull_request_review_comment`,
`pull_request_review_thread`, `check_run`, `check_suite`, `workflow_run`, `issue_comment` and
`issues`. The host masks the secret in every answer (`********`, recorded), so it is never read back.

The **secret** is 32 random bytes as hex, one per registration, in `webhook-secrets.json` in the
data directory with mode 0600 (`hosts/webhook-secrets.ts`). The database and the API never hold it.
The receiver and the service read it through `core.webhookSecrets`; a registration without a secret
is refused with `401`.

How it is kept is decision 3, in `secret-box.ts`: in the desktop app each value is encrypted
(AES-256-GCM) with a key the app keeps under Electron's `safeStorage` (`secret-key.bin` in its
user data, made by `apps/desktop/src/secret-key.ts`) and hands the server at launch in
`AGENTRY_SECRET_KEY`, which the server removes from `process.env` once read so no chat inherits it.
On a server there is no key and the values are plain, at 0600. A plain file found while a key is set
is encrypted when the server starts; a value sealed under another key, or opened with no key, reads
as absent and its hook is registered again. The decision engine's key and the account credentials
are still plain files: they can move to the same box.

**A new public address** (decision 2): the service re-points the registered hooks by id
(`WebhooksService.follow`, and `observe` for `tunnel.changed`). A hook that cannot be moved becomes
`stale` and is tried again on the next address. The service emits `webhook.changed` for each change.
Since the tunnel moved to Tailscale (2026-10-06) it is tailnet-only and no public origin, so `Core`
does not wire `observe`, and a hook is never moved to a tailnet address.

Failures are a `WebhooksError` with a status and a code: `403 hook-no-permission` (the account
cannot manage hooks), `404 registration-not-found`, `409` for `no-public-url`,
`no-remote` and `already-registered`, `502 hook-unreachable` or a host reason.

### What is not built yet

- **GitHub redelivery.** It needs the `admin:repo_hook` scope (recorded: exit 1), so it is not
  offered; `canRedeliver` is always false.
- **Freshness.** `ChangeRequest.freshness` has no producer yet.

## How to add a code host

1. **Check the interface.** The vendor must ship a CLI (or its own `api` subcommand) for programs.
   No REST client, no token of Agentry's own.
2. **Search the knowledge base**, then collect the facts from the vendor's docs and from running
   the CLI: version flag and output, auth probe, how it lists its hosts, how it pins a repository,
   create, find, view and default branch, and its install and sign-in pages. A fact you cannot
   confirm is left out.
3. **Record it.** Capture the calls with a scratch configuration directory, scrub them with
   `scripts/redact-recordings.mjs`, add them under `test/fixtures/recordings/` with a `NOTES.md`
   and an entry in `index.json`.
4. **Add `hosts/<id>/manifest.ts`**, each fact with its source in a comment, and one line in
   `CODE_HOST_MANIFESTS` in `hosts/registry.ts`. Add the id to `CodeHostId` in
   `packages/shared/src/types.ts` and regenerate the schemas
   (`pnpm --filter @agentry/api openapi:schemas`).
5. **Add `hosts/<id>/adapter.ts`**, implementing `CodeHostAdapter`. It builds `HostCall`s and
   parses, and runs nothing. Pin every call to the host; declare `kind` and `class` on each; never
   build an absolute URL for `api`.
6. **Extend the classifier and the environment** (`hosts/classify.ts`, `hosts/env.ts`) if the CLI
   has verbs or variables they do not know.
7. **Test it.** Run the conformance suite against the recordings, add a fake of the CLI and a run
   of the work item scenarios against it with its own golden logs, and detector and readiness
   tests with the fake on a temporary PATH.
8. **Ship a fake for e2e**, a small binary the suite puts on PATH; it never depends on the real CLI.
9. **Update the docs** in the same change: the tables in this document, `docs/work-items.md` if a
   reason or a step changed, and [status.md](status.md).

## Related

[[plans/code-hosts.md]] · [[decision-engine.md]] · [[work-items.md]] · [[trackers.md]] · [[tunnel.md]] · [[deploy.md]] · [[plans/work-item-pull-requests.md]] · [[providers.md]] · [[status.md]] · [[knowledge-base.md]]
