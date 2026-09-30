> **Fixture copy (task `c12`).** This is the glab 1.120.0 recording note, committed with its raw
> captures in `1.120.0/<label>.{out,err,rc}`. glab's recorder kept no argv file, so each
> `<label>.meta` was rebuilt from the recorder's own console line for that label
> (`=== <label> :: argv: <argv> :: exit=<code>`), with the binary's path shortened to `glab`, and
> `env:`/`wrapper:` for the calls run under `env` or `timeout`. Paths under
> `/tmp/code-hosts-research/` below are where the run was recorded. Every file went through
> `packages/core/scripts/redact-recordings.mjs`.

# glab 1.120.0 recording against gitlab.com/yeyo11/agentry (id 87089091)

Recorded 2026-09-30, 17:45-18:07 UTC. `glab 1.120.0 (78790114c)`, signed in as yeyo11 through the
keyring. Env on every call: `GLAB_NO_PROMPT=1 GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false
NO_COLOR=1 GIT_TERMINAL_PROMPT=0`, stdin `</dev/null`, stdout, stderr and exit code captured
separately. Raw captures (per step: `.out`, `.err`, `.rc`) are in `/tmp/code-hosts-research/glab/`.
Tokens are redacted. The `runners_token` field in `repo view -F json` is a secret and must never be
logged.

Server: GitLab.com 19.5.0-pre (from the `User-Agent` of the webhook deliveries and the runner log).

## 0. General behaviour of glab (applies to every section)

- **Errors** always go to stderr as a boxed block (`\n   ERROR  \n\n  <message>.\n`, padded to about
  120 columns and wrapped), exit **1**. No other non-zero code was seen from glab itself; `timeout`
  gives 124.
- **With `-F json`, an error is ALSO printed on stdout** as `{"error":{"message":"..."}}` (seen for
  `mr view`, `mr list`, `issue view`, `ci status`). So when exit is not 0, stdout is not the data.
- **`glab api`** errors: stdout carries the raw response body (`{"message":"404 Not found"}`), stderr
  one line `glab: <message> (HTTP <code>)`, exit 1. When the body has no `message`
  (`{"error":"..."}`), stderr is just `glab: HTTP 400`.
- **Progress lines go to stdout**, not stderr, for most mutating commands: `mr update`, `mr close`,
  `mr reopen`, `mr merge`, `mr approve`, `mr revoke`, `mr delete`, `issue close/reopen/update`. The
  URL is the last line. Exceptions: `mr create` prints `Creating merge request for ...` on
  **stderr** and only the URL on stdout; `issue create` prints `- Creating issue in ...` on stderr
  and the URL on stdout; `issue delete` prints `✓ Issue deleted.` on **stderr** and nothing on
  stdout.
- The `✓ ! ✘` glyphs remain under NO_COLOR.
- Failed `mr create` writes a recovery file: `~/.config/glab-cli/recover/<owner>/<repo>/mr.json`
  and says so on stderr (`Created recovery file: ... Run the command again with the '--recover'
  option`). This is a side effect on disk (I deleted the one I caused).
- Commands that ask for confirmation fail without a TTY unless given `-y`/`--yes`:
  `mr note delete`, `mr note publish` -> `--Yes required when not running interactively.` exit 1.
  But `mr delete` has **no** `-y` flag (`Unknown shorthand flag: 'y' in -y.`) and deletes
  without asking when there is no TTY. `issue create` without `-y` also just creates. `mr merge`
  without `-y` also proceeded to the draft check (no prompt).
- `mr list` / `issue list` JSON are the go-gitlab structs: fields the struct lacks are dropped (see
  `merge_status` below) and nullable objects come out as zero values (e.g. `resolved_by`
  `{"id":0,"username":"",...}` instead of `null`). Prefer `glab api` when the exact REST shape
  matters.
- Web URLs of issues are now `/-/work_items/<iid>` (not `/-/issues/<iid>`).

## 1. Repository and project facts (item 9)

`glab repo view -R yeyo11/agentry -F json` -> exit 0, full REST project object (7.1 KB). Relevant
values:

```json
{"id":87089091,"default_branch":"main","visibility":"private","merge_method":"merge",
 "squash_option":"default_off","only_allow_merge_if_pipeline_succeeds":false,
 "only_allow_merge_if_all_discussions_are_resolved":false,"remove_source_branch_after_merge":true,
 "permissions":{"project_access":{"access_level":50,"notification_level":"global"},"group_access":null},
 "mirror":false,"builds_access_level":"enabled","shared_runners_enabled":true,
 "allow_merge_on_skipped_pipeline":false,"merge_pipelines_enabled":false,"merge_trains_enabled":false,
 "autoclose_referenced_issues": (present), "ci_config_path":""}
```

Other keys worth knowing: `merge_commit_template`, `squash_commit_template`,
`resolve_outdated_diff_discussions`, `approvals_before_merge`, `mr_default_target_self`,
`merge_request_title_regex`, `printing_merge_request_link_enabled`, `runners_token` (SECRET).
Access level 50 = Owner (10 guest, 15 planner, 20 reporter, 30 developer, 40 maintainer, 50 owner).

`glab api projects/87089091/protected_branches` -> exit 0:
`[{"id":...,"name":"main","push_access_levels":[{"access_level":40,"access_level_description":"Maintainers",...}],"merge_access_levels":[{"access_level":40,...}],"allow_force_push":false,"unprotect_access_levels":[],"code_owner_approval_required":false,"inherited":false}]`

Branches endpoint entries carry `name, commit{id,short_id,title,message,...}, protected, default,
merged, developers_can_push, developers_can_merge, can_push, web_url`.

## 2. Merge requests (item 2)

### Create

| argv | stdout | stderr | exit |
|---|---|---|---|
| `mr create -R r -s probe/feat -b probe/base -t T -d D -l probe-label,probe-two --reviewer yeyo11 --remove-source-branch=false --squash-before-merge=false -y` | `https://gitlab.com/yeyo11/agentry/-/merge_requests/4` | `\nCreating merge request for probe/feat into probe/base in yeyo11/agentry\n\n` | 0 |
| `... --draft -y` | URL | `Creating draft merge request for ...` | 0 (title becomes `Draft: probe draft`) |
| `... --squash-before-merge --remove-source-branch -y` | URL | same | 0 (`squash:true`, `squash_on_merge:true`) |
| source branch not pushed | (empty) | recovery-file lines + `Post https://gitlab.com/api/v4/projects/yeyo11%2Fagentry/merge_requests: 400 {message: {source_branch: [does not exist]}}.` | 1 |
| source = target (`-s probe/base -b probe/base`) | (empty) | `You must be on a different branch other than "probe/base"` + recovery-file lines (client-side check, no API call, **no ERROR box**) | 1 |
| no diff (source at same commit as target) | URL | normal | **0** - GitLab accepts it; the MR shows `detailed_merge_status:"commits_status"`, `has_conflicts:true`, `changes_count:""` |
| second MR for the same source branch | (empty) | `... 409 {message: [Another open merge request already exists for this source branch: !4]}.` | 1 |

Labels passed with `-l` are created on the project on the fly (they appeared in `projects/:id/labels`
and had to be deleted). `--remove-source-branch` omitted -> project default applies
(`force_remove_source_branch:true` here because `remove_source_branch_after_merge:true`).

### List

`mr list` flags (1.120.0 `--help`): `-A --all`, `-c --closed`, `-M --merged`, `-d --draft`,
`--not-draft`, `-s --source-branch`, `-t --target-branch`, `-l --label`, `--not-label`, `--author`,
`-a --assignee`, `-r --reviewer`, `--search`, `-m --milestone`, `--created-after/--before`,
`--deployed-after/--before`, `--environment`, `-o --order`, `-S --sort`, `-p --page`,
`-P --per-page` (30), `-F --output text|json`, `--jq`, `-g --group`. **There is no `--state`**: the
default is opened; use `-c`, `-M` or `-A`.

Tested (all exit 0): `-s probe/feat` -> [4]; `-t probe/base` -> [7,6,5,4,3]; `-d` -> [5];
`--not-draft` -> [7,6,4,3]; `-l probe-label` -> [4]; `-c` / `-M` -> []; `--search conflict` -> [7];
`-P 2` -> [7,6]; `-P 2 -p 2` -> [5,4]; no match -> `[]` (JSON) or
`No open merge requests match your search in yeyo11/agentry.` (text), both exit 0.

`mr list -F json` item keys: `allow_collaboration, allow_maintainer_to_push, assignee, assignees,
author, blocking_discussions_resolved, closed_at, closed_by, created_at, description,
detailed_merge_status, discussion_locked, downvotes, draft, force_remove_source_branch,
has_conflicts, id, iid, imported, imported_from, label_details, labels, merge_after,
merge_commit_sha, merge_user, merge_when_pipeline_succeeds, merged_at, merged_by, milestone,
prepared_at, project_id, references, reviewers, sha, should_remove_source_branch, source_branch,
source_project_id, squash, squash_commit_sha, squash_on_merge, state, target_branch,
target_project_id, task_completion_status, time_stats, title, updated_at, upvotes,
user_notes_count, web_url`. No `head_pipeline`, no `diff_refs`, no `has_conflicts` freshness
guarantee. `merge_status` is **null** in glab's JSON (deprecated field not in the struct) while
the raw API still returns it.

Text form: `Showing 5 open merge requests on yeyo11/agentry. (Page 1)\n\n!7\tyeyo11/agentry!7\tprobe conflict\t(probe/base) ← (probe/conflict)`.

### View

`mr view <iid> -F json` adds to the list keys: `changes_count` (string!), `diff_refs{base_sha,
head_sha,start_sha}`, `diverged_commits_count`, `first_contribution`, `head_pipeline`, `pipeline`,
`latest_build_started_at/finished_at`, `merge_error`, `rebase_in_progress`, `subscribed`,
`user{can_merge}`.

Observed states (raw API `merge_status` in brackets):

| MR | state | draft | detailed_merge_status | has_conflicts | merge_status |
|---|---|---|---|---|---|
| mergeable | opened | false | `mergeable` | false | can_be_merged |
| draft | opened | true (`work_in_progress:true`, title `Draft: ...`) | `draft_status` | false | can_be_merged |
| add/add conflict | opened | false | `conflict` | true | cannot_be_merged |
| no diff | opened | false | `commits_status` | **true** | cannot_be_merged |
| auto-merge set, pipeline running | opened | false | `ci_still_running` | false | - |
| auto-merge set, pipeline failed | opened | false | `ci_must_pass` | false | - |
| failed pipeline, no auto-merge, `only_allow_merge_if_pipeline_succeeds:false` | opened | false | `mergeable` | false | - |
| merged | merged | - | `not_open` | - | - |

`diverged_commits_count` is `null` unless requested:
`glab api 'projects/:id/merge_requests/8?include_diverged_commits_count=true&include_rebase_in_progress=true'`
-> `{"diverged_commits_count":4,"rebase_in_progress":false}`.

Full documented list of `detailed_merge_status` (docs/api/merge_requests.md "Merge status"):
`approvals_syncing, checking, ci_must_pass, ci_still_running, commits_status, conflict,
discussions_not_resolved, draft_status, jira_association_missing, mergeable,
merge_request_blocked, merge_time, need_rebase, not_approved, not_open, preparing,
requested_changes, security_policy_pipeline_check, security_policy_violations,
status_checks_must_pass, unchecked, locked_paths, locked_lfs_files, title_regex`.
`merge_status` is deprecated since 15.6.

Not found: `mr view 999 -R r -F json` -> stdout `{"error":{"message":"failed to get merge request 999: 404 Not Found"}}`, stderr `Failed to get merge request 999: 404 Not Found.`, exit 1.

Text view without TTY is a key/value block: `title:\t...\nstate:\topen\nauthor:\t...\nlabels:\t...\nassignees:\t\nreviewers:\t...\nsource_branch:\t...\ntarget_branch:\t...\ncomments:\t0\nnumber:\t4\nurl:\t...\n--\n<description>`.
`mr view --comments` / `--unresolved` / `--resolved` append the notes in the text form (no JSON
for comments; use `mr note list -F json`).

### Update, close, reopen, delete

| argv | stdout | exit |
|---|---|---|
| `mr update 4 -R r -t "..." -d "..."` | `- Updating merge request !4\n✓ updated title to "..."\n✓ updated body\n<url>` | 0 |
| `mr update 5 --ready` | `✓ marked as ready` (draft false, title prefix removed, status `mergeable`) | 0 |
| `mr update 5 --draft` | `✓ marked as Draft` (title `Draft: ...`, `draft_status`) | 0 |
| `mr update 4 -u probe-two` | `✓ removed labels probe-two` | 0 |
| `mr close 6` | `- Closing merge request...\n✓ Closed merge request !6.\n<url>` | 0 |
| `mr close 6` again | stderr `This merge request has been closed.` | **1** |
| `mr reopen 6` | `- Reopening merge request !6...\n✓ Reopened merge request !6.\n<url>` | 0 |
| `mr reopen 6` again | stderr `This merge request is already open.` | **1** |
| `mr close 999` | stderr `Failed to get merge request 999: 404 Not Found.` | 1 |
| `mr delete 3` (no `-y` exists) | `- Deleting merge request !3.\n✓ Merge request !3 deleted.` | 0 (works on merged MRs too) |
| `mr delete 3` again | stderr `Failed to get merge request 3: 404 Not Found.` | 1 |

### Diff

`mr diff 4 -R r` (non-TTY, and `--color never`) -> unified diff, exit 0, **without `index` lines**:

```
diff --git a/probe-notes.txt b/probe-notes.txt
--- a/probe-notes.txt
+++ b/probe-notes.txt
@@ -1,5 +1,5 @@
 probe line 1
-probe line 2
+probe line 2 changed by feat
```

`mr diff 4 --raw` -> the same plus `index <sha>..<sha> <mode>` lines (git-apply-able). No-diff MR
-> empty stdout, exit 0. `mr diff 999` -> exit 1, 404 message.

## 3. Merge (item 3)

`mr merge` flags in 1.120.0: `--auto-merge` (**default true**), `-m --message`, `-r --rebase`,
`-d --remove-source-branch`, `--sha`, `-s --squash`, `--squash-message`, `-y --yes`.
**There is no `--when-pipeline-succeeds`** (auto-merge replaced it).

| case | argv | stdout | stderr | exit |
|---|---|---|---|---|
| plain, with sha + message | `mr merge 4 -R r -y --sha defa07dd... -m "probe merge commit message"` | `! No pipeline running on probe/feat\n✓ Merged!\n<url>` | - | 0 (merge commit title = the message) |
| squash + delete branch | `mr merge 6 -y --squash --squash-message "..." -d` | same shape | - | 0; `squash_commit_sha` set, branch deleted (404 afterwards) |
| rebase | `mr merge 8 -y --rebase` | `✓ Rebase successful!\n! No pipeline running on probe/rebase\n✓ Merged!\n<url>` | - | 0; with `merge_method:merge` it still creates a merge commit after rebasing |
| pipeline running | `mr merge 10 -y` | `! Pipeline status: running\n✓ Auto-merge enabled\n<url>` | - | 0; MR stays opened, `merge_when_pipeline_succeeds:true`, `ci_still_running` |
| already merged | `mr merge 4 -y` | - | `This merge request has already been merged.` | 1 |
| draft | `mr merge 5 [-y]` | - | ``This merge request is still a draft; run `glab mr update 5 --ready` to mark it as ready for review.`` | 1 |
| conflicts | `mr merge 7 -y` | - | `Merge conflicts exist; resolve the conflicts and try again, or merge locally.` | 1 |
| no diff | `mr merge 3 -y` | - | same conflict message (glab keys off `has_conflicts:true`) | 1 |
| sha mismatch | `mr merge 4 -y --sha 000...` | - | `All attempts fail:\n#1: PUT .../merge_requests/4/merge: 409 {message: SHA does not match HEAD of source branch: defa07dd...}.` | 1 |
| pipeline failed with auto-merge set | `mr merge 10 -y` | - | `This merge request requires a passing pipeline before merging.` | 1 |
| not found | `mr merge 999 -y` | - | `Failed to get merge request 999: 404 Not Found.` | 1 |

Raw API `PUT projects/:id/merge_requests/:iid/merge` for draft / conflict / no diff / ci_must_pass:
stdout `{"message":"405 Method Not Allowed"}`, stderr `glab: 405 Method Not Allowed (HTTP 405)`,
exit 1 - the API does not say why; read `detailed_merge_status` first. Documented codes: 400 SHA
required, 401 no permission, 405 cannot merge, 409 SHA mismatch, 422 branch cannot be merged.
`GET .../merge_ref` on a conflicting MR -> `{"message":"Merge request is not mergeable"}` HTTP 400.

`mr rebase 7` (conflicting) -> stderr `Rebase failed: Rebase locally, resolve all conflicts, then
push the branch..`, exit 1; the MR then carries `merge_error` with that text. Flag: `--skip-ci`.

Race found: `mr merge` decides "wait or merge" from the MR's pipeline at call time. Right after a
push (5 s), `head_pipeline` was not linked yet, glab printed `! No pipeline running on probe/ci-ok`
and **merged immediately**; the source branch was then removed by the project default and the
running job failed in `get_sources` (`ERROR: Job failed: exit code 128`, `failure_reason:
script_failure`). An integration that wants "merge when green" must pass `--auto-merge` knowingly
or check `head_pipeline` first.

Auto-merge cancel: `glab api -X POST projects/:id/merge_requests/10/cancel_merge_when_pipeline_succeeds`
-> `{"status":"success"}` exit 0. A second call -> HTTP **201** with body
`{"message":"Can't cancel the automatic merge","status":"error","http_status":406}` and **exit 0**:
errors can hide in a 2xx body here.

Project settings that decide allowed methods: `merge_method` (`merge|rebase_merge|ff`),
`squash_option` (`never|always|default_on|default_off`), `only_allow_merge_if_pipeline_succeeds`,
`allow_merge_on_skipped_pipeline`, `only_allow_merge_if_all_discussions_are_resolved`,
`remove_source_branch_after_merge`, `merge_pipelines_enabled`, `merge_trains_enabled`.

Untested: blocked by unresolved discussions (would need changing
`only_allow_merge_if_all_discussions_are_resolved` on the project; I did not change project
settings). Expected status `discussions_not_resolved`, API 405.

## 4. Notes, discussions, reviews, approvals (item 4)

`glab mr note` has subcommands (all marked EXPERIMENTAL): `create, delete, list, publish, reopen,
resolve, update`. **Argument order is `<mr-iid> <discussion-or-note-id>`** as in the examples; the
USAGE line (`resolve <discussion-id> [<id>]`) is wrong: `mr note resolve abad0af1 4` -> `No open
merge request available for "abad0af1".` exit 1; `mr note update 3932642695 4` -> `Failed to get
merge request 3932642695: 404 Not Found.`

| argv | stdout | stderr | exit |
|---|---|---|---|
| `mr note create 4 -R r -m "..."` | `https://gitlab.com/yeyo11/agentry/-/merge_requests/4#note_3932640920` | - | 0 (creates a resolvable `DiscussionNote`) |
| `mr note 4 -R r -m "..."` (old form) | URL | `Flag --message has been deprecated, use \`glab mr note create\` instead.` | 0 (creates a non-resolvable individual note) |
| `... --file probe-notes.txt --line 2 -m ...` | URL | - | 0 (`DiffNote`, new_line 2) |
| `... --file probe-notes.txt --old-line 2` | URL | - | 0 (old_line 2, new_line null) |
| `... --file probe-notes.txt --line 1:3` | URL | - | 0 (line_range set; position new_line/old_line = end of range) |
| `... --file probe-notes.txt --line 99` | - | `Line 99 not found in diff for probe-notes.txt.` | 1 |
| `... --file nope.txt --line 1` | - | `File "nope.txt" not found in MR diff.` | 1 |
| `... --resolvable=false` | URL | - | 0 |
| `... -m "<same body>" --unique` | URL **of the existing note** | - | 0 (no new note) |
| `echo body \| mr note create 4` | URL | - | 0 (stdin body) |
| `... -m ""` | - | `Aborted: note has an empty message.` | 1 |
| `... --reply abad0af1 -m ...` | URL | - | 0 |
| `... --internal -m ...` | URL | - | 0 (`internal:true`) |
| `... --draft --file probe-feat.txt --line 1 -m ...` | `83292388` (the **draft note id**, not a URL) | - | 0 |
| `mr note publish 4` | - | `--Yes required when not running interactively.` | 1 |
| `mr note publish 4 -y` | `✓ Published 1 pending review comment. <mr url>` | - | 0 |
| `mr note publish 4 -y` (nothing pending) | - | `No pending review comments on !4.` | 1 |
| `mr note resolve 4 abad0af1` | `✓ Discussion resolved (abad0af1… in !4)` | - | 0; again -> same output, 0 (idempotent) |
| `mr note reopen 4 abad0af1` | `✓ Discussion reopened (abad0af1… in !4)` | - | 0 |
| `mr note resolve 4 <non-resolvable note's discussion>` | - | `Failed to resolve discussion: PUT .../discussions/6079...: 403 {message: 403 Forbidden}.` | 1 |
| `mr note resolve 4 deadbeef00` | - | `No discussion found matching prefix "deadbeef00".` | 1 |
| `mr note update 4 3932642695 -m ...` | URL | - | 0 |
| `mr note delete 4 <id>` | - | `--Yes required when not running interactively.` | 1 |
| `mr note delete 4 <id> -y` | `✓ Deleted note 3932642695 from !4` | - | 0; again -> `Note 3932642695 not found in merge request !4.` exit 1 |

`mr note list 4 -F json` -> array of discussions `{id, individual_note, notes[]}`; note keys:
`attachment, author, body, commit_id, confidential, created_at, expires_at, file_name, id,
internal, noteable_id, noteable_iid, noteable_type, position, project_id, resolvable, resolved,
resolved_at, resolved_by, system, title, type, updated_at`. `type` is `""` for plain notes (the API
has `null`), `DiscussionNote`, `DiffNote`. Filters: `--type all|general|diff|system`,
`--state all|resolved|unresolved`, `--file`. Text form:
`@yeyo11 commented less than a minute ago (2026-09-30 17:48:55) [note #3932641401] [discussion: 25947bcb…]\n on probe-notes.txt:2\n <body>`.

### Through `glab api`

- List: `glab api "projects/:id/merge_requests/4/discussions?per_page=3" -i` -> headers include
  `X-Total: 10`, `X-Total-Pages: 4`, `X-Page`, `X-Per-Page`, `X-Next-Page`, `X-Prev-Page`, `Link:
  <...page=2...>; rel="next", <...>; rel="first", <...>; rel="last"`, `Etag: W/"..."`. Discussion
  keys: `id` (40-hex), `individual_note`, `resolvable` (API only, glab struct drops it), `resolved`
  (only when resolvable), `notes[]`. Note extra keys vs glab: `imported, imported_from,
  commands_changes, suggestions, author.public_email, author.locked`.
- Create a diff discussion: `--input pos.json -H "Content-Type: application/json"` with
  `{"body":"...","position":{"position_type":"text","base_sha":"...","start_sha":"...","head_sha":"...","new_path":"probe-feat.txt","old_path":"probe-feat.txt","new_line":1}}`
  -> exit 0, discussion object. Or `-f body=... -F 'position={"position_type":"text",...}'` (JSON
  value) -> 0. **Bracket field names are rejected client-side**: `-f position[base_sha]=...` ->
  `Field name "position[position_type]": a field name containing a bracket is not supported in a
  JSON request body; pass the value as JSON, for example -F 'position={"position_type":"..."}', or
  use --input.` exit 1. The SHAs come from `mr view -F json` `.diff_refs`.
  Position shape returned: `{"base_sha","start_sha","head_sha","old_path","new_path",
  "position_type":"text","old_line":null,"new_line":1,"line_range":null}`. Unchanged context line
  needs both `old_line` and `new_line`.
- Bad line: `{"message":"400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}"}` HTTP 400.
- Reply: `-X POST .../discussions/<id>/notes -f body=...` -> the note, `type:"DiffNote"`, same position.
- Resolve: `-X PUT ".../discussions/<id>?resolved=true"` (or `-F resolved=false`) -> discussion with
  `resolved:true` and on every note `resolved:true, resolved_by:{user}, resolved_at`. Unresolved:
  `resolved_by:null, resolved_at:null`.
- Delete: `-X DELETE .../merge_requests/4/notes/<note_id>` -> empty stdout, exit 0; again -> 404.
- Pending review: `GET .../merge_requests/4/draft_notes` -> `[{"id","author_id","merge_request_id",
  "resolve_discussion","discussion_id","note","commit_id","line_code","position"}]`.

### Approvals

| argv | stdout | stderr | exit |
|---|---|---|---|
| `mr approvers 4 -F json` | `{"approval_rules_overwritten":false,"rules":[]}` | - | 0 |
| `mr approve 4` (own MR) | `- Approving merge request !4\n✓ Approved` | - | 0 (self-approval allowed: no rules on this Free project) |
| `mr approve 4` again | `- Approving merge request !4` | `Post .../merge_requests/4/approve: 401 {message: 401 Unauthorized}.` | 1 (already approved -> **401**, not 409) |
| `mr approve 4 --sha 000...` | progress line | `... 409 {message: SHA does not match HEAD of source branch: defa07dd...}.` | 1 |
| `mr revoke 4` | `- Revoking approval for merge request !4...\n✓ Merge request approval revoked.` | - | 0 |
| `mr revoke 4` again | progress line | `404 Not Found.` | 1 |

There is no `unapprove` subcommand; `revoke` is it. `GET .../merge_requests/4/approvals` ->
`{approved, approvals_required:0, approvals_left:0, approved_by:[{user,approved_at}],
user_has_approved, user_can_approve, approval_rules_left, has_approval_rules,
merge_request_approvers_available:false, multiple_approval_rules_available:false, ...}`.
`GET .../approval_state` -> `{"approval_rules_overwritten":false,"rules":[]}`. Approvals and
revokes appear as system notes (`approved this merge request`, `unapproved this merge request`).

## 5. CI (item 5)

**Pipelines run on this account.** Pushing a branch with `.gitlab-ci.yml` created a `push`
pipeline on SaaS runner `k8s.saas-linux-small-amd64` (docker+machine, default image `ruby:3.1`)
within about 1 s; no verification message.

Config used (probe branch only): `probe-ok` (echo + 6×sleep 5), `probe-fail` (`exit 3`),
`probe-manual` (`when: manual`). `glab ci lint <file> -R r` -> `Validating...\n✓ CI/CD YAML is valid!` exit 0.

| argv | stdout | stderr | exit |
|---|---|---|---|
| `ci status -R r -b probe/ci` (running) | `(manual) • not started\ttest\t\tprobe-manual\n(running) • 00m 22s\ttest\t\tprobe-fail\n...\n\n<pipeline url>\nSHA: <sha>\nPipeline state: running` | - | **0** |
| same, pipeline failed | `... Pipeline state: failed` | - | **1** (no ERROR box) |
| same, pipeline canceled | `... Pipeline state: canceled` | - | **0** |
| same, pipeline success | `... Pipeline state: success` | - | 0 |
| `ci status -F json` (failed pipeline) | `{"jobs":[...],"pipeline":{...}}` | - | **0** (JSON form does not encode the result in the exit code) |
| no pipeline on branch | `✘ no pipeline found for branch probe/base and failed to find associated merge request: ...` (JSON form: `{"error":{...}}`) | same text in ERROR box | 1 |
| `ci get -R r -b probe/ci -F json` | pipeline object + `jobs[]` | - | 0 |
| `ci get --merge-request 10 -F json` | the MR's head pipeline | - | 0 |
| `ci list -R r -F json -r probe/ci` | `[{"id","iid","project_id","status","source","ref","sha","name","web_url","updated_at","created_at"}]` | - | 0 |
| `ci view probe/ci -R r` | - | `Ci view requires an interactive terminal (TTY). For non-interactive use, try: - 'glab ci status' ... - 'glab ci get' ... - 'glab ci trace' ...` | 1 |
| `ci trace <failed job id>` | `\nGetting job trace...\nShowing logs for probe-fail job #16845636949.\n<raw log>` | - | **0** (job failure not reflected) |
| `ci trace <running job id>` | follows live until the job ends (61 s for the 30 s job incl. startup) | - | 0 |
| `timeout 8 ci trace <running>` (TERM or INT) | partial log | - | 124 |
| `ci retry 16845636948` | `Retried job (ID: 16845661144), status: running, ref: probe/ci, weburl: .../jobs/16845661144` | - | 0 |
| `ci run -R r -b probe/ci` | `Created pipeline (id: 2898390023), status: created, ref: probe/ci, weburl: ...` | - | 0 (`source:"api"`) |
| `ci cancel pipeline <id>` | `✓ Pipeline #<id> is canceled successfully.` | - | 0; again on a finished one: same text, 0 |
| `ci cancel pipeline 1` | - | `404 Not Found.` | 1 |
| `ci trigger <manual job id>` | `Triggered job (ID: ...), status: pending, ref: ..., weburl: ...` | - | 0 |
| `ci trigger` again | - | `Post .../jobs/<id>/play: 400 {message: 400 Bad request - Unplayable Job}.` | 1 |
| `ci delete <id>` (one id only; several -> `Accepts 1 arg(s), received 7.`) | `✓ Pipeline #<id> deleted successfully.` | - | 0 |
| `glab api -X DELETE projects/:id/pipelines/<deleted>` | `{"message":"404 Not found"}` | `glab: 404 Not found (HTTP 404)` | 1 |

Trace notes: the log keeps ANSI escapes (`ESC[32;1m`), `\r` and runner section markers
(`section_start:<epoch>:<name>\r ESC[0K`) even under NO_COLOR; each line is prefixed with an
RFC3339 timestamp and a stream tag (`00O`, `01O`, `00O+`). The last line says
`ERROR: Job failed: exit code 3` or `Job succeeded`. `glab api projects/:id/jobs/<id>/trace`
returns the same raw log without the two header lines (exit 0). `ci trace` flags: `-b`, `-p
--pipeline-id`; `ci retry` same. `ci run` flags: `-b`, `--mr`, `--variables`,
`--variables-env`, `--variables-file`, `-f --variables-from`, `-i --input`. `ci cancel` has
`job <id...>` and `pipeline <id...>` with `--dry-run`. `ci delete` has `--status`, `--source`,
`--older-than`, `--dry-run`, `--paginate`.

`ci get -F json` keys: `before_sha, committed_at, coverage, created_at, detailed_status{icon,text,
label,group,tooltip,has_details,details_path,illustration,favicon}, duration, finished_at, id, iid,
jobs[], name, project_id, queued_duration, ref, sha, source, started_at, status, tag, updated_at,
user, variables, web_url, yaml_errors`. Job keys (API): `allow_failure, archived, artifacts,
artifacts_expire_at, commit, coverage, created_at, duration, erased_at, failure_reason,
finished_at, id, name, pipeline, project, queued_duration, ref, runner, runner_manager, stage,
started_at, status, tag, tag_list, user, web_url` (`commit` contains author/committer **emails**,
do not log). Manual jobs: `status:"manual"`, `allow_failure:true`.

MR linkage: `mr view 10 -F json` -> `head_pipeline:{id,status,source,sha,detailed_status,...}` and
`pipeline:{...}` = latest pipeline for the source branch; `glab api projects/:id/merge_requests/10/pipelines`
-> `[{id,iid,project_id,sha,ref,status,source,created_at,updated_at,web_url}]` (both push and api
pipelines of the source branch; no merge_request_event pipelines because the config has no
`workflow:rules`).

Statuses observed. Pipeline: `running, failed, canceling, canceled, success`. Job: `manual,
running, failed, success, canceled, canceling, pending`. `failure_reason`: `script_failure`.
Documented pipeline statuses: `created, waiting_for_resource, preparing, waiting_for_callback,
pending, running, success, failed, canceling, canceled, skipped, manual, scheduled`.
Proposed roll-up: `success` -> passed; `failed` -> failed; `canceled|canceling` -> canceled;
`skipped` -> skipped (neutral); `manual` -> needs action; `created|waiting_for_resource|preparing|
waiting_for_callback|pending|scheduled|running` -> running. Note: a pipeline with a manual job and
other jobs finished stays `running`-then-`failed/success` (manual jobs with allow_failure do not
block); triggering the manual job re-opens a finished pipeline to `running`. Cancelling a pipeline
where a job had already failed ended as `failed`, not `canceled`.

## 6. Issues (item 6)

Note the flag clash: `issue list -F` is `--output-format details|ids|urls`; JSON is `-O json`
(`--output`). `issue list -F json` -> `Invalid argument "json" for "-F, --output-format" flag: must
be one of [urls details ids].` exit 1. `issue view` uses `-F json` like MRs.

| argv | stdout | stderr | exit |
|---|---|---|---|
| `issue create -R r -t T -d D -l probe-label -a yeyo11 -y` | `https://gitlab.com/yeyo11/agentry/-/work_items/1` | `- Creating issue in yeyo11/agentry` | 0 |
| same without `-y` (non-TTY) | URL | same | 0 |
| without `-t` | - | `'--Title' and '--description' (or '--template' or '--attach') required for non-interactive mode.` | 1 |
| `issue list -R r -O json` | array | - | 0 |
| `issue list -F ids` / `-F urls` | `3\n2\n1` / one URL per line | - | 0 |
| `issue view 1 -F json` | object | - | 0 |
| `issue view 999 -F json` | `{"error":{"message":"404 Not Found"}}` | `404 Not Found.` | 1 |
| `issue update 2 -t ... -l probe-extra -d ...` | `- Updating issue #2\n✓ updated title to "..."\n✓ updated description\n✓ added labels probe-extra\n<url>` | - | 0 |
| `issue note 2 -m ...` | `https://gitlab.com/yeyo11/agentry/-/work_items/2#note_3932668019` | - | 0 |
| `issue close 2` | `- Closing issue...\n✓ Closed issue #2\n<url>` | - | 0; **again: same output, 0** (idempotent, unlike MRs) |
| `issue reopen 2` | `- Reopening issue...\n✓ Reopened issue #2.\n<url>` | - | 0; again: 0 |
| `issue close 999` | - | `404 Not Found.` | 1 |
| `issue delete 1` | (empty) | `✓ Issue deleted.` | 0; again: `404 Not Found.` exit 1 |

Issue JSON keys: `_links, assignee, assignees, author, closed_at, closed_by, confidential,
created_at, description, discussion_locked, downvotes, due_date, epic, epic_issue_id, external_id,
health_status, id, iid, issue_link_id, issue_type, iteration, label_details, labels,
merge_requests_count, milestone, moved_to_id, project_id, references{short,relative,full},
service_desk_reply_to, state (opened|closed), subscribed, task_completion_status, time_stats,
title, updated_at, upvotes, user_notes_count, web_url, weight`.

Filters tested (exit 0): `-l probe-label` [1], `-a yeyo11` [1], `--search two` [2], `-c` [],
`-A` [3,2,1], `--not-label probe-label` [3,2], `-P 1 -p 2` [2]. Others: `--author`, `--in
title,description`, `-t --issue-type`, `-m`, `-C --confidential`, `--order`, `-s --sort`.
`issue view -c` prints comments in text only.

Closing keywords: MR !9 `probe/closes -> probe/base` with description `Closes #1`.
- Before merge: `GET .../merge_requests/9/closes_issues` -> `[]`; `glab mr issues 9` -> `No issues
  match your search in yeyo11/agentry.` exit 0; `GET .../issues/1/related_merge_requests` -> [MR !9
  (state opened, target probe/base)]; `GET .../issues/1/closed_by` -> `[]`.
- After merging into the **non-default** `probe/base`: issue 1 stays `opened`, `closed_by:null`;
  its system notes are only `mentioned in merge request !9`. `closes_issues` stays `[]`. So GitLab
  computes closing issues only for MRs targeting the default branch, and the mention still gives a
  `related_merge_requests` link. Not tested into `main` (forbidden).

## 7. Webhooks (item 7)

Create: `glab api -X POST projects/87089091/hooks -f url=https://example.invalid/probe -f name=probe-hook
-f token=<secret> -F merge_requests_events=true -F pipeline_events=true -F note_events=true -F
issues_events=true -F push_events=false -F job_events=false -F enable_ssl_verification=true` ->
exit 0. Response keys: `alert_status, branch_filter_strategy, confidential_issues_events,
confidential_note_events, created_at, custom_headers, custom_webhook_template, deployment_events,
description, disabled_until, duo_flow_callback_enabled, emoji_events, enable_ssl_verification,
feature_flag_events, id, issues_events, job_events, merge_requests_events, milestone_events, name,
note_events, pipeline_events, project_id, push_events, push_events_branch_filter,
releases_events, repository_update_events, resource_access_token_events,
resource_deploy_token_events, signing_token_present, tag_push_events, token_present, url,
url_variables, vulnerability_events, wiki_page_events`. The secret is never returned
(`token_present:true`).

- Bad url: `-f url=not-a-url` -> `{"error":"Invalid url given"}` stderr `glab: HTTP 422`, exit 1.
- Test: `-X POST .../hooks/:id/test/merge_requests_events` against the unresolvable host ->
  `{"message":"URL is blocked: Host cannot be resolved or invalid"}` HTTP 422 exit 1, **but the
  delivery was still recorded**. Bad trigger `test/nope_events` -> `{"error":"trigger does not have a
  valid value"}` HTTP 400.
- Delivery log: `GET .../hooks/:id/events` -> `[{id, url, trigger (merge_request_hooks |
  pipeline_hooks | issue_hooks | note_hooks), request_headers, request_data, response_headers,
  response_body, response_status ("internal error" here), execution_duration, created_at}]`. The
  log redacts `X-Gitlab-Token` and user email as `[REDACTED]`.
- Real events fired it too (note on !7, issue title edit, `ci run`). After 4 failures the hook got
  `disabled_until:"2026-09-30T18:04:27Z"` while `alert_status` still read `executable`.
- Delete: `-X DELETE .../hooks/:id` -> empty, 0; again -> 404, exit 1.

Delivered headers (recorded): `Content-Type: application/json`, `User-Agent: GitLab/19.5.0-pre`,
`Idempotency-Key`, `webhook-id` (= Idempotency-Key), `webhook-timestamp` (unix seconds),
`X-Gitlab-Event` (`Merge Request Hook`, `Pipeline Hook`, `Issue Hook`, `Note Hook`),
`X-Gitlab-Event-UUID`, `X-Gitlab-Webhook-UUID`, `X-Gitlab-Instance: https://gitlab.com`,
`X-Gitlab-Token`.

Signature scheme (https://docs.gitlab.com/user/project/integrations/webhooks/): the legacy
**secret token** is sent verbatim in `X-Gitlab-Token` (compare in constant time; no HMAC). The newer
**signing token** (`signing_token_present`) adds `webhook-signature: v1,<base64 HMAC-SHA256>`
(space-separated list) computed over `{webhook-id}.{webhook-timestamp}.{body}` (Standard Webhooks
style). Hooks are auto-disabled after 4 consecutive failures (temporarily) and permanently after 40;
reply 200/201 quickly.

Payloads (`object_kind` / top-level keys / `object_attributes` keys):
- merge_request: `changes, event_type, labels, object_attributes, object_kind, project, repository,
  user`; OA: `action, approval_rules, assignee_id(s), author_id, blocking_discussions_resolved,
  created_at, description, detailed_merge_status, draft, first_contribution, head_pipeline_id,
  id, iid, labels, last_commit, merge_commit_sha, merge_error, merge_params, merge_status,
  merge_user_id, merge_when_pipeline_succeeds, merged_at, prepared_at, reviewer_ids, source,
  source_branch, source_project_id, squash_commit_sha, state, state_id, target, target_branch,
  target_branch_protected, target_project_id, title, updated_at, url, work_in_progress, ...`.
- pipeline: top `bridges, builds, commit, merge_request (null for branch pipelines),
  object_attributes, object_kind, project, user`; OA: `before_sha, created_at, default_branch,
  detailed_status, duration, finished_at, id, iid, name, protected_ref, queued_duration, ref,
  ref_status_name, root_pipeline_id, sha, source, stages, status, tag, url, variables`; `builds[]`
  has `id, name, status, ...`.
- note: top `event_type, merge_request (for MR notes), object_attributes, object_kind, project,
  project_id, repository, user`; OA: `action, author_id, change_position, commit_id, created_at,
  description, discussion_id, id, internal, line_code, note, noteable_id, noteable_type,
  original_position, position, project_id, resolved_at, resolved_by_id, resolved_by_push, st_diff,
  system, type, updated_at, updated_by_id, url`.
- issue: top `changes (e.g. title, updated_at, updated_by_id), event_type, labels,
  object_attributes, object_kind, project, repository, user`; OA includes `action (update)`,
  `state`, `iid`, `type`, `url`, ...

## 8. API mechanics (item 8)

- `--paginate` **concatenates the JSON arrays** (`[...][...][...]`, not one array). Use
  `--paginate --output ndjson` (one object per line; 10 lines for 10 discussions) or `jq -s add`.
- `-i` prints the status line and headers on **stdout** before the body (blank line between).
- Rate limit headers on every response: `Ratelimit-Limit: 2000`, `Ratelimit-Name:
  throttle_authenticated_api`, `Ratelimit-Observed`, `Ratelimit-Remaining`, `Ratelimit-Reset`
  (unix epoch). 2000 requests/minute for this authenticated account.
- Conditional request: `-H 'If-None-Match: W/"3a90..."'` -> `HTTP/2.0 304 Not Modified`, empty
  body, stderr `glab: HTTP 304`, **exit 1** (a 304 is treated as an error). Weak ETags on list
  endpoints.
- `--hostname gitlab.com` works; `--hostname gitlab.invalid.example` and
  `GITLAB_HOST=gitlab.invalid.example glab api user` -> ERROR box `Get
  "https://gitlab.invalid.example/api/v4/user": dial tcp: lookup gitlab.invalid.example on
  127.0.0.53:53: no such host.` exit 1, nothing on stdout. With `-R https://gitlab.invalid.example/a/b
  -F json` the error also lands on stdout as `{"error":...}`.
- `GITLAB_TOKEN=invalid` overrides the keyring: `glab api user` -> `{"message":"401 Unauthorized"}`,
  `glab: 401 Unauthorized (HTTP 401)`, exit 1; `mr list -F json` -> stdout
  `{"error":{"message":"GET ...: 401 {message: 401 Unauthorized}"}}`, stderr box, exit 1.
- `glab api` accepts an absolute URL (`glab api https://gitlab.com/oauth/token/info` worked).
- `glab api` field types: `-f` string, `-F` inferred (bool/number/JSON object), `--input` file body,
  `--form` multipart; any field switches the method to POST.
- `auth status --show-token` prints the token on stderr in the `Token found in operating system
  keyring:` line (not reproduced here). It is a 64-character OAuth access token.

## 9. Token scopes (item 10)

`glab api personal_access_tokens/self` -> `{"message":"400 Bad request - This endpoint requires
token type to be a personal access token"}` exit 1: glab's keyring login here is an **OAuth
token**. `glab api https://gitlab.com/oauth/token/info` -> `{"scope":["openid","profile",
"read_user","write_repository","api"], "expires_in":3861, ...}` (keys: `application, created_at,
expires_in, expires_in_seconds, resource_owner_id, scope, scopes`) - short-lived, refreshed by glab.

Scopes needed (docs https://docs.gitlab.com/security/tokens/access_token_scopes/): every mutation
in this note (MR create/update/merge/close/delete, notes, discussions, approvals, issues, CI
run/retry/cancel/delete, hooks) needs `api`; listing and viewing works with `read_api` (GET only);
`git push` needs `write_repository` (`read_repository` for fetch). Role requirements on top:
merging into a protected branch needs the role in `merge_access_levels` (Maintainer here);
deleting MRs, issues and pipelines needs Owner/Maintainer-level rights; hooks need Maintainer.
Untested: a read-only token (I did not create tokens). Expected: mutations with `read_api` fail with
`403 insufficient_scope`.

## 10. Summary table

| action | argv | stdout / fields | stderr | exit codes | tested |
|---|---|---|---|---|---|
| version | `glab version` | `glab 1.120.0 (78790114c)` | - | 0 | yes |
| auth | `glab auth status` | - | status block | 0 | yes |
| project facts | `glab repo view -R r -F json` | project object (`default_branch, merge_method, squash_option, permissions.project_access.access_level`, ...) | - | 0 | yes |
| protected branches | `glab api projects/:id/protected_branches` | `name, push_access_levels, merge_access_levels, allow_force_push` | - | 0 | yes |
| MR create | `glab mr create -R r -s S -b B -t T -d D [--draft] [-l] [--reviewer] [--remove-source-branch[=false]] [--squash-before-merge[=false]] -y` | URL | `Creating ... merge request ...`; errors 400 source missing, 409 duplicate, client-side same branch | 0 / 1 | yes |
| MR list | `glab mr list -R r -F json [-s][-t][-d][--not-draft][-l][-c][-M][-A][--search][-P][-p]` | array (no `merge_status`, no `head_pipeline`) | - | 0 (empty `[]` is 0) | yes |
| MR view | `glab mr view N -R r -F json` | `state, draft, detailed_merge_status, has_conflicts, diff_refs, head_pipeline, sha, ...` | 404 box (+ `{"error"}` on stdout) | 0 / 1 | yes |
| MR update | `glab mr update N -R r [-t][-d][--ready][--draft][-l][-u]` | progress + URL | - | 0 | yes |
| MR close/reopen | `glab mr close/reopen N -R r` | progress + URL | `has been closed` / `already open` | 0 / 1 | yes |
| MR delete | `glab mr delete N -R r` (no -y) | progress | 404 | 0 / 1 | yes |
| MR diff | `glab mr diff N -R r [--raw]` | unified diff (`--raw` adds index lines) | - | 0 | yes |
| MR merge | `glab mr merge N -R r -y [--squash --squash-message][--rebase][-d][--sha][-m][--auto-merge=false]` | `✓ Merged!` / `✓ Auto-merge enabled` + URL | draft / conflicts / already merged / passing pipeline required / 409 SHA | 0 / 1 | yes (discussions block untested) |
| MR rebase | `glab mr rebase N -R r` | - | `Rebase failed: ...` | 0 / 1 | conflict case only |
| cancel auto-merge | `glab api -X POST .../cancel_merge_when_pipeline_succeeds` | `{"status":"success"}` or 201 `{"status":"error","http_status":406}` | - | 0 (both!) | yes |
| note create | `glab mr note create N -R r -m ... [--file --line/--old-line/--line a:b] [--reply id] [--draft] [--internal] [--resolvable=false] [--unique]` | note URL (draft: draft note id) | line/file not found, empty body | 0 / 1 | yes |
| note list | `glab mr note list N -R r -F json [--type][--state][--file]` | discussions `{id, individual_note, notes[]}` | - | 0 | yes |
| resolve/reopen | `glab mr note resolve/reopen N <disc-prefix>` | `✓ Discussion resolved (...)` | 403 on non-resolvable, prefix not found | 0 / 1 | yes |
| note update/delete | `glab mr note update N <note> -m` / `delete N <note> -y` | URL / `✓ Deleted note ...` | `--Yes required`, not found | 0 / 1 | yes |
| publish review | `glab mr note publish N -y` | `✓ Published 1 pending review comment.` | `No pending review comments` | 0 / 1 | yes |
| discussions API | `glab api ".../merge_requests/N/discussions?per_page=" [--paginate --output ndjson]` | discussion objects, `X-Total`, `Link` | - | 0 | yes |
| diff discussion API | `glab api -X POST .../discussions --input pos.json -H "Content-Type: application/json"` | discussion with `position` | 400 invalid line_code | 0 / 1 | yes |
| resolve API | `glab api -X PUT ".../discussions/<id>?resolved=true"` | discussion, `resolved_by`, `resolved_at` | - | 0 | yes |
| approve / revoke | `glab mr approve N [--sha]` / `glab mr revoke N` | `✓ Approved` / `✓ ... revoked.` | 401 when already approved, 409 sha, 404 when not approved | 0 / 1 | yes |
| approvals state | `glab mr approvers N -F json`, `glab api .../approvals`, `.../approval_state` | `approved, approvals_left, approved_by[]` | - | 0 | yes |
| CI status | `glab ci status -R r -b B [-F json]` | job lines + `Pipeline state: X` | no pipeline | text: 0 running/canceled/success, 1 failed; json: 0 | yes |
| CI get/list | `glab ci get -b B -F json`, `--merge-request N`; `glab ci list -F json -r B` | pipeline + jobs | - | 0 | yes |
| CI view | `glab ci view` | - | requires TTY | 1 | yes |
| CI trace | `glab ci trace <job> -R r` (bound with `timeout`) | 2 header lines + raw ANSI log, follows live | - | 0 (even if job failed), 124 on timeout | yes |
| CI retry/run/cancel/trigger/delete | see section 5 | one-line confirmations with ids | 404 / Unplayable Job | 0 / 1 | yes |
| MR pipelines | `glab api .../merge_requests/N/pipelines`; `head_pipeline` in `mr view` | `id, status, source, ref, sha` | - | 0 | yes |
| issue create/list/view | `glab issue create -t -d [-l][-a] -y`; `list -O json` (not -F); `view N -F json` | URL on stdout / array / object | progress on stderr | 0 / 1 | yes |
| issue update/note/close/reopen/delete | see section 6 | progress + URL (delete: stderr only) | 404 | 0 (close/reopen idempotent) / 1 | yes |
| closing links | `glab api .../merge_requests/N/closes_issues`, `.../issues/N/related_merge_requests`, `.../issues/N/closed_by`, `glab mr issues N` | issue/MR arrays | - | 0 | yes (non-default target only) |
| webhook CRUD | `glab api -X POST/GET/DELETE projects/:id/hooks[/:id]` | hook object (`token_present`) | 422 invalid url | 0 / 1 | yes |
| webhook test | `glab api -X POST .../hooks/:id/test/merge_requests_events` | - | 422 URL blocked (delivery still logged) | 1 | yes |
| webhook deliveries | `glab api .../hooks/:id/events` | `trigger, request_headers, request_data, response_status` | - | 0 | yes |
| conditional GET | `glab api ... -H 'If-None-Match: <etag>'` | empty | `glab: HTTP 304` | 1 | yes |
| bad token / host | `GITLAB_TOKEN=invalid ...`, `--hostname`, `GITLAB_HOST` | 401 body / nothing | 401 / DNS error | 1 | yes |
| token scopes | `glab api https://gitlab.com/oauth/token/info` | `scope[]` | PAT endpoint 400 for OAuth | 0 | yes (read-only token untested) |

## 11. Cleanup verification (after the run)

Listed at 18:07 UTC (`/tmp/code-hosts-research/glab/cleanup_verify.txt`):
- branches: `dependabot/npm_and_yarn/dev-dependencies-3786338114`,
  `dependabot/npm_and_yarn/production-dependencies-63858eaa04`, `feat/code-hosts`,
  `feat/multi-provider-2`, `feat/web-packages`, `main` (main still at `9820eff3`, untouched).
- merge requests (any state, API): `[]`. MRs !3-!11 were created and deleted; iids 1-2 predate
  this run.
- issues (any state): `[]` (#1-#3 deleted). hooks `[]`, labels `[]` (probe-label, probe-two,
  probe-extra deleted), milestones `[]`, environments `[]`, pipelines `[]` (7 deleted).
- local: worktree `/tmp/code-hosts-research/wt` removed, 10 local `probe/*` branches deleted, 4
  stale `gitlab/probe/*` remote-tracking refs deleted, glab recovery file `mr.json` deleted (the
  empty directory `~/.config/glab-cli/recover/yeyo11/agentry/` remains).
- Leftovers I cannot delete through the API: the project's MR and issue iid counters moved on
  (next MR !12, next issue #4), the activity feed and CI minutes used (about 5 minutes on shared
  runners) remain, and the owner may have received notification emails for the probe activity.
