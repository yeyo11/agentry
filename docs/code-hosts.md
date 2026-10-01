---
created_at: 2026-10-01T09:00:00Z
updated_at: 2026-10-01T12:00:00Z
tags:
    - code-hosts
    - pull-request
    - detection
    - architecture
    - convention
    - checks
    - logs
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
and screens come with the tasks that own them. Reviews, merging, trackers and webhooks are later
phases and not described here as if they existed.

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
  characters, carriage-return overwrites (a progress bar leaves its last frame) and GitLab's
  `section_start` and `section_end` markers. It never depends on GitHub's step labels, which read
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
Disarming auto-merge before the push belongs to the merging phase and is not done yet.

### What the watcher tells the decision engine

Both watchers read through the checks service and call `onChecksFailing` when a rollup reads
`failing` for a head they have not announced: once per head, never while a fix is under way. The
`checks.fix` point (see [decision-engine.md](decision-engine.md#the-points)) answers it. The memory
of what was announced is in the process, so after a restart a head that is still failing is
announced again; the point's own limits, not that memory, stop a chain of fixes.

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
- The registry test fails when two manifests share an id, a CLI or a default host.

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

[[plans/code-hosts.md]] · [[work-items.md]] · [[plans/work-item-pull-requests.md]] · [[providers.md]] · [[status.md]] · [[knowledge-base.md]]
