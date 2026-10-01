> **Fixture copy (task `c12`).** This is the gh 2.92.0 / 2.102.0 recording note, committed with its
> raw captures beside it: `2.92.0/<label>.{out,err,rc,meta}` and `2.102.0/<label>.{out,err,rc,meta}`
> (recorded as `ghm/<label>.<92|102>.*`), the webhook deliveries in `deliveries/`, and the one
> capture kept from the obsolete gh 2.45.0 run, `2.45.0/version.*`. Paths under
> `/tmp/code-hosts-research/` below are where the run was recorded. Captures whose stdout is over
> 128 KiB (whole Actions logs and one slurped list) are not committed; phase 2 records its own logs.
> Every file went through `packages/core/scripts/redact-recordings.mjs`, and `index.json` one level
> up lists the calls `fake-cli.mjs` replays.

# gh recording on the supported range: gh 2.92.0 (minimum) and gh 2.102.0 (latest)

Recorded 2026-09-30 by running every command, with the same argv, on
`$HOME/.local/share/gh/2.92.0/bin/gh` (`gh version 2.92.0 (2026-04-28)`) and
`$HOME/.local/share/gh/2.102.0/bin/gh` (`gh version 2.102.0 (2026-09-30)`), signed in as `yeyo11`
(keyring OAuth token, scopes `admin:public_key, gist, read:org, repo`; token never recorded).

- Read-only on the public repo `yeyo11/agentry` (PRs #150, #127, #25, #1; Actions runs of `CI` and
  `Release`; releases). Nothing was written there.
- Writes only on the public scratch repo `yeyo11/agentry-probe` (empty at start). Every commit used
  `yeyo11 <33735891+yeyo11@users.noreply.github.com>`; the push helper refused any other identity.
- Environment on every call: `GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1
  GIT_TERMINAL_PROMPT=0 LC_ALL=C`, stdin `/dev/null`, stdout and stderr redirected to files (non-TTY,
  what Agentry sees). cwd `/tmp/code-hosts-research/ghm-work` (not a git repo) unless noted.
- Recorder: `/tmp/code-hosts-research/m1.sh <92|102> <label> <gh args>` and `m2.sh <label> <args>`
  (runs both, prints `IDENTICAL`/`DIFFERS`). Raw captures:
  `/tmp/code-hosts-research/ghm/<label>.<92|102>.{out,err,rc,meta}`; webhook deliveries (with
  payloads) in `ghm/deliveries/`. Tokens and personal emails redacted; the run-log zips were
  replaced by a placeholder.

**Headline:** 2.92 and 2.102 behave identically for almost everything a code-hosts driver needs.
The differences that matter are (1) `gh pr view N --json number` no longer lies on 2.102 (fixed in
2.93.0), (2) 2.102 **refuses** to print a text response containing terminal escape sequences from
`gh api` and `gh pr diff` (exit 1) unless `--allow-escape-sequences` is passed, a flag 2.92 does not
know (added 2.97.0), (3) issue types / sub-issues fields exist only on 2.102 (2.94.0), (4) usage
errors on 2.102 print the whole long help on stderr instead of the short usage. Everything else,
including all messages and exit codes below, was byte-identical unless a row says otherwise.

---

## Part A. The 2.45 traps, re-verified

| # | 2.45 trap | 2.92 | 2.102 | verdict |
|---|---|---|---|---|
| A1 | `gh auth status` exit 0 with an invalid `GH_TOKEN` | exit **1** | exit **1** | **gone** |
| A1 | `gh auth status` prints status on stdout | valid: stdout; **invalid: everything on stderr, stdout empty** | same | different |
| A1 | no `--json` on auth status | `--json hosts` exists | same | gone (but see below: exit 0 even when invalid) |
| A2 | `gh pr view 999999 --json number` → exit 0 `{"number":999999}` without an API call | **still there** (also with `GH_TOKEN=invalid`) | exit 1 `GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)`; invalid token → exit 1 `HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com` | still on 2.92, gone on 2.102 (fixed 2.93.0, cli/cli#13327 "remove numberFieldOnly optimization") |
| A3 | `gh pr checks --json` missing | present | present | gone |
| A4 | `gh run view --log/--log-failed` empty | full logs | full logs | gone |
| A4 | `--exit-status` ignored with `--log*` | honoured (exit 1 on a failed run) | same | gone |
| A4 | `--exit-status` ignored with `--json` | **still ignored** (exit 0 on a failed run) | same | still there |
| A5 | `closingIssuesReferences`, `stateReason` (issues), `attempt` missing | present | present | gone |
| A5 | `gh issue view <PR number>` resolves a PR | **still** `{"number":1,"state":"MERGED","url":".../pull/1"}` exit 0 | same | still there |
| A5 | `files` capped at 100 in `pr view --json files` | still 100 (PR #150: changedFiles 152) | same | still there |
| A6 | `--slurp` missing | present | present | gone |
| A6 | GraphQL `--paginate` loops forever unless the variable is `$endCursor` | **still loops** (`$after`: 31-32 identical first pages in 15 s, killed by `timeout`) | same | still there |
| A6 | `--jq` corrupts big integers | plain `--jq .id` now **exact**; `tostring`, `@tsv` and `--template` still lose precision | same | partly gone |
| A6 | 304 is exit 1 `gh: HTTP 304` | still | still | still there |
| A7 | `GH_HOST` overrides host-less `-R owner/repo` | still (`error connecting to git.example.invalid`) | same | still there |
| A7 | git messages localised | still (`fatal: no es un repositorio git` without `LC_ALL=C`) | same | still there |
| A7 | `GH_SPINNER_DISABLED` unknown | documented | documented | gone |
| A8 | `gh pr edit` broken by "Projects (classic)" | **works**, every flag | works | gone |
| A8 | text `gh pr view N` / `gh issue view N` broken | works | works | gone |
| A9 | `gh auth token --user/--hostname` | exists | exists | — |

### A1. Auth

| argv / env | 2.92 & 2.102 exit | stdout | stderr |
|---|---|---|---|
| `gh auth status` (valid keyring) | 0 | `github.com\n  ✓ Logged in to github.com account yeyo11 (keyring)\n  - Active account: true\n  - Git operations protocol: ssh\n  - Token: gho_****…\n  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'` | — |
| `GH_TOKEN=invalid gh auth status` (keyring still valid) | **1** | — | `github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  - Active account: true\n  - The token in GH_TOKEN is invalid.\n\n  ✓ Logged in … (keyring)\n  - Active account: false …` |
| `GH_CONFIG_DIR=<empty> GH_TOKEN=invalid gh auth status` | **1** | — | `github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  - Active account: true\n  - The token in GH_TOKEN is invalid.` |
| no token (`GH_CONFIG_DIR=<empty>`, no env) | 1 | — | `You are not logged into any GitHub hosts. To log in, run: gh auth login` |
| `gh auth status --json hosts` (valid) | 0 | `{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"yeyo11","tokenSource":"keyring","scopes":"admin:public_key, gist, read:org, repo","gitProtocol":"ssh"}]}}` | — |
| `--json hosts`, invalid `GH_TOKEN` | **0** (!) | `{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized body: …Bad credentials…","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"https"}]}}` | — |
| `--json hosts`, no token | **0** (!) | `{"hosts":{}}` | `You are not logged into any GitHub hosts. To log in, run: gh auth login` |
| `gh auth status --json` (no field) | 1 | — | ``Specify one or more comma-separated fields for `--json`:\n  hosts`` |
| `gh api user --jq .login` valid / invalid / none | 0 `yeyo11` / 1 (stdout 401 JSON, stderr `gh: Bad credentials (HTTP 401)`) / **4** (stderr `To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable…`) | | |
| `gh auth token` / `gh auth token --user yeyo11 --hostname github.com` | 0, the token (41 B) | | |
| `gh auth token --user nosuchuser-zz --hostname github.com` | 1 | — | `no oauth token found for github.com account nosuchuser-zz` |
| `GH_TOKEN=invalid gh auth token` | 0, prints `invalid` (it echoes the env var, no validation) | | |

Driver rule: `gh auth status --json hosts` is the structured check but its exit code is 0 even when
the token is bad or absent: read `hosts[host][active].state == "success"`. `gh api user` stays the
simplest proof (0 / 1 on 401 / 4 when no credentials).

### A2. Nonexistent PR and branch without PR (both versions)

- `gh pr view 999999 -R yeyo11/agentry --json number` → 2.92 exit 0 `{"number":999999}`; 2.102 exit 1
  (text above). With any real field (`--json number,state`) both exit 1 with
  `GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)`.
  **Driver rule for the 2.92 floor: never ask for `number` alone.**
- `gh pr view main -R yeyo11/agentry --json number,url` → 1, `no pull requests found for branch "main"`.
- `gh pr view feat/multi-provider --json number,url,state` → 0, merged PRs are found by branch.

### A3. `gh pr checks` (both versions identical)

- `--json` fields: `bucket completedAt description event link name startedAt state workflow`.
  Buckets seen: `pass`, `fail`, `pending`, `skipping`, `cancel`. `state` is the raw
  CheckRun conclusion/status or StatusContext state (`SUCCESS`, `FAILURE`, `IN_PROGRESS`, `QUEUED`,
  `CANCELLED`, `SKIPPED`, `PENDING`, `ERROR`). A pending check has `"completedAt":"0001-01-01T00:00:00Z"`
  (Go zero time, not null). A StatusContext row: `{"bucket":"pending","description":"probe pending",
  "event":"","link":"https://example.invalid/probe","name":"probe/status","state":"PENDING","workflow":""}`;
  `state=error` → bucket `fail`.
- **Exit codes, text mode** (non-TTY TSV `name\tbucket\telapsed\tlink\tdescription`):
  all pass → 0; any fail → 1 (rows on stdout, stderr empty); any pending and no fail → **8**
  (observed live); fail + pending → 1; no checks → 1 with stdout empty and stderr
  `no checks reported on the '<branch>' branch`.
- **Trap (new finding): a cancelled check alone → exit 0**, and the TSV row says `fail`
  (`slow	fail	1m30s	…`) while `--json` says `bucket:"cancel", state:"CANCELLED"`. Never trust the
  TSV bucket word for cancel.
- **Trap: `--json` always exits 0** (failing PR #127, pending PR #1): with `--json` the exit code
  carries no check state; compute it from `bucket`. Only "no checks" still exits 1.
- `--required`: filters to required checks, works for classic protection **and** rulesets
  (`ok	pass	9s	…`); a required check that never reported (commit `[skip ci]`) → exit 1
  `no checks reported on the 'st-missing' branch` (it does not list the missing required one).
- `--watch -i N`: prints `Refreshing checks status every N seconds. Press Ctrl+C to quit.` + the full
  table every round (no clearing when not a TTY; 35 lines for a 65 s wait), then exits with the final
  code (0). `--watch --fail-fast` exited after 3 s with 1 on the first failed check. `--fail-fast`
  without `--watch` → 1 ``cannot use `--fail-fast` flag without `--watch` flag``; `--watch --json` →
  1 ``cannot use `--watch` with `--json` flag``. Use polling, not `--watch`.
- `gh pr checks` costs 4 GraphQL requests per call (`GH_DEBUG=api`); `gh pr view --json …` 1.

### A4. Actions logs (real repo, read-only) and run JSON

- `gh run list/view --json` fields: `attempt conclusion createdAt databaseId displayTitle event
  headBranch headSha name number startedAt status updatedAt url workflowDatabaseId workflowName`
  (+ `jobs` on view). Identical on both.
- Real failed run `yeyo11/agentry` 36736141177 (created 15:21, read at ~18:30):
  `--log` 2,252,005 B / 20,485 lines; `--log-failed` 115,505 B / 936 lines (jobs `e2e (1/4)` 890 lines
  and `test` 46 lines). Line format `<job name>\t<step name>\t<UTF-8 BOM on first line><RFC3339 7-digit ts> <text>`.
  **Every line of this run is labelled `UNKNOWN STEP`** on both versions. Cause, verified from the
  archives: the run-log zip of this ~3 h old run has only `N_<job>.txt` + `<job>/system.txt`, while a
  12-min-old real run (36758265884) and fresh probe runs still have per-step files
  (`bad/3_Fail when FAIL exists.txt`); for those, the step column is correct and `--log-failed` returns
  only the failed step (probe: 14 lines, 1,437 B). So **step labels disappear a few hours after the
  run**; `--log-failed` then returns the whole failed job.
- `##[error]` lines look like `e2e (1/4)\tUNKNOWN STEP\t2026-09-30T15:27:23.5831898Z ##[error]Process completed with exit code 1.`;
  an `::error file=README.md,line=2,endLine=3,title=Probe failure::msg` line becomes
  `…Z ##[error]bad job failed on purpose`, `::warning` becomes `##[warning]…`. With
  `gh run rerun --debug`, `##[debug]` lines appear (50 in the failed step).
- **Escape sequences:** both versions replace ESC by the two characters `^[` in `run view --log*`
  output (`^[[36;1mpnpm install --frozen-lockfile^[[0m`); raw ESC count 0.
- `--job <id> --log` → only that job (111,865 B); `--job <successful job> --log-failed` → empty, exit 0;
  `--log-failed` on a cancelled run → empty, exit 0 (cancelled is not "failed").
- `--exit-status`: text on failed run → 1 (stdout still printed); `--log-failed --exit-status` → 1;
  `--exit-status --json` → **0** (ignored); cancelled run `--exit-status` → **0**.
- No way to bound output in gh: `--log` has no tail/limit; `gh api -H 'Range: bytes=-500' …/jobs/:id/logs`
  is ignored (full 144,964 B). Bound by piping (`head -c`) or by reading `--log-failed` of one job.
- **REST per-job logs** `gh api repos/O/R/actions/jobs/<id>/logs`: 302 to
  `productionresultssa3.blob.core.windows.net/…/job-logs.txt?rsct=text%2Fplain&…` (seen with
  `GH_DEBUG=api`), followed automatically, `Content-Type: text/plain`, BOM + one line per log line,
  **raw ESC bytes** (26 in the e2e job).
  - 2.92: exit 0, 91,369 B.
  - **2.102: exit 1, stdout empty, stderr `the response contains terminal escape sequences; pass
    --allow-escape-sequences to output it anyway`** — for any job whose log has an ANSI colour code
    (i.e. most). `--allow-escape-sequences` → exit 0, same 91,369 B. 2.92 → `unknown flag:
    --allow-escape-sequences`, exit 1. `--jq .` → exit 1 `invalid character '﻿' looking for
    beginning of value`.
  - Whole-run zip `gh api …/actions/runs/<id>/logs`: application/zip, passes on both (350,046 B;
    16 files). `-H 'Accept: application/zip'` → 415 `Must accept 'application/json'`.
- `gh run view --log*` caches the zip in `~/.cache/gh/run-log-<runid>-<ts>.zip` (files left there).

### A5. JSON field lists (identical on both unless marked)

- `gh pr view/list/status --json` (46): `additions assignees author autoMergeRequest baseRefName
  baseRefOid body changedFiles closed closedAt closingIssuesReferences comments commits createdAt
  deletions files fullDatabaseId headRefName headRefOid headRepository headRepositoryOwner id
  isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit mergeStateStatus
  mergeable mergedAt mergedBy milestone number potentialMergeCommit projectCards projectItems
  reactionGroups reviewDecision reviewRequests reviews state statusCheckRollup title updatedAt url`.
  No `stateReason`, no `isInMergeQueue` for PRs.
- `gh issue view/list --json` 2.92 (22): `assignees author body closed closedAt
  closedByPullRequestsReferences comments createdAt id isPinned labels milestone number projectCards
  projectItems reactionGroups state stateReason title updatedAt url`. **2.102 adds** `blockedBy
  blocking issueType parent subIssues subIssuesSummary` (2.94.0); `--json issueType` on 2.92 → 1
  `Unknown JSON field: "issueType"`. 2.102's text view adds `issue-type:, parent:, sub-issues:,
  sub-issues-completed:, blocked-by:, blocking:` lines.
- `gh repo view --json` adds `archivedAt projectsV2` vs 2.45; still **no `autoMergeAllowed`** → read
  `gh api repos/O/R --jq .allow_auto_merge`.
- `gh release list --json`: `createdAt isDraft isImmutable isLatest isPrerelease name publishedAt tagName`;
  `gh release view --json` adds `apiUrl assets author body databaseId id tarballUrl targetCommitish uploadUrl url zipballUrl`.
- `gh workflow list --json id name path state`; `gh label list --json color createdAt description id isDefault name updatedAt url`.
- Caps: `pr view --json files` 100 (152 real); `pr view --json comments` **paginates** (105 of 105);
  `pr list --json comments` **caps at 100** (105 posted); `pr view 150 --json commits` 45 of 45.
- PR #150 sample (both): `{"autoMergeRequest":null,"baseRefOid":"6dcb3b25…","closingIssuesReferences":[],
  "fullDatabaseId":"4692176010","latestReviews":[],"mergeStateStatus":"UNKNOWN","mergeable":"UNKNOWN","reviewDecision":""}`.
- `gh issue list -R yeyo11/agentry --state all --json number,state,stateReason` → `[]` (no issues).

### A6. `gh api` mechanics (both identical unless marked)

- `--paginate` on an array endpoint: one merged JSON array; with `--jq length` per page (`50 50 50 2`).
- `--paginate` on an object endpoint (`commits/:sha/check-runs?per_page=3`): 3 concatenated objects.
- `--paginate --slurp`: one JSON array of pages (`[[50],[50],[50],[2]]`; objects: `[{…3},{…3},{…2}]`).
  `--slurp` without `--paginate` → 1 ``--paginate` required when passing `--slurp``; with `--jq` →
  1 ``the `--slurp` option is not supported with `--jq` or `--template```.
- GraphQL `--paginate` with `$endCursor`: 4 pages (40+40+40+26 merged PRs), one document per page;
  `--slurp` wraps them in an array. With `$after`: infinite loop on both.
- Big ints: webhook delivery ids (e.g. `3845703270446145536`): plain `--jq '.[].id'` printed all 100
  exactly on both. `--jq '.[0].id|tostring'` → `3845703270446145500`; `@tsv` → `3845703476233388000`;
  `--template '{{.id}}'` → `3.8457032704461455e+18`.
- `-i`: `HTTP/2.0 200 OK` + headers (`Etag`, `Link`, `X-Ratelimit-Limit/Remaining/Reset/Resource/Used`,
  `X-Oauth-Scopes`, `X-Accepted-Oauth-Scopes`, `X-Github-Api-Version-Selected: 2022-11-28`, …) + body.
- `If-None-Match: <etag>` → exit **1**, stderr `gh: HTTP 304`, stdout empty (with `-i`: the 304 status
  line and headers). Remaining did not decrease.
- `--cache 60s`: second call served from disk (same `Date`); **the cache is shared between the two
  gh versions** (a 2.102 call got 2.92's cached response). Works for GraphQL too.
- Errors: 4xx → exit 1, API JSON on stdout, `gh: <message> (HTTP <code>)` on stderr. Deleting a
  missing webhook still adds the misleading `gh: This API operation needs the "admin:repo_hook" scope…` hint.
- 2.102 only: text responses with ESC → refused (see A4); JSON bodies and zips pass. In JSON strings,
  both versions render control chars as `^[` (issue body with ESC → `"body with ^[[31mred^[[0m escape\n"`).

### A7. Environment

- `GH_HOST=git.example.invalid` + `-R yeyo11/agentry` → 1 `error connecting to git.example.invalid\ncheck
  your internet connection or https://githubstatus.com`; `-R github.com/yeyo11/agentry` → 0; `gh api`
  host-less path → same error; `gh api --hostname github.com …` → 0.
- `GH_REPO=yeyo11/agentry`: `gh pr view 150 --json state` and `gh api 'repos/{owner}/{repo}'` work
  from a non-git cwd. Without `-R`/`GH_REPO` in a non-git cwd: 1 `failed to run git: fatal: not a
  git repository (or any of the parent directories): .git` (Spanish without `LC_ALL=C`).
- `GH_FORCE_TTY=100 GH_PAGER='sed s/^/PAGED:/'` → output goes through the pager (`PAGED:{"state":"MERGED"}`)
  and `pr checks` renders the TTY table (`All checks were successful`, `✓  CI/changes (pull_request)`).
  Never set `GH_FORCE_TTY`; set `GH_PAGER=cat` defensively.
- `gh help environment` lists on both: `GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  GH_HOST GH_REPO GH_EDITOR … GH_DEBUG DEBUG GH_PAGER PAGER GLAMOUR_STYLE NO_COLOR CLICOLOR
  CLICOLOR_FORCE GH_COLOR_LABELS GH_ACCESSIBLE_COLORS GH_FORCE_TTY GH_NO_UPDATE_NOTIFIER
  GH_NO_EXTENSION_UPDATE_NOTIFIER GH_CONFIG_DIR GH_PROMPT_DISABLED GH_PATH GH_MDWIDTH
  GH_ACCESSIBLE_PROMPTER GH_TELEMETRY DO_NOT_TRACK GH_SPINNER_DISABLED`; 2.102 adds `GH_EXTENSION`.
- **Telemetry is on by default in both.** `GH_TELEMETRY=log` prints to stderr, e.g. on 2.92
  `Telemetry payload:\n{"events":[{"type":"command_invocation","dimensions":{"agent":"claude-code_2-1-285_agent",
  "command":"gh pr view","flags":"json,repo","is_tty":"false","version":"2.92.0",…}}]}` (2.102 adds
  `accessible_colors, accessible_prompter, color_labels, spinner_disabled`). gh detects the calling
  agent. Set `GH_TELEMETRY=0` (or `DO_NOT_TRACK=1`) in the driver.
- Success paths print nothing on stderr (non-TTY) except the `✓`/`!` status lines listed in B6/B8.
- Usage errors: 2.92 prints `Usage: … Flags: …` (~0.5–1.7 KB), 2.102 prints the full help text
  (~1.6–7.8 KB) after the same first error line. Only parse the first line.

### A9. Rate limit

- `gh api rate_limit` returned `core.used 0`, `graphql.used 8` throughout while response headers of
  the same calls said `X-Ratelimit-Used: 165…168` (core) and GraphQL `rateLimit{used}` said 436–442
  (with different `reset` values). **`/rate_limit` does not reflect the bucket the calls draw from;
  trust `X-Ratelimit-*` headers and GraphQL `rateLimit`.**
- Requests per command (`GH_DEBUG=api`, both versions): `pr view --json …` 1 GraphQL; `pr checks`
  4 GraphQL; `pr merge` (already merged) 3 GraphQL; `run view --json jobs` 3 REST (`runs/:id`,
  `runs/:id/jobs`, `workflows/:id`); `run view --log-failed` 3 REST + the zip when a job failed.
- The review-threads query below costs `rateLimit.cost` **1** per page (3 pages of 2 threads → 1,1,1).

---

## Part B. Write matrix on `yeyo11/agentry-probe` (public)

### B1. Seed and Actions

`main` got `README.md` and `.github/workflows/ci.yml` (push to main, pull_request, workflow_dispatch
with inputs `fail` boolean and `note` string). Jobs: `ok` (fails if `OKFAIL`, sleeps 60 s if `OKSLOW`
or head branch `am-*`), `bad` (`::warning`, an ANSI red line, and on `FAIL`/input: `::error
file=README.md,line=2,endLine=3,title=Probe failure::…` + exit 1), `matrix` (n: 1,2, fail-fast off),
`slow` (sleeps 90 s if `SLOW`), `long` (3000 lines). **Actions ran** (first run success in ~48 s).
Probe `long` job log: 3,035 lines / 211,558 B via `run view --job --log`.

### B2. Actions on real runs

| action | argv | exit | stdout | stderr | 92 vs 102 |
|---|---|---|---|---|---|
| dispatch | `gh workflow run ci.yml -R R --ref main -f fail=true -f note=…` | 0 | **run URL** `https://github.com/yeyo11/agentry-probe/actions/runs/36759972198` | — | same |
| dispatch bad input | `… -f nope=1` | 1 | — | `could not create workflow dispatch event: HTTP 422: Unexpected inputs provided: ["nope"] (…/dispatches)` | same |
| dispatch unknown workflow | `gh workflow run nope.yml` | 1 | — | `HTTP 404: workflow nope.yml not found on the default branch (…)` | same |
| rerun in progress | `gh run rerun <id>` / `--failed` | 1 | — | `run 36759652349 cannot be rerun; This workflow is already running` | same |
| rerun failed jobs | `gh run rerun <id> --failed` | 0 | — | — | same |
| rerun job (+debug) | `gh run rerun --job <jobId> --debug` | 0 | — | — | same |
| rerun job of an older attempt | `gh run rerun --job <old jobId>` | 1 | — | `job 110039358166 cannot be rerun` | same |
| rerun whole | `gh run rerun <id>` | 0 | — | — | same |
| rerun unknown | `gh run rerun 1` | 1 | — | `failed to get run: HTTP 404: Not Found (…/actions/runs/1?exclude_pull_requests=true)` | same |
| cancel queued | `gh run cancel <id>` (status `queued`) | 0 | `✓ Request to cancel workflow <id> submitted.` | — | same |
| cancel in progress (slow job sleeping) | `gh run cancel <id>` | 0 | same line | — | same |
| cancel completed | `gh run cancel <id>` | 1 | — | `Cannot cancel a workflow run that is completed` | same |
| delete | `gh run delete <id>` | 0 | `✓ Request to delete workflow run submitted.` | — | same |
| delete again | same | 1 | — | `could not find any workflow run with ID <id>` | same |
| watch in progress | `timeout 12 gh run watch <id> -i 3 --exit-status` | 124 (killed) | 4,756 B in 12 s: `Refreshing run status every 3 seconds…` + full job/step tree each round | — | same |
| watch completed | `gh run watch <id> [--exit-status]` | 1 with `--exit-status` (cancelled run), 0 without | `Run ci (<id>) has already completed with 'cancelled'` | — | same |
| older attempt | `gh run view <id> --attempt 1 --json attempt,conclusion,jobs` | 0 | attempt-1 jobs (other job ids) | — | same |
| missing attempt | `--attempt 9` | 1 | — | `failed to get run: HTTP 404: Not Found (…/attempts/9?…)` | same |

- Right after `rerun`, `run view --json attempt,status,jobs` shows `{"attempt":2,"jobs":[],"status":"queued"}`;
  the attempt number flips later. After `--failed`, **all** jobs of the new attempt have new ids
  (passed ones are copied). `gh run list` shows the latest `attempt` (5 after four reruns).
- Cancelled run: `conclusion:"cancelled"`, cancelled job `conclusion:"cancelled"`; 2 queued runs
  cancelled in < 1 s end `cancelled` with 6 jobs.
- Annotations `gh api repos/R/check-runs/<jobId>/annotations` (bad job, 5 items), shape:
  `{"path":"README.md","blob_href":"https://github.com/…/blob/<sha>/README.md","start_line":2,"start_column":null,
  "end_line":3,"end_column":null,"annotation_level":"failure","title":"Probe failure","message":"bad job failed on purpose","raw_details":""}`;
  runner-generated ones use `path:".github"` (`Process completed with exit code 1.`, Node 20
  deprecation `warning`, ubuntu-latest migration `notice`). `gh run view <id>` (text) prints them
  under `ANNOTATIONS` as `- message\njob: path#line`.
- `commits/:sha/check-runs` → `total_count:6` (latest attempt only); each `{id=job id, name, status,
  conclusion, app.slug:"github-actions", output:{title:null,summary:null,annotations_count}, check_suite.id}`.
  `commits/:sha/check-suites` → `{app:"github-actions",conclusion:"failure",head_branch:"pr-fail",
  latest_check_runs_count:6,rerequestable:true,runs_rerequestable:false,status:"completed"}`.
  `commits/:sha/status` → `{"state":"pending","total_count":0}` (Checks only).
- `statusCheckRollup` item shapes: CheckRun `{"__typename":"CheckRun","completedAt","conclusion":"SUCCESS",
  "detailsUrl":".../actions/runs/<run>/job/<job>","name":"ok","startedAt","status":"COMPLETED","workflowName":"ci"}`;
  StatusContext `{"__typename":"StatusContext","context":"probe/status","startedAt","state":"PENDING","targetUrl":"https://example.invalid/probe"}`.

### B3. Protection and merge states (both versions identical, texts exact)

Classic protection (`PUT branches/main/protection`, 200) returns
`{required_status_checks:{strict:true,contexts:["ok"],checks:[{context:"ok",app_id:15368}]},
required_pull_request_reviews:{dismiss_stale_reviews:false,require_code_owner_reviews:false,require_last_push_approval:false,required_approving_review_count:1},
required_signatures.enabled, enforce_admins.enabled, required_linear_history.enabled, allow_force_pushes.enabled,
allow_deletions.enabled, block_creations.enabled, required_conversation_resolution.enabled, lock_branch.enabled, allow_fork_syncing.enabled}`.
`GET branches/main` (non-admin view) → `{"protected":true,"protection":{"enabled":true,"required_status_checks":{"checks":[{"app_id":15368,"context":"ok"}],"contexts":["ok"],"enforcement_level":"everyone"}}}`.
`GET rules/branches/main` → `[]` for classic protection (rules endpoint only shows rulesets).
Delete → 204; then `GET …/protection` → 404 `Branch not protected`.

Ruleset (`POST repos/R/rulesets`, 201): `{"id":24265748,"name":"probe-main","target":"branch","source_type":"Repository",
"enforcement":"active","conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}},"rules":[
{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"do_not_enforce_on_create":false,"required_status_checks":[{"context":"ok","integration_id":15368}]}},
{"type":"pull_request","parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":false,"required_reviewers":[],"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true,"require_extra_approval_for_unattributed_changes":true,"allowed_merge_methods":["squash","rebase"]}},
{"type":"required_linear_history"}],"bypass_actors":[],"current_user_can_bypass":"never",…}`.
`GET rules/branches/main` → the same rules each with `ruleset_source_type, ruleset_source, ruleset_id`.
`gh ruleset list` → `24265748\tprobe-main\tyeyo11/agentry-probe (repo)\tactive\t3`; `gh ruleset check main`
→ text `3 rules apply to branch main …` (no `--json`).

| state produced | how | `mergeable` / `mergeStateStatus` / `reviewDecision` | `gh pr merge N --squash` | exit |
|---|---|---|---|---|
| required check pending | `ok` sleeping | MERGEABLE / BLOCKED / "" | `X Pull request yeyo11/agentry-probe#9 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.` | 1 |
| required check missing | commit `[skip ci]` | MERGEABLE / BLOCKED | same text | 1 |
| required check failing | `OKFAIL` | MERGEABLE / BLOCKED | same text | 1 |
| BEHIND (strict) | base moved | MERGEABLE / BEHIND | `X Pull request …#4 is not mergeable: the head branch is not up to date with the base branch.` + the `--auto` and `--admin` lines | 1 |
| DIRTY | both sides edited README line 4 | CONFLICTING / DIRTY | `X Pull request …#6 is not mergeable: the merge commit cannot be cleanly created.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.` (also with `--admin`) | 1 |
| DRAFT | `--draft` | MERGEABLE / **CLEAN** (or BEHIND); `isDraft:true`. The `DRAFT` enum value exists but is deprecated ("Use PullRequest.isDraft instead") and is never returned | `GraphQL: Pull Request is still a draft (mergePullRequest)` | 1 |
| UNSTABLE | non-required `bad` fails | MERGEABLE / UNSTABLE | merges (`--merge`), stdout/stderr empty | 0 |
| CLEAN | all green | MERGEABLE / CLEAN | merges, empty output | 0 |
| review required (classic, 1 approval) | no approver possible | MERGEABLE / BLOCKED / `REVIEW_REQUIRED` | the "base branch policy" text | 1 |
| HAS_HOOKS | needs GHES pre-receive hooks | — | — | untestable on github.com |

`--admin`:
- Classic protection, `enforce_admins:false`: `gh pr merge 10 --squash --admin` (missing check) → 0, merged.
  **The refusal above is client-side**: the raw mutation `mergePullRequest(input:{pullRequestId,
  mergeMethod:SQUASH,expectedHeadOid})` on a BLOCKED PR (#11) merged it (exit 0) because the caller is
  an admin and admins are not enforced. Do not call `mergePullRequest` directly unless a bypass is meant.
- Classic, `enforce_admins:true`: `--admin` → 1 `GraphQL: At least 1 approving review is required by
  reviewers with write access. Required status check "ok" is in progress. (mergePullRequest)`; after
  `ok` passed: `GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)`;
  with an unresolved inline comment: `GraphQL: All comments must be resolved. At least 1 approving
  review is required by reviewers with write access. (mergePullRequest)`. `--merge --admin` with
  linear history → `GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)`.
- Ruleset (no bypass actors): `--admin` → 1 `GraphQL: Repository rule violations found\n\nA conversation
  must be resolved before this pull request can be merged.\n\n (mergePullRequest)` (only the first
  violation is named); after resolving: `…\n\nAt least 1 approving review is required by reviewers
  with write access.\n\n (mergePullRequest)`.
- **Trap:** right after the ruleset was created, the same PR read `reviewDecision:""`; minutes later
  `REVIEW_REQUIRED`. Don't treat `""` as "no review needed".
- `gh pr update-branch 3` → 0 stdout `✓ PR branch updated`; `--rebase` same; up to date → `✓ PR branch already up-to-date`.

### B4. Auto-merge

- `PATCH repos/R -F allow_auto_merge=true` → **sticks** (`true`) on the public repo.
- `gh pr merge 13 --auto --squash` with required `ok` pending → 0, no output;
  `autoMergeRequest:{"authorEmail":null,"commitBody":null,"commitHeadline":null,"mergeMethod":"SQUASH",
  "enabledAt":"…","enabledBy":{"id","is_bot":false,"login":"yeyo11","name":"…"}}`, `mergeStateStatus:"BLOCKED"`.
  Merged 64 s after `ok` completed. **`autoMergeRequest` stays non-null after the merge**
  (`state:"MERGED"` + the request) — check `state`, not the request.
- Other latencies between required-check completion and merge: 37 s (#14), 4 s (#16), and 83 s
  after arming an already-mergeable PR via GraphQL (#19). Budget up to ~1.5 min.
- GraphQL `enablePullRequestAutoMerge(input:{pullRequestId,mergeMethod:SQUASH,expectedHeadOid,commitHeadline,commitBody})`
  → `autoMergeRequest{mergeMethod:"SQUASH",commitHeadline:"Auto-merged via GraphQL (#14)",commitBody:"Body set at enable time."}`;
  the squash commit used them. Stale `expectedHeadOid` → 1, stdout `{"data":{"enablePullRequestAutoMerge":null},"errors":[{"type":"UNPROCESSABLE",…,"message":"Failed to add PR #14: expected head oid does not match the current head oid"}]}`,
  stderr `gh: Failed to add PR #14: expected head oid does not match the current head oid`.
- `disablePullRequestAutoMerge(input:{pullRequestId})` → `autoMergeRequest:null`. `gh pr merge N --disable-auto`
  → 0 silent, also when nothing is armed.
- New commit pushed by the owner while armed (#16): stays armed; merged both commits after the new run's `ok` passed.
- `--auto` on an already mergeable PR (CLEAN or UNSTABLE, state settled): **merges immediately**
  on both versions (#17 on 2.92, #18 on 2.102): `autoMergeRequest:null`, `state:"MERGED"`.
  When gh read `mergeStateStatus:"UNKNOWN"` it called `enablePullRequestAutoMerge` instead, and
  GitHub answered `GraphQL: Pull request Pull request is in unstable status (enablePullRequestAutoMerge)`
  (exit 1, 2.102 on #15; timing, not version). Arming via GraphQL on a mergeable PR succeeded another time (#19).
- Repo with auto-merge off: not re-tested (2.45 text `Auto merge is not allowed for this repository`).

### B5. Merge mechanics (identical on both)

| case | argv | exit | output |
|---|---|---|---|
| squash + subject/body + delete + head guard | `gh pr merge 5 -R R --squash --subject "Clean squash subject (#5)" --body "Squash body line." --delete-branch --match-head-commit <sha>` | 0 | none; commit `Clean squash subject (#5)` / `Squash body line.`; remote branch 404 |
| stale head | `--match-head-commit 000…0` | 1 | `GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)` |
| merged PR again | `gh pr merge 5 --squash` | 0 | stderr `! Pull request yeyo11/agentry-probe#5 was already merged` |
| no method | `gh pr merge 4 -R R` | 1 | `--merge, --rebase, or --squash required when not running interactively` + usage/help |
| squash disabled | `allow_squash_merge=false`, `--squash` | 1 | `GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)` |
| merge disabled | `allow_merge_commit=false`, `--merge` | 1 | `GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)` |
| rebase disabled | `allow_rebase_merge=false`, `--rebase` | 1 | `GraphQL: Rebase merges are not allowed on this repository. (mergePullRequest)` |
| rebase + delete from `/tmp` | `gh pr merge 4 -R R --rebase --delete-branch` (non-git cwd) | 0 | remote branch deleted; the clone's local `pr-fill` untouched |
| delete with `-R` from the clone, branch checked out | `CWD=clone gh pr merge 12 -R R --squash --delete-branch` | 0 | remote deleted; **local branch kept and still checked out** |
| delete without `-R` from the clone | `CWD=clone gh pr merge 3 --squash --delete-branch` | 0 | **local side effects**: switched to `main`, ran `git pull` (git's `Updating…/Fast-forward` + file list on **stdout**, `From github.com:… * branch main -> FETCH_HEAD` on stderr), deleted local `pr-draft`, deleted remote |

`mergeable` UNKNOWN timing: first read right after create or after the base moved returned
`UNKNOWN/UNKNOWN`; the next read 2–5 s later was settled (5 cases). Merged PRs always read `UNKNOWN`.

### B6. Pull requests (both identical except where noted)

| case | argv | exit | stdout | stderr |
|---|---|---|---|---|
| create | `gh pr create -R R --head pr-fail --base main --title T --body-file -` | 0 | `https://github.com/yeyo11/agentry-probe/pull/1` | — |
| draft | `… --draft` | 0 | URL | — |
| `--fill` (cwd clone) | `gh pr create -R R --fill --head pr-fill --base main` | 0 | URL (title = commit subject, body `""`) | — |
| already exists | same head/base | 1 | — | `a pull request for branch "pr-fail" into branch "main" already exists:\nhttps://github.com/yeyo11/agentry-probe/pull/1` |
| unpushed head | `--head pr-unpushed` | 1 | — | `pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and pr-unpushed, Head ref must be a branch (createPullRequest)` |
| head == base | `--head main --base main` | 1 | — | `head branch "main" is the same as base branch "main", cannot create a pull request` (now client-side; 2.45 got a GraphQL error) |
| no diff | `--head pr-nodiff` | 1 | — | `pull request create failed: GraphQL: No commits between main and pr-nodiff (createPullRequest)` |
| no body | `--title T` only | 1 | — | ``must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively`` + usage (2.92 short, 2.102 full help) |
| dry run | `--dry-run` | 0 | `Would have created a Pull Request with:\ntitle:\tT\ndraft:\tfalse\nbase:\tmain\nhead:\tpr-nodiff\nmaintainerCanModify:\ttrue\nbody:\nB` (does not validate "no commits") | — |
| ready / again | `gh pr ready 3` | 0 | — | `✓ Pull request yeyo11/agentry-probe#3 is marked as "ready for review"` / `! … is already "ready for review"` |
| undo / again | `gh pr ready 3 --undo` | 0 | — | `✓ … is converted to "draft"` / `! … is already "in draft"` |
| comment | `gh pr comment 4 --body …` / `--body-file -` | 0 | `https://github.com/yeyo11/agentry-probe/pull/4#issuecomment-5917491680` | — |
| edit last | `--edit-last --body …` | 0 | URL of the edited comment | — |
| delete last | `--delete-last --yes` | 0 | — | `Comment deleted` |
| close / again | `gh pr close 4 --comment …` | 0 | — | `✓ Closed pull request yeyo11/agentry-probe#4 (Add fill file)` / `! … is already closed` |
| reopen / again | `gh pr reopen 4` | 0 | — | `✓ Reopened pull request …` / `! … is already open` |
| diff | `gh pr diff 4` / `--name-only` | 0 | unified diff / `fill.txt` | — |
| **diff with ESC in content** | `gh pr diff 30` | **92: 0** (raw ESC in stdout); **102: 1** | 102: — | 102: `the diff contains terminal escape sequences; pass --allow-escape-sequences to output it anyway` |
| same, flag | `gh pr diff 30 --allow-escape-sequences` | 92: 1 `unknown flag`; 102: 0 | | |
| same via API | `gh api -H 'Accept: application/vnd.github.diff' repos/R/pulls/30` | 92: 0; 102: 1 (`the response contains terminal escape sequences; …`) | | |

Status lines now name the repo (`yeyo11/agentry-probe#3`), 2.45 said `#3`.

**`gh pr edit`** (all exit 0, stdout = PR URL, stderr empty, both versions):
`--title … --body-file -`, `--add-label probe-label`, `--remove-label probe-label`,
`--add-assignee yeyo11` / `@me`, `--milestone probe-ms`, `--base pr-slow` then `--base main`.
Errors: `--add-label nope-label` → 1 `'nope-label' not found`; `--milestone nope-ms` → 1 `'nope-ms' not found`;
`--base nope-branch` → 1 `GraphQL: Proposed base branch 'nope-branch' was not found (updatePullRequest)`;
`--add-assignee nosuchuser-zz9-qq` → 1 `GraphQL: Could not resolve to a user or bot with the login 'nosuchuser-zz9-qq'. (replaceActorsForAssignable)`;
`--add-reviewer nosuchuser-zz9-qq` → 1 `GraphQL: Could not resolve user with login 'nosuchuser-zz9-qq'. (requestReviewsByLogin)`.
**Trap: `--add-reviewer yeyo11` (the PR author) → exit 0, URL printed, but `reviewRequests:[]`** — silently
dropped; REST `POST pulls/1/requested_reviewers -f 'reviewers[]=yeyo11'` → 1 `gh: Review cannot be requested from pull request author. (HTTP 422)`.

### B7. Reviews (both identical)

| action | argv | exit | output |
|---|---|---|---|
| inline single line | `gh api -X POST repos/R/pulls/12/comments -f body=… -f commit_id=<head> -f path=review.txt -F line=2 -f side=RIGHT` | 0 | comment JSON (`id` 4148159984, `node_id` `PRRC_…`, `pull_request_review_id`, `line`, `original_line`, `start_line:null`, `side`, `position`, `subject_type:"line"`, `html_url …#discussion_r<id>`, `diff_hunk`) |
| inline range | `… -F start_line=3 -F line=4 -f side=RIGHT -f start_side=RIGHT` | 0 | `{"line":4,"start_line":3,"side":"RIGHT","start_side":"RIGHT",…}` |
| suggestion | `-F body=@file` with ```` ```suggestion\nline FIVE\n``` ```` | 0 | body read back verbatim `"Suggested wording:\n\n```suggestion\nline FIVE\n```\n"` (REST and GraphQL) |
| reply (in_reply_to) | `-F in_reply_to=<root id>` | 0 | `{"in_reply_to_id":4148159984,"line":2,"path":"review.txt","pull_request_review_id":<new>}` |
| reply (endpoint) | `POST pulls/12/comments/<id>/replies -f body=…` | 0 | `{"in_reply_to_id":4148159984}` |
| review + comments[] | `POST pulls/12/reviews --input` `{commit_id,event:"COMMENT",body,comments:[{path,line,side,body},{path,start_line,line,side,body}]}` | 0 | `{"id":5370592351,"node_id":"PRR_…","state":"COMMENTED","submitted_at":…}` |
| top-level comment review | `gh pr review 12 --comment -b …` | 0 | nothing |
| approve / request changes own PR | `gh pr review 12 --approve` / `--request-changes -b no` | 1 | `failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)` / `… Can not request changes on your own pull request …` |
| pending review | GraphQL `addPullRequestReview(input:{pullRequestId,body})` (no event) | 0 | `{"id":"PRR_…","databaseId":5370596714,"state":"PENDING"}` |
| REST comment / reply while pending | as above | 1 | stdout `{"message":"Validation Failed","errors":[{"resource":"PullRequestReview","code":"custom","field":"user_id","message":"user_id can only have one pending review per pull request"}],…}`, stderr `gh: Validation Failed (HTTP 422)` |
| `gh pr review --comment` while pending | | 1 | `failed to create review: GraphQL: User can only have one pending review per pull request (addPullRequestReview)` |
| `gh pr comment` while pending | | 0 | issue comments are not blocked |
| second pending review | `addPullRequestReview` again | 1 | `{"data":{"a":null},"errors":[{"type":"UNPROCESSABLE",…,"message":"User can only have one pending review per pull request"}]}` |
| thread into the pending review | `addPullRequestReviewThread(input:{pullRequestId,pullRequestReviewId,path,line:3,side:RIGHT,body})` | 0 | `{"thread":{"id":"PRRT_…","isResolved":false,"line":3}}` |
| submit | `submitPullRequestReview(input:{pullRequestReviewId,event:COMMENT,body})` | 0 | `{"state":"COMMENTED","submittedAt":…}` |
| delete pending | `deletePullRequestReview(input:{pullRequestReviewId})` | 0 | returns the review with `state:"PENDING"` |
| thread reply | `addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId,body})` | 0 | `{"comment":{"id":"PRRC_…","databaseId":4148183501,"replyTo":{"databaseId":4148159984},"pullRequestReview":{"databaseId":…,"state":"COMMENTED"}}}` |
| resolve / unresolve | `resolveReviewThread` / `unresolveReviewThread(input:{threadId})` | 0 | `{"isResolved":true,"resolvedBy":{"login":"yeyo11"}}` / `{"isResolved":false}` |

Threads query (file `/tmp/code-hosts-research/ghm-threads.graphql`):
```graphql
query($owner:String!,$repo:String!,$number:Int!,$first:Int!,$endCursor:String){
  rateLimit{cost remaining resetAt used}
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    reviewThreads(first:$first, after:$endCursor){ totalCount pageInfo{hasNextPage endCursor}
      nodes{ id isResolved isOutdated path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
             resolvedBy{login} viewerCanResolve viewerCanUnresolve viewerCanReply
             comments(first:20){ totalCount nodes{ id databaseId body author{login} createdAt outdated
                                                   replyTo{databaseId} pullRequestReview{databaseId state} } } } } } } }
```
`gh api graphql --paginate -F query=@file -F owner=yeyo11 -F repo=agentry-probe -F number=12 -F first=2`
→ 3 documents (2+2+2 threads, totalCount 6, cost 1 each); `--slurp` → array of 3. Node sample:
`{"id":"PRRT_kwDOU1zIIM6nqpYo","isResolved":false,"isOutdated":false,"path":"review.txt","line":4,"startLine":3,"originalLine":4,"diffSide":"RIGHT","subjectType":"LINE"}`;
a single-line thread has `startLine == line` here (not null). Replies from REST `in_reply_to`, the
replies endpoint and GraphQL all join the root thread. **After a force-push** that changed line 2:
the two threads on line 2 became `isOutdated:true, line:null, startLine:null, originalLine:2`, first
comment `outdated:true`; REST shows `line:null, original_line:2, position:1`, `commit_id` still the old sha,
while the untouched threads moved to the new `commit_id`. Resolution state survives.

### B8. Issues (both identical except where noted)

| action | argv | exit | stdout | stderr |
|---|---|---|---|---|
| create | `gh issue create -R R --title T --body-file - [--label probe-label]` | 0 | `https://github.com/yeyo11/agentry-probe/issues/20` | — |
| bad label | `--label nope-label` | 1 | — | `could not add label: 'nope-label' not found` (no issue created) |
| **type (2.102)** | `--type Bug` | 1 | — | `type "Bug" not found; available types: ` — **but the issue WAS created (#26)**; user-owned repos have no issue types (`issueTypes:null`, `issueType:null`) |
| type (2.92) | `--type Bug` | 1 | — | `unknown flag: --type` + usage |
| edit | `gh issue edit 20 --add-assignee @me --milestone probe-ms --title …` / `--add-label …` | 0 | issue URL | — |
| comment | `gh issue comment 20 --body …` | 0 | `…/issues/20#issuecomment-5917788187` | — |
| close not planned | `gh issue close 21 --reason "not planned" --comment …` | 0 | — | `✓ Closed issue yeyo11/agentry-probe#21 (Probe issue B)` |
| close duplicate | `--reason duplicate` (valid on both; `--duplicate-of <n>` also exists) | 0 | — | `✓ Closed issue …` |
| close closed | | 0 | — | `! Issue … is already closed` (also with a different `--reason`) |
| reopen | `gh issue reopen 21` | 0 | — | `✓ Reopened issue …` |
| develop | `gh issue develop 25 -R R --name dev-e --base main` from a non-git cwd | **1** | — | `failed to run git: fatal: not in a git directory` — **the linked remote branch `dev-e` was created anyway** (`issue develop --list 25` → `dev-e\thttps://github.com/yeyo11/agentry-probe/tree/dev-e`; GraphQL `linkedBranches` has it) |
| delete | `gh issue delete N --yes` | 0 | — | (used in cleanup) |

Closing keywords: PR #24 body `Closes #22\nFixes yeyo11/agentry-probe#23\nResolves #20` →
`gh pr view 24 --json closingIssuesReferences` (both) →
`[{"id":"I_…","number":20,"repository":{"id","name":"agentry-probe","owner":{"id","login":"yeyo11"}},"url":".../issues/20"}, …22, …23]`
(no `state` in the gh projection). After squash-merge all three: `state:"CLOSED", stateReason:"COMPLETED"`,
`closedByPullRequestsReferences:[{"id":"PR_…","number":24,"repository":{…},"url":".../pull/24"}]`.
`gh issue view 24 --json number,state,url` on the PR number → `{"number":24,"state":"MERGED","url":".../pull/24"}`.
Webhook `issues.closed` payload carries `state_reason:"not_planned"` (REST snake case; gh JSON uses `NOT_PLANNED`).

### B9. Webhooks

Create `POST repos/R/hooks --input` `{name:"web",active:true,events:[pull_request, pull_request_review,
pull_request_review_comment, pull_request_review_thread, check_run, check_suite, workflow_run,
workflow_job, issue_comment, issues, push, status], config:{url:"https://example.invalid/probe",
content_type:"json", secret:<random>, insecure_ssl:"0"}}` → 0, hook `{type:"Repository",id:689845722,
name,active,events,config:{…,secret:"********"},ping_url,test_url,deliveries_url,last_response:{code:null,status:"unused",message:null}}`
(works with the `repo` scope as repo admin). Duplicate → 1 `Hook already exists on this repository` (422).
`POST …/pings` and `POST …/tests` → 0, empty stdout. `GET hooks/:id` afterwards:
`last_response:{"code":502,"message":"failed to connect to host","status":"connection_error"}`, events sorted.

Deliveries (`GET hooks/:id/deliveries?per_page=100`, `--paginate`): 117 after one PR lifecycle:
`check_run created×18/completed×18, check_suite completed×3, issue_comment created×2, issues opened/closed,
ping×2, pull_request opened/synchronize/closed×2, pull_request_review submitted×2,
pull_request_review_comment created, pull_request_review_thread resolved, push×3,
workflow_job queued×18/in_progress×16/completed×18, workflow_run requested/in_progress/completed×3`.
List item: `{id,guid,delivered_at,redelivery,duration,status:"failed to connect to host",status_code:502,event,action,installation_id:null,repository_id,url:"",throttled_at:null}`.
`GET …/deliveries/:id` adds `request:{headers,payload}`, `response:{headers:null,payload:""}`.
Redeliver `POST …/deliveries/:id/attempts` → 0, stdout `{}`; the new delivery has `redelivery:true`.
Delete → 204; again → 1, 404 JSON + the misleading `admin:repo_hook` scope hint.

Headers actually sent (from `request.headers`): `Accept: */*`, `Content-Type: application/json`,
`User-Agent: GitHub-Hookshot/08eeed9`, `X-Github-Delivery: <guid>`, `X-Github-Event: pull_request`,
`X-Github-Hook-Id: 689845722`, `X-Github-Hook-Installation-Target-Id: <repo id>`,
`X-Github-Hook-Installation-Target-Type: repository`, `X-Hub-Signature: sha1=…`, `X-Hub-Signature-256: sha256=<64 hex>`.
**Signature verified:** for both `pull_request.closed` deliveries, `"sha256=" + HMAC-SHA256(secret,
compact JSON of the stored payload)` equals `X-Hub-Signature-256`. Docs:
https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries and
https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers (always verify over the raw body bytes).

Payload top-level keys (real deliveries, `ghm/deliveries/*.json`):
- `pull_request` (`opened`, `closed`): `action number pull_request repository sender`; `synchronize` adds `before after`.
  Merged close: `pull_request.merged:true, merged_at, merge_commit_sha, merged_by.login`; unmerged close: `merged:false, merged_at:null, merged_by:null`.
  `pull_request` keys: `_links active_lock_reason additions assignee assignees author_association auto_merge base body changed_files closed_at comments comments_url commits commits_url created_at deletions diff_url draft head html_url id issue_url labels locked maintainer_can_modify merge_commit_sha mergeable mergeable_state merged merged_at merged_by milestone node_id number patch_url rebaseable requested_reviewers requested_teams review_comment_url review_comments review_comments_url state statuses_url title updated_at url user`.
- `pull_request_review` (`submitted`): `action pull_request repository review sender`; review keys `_links author_association body commit_id html_url id node_id pull_request_url state submitted_at updated_at user`.
- `pull_request_review_comment` (`created`): `action comment pull_request repository sender`; comment keys `… commit_id diff_hunk id in_reply_to_id? line node_id original_commit_id original_line original_position original_start_line path position pull_request_review_id side start_line start_side subject_type …`.
- `pull_request_review_thread` (`resolved`): `action pull_request repository sender thread updated_at`; `thread:{node_id:"PRRT_…",comments:[…]}`.
- `check_run` (`created`, `completed`): `action check_run repository sender`; check_run keys `app check_suite completed_at conclusion details_url external_id head_sha html_url id name node_id output pull_requests started_at status url` (`pull_requests:[]` for the push run on main).
- `check_suite` (`completed`): `action check_suite repository sender`; keys `after app before check_runs_url conclusion created_at head_branch head_commit head_sha id latest_check_runs_count node_id pull_requests rerequestable runs_rerequestable status updated_at url`.
- `workflow_run` (`requested`, `in_progress`, `completed`): `action repository sender workflow workflow_run`; workflow_run keys include `id name event status conclusion run_attempt run_number head_branch head_sha pull_requests check_suite_id logs_url rerun_url cancel_url jobs_url path display_title previous_attempt_url triggering_actor`.
- `workflow_job` (`queued`, `in_progress`, `completed`): `action repository sender workflow_job`; keys `check_run_url completed_at conclusion created_at head_branch head_sha html_url id labels name node_id run_attempt run_id run_url runner_* started_at status steps url workflow_name`.
- `issue_comment` (`created`): `action comment issue repository sender`; on a PR, `issue.pull_request` is present.
- `issues` (`opened`, `closed`): `action issue repository sender`; issue keys include `state state_reason sub_issues_summary issue_dependencies_summary pinned_comment`.
- `push`: `after base_ref before commits compare created deleted forced head_commit pusher ref repository sender`.
- `ping`: `hook hook_id repository sender zen`.
- No `status` delivery was produced (the commit status was created before the hook existed).

### B10. Rate limit around a poll

See A9. A typical PR poll (`pr view --json …` 1 GraphQL request + `pr checks --json` 4 GraphQL
requests) consumed about 1 point per command in the GraphQL bucket; the threads query reports
`cost:1` per page; `run view --json jobs` uses 3 core requests. REST header sample after the poll:
`X-Ratelimit-Limit: 5000 X-Ratelimit-Remaining: 4832 X-Ratelimit-Reset: 1790796134 X-Ratelimit-Resource: core X-Ratelimit-Used: 168`.
304 responses are free (Remaining unchanged). No secondary rate limit was hit.

---

## (a) Summary table

| action | argv | output fields | stderr | exit codes | 2.92 vs 2.102 | tested |
|---|---|---|---|---|---|---|
| version | `gh --version` | `gh version X.Y.Z (date)` | — | 0 | — | yes |
| auth check | `gh auth status --json hosts` / `gh api user --jq .login` | `hosts[h][].state/login/scopes/tokenSource` | text status on stderr when invalid | status: 0 ok, 1 invalid/none (text); **0 always with `--json`**; api user 0/1/4 | same | yes |
| auth token | `gh auth token [--user U --hostname H]` | token | `no oauth token found…` | 0/1 | same | yes |
| PR view | `gh pr view N -R github.com/O/R --json <≥2 fields>` | 46 fields | GraphQL not-found text | 0/1/4 | `--json number` alone: 92 exit 0 fake, 102 exit 1 | yes |
| PR view by branch | `gh pr view <branch> -R …` | same | `no pull requests found for branch "b"` | 0/1 | same | yes |
| closing issues | `gh pr view N --json closingIssuesReferences` | `[{id,number,repository{id,name,owner{id,login}},url}]` | — | 0 | same | yes |
| checks | `gh pr checks N -R … --json bucket,state,name,link,…` | 9 fields | `no checks reported…` | `--json`: 0 (1 only no checks); text: 0/1/8, cancel-only 0 | same | yes |
| required checks | `gh pr checks N --required` | TSV | `no checks reported…` | 0/1/8 | same | yes |
| watch checks | `gh pr checks N --watch [--fail-fast] -i s` | repeated TSV | — | final code; blocks | same | yes |
| run list/view | `gh run list/view --json … [--attempt n]` | 15/16 fields incl. `attempt` | 404 text | 0/1 | same | yes |
| run logs | `gh run view ID --log / --log-failed / --job J --log` | `job\tstep\tts line`, ESC→`^[`, `UNKNOWN STEP` once step logs pruned | — | 0; `--exit-status` 1 on failure | same | yes |
| job log REST | `gh api [--allow-escape-sequences] repos/O/R/actions/jobs/J/logs` | plain text, BOM, raw ESC | 102: `the response contains terminal escape sequences…` | 92: 0; 102: 1 without flag | **differs** | yes |
| run zip | `gh api repos/O/R/actions/runs/ID/logs` | zip, per-job + per-step files (fresh) | — | 0 | same | yes |
| rerun | `gh run rerun ID [--failed] [--job J] [--debug]` | none | `cannot be rerun; This workflow is already running`, `job J cannot be rerun`, 404 | 0/1 | same | yes |
| cancel | `gh run cancel ID` | stdout `✓ Request to cancel workflow ID submitted.` | `Cannot cancel a workflow run that is completed` | 0/1 | same | yes (queued + in progress) |
| delete run | `gh run delete ID` | stdout `✓ Request to delete workflow run submitted.` | `could not find any workflow run with ID` | 0/1 | same | yes |
| dispatch | `gh workflow run f.yml --ref r -f k=v` | stdout run URL | 422/404 texts | 0/1 | same | yes |
| run watch | `gh run watch ID [-i s] [--exit-status]` | job tree per round | — | blocks; completed: 0 / 1 with `--exit-status` if not success | same | yes |
| check runs / annotations / suites | `gh api repos/O/R/commits/SHA/check-runs`, `check-runs/ID/annotations`, `commits/SHA/check-suites` | §B2 | — | 0 | same | yes |
| commit status | `gh api -X POST repos/O/R/statuses/SHA -f state= -f context=` | status JSON | — | 0 | same | yes |
| create PR | `gh pr create -R … --head h --base b --title t --body-file - [--draft] [--dry-run]` | stdout URL | exists/no commits/unpushed/head==base | 0/1 | usage text length only | yes |
| edit PR | `gh pr edit N --title --body-file - --base --add/remove-label --add-assignee --milestone --add-reviewer` | stdout URL | not-found texts | 0/1; self reviewer silently 0 | same | yes |
| ready/draft | `gh pr ready N [--undo]` | — | `✓`/`!` line | 0 | same | yes |
| close/reopen/comment/diff | `gh pr close/reopen/comment/diff` | URL / diff | `✓`/`!` lines | 0/1 | `pr diff` with ESC: 92 0, 102 1 unless `--allow-escape-sequences` | yes |
| update branch | `gh pr update-branch N [--rebase]` | stdout `✓ PR branch updated` | — | 0 | same | yes |
| merge | `gh pr merge N --squash/--merge/--rebase [--subject --body] [--match-head-commit S] [-d] [--admin]` | none | client-side `X … is not mergeable: <reason>` + hints; GraphQL server texts | 0/1; already merged 0 `!` | same | yes |
| auto-merge | `gh pr merge N --auto --squash`, `--disable-auto`; GraphQL enable/disable | `autoMergeRequest{mergeMethod,enabledAt,enabledBy,commitHeadline,commitBody,authorEmail}` | `expected head oid does not match…`, `Pull request is in unstable status` | 0/1 | same | yes |
| protection | `gh api -X PUT/GET/DELETE repos/O/R/branches/B/protection`, `GET branches/B` | §B3 | `Branch not protected` 404 | 0/1 | same | yes |
| rulesets | `gh api repos/O/R/rulesets`, `rules/branches/B`; `gh ruleset list/check` | §B3 | — | 0 | same | yes |
| reviews | `gh pr review N --comment -b`; REST `pulls/N/comments`, `/replies`, `/reviews` | §B7 | own-PR approval refused; 422 pending | 0/1 | same | yes |
| threads | `gh api graphql --paginate [--slurp] -F query=@threads.graphql …` + resolve/unresolve/reply/pending mutations | §B7 | `gh: <message>` | 0/1 | same | yes |
| issues | `gh issue create/edit/comment/close --reason/reopen/delete/develop` | URL / `✓` lines | see §B8 | 0/1; `--type` 102 creates then exits 1; develop creates branch then exits 1 outside a clone | `--type`, `issueType` 102 only | yes |
| issue JSON | `gh issue view/list --json stateReason,closedByPullRequestsReferences,…` | 22 / 28 fields | — | 0 | 102 adds 6 fields | yes |
| webhooks | `gh api -X POST/GET/DELETE repos/O/R/hooks[/:id[/pings|/tests|/deliveries[/:id[/attempts]]]]` | §B9 | 422 exists, 404 + scope hint | 0/1 | same | yes |
| pagination | `gh api --paginate [--slurp]` | merged array / concatenated objects / array of pages | slurp misuse texts | 0/1 | same | yes |
| conditional GET | `gh api -H 'If-None-Match: E'` | 304 | `gh: HTTP 304` | 1 | same | yes |
| rate limit | `-i` headers, GraphQL `rateLimit{cost remaining resetAt used}` | §A9 | — | 0 | same | yes (`/rate_limit` misleading) |
| HAS_HOOKS state, merge queue, fork PRs, second-account approval/request-changes | — | — | — | — | — | **untested** (GHES / org-only / single account) |

## (b) 2.45 traps: gone or still present on 2.92

Gone on 2.92 (and 2.102):
1. `gh auth status` exit 0 with an invalid token (now 1; but `--json hosts` exits 0 in every case).
2. `gh pr edit` and the text views of `pr view`/`issue view` failing on "Projects (classic)".
3. `gh run view --log/--log-failed` empty; `--exit-status` ignored with `--log*`.
4. Missing `gh pr checks --json`, `attempt`, `stateReason`, `closingIssuesReferences`,
   `closedByPullRequestsReferences`, `--slurp`, `--dry-run`, `GH_SPINNER_DISABLED`.
5. Plain `--jq` output of big integers (exact now).
6. Workflow dispatch printing nothing (now the run URL).
7. Private-repo plan limits (not a gh trap: Actions, protection, rulesets and auto-merge all work on the public repo).

Still present on 2.92:
1. `gh pr view N --json number` answers without an API call (exit 0 for a missing PR and a bad token) — **fixed only on 2.93+**.
2. `gh issue view <PR number>` resolves the PR.
3. GraphQL `--paginate` loops forever unless the cursor variable is `$endCursor`.
4. `--jq` arithmetic/`tostring`/`@tsv` and `--template` lose precision on big ints.
5. 304 → exit 1 `gh: HTTP 304`.
6. `GH_HOST` overrides host-less `-R`; git messages localised without `LC_ALL=C`.
7. `files` capped at 100 in `pr view --json`; `pr list --json comments` capped at 100.
8. `--exit-status` ignored with `--json`.
9. "Already in that state" is exit 0 with a `!` line on stderr; outputs of writes split between stdout/stderr/nothing.
10. `gh pr merge --delete-branch` touches the local checkout when run without `-R` inside a clone.
11. The misleading `admin:repo_hook` scope hint on 404 hook calls.
12. `mergeable`/`mergeStateStatus` read `UNKNOWN` for a few seconds after changes (and always for merged PRs).

New traps found on 2.92/2.102: `pr checks --json` always exit 0; cancelled-only checks exit 0 with a
`fail` TSV label; step labels become `UNKNOWN STEP` once step logs are pruned (hours); `run view
--exit-status` exit 0 on a cancelled run; `pr edit --add-reviewer <author>` silently does nothing;
`issue develop` outside a clone creates the branch then exits 1; `issue create --type` (2.102) creates
the issue then exits 1; `gh pr merge` refusals are client-side and the raw `mergePullRequest` mutation
bypasses unenforced protection for admins; `autoMergeRequest` stays set after an auto-merge; a draft
PR reports `CLEAN`/`BEHIND`, never `DRAFT`; ruleset `reviewDecision` can read `""` right after a
ruleset appears; `/rate_limit` does not match the buckets calls consume; telemetry is on by default
and names the calling agent; 2.102 refuses text with escape sequences in `gh api` and `gh pr diff`
(exit 1) and 2.92 does not know the `--allow-escape-sequences` flag (so a driver spanning both must
branch on version, or strip escapes itself from 2.92 output and pass the flag on ≥ 2.97).

## (c) Cleanup

Removed from `yeyo11/agentry-probe`: the 6 still-open PRs closed with their branches (#1 had been closed earlier); 13 more branches
deleted (only `main` remains); every workflow run deleted (`actions/runs total_count 0`); webhook
689845722 deleted; ruleset 24265748 deleted; classic protection deleted (404 `Branch not protected`);
label `probe-label` and milestone `probe-ms` deleted; all 7 issues (#20–#23, #25, #26, #28) deleted with `gh issue delete`;
repo settings restored to the starting values (`allow_auto_merge:false, allow_merge_commit:true,
allow_rebase_merge:true, allow_squash_merge:true, delete_branch_on_merge:false`, still public).

Cannot be removed (left behind): 23 closed/merged pull requests (#1–#19, #24, #27, #29, #30) with
their comments, reviews, review threads and commit statuses (`probe/status` on one commit); the
`main` history (seed, workflow, and the merged probe files such as `FAIL`, `review.txt`, `*.txt`);
the `ci` workflow registration; webhook delivery history went with the hook. The repository itself
stays for the owner to delete.

Local: throwaway clone `/tmp/ghm-probe`, the hook secret and hook JSON were deleted. Left: raw
captures in `/tmp/code-hosts-research/ghm/` (redacted; run-log zips replaced by a placeholder),
helpers `m1.sh m2.sh gc.sh gp.sh until.sh fields.sh rl.sh rl2.sh ghm-threads.graphql` in
`/tmp/code-hosts-research/`, and gh's own run-log cache `~/.cache/gh/run-log-*.zip` (written by
`gh run view --log*`, includes real-repo logs).
