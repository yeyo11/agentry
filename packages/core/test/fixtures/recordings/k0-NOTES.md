# k0 recording: checks (code hosts plan, phase 2)

Recorded 2026-10-01, 10:37-10:47 UTC, by the owner's assistant.

- `glab 1.120.0 (78790114c)` at `~/.local/bin/glab`, signed in to gitlab.com as `yeyo11`, against
  the private test project `yeyo11/agentry` (id 87089091) only.
- `gh version 2.102.0 (2026-09-30)` (PATH) and `gh version 2.92.0 (2026-04-28)`
  (`~/.local/share/gh/2.92.0/bin/gh`), signed in as `yeyo11`, read-only against the public scratch
  repository `yeyo11/agentry-probe`.
- Environment on every call: `LC_ALL=C NO_COLOR=1 GIT_TERMINAL_PROMPT=0`, plus
  `GLAB_NO_PROMPT=1 GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false` for glab and
  `GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1` for gh. stdin `/dev/null` unless the meta's
  `stdin-sha256` says otherwise, stdout and stderr to separate files (non-TTY), cwd `/tmp`, each call
  under `timeout 60`.
- Recorder: `rec.sh <glab|gh92|gh102> <label> <args>`. Captures: `glab/1.120.0/<label>.{out,err,rc,meta}`,
  `gh/2.92.0/…`, `gh/2.102.0/…`, same format as `packages/core/test/fixtures/recordings/`
  (glab meta: `glab`, `argv`, `exit`, `env`, `stdin-sha256`; gh meta: `gh`, `argv`, `exit`, `secs`,
  `env`). Every file went through `packages/core/scripts/redact-recordings.mjs` (committer e-mails
  in commit objects became `user@example.com`; `runners_token` was already empty). `raw/` holds
  the same captures (also redacted), the CI payloads in `raw/payload/`, the starting branch list and
  the cleanup verification.

Server: GitLab.com, runner `gitlab-runner 19.5.0~pre` on `k8s.saas-linux-small-amd64` (shared
runners run for this account; no identity-verification refusal).

## Setup

Branch `probe/k0` was created from `main` through the commits API (`setup_commit`,
`POST projects/87089091/repository/commits` with `start_branch: main`, author the GitHub noreply
identity); nothing was pushed to `main`. Files:

- `.gitlab-ci.yml`: `workflow:rules` allowing `merge_request_event`, `api` and `web` only (so the
  branch push made no pipeline: `pipelines?ref=probe/k0` → `[]`), default image `alpine:3.20`,
  jobs `probe-sleep` (18 × `sleep 5`, about 90 s of script), `probe-fail` (`exit 3`),
  `probe-allowed` (`allow_failure: true`, `exit 4`), `probe-manual` (`when: manual`), and the
  bridge `probe-child` (`trigger: include: .gitlab/ci/probe-child.yml`, `strategy: depend`,
  `needs: []`). `glab ci lint` → `Validating...\n✓ CI/CD YAML is valid!` exit 0 (`lint`).
- `.gitlab/ci/probe-child.yml`: `probe-child-ok` (echo) and `probe-child-fail` (`exit 5`). First
  version without `workflow:rules`, second (`setup_commit2`) with
  `workflow: rules: - if: $CI_PIPELINE_SOURCE == "parent_pipeline"`.

`glab mr create -R yeyo11/agentry --source-branch probe/k0 --target-branch main --title "probe k0
checks" … --yes` → stdout the URL (`…/merge_requests/12`), stderr `Creating merge request for
probe/k0 into main in yeyo11/agentry`, exit 0 (`mr_create`). The MR pipeline (source
`merge_request_event`, ref `refs/merge-requests/12/head`) started about 1 s later.

Pipelines: A `2900771578` (first commit), B `2900783081` (second commit, child `2900783186`),
C `2900799542` (created by the MR pipelines POST, child `2900799629`).

## General behaviour (same as the phase 1 recording, confirmed)

Every `glab api` success: body on stdout, stderr empty, exit 0. Every `glab api` failure: the
response body on stdout (`{"message":"…"}`), one line `glab: <message> (HTTP <code>)` on stderr,
exit 1. `glab api -i`: the status line and headers go to **stdout** before the body, stderr empty.

## C2 · jobs of a pipeline

`glab api projects/87089091/pipelines/<id>/jobs?per_page=100` → exit 0, a JSON array, newest job
first (`jobs_running`, `jobs_done`, `jobs_running_b`, `jobs_done_b`, `jobs_after_play`,
`jobs_c_canceled`, `jobs_c_final`, `child_jobs`).

- Job keys: `allow_failure, archived, artifacts, artifacts_expire_at, commit, coverage, created_at,
  duration, erased_at, finished_at, id, name, pipeline, project, queued_duration, ref, runner,
  runner_manager, stage, started_at, status, tag, tag_list, user, web_url`, plus
  **`failure_reason` only on failed jobs** (the key is absent, not `null`, on `success` and `manual`
  jobs).
- `commit` holds `author_email` and `committer_email` (redacted here); `runner` is `null` for a job
  that never ran, otherwise an object whose `created_by` is a GitLab staff account (name and avatar):
  drop both before storing.
- A manual job: `status: "manual"`, `allow_failure: true`, `started_at`, `finished_at`, `duration`,
  `queued_duration`, `runner` all `null`.
- An allowed failure: `status: "failed"`, `allow_failure: true`, `failure_reason: "script_failure"`.
- **Bridges are not in this list**, and the child pipeline's jobs are not either: they come only
  from C3.
- `--paginate --output ndjson` (the plan's argv): one job object per line, 4 lines, exit 0
  (`jobs_ndjson`); with `per_page=1` it followed the pages and still printed the same 4 lines
  (`jobs_ndjson_p1`).
- `include_retried=true` (`jobs_after_retry_incl`): the old and new attempts side by side, 6 rows,
  with **no `retried` key** to tell them apart; without the parameter only the latest attempt of
  each name (`jobs_after_retry`).
- Statuses seen: `manual, running, pending, failed, success, canceling, canceled`.

`glab ci get -R yeyo11/agentry --merge-request 12 -F json` (`ci_get_mr_running`, `ci_get_mr_done`)
→ exit 0, the MR's head pipeline with `jobs[]` (keys as above but with `artifacts_file`, no
`archived`, no `runner_manager`, and `failure_reason` on every job, `""` when the job did not fail). It has **no bridges and no
child pipelines** (`downstream`/`bridge` do not occur in the 28 KB document), so it cannot be the
whole check list of a pipeline with a trigger job.

## C3 · bridges and child pipelines

`glab api projects/87089091/pipelines/<id>/bridges?per_page=100` → exit 0, a JSON array.

- Bridge keys: `allow_failure, commit, coverage, created_at, downstream_pipeline, duration,
  erased_at, failure_reason, finished_at, id, name, pipeline, project, queued_duration, ref, stage,
  started_at, status, tag, user, web_url` (no `runner`, `artifacts`, `tag_list`, `archived`).
- `downstream_pipeline` keys: `created_at, id, iid, project_id, ref, sha, source` (`parent_pipeline`),
  `status, updated_at, web_url`.
- **`downstream_pipeline` can be `null`.** In pipeline A the child config had no `workflow:rules`,
  so in a merge request pipeline its jobs were all excluded; the bridge failed in under a second
  with `status: "failed"`, `failure_reason: "downstream_pipeline_creation_failed"`,
  `downstream_pipeline: null` (`bridges_running`). REST gives no reason text; the text only comes
  from GraphQL `detailedStatus.tooltip`: `Failed - (downstream pipeline can not be created, The
  resulting pipeline would have been empty. Review the rules configuration.)`
  (`gql_bridge_tooltip`, node id `gid://gitlab/Ci::Bridge/<id>`).
- With `strategy: depend` the bridge mirrors the child: `running` while the child runs
  (`bridges_c_running`), `failed` with `failure_reason: "unknown_failure"` when the child failed
  (`bridges_child`, `bridges_done_b`, `bridges_b_final`), `pending` while a retried child runs
  (`bridges_after_child_retry`), `canceled` after a cancel (`bridges_c_canceled`).
- A child pipeline's own `bridges` list is `[]` (`child_bridges`); its jobs come from C2 on the
  `downstream_pipeline.id` (`child_jobs`, `pipeline.source: "parent_pipeline"`).
- **A bridge is not a job for the jobs endpoints**: `GET projects/:id/jobs/<bridge id>` and
  `…/jobs/<bridge id>/trace` → `{"message":"404 Not found"}`, stderr `glab: 404 Not found (HTTP
  404)`, exit 1 (`bridge_get`, `bridge_trace`).
- **But a bridge can be retried**: `POST projects/:id/jobs/<bridge id>/retry` → exit 0, a new
  bridge object (new id, `status: "running"`, `downstream_pipeline: null`) (`bridge_retry`). In A
  it failed again the same way (`bridges_after_retry`).
- **Child pipelines are hidden from the pipeline lists**: `GET projects/:id/pipelines` showed only
  the parents (`pipes_list`); `?source=parent_pipeline` showed the child (`pipes_list_parent`);
  `merge_requests/12/pipelines` never listed a child.

## C4 · the log of a running job

`glab api projects/87089091/jobs/<id>/trace` on the running `probe-sleep` → exit 0 every time,
stderr empty, raw log on stdout (timestamp + stream tag prefix, ANSI, `section_start` markers, as in
phase 1).

- **The partial trace lags**: read at 10:37:49, 10:38:17, 10:38:35 it was the same 12 lines
  (1848 B, runner preamble only) although the job had been running for 60 s; at 10:38:49 it jumped
  to 56 lines (up to `probe tick 11`), stayed there at 10:39:03 and 10:39:16, and at 10:39:30
  (job `success`) it was complete with `Job succeeded` (`trace_running1`–`trace_running7`). The
  log reaches the API in chunks about a minute apart, so a running job's tail can be a minute old.
- With `-i` (`trace_running_i`): `HTTP/2.0 200 OK`, `Content-Type: text/plain`,
  `Content-Disposition: infile; filename="<id>.log"`, a weak `Etag`, and `Ratelimit-Limit: 2000`,
  `Ratelimit-Name: throttle_authenticated_api`, `Ratelimit-Observed`, `Ratelimit-Remaining`,
  `Ratelimit-Reset`, all on stdout before the log.
- A manual job that never ran: exit 0, **empty stdout** (`trace_manual`), not 404.
- `GET projects/:id/jobs/<id>` of the running job: `status: "running"`, `finished_at: null`,
  `duration` growing (`job_running`).

## C6 · pipeline retry

`glab api -X POST projects/87089091/pipelines/2900783081/retry` on a failed pipeline → exit 0,
stderr empty, the pipeline object with `status: "running"` (keys `archived, before_sha,
committed_at, coverage, created_at, detailed_status, duration, finished_at, id, iid, project_id,
queued_duration, ref, sha, source, started_at, status, tag, updated_at, user, web_url,
yaml_errors`) (`pipeline_retry`).

- Re-read (`jobs_after_retry`): the two failed jobs (`probe-fail` and the allowed
  `probe-allowed`) got new ids and run again; the passed job and the played manual job kept their
  ids.
- **The failed bridge was not retried** (same id, still `failed`, 3 and 25 s later:
  `bridges_after_pretry`, `bridges_after_pretry2`).
- Retrying the child pipeline itself (`POST pipelines/2900783186/retry`, `child_retry`) → exit 0,
  child `running`; the parent's bridge turned `pending` and the parent `running` again; the failing
  child job got a new id, the passed one kept its id (`child_jobs_after_retry`); both ended
  `failed`.

## C8 · run the merge request pipeline again

`glab api -X POST projects/87089091/merge_requests/12/pipelines` → exit 0, stderr empty, the new
pipeline object (`status: "created"`, `source: "merge_request_event"`, `ref:
"refs/merge-requests/12/head"`, the MR head `sha`; same keys as C6) (`mr_pipeline_post`). Six
seconds later `mr view 12 -F json` showed it as `head_pipeline` (`mrview_after_post`) and its
bridge had started a child (`bridges_c_running`).

## C9 · cancel (through the API)

`glab api -X POST projects/87089091/pipelines/2900799542/cancel` → exit 0, the pipeline object
with `status: "running"` (not yet cancelled) (`pipeline_cancel`). A second call → exit 0,
`status: "canceling"` (`pipeline_cancel_again`). Eight seconds later: `probe-manual` `canceled`,
`probe-sleep` `canceling`, the jobs that had already failed stay `failed`, the bridge and its child
`canceled` (`jobs_c_canceled`, `bridges_c_canceled`); about a minute later the pipeline ended
**`failed`**, not `canceled`, because a job had failed before the cancel (`pipeline_c_final`,
`jobs_c_final`).

## C10 · playing a manual job (through the API)

`glab api -X POST projects/87089091/jobs/<manual id>/play` → exit 0, the job object with the **same
id** and `status: "pending"` (unlike retry, no new job); the finished pipeline went back to
`running`, and the job ended `success` (`job_play`, `jobs_after_play`). Playing it again, or playing
a job that is not manual → `{"message":"400 Bad request - Unplayable Job"}`, stderr
`glab: 400 Bad request - Unplayable Job (HTTP 400)`, exit 1 (`job_play_again`,
`job_play_notmanual`).

## Other facts

- The MR stayed `detailed_merge_status: "mergeable"` with a failed head pipeline, because the
  project does not set `only_allow_merge_if_pipeline_succeeds` (`mrview_done`).
- `POST projects/:id/ci/lint` with `dry_run: true` on the child file returned `valid: true` and an
  empty `jobs` list, without hinting that the jobs would be excluded in a merge request pipeline
  (`lint_child_dry`, `lint_child`).
- Deleting a parent pipeline does not delete its child: child `2900799629` was still listed under
  `source=parent_pipeline` after its parent C was deleted, and was deleted on its own
  (`cleanup_child2_delete`). `DELETE` of a pipeline, an MR and a branch: exit 0, empty stdout and
  stderr.

## GitHub · a failed `gh api -i` read

`gh api -i repos/yeyo11/agentry-probe/pulls/999999`, on 2.92.0 and 2.102.0 (`api-404-i`):

- exit **1**;
- stdout: `HTTP/2.0 404 Not Found`, every header (`Content-Type`, `X-Github-Request-Id`,
  `X-Oauth-Scopes`, `X-Accepted-Oauth-Scopes: repo`, `X-Ratelimit-Limit/Remaining/Reset/Resource/Used`,
  …), a blank line, then the body
  `{"message":"Not Found","documentation_url":"https://docs.github.com/rest/pulls/pulls#get-a-pull-request","status":"404"}`;
- stderr: one line, `gh: Not Found (HTTP 404)`.

Without `-i` (`api-404`): the same body on stdout, the same stderr line, exit 1. Both versions are
identical apart from `Date`, the request id and the rate-limit counters.

GraphQL with `-i` for a pull request that does not exist (`api-404-i-gql`, both versions):
`HTTP/2.0 200 OK` and headers on stdout, then
`{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND",…,"message":"Could not
resolve to a PullRequest with the number of 999999."}]}`; stderr `gh: Could not resolve to a
PullRequest with the number of 999999.`; exit **1**. So a GraphQL "not found" is a 200 with exit 1:
the status line alone does not say it failed, the `errors[].type` does.

## Contradictions with the plan, and what changes

1. **C3 "a bridge row has no log and no retry"**: no log is right (404), but `POST
   jobs/<bridge id>/retry` works (exit 0, new bridge id). And `POST pipelines/<id>/retry` does
   **not** retry a failed bridge; retrying the child pipeline (`POST pipelines/<child id>/retry`)
   does re-run it and reopens the parent.
2. **C3 assumes `downstream_pipeline` is present**: it is `null` when the child could not be
   created (`failure_reason: "downstream_pipeline_creation_failed"`); the reason text is only
   reachable through GraphQL. A bridge with a `null` downstream must be a check of its own (failed,
   no children to fetch).
3. **C2 lists `failure_reason` among the job fields**: on the REST jobs endpoint the key is absent
   unless the job failed. Bridges and child jobs are never in this list, and the retried attempts
   (with `include_retried`) carry no `retried` flag.
4. **The k0 "safe default" (jobs from `glab ci get --merge-request -F json`)** misses bridges and
   child pipelines entirely.
5. **Child pipelines do not show in `pipelines` or `merge_requests/:iid/pipelines` lists** unless
   `source=parent_pipeline` is asked for; they are reachable from the bridge, which is what C3
   already does. Deleting a parent does not delete its children (matters only for cleanup).
6. **C4 "a running job's partial trace"**: readable (exit 0) but it lags by up to about a minute;
   the first minute of a job can show only the runner preamble. A manual job's trace is empty with
   exit 0, not 404.
7. **C9 through the API** answers `running`/`canceling` (not `canceled`), and a cancelled pipeline
   with an earlier failure ends `failed`: the re-read must not expect `canceled`.
8. **C10 through the API** keeps the job id (only retry makes a new one); an unplayable job is
   400 exit 1, as recorded for `ci trigger`.
9. **"Where `gh api -i` puts status and headers on a 4xx"**: on stdout, before the body, on both
   versions; stderr has only the `gh: <message> (HTTP <code>)` line; exit 1. The watcher can parse
   the status and the rate-limit headers from stdout on an error. For GraphQL, a not-found is HTTP
   200 with exit 1 and `errors[]` in the body.
10. A child config needs its own `workflow:rules` (or job rules) to run under a merge request
    pipeline; with none, the bridge fails as in 2. This is a fact about the project's CI that
    Agentry will see in other people's projects, not something to fix.

Not recorded in k0: read-only tokens (the plan's "What is still not recorded" assigns a gh
fine-grained token on the probe repository to k0; it was not in this task's brief, so it stays
open).

## Cleanup (verified at 10:46:42 UTC, `raw/cleanup_verify.txt`)

GitLab: pipelines A, B, C and both children deleted (`cleanup_*`); MR !12 deleted; branch
`probe/k0` deleted. After: merge requests (all states) `[]`; pipelines `[]` unfiltered and for each
of `parent_pipeline`, `merge_request_event`, `api`, `push`, `web`. Branches: every branch from the
start is there, `probe/k0` is gone, and I never wrote to `main`. Two differences against the start
list do not come from this run: the project's event log shows a mirror sync by the owner at
10:41:22 UTC that pushed `main` from `f994c06e` to `654745f0` (= GitHub `origin/main`, #159) and
created `dependabot/docker/docker/node-26-bookworm-slim`,
`dependabot/github_actions/docker/login-action-4` and
`dependabot/github_actions/googleapis/release-please-action-5` (all three exist on GitHub
`origin`). They were left as they are. The MR iid counter moved on (next MR !13) and about 6 CI
minutes on shared runners were used.

GitHub `yeyo11/agentry-probe`: only reads; branches `["main"]`, open pull requests `[]`.
