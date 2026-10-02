# m0 recording: merging (code hosts plan, phase 4)

Recorded 2026-10-01 by the owner's assistant, in two sittings: 14:18-14:28 UTC (first recorder, cut
off by a quota limit) and from 15:37 UTC (resumed). Written incrementally; the "Status" line at the
end says how far it got.

- `glab 1.120.0` at `~/.local/bin/glab`, signed in to gitlab.com as `yeyo11`, against the private
  test project `yeyo11/agentry` (id 87089091) only, branches `probe/m0*` only; nothing merged into
  `main`.
- `gh version 2.102.0` (`~/.local/bin/gh`) and `gh version 2.92.0`
  (`~/.local/share/gh/2.92.0/bin/gh`), signed in as `yeyo11`, against `yeyo11/agentry-probe` only,
  merging only into `probe/m0*` base branches.
- Environment on every call: `LC_ALL=C NO_COLOR=1 GIT_TERMINAL_PROMPT=0`, plus
  `GLAB_NO_PROMPT=1 GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false` for glab and
  `GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1` for gh; stdin `/dev/null` unless the meta's
  `stdin-sha256` says otherwise (glab) or the argv has `--input -`/`--body-file -` (stdin documents in
  `work/`); cwd `/tmp`; `timeout 60`. Recorder `rec.sh` (the r0 recorder, base moved to `m0/raw`).
- Captures: `glab/1.120.0/<label>.{out,err,rc,meta}`, `gh/2.102.0/…`, `gh/2.92.0/…`, same format as
  `packages/core/test/fixtures/recordings/`, every file passed through
  `packages/core/scripts/redact-recordings.mjs`.
- Start state (the restore target): `raw/start-settings.json` (the 20 merge-related project
  settings), `raw/start-project.json`, `raw/start-gitlab-branches.txt`,
  `raw/start-github-settings.json`, `raw/start-github-branches.txt`, `raw/start-github-rulesets.json`.

General behaviour, same as phase 1, k0 and r0: `glab api` success → body on stdout, exit 0; failure →
body on stdout, `glab: <message> (HTTP <code>)` on stderr, exit 1. **`glab mr merge` failures do not
follow that shape**: stdout is empty and stderr is a boxed block,

```
          
   ERROR  
          
  All attempts fail:                                                                    
  #1: PUT https://gitlab.com/api/v4/projects/yeyo11%2Fagentry/merge_requests/14/merge: 405 {message: 405 Method Not   
  Allowed}.                                                                             
```

wrapped at ~118 columns with trailing spaces (so the HTTP status and the message can be split across
lines: unwrap before matching), exit 1. GitLab's 405 on merge carries **no reason**: every blocker
seen (unresolved discussions, `merge_time`, pipeline required and running) gives the same
`405 Method Not Allowed`. The reason only comes from re-reading `detailed_merge_status`, which
confirms the plan's "re-read on failure" rule.

## GitLab fixtures

| | value |
|---|---|
| base branches | `probe/m0-base`, `probe/m0-base2` (both created from `main` at `d57069b3`, `setup_base`, `setup_base2`: `POST projects/87089091/repository/branches?branch=…&ref=main`) |
| MR **!14** `probe m0 discussions` | `probe/m0-disc` → `probe/m0-base` (later `probe/m0-base2`), one file `probe-m0-disc.txt`; head `54f04ffb`, then `7d13d5b9` after a second commit |
| MR **!16** `probe m0 conflict` | `probe/m0-conf` → `probe/m0-base2` (§8) |
| MR **!15** `probe m0 pipeline` | `probe/m0-ci` → `probe/m0-base`, head `a9a9fc24` adds `.gitlab-ci.yml` with one job `probe-m0-wait` (`alpine:3.20`, `sleep 150`) |

Commits are made with `gc.sh` → `glab api -X POST projects/87089091/repository/commits -H "Content-Type: application/json" --input -`
(stdin `{branch, start_branch?, commit_message, author_name, author_email, actions[]}`, the
documents in `work/`), as `yeyo11 <33735891+yeyo11@users.noreply.github.com>`.

## 1. `unchecked` is sticky, and `with_merge_status_recheck`

A new MR with no pipeline stayed **`detailed_merge_status: "unchecked"`, `merge_status:
"unchecked"`** for minutes: `disc_get_fresh` (14:19:40), `disc_get_settled`, `disc_get_plain_2…5`
(to 14:21) all `unchecked`, and so did every read with `?with_merge_status_recheck=true`
(`disc_get_fresh_recheck`, `disc_get_recheck_2`, `disc_list_recheck` on the list endpoint
`merge_requests?iids[]=14&with_merge_status_recheck=true`). `updated_at` did not move on a recheck
read. GraphQL `mergeabilityChecks` (`disc_gql_checks`) already had every check evaluated while the
REST status was still `UNCHECKED`.

The status was computed only after a **push** to the source branch (`setup_disc_commit2` at 14:23,
head `7d13d5b9`): plain reads right after the push (`disc_get_push_1…4`) were still `unchecked`; the
first read with `with_merge_status_recheck=true` (`disc_get_recheck_3`) came back computed
(`discussions_not_resolved`, `merge_status: "can_be_merged"`), and so did every later plain read. The
same after `mr update --target-branch` (§4): `unchecked` on plain and recheck reads for about a
minute.

So the parameter is accepted (exit 0, same body shape, no extra field), and it is a request, not a
guarantee, as GitLab documents: it never turned an idle `unchecked` into a value within the minutes
observed, and it did once right after a push. **Contradiction with the plan's `computing` rule**
("re-read after 5 s, three times, then Refresh"): on GitLab `unchecked` can last far longer than 15 s
on an untouched MR. Merging an `unchecked` MR is still possible (GitLab checks on merge; the 405s
below came back while REST said `unchecked`), so `unchecked` should not disable Merge; it should show
"still working out" and let the person try, the server refusal being authoritative.

## 2. `discussions_not_resolved` and its refusal (recorded)

- `disc_thread_create`: `glab api -X POST projects/87089091/merge_requests/14/discussions -H "Content-Type: application/json" --input -`
  (stdin `{"body":"probe m0: an unresolved thread"}`) → exit 0, a resolvable `DiscussionNote`; the
  MR's `blocking_discussions_resolved` turns `false` at once (`disc_get_thread_before_setting`),
  even before the setting is on.
- `set_discussions_on`: `glab api -X PUT projects/87089091 -f only_allow_merge_if_all_discussions_are_resolved=true` → exit 0, the project.
- Once computed (§1): `detailed_merge_status: "discussions_not_resolved"`, `merge_status:
  "can_be_merged"` (the legacy field ignores discussions), `blocking_discussions_resolved: false`
  (`disc_get_recheck_3`, `disc_get_later3`, `disc_mr_view_blocked` through `glab mr view 14 -F json`).
  GraphQL: `detailedMergeStatus: "DISCUSSIONS_NOT_RESOLVED"`, `mergeStatusEnum: "CAN_BE_MERGED"`,
  `mergeable: false`, check `DISCUSSIONS_NOT_RESOLVED: FAILED` (`disc_gql_checks_blocked`).
- Refusal: `glab mr merge 14 -R yeyo11/agentry -y --sha <full head> --auto-merge=false`
  (`disc_merge_refused`, `disc_merge_refused_settled`) and without `--sha`/`--auto-merge`
  (`disc_merge_refused_default`) → exit 1, stdout empty, stderr the boxed
  `405 {message: 405 Method Not Allowed}`. Raw API (`disc_api_merge_refused`: `glab api -X PUT …/merge_requests/14/merge -f sha=…`)
  → exit 1, stdout `{"message":"405 Method Not Allowed"}`, stderr `glab: 405 Method Not Allowed (HTTP 405)`.
- Resolve (`disc_thread_resolve`: `PUT …/discussions/<id> -f resolved=true`) → `mergeable` at once
  (`disc_get_resolved_1…3`); unresolve (`disc_thread_unresolve`) → back to
  `discussions_not_resolved` at once (`disc_get_unresolved`). Once computed, the status follows
  discussion changes immediately, without a recheck.
- `disc_merge_short_sha`: `--sha 7d13d5b97` (9 hex of the right head) → **409**
  `SHA does not match HEAD of source branch: 7d13d5b98f11…` (the full head in the message): `--sha`
  must be the full 40-hex id; a short one is a `head-moved` false positive.

## 3. `merge_time` (recorded, not in the m0 bullet)

- `mt_set_merge_after`: `glab api -X PUT projects/87089091/merge_requests/14 -f merge_after=2026-10-09T12:00:00Z`
  → exit 0, `merge_after: "2026-10-09T12:00:00.000Z"`; GraphQL check `MERGE_TIME: FAILED` at once
  (`mt_gql_checks`) while REST stayed `unchecked` (`mt_get_recheck`, `mt_get_2`).
- About 70 min later, untouched: `detailed_merge_status: "merge_time"` (`mt_get_settled`).
  `mt_merge_refused` (`--sha <head> --auto-merge=false`) → the same boxed 405.
- Clearing it: `-F merge_after=null` is **ignored** (exit 0, value kept, `mt_clear_merge_after`);
  `-f merge_after=` (empty) clears it (`mt_clear_merge_after_empty`, `merge_after: null`).

## 4. `glab mr update --target-branch` (recorded)

- `tb_update`: `glab mr update 14 -R yeyo11/agentry --target-branch probe/m0-base2` → exit 0, stderr
  empty, stdout three lines: `- Updating merge request !14`, `✓ set target branch to "probe/m0-base2"`,
  the MR URL. Re-read (`tb_get_after`): `target_branch: "probe/m0-base2"`, `detailed_merge_status`
  back to `unchecked`.
- `tb_update_missing`: `--target-branch probe/m0-nonexistent` → **exit 0, accepted**: GitLab sets a
  target branch that does not exist (`tb_get_after_missing`: `target_branch: "probe/m0-nonexistent"`,
  `unchecked`, also with recheck). Agentry must check the branch exists before offering or sending a
  base change (`projects/{P}/repository/branches/<b>`), since neither glab nor GitLab refuses.
- `tb_update_back` → `probe/m0-base2` again, exit 0.

## 5. `ci_must_pass` without any pipeline (recorded, new)

With `only_allow_merge_if_pipeline_succeeds: true` (set for §6 by `set_pipeline_on`), MR !14, whose
branch has no `.gitlab-ci.yml` and never had a pipeline, reads `detailed_merge_status:
"ci_must_pass"`, `head_pipeline: null`, `pipeline: null` (`nopipe_get`; GraphQL `CI_MUST_PASS:
FAILED`, `nopipe_gql_checks`). `nopipe_merge_refused` (`glab mr merge 14 -y --sha <head>
--auto-merge=false`) → exit 1, stdout empty, stderr a **different, client-side-looking box**:

```
          
   ERROR  
          
  This merge request requires a passing pipeline before merging.                       
```

(no URL, no HTTP status). Contradiction with the plan's pipeline guard: "the project has no CI" is
not enough to enable Merge now; when the project requires a passing pipeline, no pipeline means
blocked (`checks-failing`/`ci_must_pass` reads wrong for this case; a text such as "This project
requires a passing pipeline, and none ran for the latest commit" fits it better).

## 6. Pipelines, with `only_allow_merge_if_pipeline_succeeds: true` (recorded)

`set_pipeline_on`: `glab api -X PUT projects/87089091 -f only_allow_merge_if_pipeline_succeeds=true` → exit 0.

**Running.** `setup_ci_commit` (14:27, `sleep 150`) and `setup_ci_commit2` (15:39, head `8af90689`,
`sleep 90`): `head_pipeline` attached within 8 s (`ci2_get_1`: `head_pipeline.status: "running"`,
`head_pipeline.sha == sha`). `detailed_merge_status` stayed **`unchecked`** throughout (with and
without recheck, `ci_get_1…3`, `ci2_get_1…2`), never `ci_still_running`; GraphQL said
`detailedMergeStatus: UNCHECKED` with `CI_MUST_PASS: CHECKING` and `CONFLICT: CHECKING`
(`ci_gql_checks`, `ci2_gql_checks`). `glab mr merge 15 -R yeyo11/agentry -y --sha <head> --auto-merge=false`
(`ci_merge_noauto_required`, `ci2_merge_noauto_running`) → exit 1, the boxed **405** (server-side).
So `--auto-merge=false` does not arm when the project requires a pipeline: it is refused.

**Draft** (MR !15 while the pipeline ran). `draft_update`: `glab mr update 15 -R yeyo11/agentry --draft`
→ exit 0, stdout `- Updating merge request !15` / `✓ marked as Draft` / URL; the title becomes
`Draft: probe m0 pipeline`, `draft: true`. REST stayed `unchecked` for 2 minutes (`draft_get_1…9`,
also after the pipeline succeeded, also plain `draft_get_plain` and the list `draft_list_opened`), so
**`draft_status` was never seen in REST**; GraphQL had `DRAFT_STATUS: FAILED` at once
(`draft_gql_checks`). `draft_merge_refused` → exit 1, stdout empty, stderr a **client-side** box from
glab (no request URL):
`This merge request is still a draft; run \`glab mr update 15 --ready\` to mark it as ready for review.`
(glab hands out a command; Agentry must show its own text, never this line). `draft_ready`:
`glab mr update 15 -R yeyo11/agentry --ready` → `✓ marked as ready`, title back.

**Failed.** `setup_ci_fail` (15:43, head `0208baec`, job `exit 1`): `head_pipeline.status: "failed"`
within 30 s; REST still `unchecked` for 90 s (`cifail_get_1…6`), GraphQL `CI_MUST_PASS: FAILED`,
`CONFLICT: CHECKING` (`cifail_gql_checks`); merge → the boxed 405 (`cifail_merge_refused`).

So on this project REST `detailed_merge_status` was computed only by the conflict check, and that
check ran only after some later event (a push followed by a recheck read, or tens of minutes).
**`ci_still_running` and `draft_status` could not be produced through REST**; `ci_must_pass` was
(§5, an MR whose conflict check had already run). GraphQL `mergeabilityChecks{identifier status}`
(`glab api graphql`, statuses `SUCCESS`, `FAILED`, `CHECKING`, `INACTIVE`, `WARNING` documented)
gave every blocker at once in every case. Proposal for the plan: when REST says `unchecked` or
`checking`, read the GraphQL checks and map each `FAILED` identifier with the same table (the
identifiers are the upper-case `detailed_merge_status` values), keeping `computing` only for
`CHECKING`.

## 7. `--auto-merge=false` while a pipeline runs, pipeline not required (recorded)

`set_pipeline_off` (`-f only_allow_merge_if_pipeline_succeeds=false`, exit 0), then
`setup_ci_commit3` (15:45:15, head `a3b08a21`, `sleep 90`); 12 s later `head_pipeline` is
`running` with `sha == head` (`ci3_get_1`, REST `unchecked`).

`ci3_merge_noauto_running`: `glab mr merge 15 -R yeyo11/agentry -y --sha a3b08a21… --auto-merge=false`
→ **exit 0, merged at once**, stdout `✓ Merged!` then the MR URL, stderr empty. Re-read
(`ci3_get_after_merge`): `state: "merged"`, `detailed_merge_status: "not_open"`,
`merge_when_pipeline_succeeds: false`, `merge_commit_sha` set, `head_pipeline.status: "running"`,
`force_remove_source_branch: true`; `probe/m0-ci` was gone 20 s later (`ci3_branch_after`: 404
`Branch Not Found`) although `-d` was not passed (the project's `remove_source_branch_after_merge:
true`, as gl§3); the pipeline for the deleted branch was still `running` (`ci3_pipelines_after`) and
ended `success`, unlike gl§3's race where the job failed (there the branch went before the job had
fetched it; the outcome depends on timing, so the guard stays). The merge commit started its own pipeline on `probe/m0-base`, whose head now carried the
`.gitlab-ci.yml`.

So `--auto-merge=false` means "merge now": it neither arms nor waits, and an unrequired running
pipeline does not stop it. That confirms the plan's pipeline guard is needed (Agentry, not GitLab,
must hold Merge now while the head's pipeline runs) and that the flag is safe to always pass.

## 8. `conflict` (recorded)

`setup_conf_branch` (`probe/m0-conf` from `d57069b3`), `setup_conf_commit` (creates
`probe-m0-conf.txt` "side A"), `setup_base2_diverge` (creates the same path on `probe/m0-base2`,
"side B"), `conf_mr_create`: MR **!16** `probe m0 conflict`, `probe/m0-conf` → `probe/m0-base2`.

- REST stayed `unchecked`, **`has_conflicts: false`**, for 3 minutes, with recheck reads and after a
  further push to the source branch (`conf_get_1`, `poll_16_2…4`, `conf_push_plain_1…3`,
  `conf_push_recheck`, `conf_push_recheck_2…6`). `has_conflicts: false` is therefore not "no
  conflict" while the status is `unchecked`.
- GraphQL at the same time (`conf_gql_checks`): `detailedMergeStatus: UNCHECKED`, **`conflicts: true`**,
  `CONFLICT: FAILED`.
- `conf_merge_refused`: `glab mr merge 16 -R yeyo11/agentry -y --sha <head> --auto-merge=false` →
  exit 1, stdout empty, stderr a box without URL or status:
  `Merge conflicts exist; resolve the conflicts and try again, or merge locally.`
- Right after the attempt, REST was computed (`conf_get_after_refusal`): `detailed_merge_status:
  "conflict"`, `merge_status: "cannot_be_merged"`, `has_conflicts: true`, `merge_error: null`.
  The merge attempt is what made GitLab run the check.

## 9. `merge_method: ff`, `need_rebase`, a successful `glab mr rebase` (recorded)

MR !14 (`probe/m0-disc`, head `7d13d5b9` on `d57069b3`) → `probe/m0-base2`, which had moved on to
`1b34e663` (`setup_base2_diverge`, a different file: diverged, no conflict).

- `set_ff`: `glab api -X PUT projects/87089091 -f merge_method=ff` → exit 0.
- 4 s later (`ff_get_1`, recheck): **`detailed_merge_status: "need_rebase"`**, `merge_status:
  "can_be_merged"`, `has_conflicts: false`, computed at once this time. GraphQL (`ff_gql_checks`):
  `NEED_REBASE`, `shouldBeRebased: true`, `divergedFromTargetBranch: true`, check `NEED_REBASE: FAILED`.
- `ff_merge_refused` (`--sha <head> --auto-merge=false`) → the boxed **405**, as every other blocker.
- `rebase_in_progress` is **not in the default MR body**: it appears only with
  `?include_rebase_in_progress=true` (`ff_get_irp`: `rebase_in_progress: false`). E9 must add that
  parameter.
- `ff_rebase`: `glab mr rebase 14 -R yeyo11/agentry` → exit 0, stdout `✓ Rebase successful!`, stderr
  empty; glab waits for the rebase to finish (the re-read right after, `ff_get_rebase_1`, had the new
  head `b4199b8f`, `rebase_in_progress: false`, `merge_error: null`, `diff_refs.base_sha` = the
  target's head, status `unchecked`). The rebased commit keeps the author; its **committer is the
  signed-in GitLab user** (name and account e-mail, redacted in the capture): a host-side rebase
  rewrites the head, so Agentry's worktree must `fetch` + `reset --keep` as the plan says.
- `ff_merge_stale_sha`: merging with the pre-rebase head → **409** `SHA does not match HEAD of source
  branch: b4199b8f…` → `head-moved`, as designed.
- `ff_merge`: `glab mr merge 14 -R yeyo11/agentry -y --sha b4199b8f… --auto-merge=false` → exit 0,
  `✓ Merged!` + URL. Re-read (`ff_get_after_merge`): `state: "merged"`, **`merge_commit_sha: null`**,
  `squash_commit_sha: null`; the target's head is now the MR's `sha` (`ff_base2_after`). After a
  fast-forward merge the merged commit is `sha`, not `merge_commit_sha`.
- A conflicting MR under `ff` (`ff_conf_get`, MR !16): `detailed_merge_status: "need_rebase"` (not
  `conflict`), `merge_status: "cannot_be_merged_recheck"`, `has_conflicts: false`. "Rebase on GitLab"
  is then offered and fails with the conflict (gl§3's recorded `merge_error`); Agentry's own update
  path stays the fallback.
- `set_merge_method_back`: `-f merge_method=merge` → exit 0.

## 10. GitHub (gh 2.102.0 and 2.92.0)

Fixtures on `yeyo11/agentry-probe` (`main` at `ac0a903b`, untouched): branches `probe/m0-base`,
`probe/m0-a`, `probe/m0-b` from `main` (`setup_ref_*`: `gh api -X POST repos/…/git/refs --input -`),
one file each on `-a`/`-b` (`setup_file_*`: `PUT …/contents/probe-m0-<s>.txt --input -`, committer
and author `yeyo11 <33735891+yeyo11@users.noreply.github.com>`), PRs **#32** (`probe/m0-a`) and
**#33** (`probe/m0-b`), both into `probe/m0-base` (`pr_create_*`). To make the PRs `BLOCKED` without
touching `main`, a ruleset (`setup_ruleset`, id 24318313, stdin `work/gh_ruleset.json`:
`required_status_checks` `probe/m0` on `refs/heads/probe/m0-base` only) was added, then deleted
(`cleanup_ruleset`, exit 0, empty body). The repository's `allow_auto_merge` was `false` from the
start and was never changed.

### Arming refused when `allow_auto_merge` is off (recorded, both versions byte-identical)

PR #32 `BLOCKED` / `MERGEABLE` (`blocked_view`).

- `automerge_off_pr_merge_auto`: `gh pr merge 32 -R yeyo11/agentry-probe --auto --squash --match-head-commit <head>`
  → exit 1, stdout empty, stderr
  `GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`.
- `automerge_off_graphql`: `gh api graphql -f query='mutation($id:ID!,$m:PullRequestMergeMethod!,$oid:GitObjectID!){enablePullRequestAutoMerge(…expectedHeadOid:$oid…)}' -F id=<PR node id> -f m=SQUASH -f oid=<head>`
  → exit 1, stdout
  `{"data":{"enablePullRequestAutoMerge":null},"errors":[{"type":"UNPROCESSABLE","path":["enablePullRequestAutoMerge"],"locations":[{"line":1,"column":64}],"message":"Auto merge is not allowed for this repository"}]}`,
  stderr `gh: Auto merge is not allowed for this repository`.
- The setting is checked **first**: the same error with a stale `oid` (`automerge_off_graphql_stale`,
  gh 2.102.0 only) and on a PR that is `UNSTABLE` rather than blocked
  (`automerge_off_graphql_unstable`). So `auto-merge-not-allowed` is matched on this message (or
  decided before the call from `allow_auto_merge`), and it hides `head-moved` and
  `auto-merge-not-needed`.

### `gh pr merge --squash --subject … --body-file - --match-head-commit` (recorded)

After the ruleset was removed both PRs were `UNSTABLE` (a non-required failing check of the probe
repository's workflow, `clean_view_32`, `clean_view_33`).

- `merge_squash_body_file`: `gh pr merge <n> -R yeyo11/agentry-probe --squash --subject "probe m0 squash subject" --body-file - --match-head-commit <head>`,
  stdin `work/gh_merge_body.md` (three lines with a backtick and `#32`) → gh 2.102.0 on #32 and gh
  2.92.0 on #33: **exit 0, stdout and stderr empty** (non-TTY), 5 s.
- Re-read (`merged_view`: `state: "MERGED"`, `mergeCommit.oid`), and the commit
  (`merged_commit`, `gh api repos/…/commits/<oid> --jq …`): message
  `probe m0 squash subject\n\nprobe m0 squash body, line one\n\nline three, with \`code\` and a #32 reference`
  — the subject, a blank line, the body verbatim with only the final newline stripped; one parent
  (squash). The plan's E4 `--body-file -` is confirmed on both versions.
- With `-R`, the head branch stayed (`merged_head_branch`: `probe/m0-a` still there; the repository's
  `delete_branch_on_merge` is `false` and `--delete-branch` was not passed).

## Values of `detailed_merge_status` seen

Recorded in REST by m0: `unchecked`, `discussions_not_resolved`, `mergeable`, `merge_time`,
`ci_must_pass` (no pipeline at all, §5), `conflict`, `need_rebase`, `not_open`. Seen only in GraphQL
`mergeabilityChecks` (REST stayed `unchecked`): `DRAFT_STATUS`, `CI_MUST_PASS` with a running
(`CHECKING`) and a failed pipeline. GraphQL identifiers seen on this Free project: `NOT_OPEN`,
`DRAFT_STATUS`, `STATUS_CHECKS_MUST_PASS`, `JIRA_ASSOCIATION_MISSING`, `MERGE_TIME`,
`MERGE_REQUEST_BLOCKED`, `REQUESTED_CHANGES`, `TITLE_REGEX`, `SECURITY_POLICY_VIOLATIONS`,
`LOCKED_LFS_FILES`, `DISCUSSIONS_NOT_RESOLVED`, `CI_MUST_PASS`, `COMMITS_STATUS`, `LOCKED_PATHS`,
`NOT_APPROVED`, `SECURITY_POLICY_PIPELINE_CHECK`, `NEED_REBASE`, `CONFLICT`; statuses `SUCCESS`,
`FAILED`, `CHECKING`, `INACTIVE`. `merge_status` (legacy) values seen: `unchecked`, `can_be_merged`
(also while blocked by discussions or `need_rebase`), `cannot_be_merged`, `cannot_be_merged_recheck`.

## Not recorded, and why

- **`ci_still_running` and `draft_status` in REST**: the MR stayed `unchecked` for the whole running
  pipeline (90 s) and the whole draft window (3 min); GraphQL had both (§6).
- **`ci_must_pass` from a failed pipeline in REST**: same reason; GraphQL `CI_MUST_PASS: FAILED`
  recorded, and REST `ci_must_pass` recorded for the no-pipeline case.
- **`not_approved`, `requested_changes`, `status_checks_must_pass`, `jira_association_missing`,
  `title_regex`, `locked_paths`, `merge_request_blocked`, security policy values,
  `approvals_syncing`, `preparing`, `checking`**: need Premium/Ultimate features or are transient;
  they stay doc-only (all `INACTIVE` in GraphQL here).
- **A glab `read_api` token** (listed for `m0` in "What is still not recorded"): not in this
  resumed task's scope, and it means creating a personal access token on the owner's account; left
  for the owner to decide.
- **`gh pr merge --auto` on a clean PR**: already recorded in gh§B4 (merges at once); not repeated.
- **`glab mr merge` timing**: the glab meta format has no `secs`; durations are not recorded.

## Contradictions with the plan

1. **`computing` on GitLab** (§1, §6, §8). `unchecked` is not a 2-5 s state: on this project REST
   stayed `unchecked` for minutes and through every `with_merge_status_recheck=true` read, and
   `has_conflicts: false` was returned for a conflicting MR while `unchecked`. The plan's "re-read
   after 5 s, three times" then Refresh would leave GitLab MRs in `computing` most of the time.
   Proposal: on `unchecked`/`checking`, read `mergeabilityChecks` through `glab api graphql` (B6), map
   `FAILED` identifiers with the same table, show `computing` only for `CHECKING`, and do not disable
   Merge on `unchecked` alone (GitLab re-checks on merge and refuses with 405/the conflict box).
2. **"The project has no CI" does not enable Merge now** when `only_allow_merge_if_pipeline_succeeds`
   is on: no pipeline means `ci_must_pass` and glab refuses (§5). The guard must read the setting.
3. **Refusal output of `glab mr merge`**: not `glab api`'s `glab: … (HTTP n)` line but a boxed
   stderr, either `All attempts fail: … <status> {message: …}` (server) or a one-line client-side
   message (draft, conflicts, pipeline required) without a status; the 405 never says why. E4's
   "409 → `head-moved`" must parse the wrapped box; every other code comes from the re-read.
4. **`--sha` must be the full id** (§2): a short head gives 409, read as `head-moved`.
5. **`rebase_in_progress` needs `?include_rebase_in_progress=true`** (§9); E9 reads it from the
   plain body, where it is absent.
6. **After an `ff` merge `merge_commit_sha` is null** (§9): the merged commit is `sha`.
7. **A conflicting MR in an `ff` project reads `need_rebase`**, not `conflict` (§9).
8. **`glab mr update --target-branch` accepts a branch that does not exist** (§4).
9. **GitHub auto-merge refusal**: the "not allowed" error comes first, before a stale head or an
   unstable PR (§10); E7's ordering of `head-moved`/`auto-merge-not-needed` only applies when the
   setting is on. Matches the plan's `auto-merge-not-allowed` otherwise.
10. Confirmed as planned: `--auto-merge=false` merges now and never arms (§7, and is refused with
    405 when the project requires a pipeline, §6); `with_merge_status_recheck` is accepted
    everywhere (single and list endpoints); `glab mr rebase` succeeds and waits (§9);
    `--target-branch` (§4); `discussions_not_resolved` and its refusal (§2); gh `--body-file -` with
    `--subject` and `--match-head-commit` on 2.92.0 and 2.102.0 (§10).

## Cleanup (verified 15:56-15:58 UTC; `raw/cleanup_gitlab.txt`, `raw/cleanup_github.txt`, `raw/cleanup_verify.txt`)

- GitLab: MRs !14, !15 (merged into probe branches) and !16 (open) deleted (`DELETE
  merge_requests/<iid>`, then GET → 404); branches `probe/m0-base`, `probe/m0-base2`, `probe/m0-conf`
  deleted (`probe/m0-disc` and `probe/m0-ci` went with their merges); the five probe pipelines
  (four on `probe/m0-ci`, one on `probe/m0-base`) deleted; no open MR, no pipeline since 14:00.
  Project settings: `only_allow_merge_if_pipeline_succeeds` back to `false`,
  `only_allow_merge_if_all_discussions_are_resolved` `false`, `merge_method` `merge`; the 20 keys of
  `raw/start-settings.json` all equal, and a full diff against `raw/start-project.json` shows only
  `updated_at`, `last_activity_at`, the avatar cache-busting `?v=` and `runners_token` (null in the
  redacted start copy). Branch list equal to the start except `main`,
  `release-please--…` and a new `fix/e2e-harness-waits`, moved by the mirror sync. `main` was never
  a target.
- GitHub: ruleset 24318313 deleted (rulesets `[]` as at the start); branches `probe/m0-base`,
  `probe/m0-a`, `probe/m0-b` deleted; the two Actions runs the PRs triggered deleted; branch list
  equal to the start (`main ac0a903b`); 0 open PRs; the 12 repository settings equal to
  `raw/start-github-settings.json` (`allow_auto_merge` never changed). PRs #32 and #33 stay as merged
  records (GitHub cannot delete a pull request); their merge commits are on no branch.

Status: complete (all captures redacted into `glab/1.120.0/`, `gh/2.102.0/`, `gh/2.92.0/`; `raw/`
redacted in place).
