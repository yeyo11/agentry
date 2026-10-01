# r0 recording: reviews (code hosts plan, phase 3)

Recorded 2026-10-01, 13:55-14:08 UTC (cleanup verified 14:14 UTC), by the owner's assistant.

- `glab 1.120.0 (78790114c)` at `~/.local/bin/glab`, signed in to gitlab.com as `yeyo11`, against
  the private test project `yeyo11/agentry` (id 87089091) only, branch `probe/r0` only.
- `gh version 2.102.0 (2026-09-30)` (`~/.local/bin/gh`, first on PATH) and `gh version 2.92.0
  (2026-04-28)` (`~/.local/share/gh/2.92.0/bin/gh`), signed in as `yeyo11`, against the public
  scratch repository `yeyo11/agentry-probe` only.
- Environment on every call: `LC_ALL=C NO_COLOR=1 GIT_TERMINAL_PROMPT=0`, plus
  `GLAB_NO_PROMPT=1 GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false` for glab and
  `GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1` for gh. stdin `/dev/null` unless the meta's
  `stdin-sha256` says otherwise (glab) or the argv has `--input -` (gh: the stdin documents are in
  `work/`), stdout and stderr to separate files (non-TTY), cwd `/tmp`, each call under `timeout 60`.
- Recorder: `rec.sh <glab|gh92|gh102> <label> <args>` (the k0 recorder with its base moved to
  `r0/raw`). Captures: `glab/1.120.0/<label>.{out,err,rc,meta}`, `gh/2.102.0/…`, `gh/2.92.0/…`,
  same format as `packages/core/test/fixtures/recordings/` (glab meta: `glab`, `argv`, `exit`,
  `env`, `stdin-sha256`; gh meta: `gh: 102|92`, `argv`, `exit`, `secs`, `env`). Every file went
  through `packages/core/scripts/redact-recordings.mjs`; one rewrite happened (the committer e-mail
  of the setup commit in `setup_commit.out` became `user@example.com`). `raw/` holds the same
  captures (also redacted), the start lists and the cleanup verification; `work/` holds every stdin
  document, the two GraphQL query files and helper id files.
- Fixtures: GitLab MR **!13** (`probe r0 reviews`), head `38ff2ab8`, base `1af44270`; GitHub PR
  **#31** (`probe r0 reviews`), head `1edb6cba`. Both add one file `probe-r0.txt` with ten lines
  `line <one…ten> of the r0 probe`, committed as `yeyo11 <33735891+yeyo11@users.noreply.github.com>`.

General behaviour seen again (same as phase 1 and k0): `glab api` success → body on stdout, stderr
empty, exit 0; failure → the response body on stdout, `glab: <message> (HTTP <code>)` on stderr,
exit 1. `gh api` failure → body on stdout, `gh: <message> (HTTP <code>)` on stderr, exit 1. gh
2.92.0 and 2.102.0 were byte-identical on every call made on both (sizes differ only where the
body names the version).

## Setup

| label | argv | exit | result |
|---|---|---|---|
| `glab/setup_commit` | `glab api -X POST projects/87089091/repository/commits -H "Content-Type: application/json" --input -` (stdin `{branch:"probe/r0",start_branch:"main",commit_message,author_name,author_email,actions:[{action:"create",file_path:"probe-r0.txt",content}]}`) | 0 | commit `38ff2ab8` |
| `glab/mr_create` | `glab mr create -R yeyo11/agentry --source-branch probe/r0 --target-branch main --title "probe r0 reviews" --description … --yes` | 0 | stdout the URL `…/merge_requests/13`, stderr `\nCreating merge request for probe/r0 into main in yeyo11/agentry\n` |
| `glab/mr_view_diffrefs` | `glab api projects/87089091/merge_requests/13` | 0 | `.diff_refs` `{base_sha, head_sha, start_sha}` |
| `gh102/setup_ref`, `setup_file` | `gh api -X POST repos/yeyo11/agentry-probe/git/refs --input -`; `gh api -X PUT repos/…/contents/probe-r0.txt --input -` | 0 | branch `probe/r0`, commit `1edb6cba` |
| `gh102/pr_create` | `gh pr create -R yeyo11/agentry-probe --head probe/r0 --base main --title "probe r0 reviews" --body …` | 0 | stdout `https://github.com/yeyo11/agentry-probe/pull/31`, stderr empty |

A first attempt of the GitLab setup failed before any request reached GitLab with a write (stdin
path was relative to the recorder's `/tmp` cwd), so `glab mr create` hit `400 {source_branch: [does
not exist]}` and wrote a recovery file `~/.config/glab-cli/recover/yeyo11/agentry/mr.json`. Those
captures and the recovery file were deleted; nothing was created on GitLab by it.

## GitLab (glab 1.120.0)

### D3 · a discussion on a line, `--input -`

`glab api -X POST projects/87089091/merge_requests/13/discussions -H "Content-Type: application/json" --input -`,
stdin `{"body","position":{"position_type":"text","base_sha","start_sha","head_sha","old_path","new_path","new_line":2}}`
(`d3_discussion`) → exit 0, stdout the discussion: `{"id":"fa6571a0…" (40 hex), "individual_note":false, "notes":[…]}`;
the note has `type:"DiffNote"`, `resolvable:true`, `resolved:false`, `suggestions:[]`, `position`
`{base_sha,start_sha,head_sha,old_path,new_path,position_type:"text",old_line:null,new_line:2,line_range:null}`.

Line 99 (`d3_discussion_badline`) → exit 1, stdout
`{"message":"400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}"}`,
stderr `glab: 400 Bad request - Note {:line_code=>["can't be blank", "must be a valid line code"]} (HTTP 400)`.
Same as phase 1.

### D7 · suggestions

The suggestion is only a fenced block in the body; GitLab parses it server-side into the note's
`suggestions` array, returned on create and on every later read (discussions list, single
discussion, notes list).

- `d7_suggestion`: a DiffNote on new line 3 with
  ```` ```suggestion:-0+0\nline THREE of the r0 probe\n``` ```` → exit 0;
  `suggestions: [{"id":23239416,"from_line":3,"to_line":3,"appliable":true,"applied":false,"from_content":"line three of the r0 probe\n","to_content":"line THREE of the r0 probe\n"}]`.
  `from_content`/`to_content` end in `\n`; `body` comes back with the trailing newline stripped.
- `d7_suggestion_multi`: on new line 5 with `suggestion:-1+1` and three lines →
  `from_line:4, to_line:6`, `from_content` is the current lines 4-6, `to_content` the three new
  lines. The `-N+M` offsets are relative to the note's line, as documented.
- `d7_suggestion_general`: the same block in a note without `position` → exit 0, a
  `DiscussionNote` (resolvable, `individual_note:false`) with **`suggestions: null`** (a DiffNote
  without suggestions has `[]`). A suggestion outside a line note is kept as plain text.
- A suggestion inside a **draft** note is parsed when the draft is published: the draft's own
  object has no `suggestions` key (`d8_draft_suggestion`); after publish the DiffNote has one
  suggestion (`d1_discussions_after_publish`, discussion `6ba427de`).

Applying a suggestion was not recorded (not in the matrix).

### D8 · draft notes through the API, then publish

Each draft: `glab api -X POST projects/87089091/merge_requests/13/draft_notes -H "Content-Type: application/json" --input -`.

| label | stdin | exit | stdout |
|---|---|---|---|
| `d8_draft_line` | `{"note","position":{…,"new_line":7}}` | 0 | `{"id":83394151,"author_id":12337531,"merge_request_id":541494948,"resolve_discussion":false,"discussion_id":null,"note":"…","commit_id":null,"line_code":"12be7771…_0_7","position":{…,"new_line":7,"line_range":null}}` |
| `d8_draft_general` | `{"note"}` | 0 | same keys, `line_code:null`, `position` with every key present and `null` except `position_type:"text"` |
| `d8_draft_suggestion` | `{"note":"…```suggestion:-0+0…","position":{…,"new_line":8}}` | 0 | as the line draft |
| `d8_draft_todelete` | `{"note"}` | 0 | id 83394157 |
| `d8_draft_badline` | `{"note","position":{…,"new_line":99}}` | **0** | **accepted**: `line_code:null`, `position.new_line:99` |
| `d8_draft_noct` | `{"note"}`, **without** `-H "Content-Type: application/json"` | 1 | stdout `{"error":"The provided content-type '' is not supported."}`, stderr `glab: HTTP 415`; no draft created |

Publish: `glab mr note publish 13 -R yeyo11/agentry -y` (`d8_publish_with_badline`) with four drafts
pending (line 7, general, suggestion on 8, **bad line 99**) → exit 0, stdout
`✓ Published 4 pending review comments. https://gitlab.com/yeyo11/agentry/-/merge_requests/13`,
stderr empty. Afterwards `draft_notes` is `[]` (`d8_draft_list_after_publish`) and **only three**
discussions were created (`d1_discussions_after_publish`, `notes_all_after_publish`): the draft on
line 99 was **dropped silently** — no note, no system note, no error, and it was counted in "4".
Re-read 3 minutes later (`big_discussions_paginate`): still absent.

What the published drafts became: the line draft → a `DiffNote` discussion (`individual_note:false`,
resolvable); the general draft → a **`DiscussionNote` discussion, `individual_note:false`,
resolvable** (not an individual note); the suggestion draft → a `DiffNote` with one suggestion.
Each published draft is its own discussion, and the publish is not one atomic "review" object.
`glab mr note list 13 -F json` while drafts were pending (`mr_note_list_with_drafts`) does not show
drafts.

### D12 · list and delete draft notes

- `glab api projects/87089091/merge_requests/13/draft_notes` (`d12_draft_list`) → exit 0, array of
  the draft objects above, **newest first**. `-i` (`d12_draft_list_i`): `HTTP/2.0 200 OK` and
  headers on stdout, **no `X-Total`/`X-Page`/`Link` headers** (the endpoint is not paginated).
- `glab api -X DELETE projects/87089091/merge_requests/13/draft_notes/83394157`
  (`d12_draft_delete`) → exit 0, stdout and stderr empty. Again (`d12_draft_delete_again`) → exit 1,
  stdout `{"message":"404 Not found"}`, stderr `glab: 404 Not found (HTTP 404)`.

### D4 · reply with `--input`

`glab api -X POST projects/87089091/merge_requests/13/discussions/<id>/notes -H "Content-Type: application/json" --input -`,
stdin `{"body"}` (`d4_reply_input`) → exit 0, the note: `type:"DiffNote"`, same `position` as the
root, `resolvable:true`. Without the content-type header (`d4_reply_input_noct`) → exit 1, `HTTP
415` as above. Unknown discussion id (`d4_reply_baddisc`) → exit 1, stdout
`{"message":"404 Discussion Not Found"}`, stderr `glab: 404 Discussion Not Found (HTTP 404)`.

### D5 / D6 · resolve and reopen

`glab mr note resolve 13 fa6571a0 -R yeyo11/agentry` (`d5_resolve`) → exit 0, stdout
`✓ Discussion resolved (fa6571a0… in !13)`; re-read (`d5_resolve_reread`): every note
`resolved:true`, `resolved_by.username:"yeyo11"`, `resolved_at` set.
`glab mr note reopen 13 fa6571a0` (`d6_reopen`) → `✓ Discussion reopened (fa6571a0… in !13)`;
re-read: `resolved:false`, `resolved_by:null`. The general discussion created from a draft
(`f5696b90`) resolves and reopens the same way (`d5_resolve_general`, `d6_reopen_general`).

### D9 · approve and revoke as the author

On gitlab.com Free, own MR, no approval rules:

| label | argv | exit | stdout / stderr |
|---|---|---|---|
| `d9_approvals_before` | `glab api …/merge_requests/13/approvals` | 0 | `approved:true, approvals_required:0, approvals_left:0, user_has_approved:false, **user_can_approve:false**, approved_by:[]` |
| `d9_approve` | `glab mr approve 13 -R yeyo11/agentry --sha 38ff2ab8…` | 0 | `- Approving merge request !13\n✓ Approved` / empty |
| `d9_approvals_after_approve` | | 0 | `user_has_approved:true, user_can_approve:false, approved_by:[{user:{username:"yeyo11"},approved_at}]` |
| `d9_approve_again` | same | 1 | progress line / `POST …/approve: 401 {message: 401 Unauthorized}.` (boxed `ERROR`) |
| `d9_revoke` | `glab mr revoke 13 -R yeyo11/agentry` | 0 | `- Revoking approval for merge request !13...\n✓ Merge request approval revoked.` |
| `d9_approvals_after_revoke` | | 0 | back to `user_has_approved:false, approved_by:[]` |
| `d9_approve_badsha` | `--sha 0000…` | 1 | `… 409 {message: SHA does not match HEAD of source branch: 38ff2ab8…}.` |

**GitLab allows the author to approve their own MR here, while `user_can_approve` stays `false`
before and after.** `approved` is `true` even with zero approvals (no rules). Approve and unapprove
each add a system note (`approved this merge request`, `unapproved this merge request`,
`individual_note:true`, `resolvable:false`, `type:null`).

### D11 · `glab mr update --reviewer`

Help: "Prefix with '!' or '-' to remove from existing reviewers, '+' to add. **Otherwise, replace
existing reviewers** with given users."

| label | argv | exit | stdout / stderr | `reviewers` after |
|---|---|---|---|---|
| `d11_update_reviewer` | `glab mr update 13 -R yeyo11/agentry --reviewer yeyo11` | 0 | `- Updating merge request !13\n✓ requested review from "@yeyo11"\n<url>` | `[{id,username:"yeyo11",state:"active",…}]` (`d11_reread`) |
| `d11_reviewers_endpoint` | `glab api …/merge_requests/13/reviewers` | 0 | `[{user:{…},state:"unreviewed",created_at}]` | |
| `d11_update_reviewer_again` | same | 0 | same text; no new system note (idempotent) | `["yeyo11"]` |
| `d11_update_reviewer_nouser` | `--reviewer no-such-user-r0-probe-zz` | 1 | stdout empty / boxed `ERROR … Failed to find user by name: no-such-user-r0-probe-zz.`; no change | `["yeyo11"]` |
| `d11_update_reviewer_remove` | `--reviewer=-yeyo11` | 0 | `✓ removed review request for "@yeyo11".` | `[]` |
| `d11_update_reviewer_add` | `--reviewer=+yeyo11` | 0 | `✓ requested review from "@yeyo11".` | `["yeyo11"]` |

Requesting the author as reviewer is accepted on GitLab. Each change adds a system note
(`requested review from @yeyo11`, `removed review request for @yeyo11`).

### D1 · a discussion with more than 100 notes

One general discussion (`67970429…`) with a root and 101 replies (102 notes), created with
`glab api -X POST …/discussions[/<id>/notes] -f body=…` in a loop (not captured; 0 failures, no
throttling at about 1 call/s).

- `glab api --paginate --output ndjson "projects/87089091/merge_requests/13/discussions?per_page=100"`
  (`big_discussions_paginate`) → exit 0, 13 lines (one discussion per line); the big discussion
  carries **all 102 notes inline**. GitLab does not paginate the notes inside a discussion.
- `-i` with `per_page=100` (`big_discussions_i`): `X-Total: 13`, `X-Total-Pages: 1`, `X-Next-Page:`
  empty, `Link` with `first`/`last`. With `per_page=5` (`big_discussions_per5_i`): `X-Total-Pages: 3`,
  `X-Next-Page: 2`, `Link rel="next"`. The total counts discussions, not notes.
- `glab api …/discussions/<id>` (`big_discussion_one`) → the one discussion, 102 notes.
- `glab api --paginate --output ndjson "…/notes?per_page=100&sort=asc"` (`big_notes_paginate`) →
  115 lines (every note, system ones included, across two pages).
- `glab mr note list 13 -F json` (`big_mr_note_list`) → 13 discussions, notes per discussion
  `[2,1,1,1,1,1,1,1,1,1,1,1,102]`.

## GitHub (gh 2.102.0 and 2.92.0, identical)

### D8 · a COMMENT review with line comments, `--input -`

`gh api -X POST repos/yeyo11/agentry-probe/pulls/31/reviews --input -`:

- gh 2.102.0 (`d8_review_comment`), stdin `{commit_id,event:"COMMENT",body,comments:[{path,line:2,side:"RIGHT",body},{path,start_line:4,start_side:"RIGHT",line:5,side:"RIGHT",body},{path,line:3,side:"RIGHT",body:"…```suggestion\n…\n```"}]}`
  → exit 0, `{"id":5380332359,"node_id":"PRR_…","state":"COMMENTED","commit_id":<head>,"submitted_at":…,"body":…}`.
- gh 2.92.0 (`d8_review_comment`), one comment on line 7 → exit 0, `state:"COMMENTED"`.
- A review whose second comment is on line 99 (`d8_review_badline`, both versions) → exit 1, stdout
  `{"message":"Unprocessable Entity","errors":["Line could not be resolved"],"documentation_url":"…#create-a-review-for-a-pull-request","status":"422"}`,
  stderr `gh: Unprocessable Entity (HTTP 422)`. **All or nothing**: no review and no comment was
  created (`d12_reviews_list` shows only the two good reviews; no PENDING review left).
- The suggestion body reads back verbatim through GraphQL (`d1_threads_big`, thread 3).

### D1 · threads query with `$endCursor`, and a thread with more than 100 comments

Query file `work/threads.graphql` (the gh§B7 query with `headRefOid`, `comments(first:100)` and
`comments.pageInfo`); follow-up `work/thread-comments.graphql`
(`node(id:$id){… on PullRequestReviewThread{comments(first:$first, after:$endCursor){totalCount pageInfo nodes}}}`).

- `gh api -i graphql --paginate -F query=@threads.graphql -F owner=yeyo11 -F repo=agentry-probe -F number=31 -F first=100`
  (`d1_threads`) → exit 0, one `HTTP/2.0 200 OK` block then the document. Node:
  `{id:"PRRT_…",path,line:2,startLine:2,originalLine:2,diffSide:"RIGHT",startDiffSide:null,subjectType:"LINE",isOutdated:false,viewerCanResolve:true,viewerCanReply:true,…}`;
  the range thread has `startLine:4,line:5,startDiffSide:"RIGHT"`. A single-line thread has
  `startLine == line` but `startDiffSide: null`.
- `first=2` (`d1_threads_first2`) → two documents (2 + 2 threads, `totalCount:4`); with `-i`
  (`d1_threads_i_first2`) each page has its own `HTTP/2.0 200 OK` header block on stdout.
- Thread `PRRT_kwDOU1zIIM6n-Zov`: root + 100 replies = **101 comments** (101 replies were sent, one
  got `gh: Server Error (HTTP 502)` and was not created; 101 is enough to cross the page). Replies
  through `POST pulls/31/comments/<id>/replies -f body=…`, paced 1.2 s, not captured.
  `d1_threads_big` (`-i`, `--paginate`, `first=100`) → one page; that thread has
  `comments.totalCount:101`, 100 nodes, `comments.pageInfo.hasNextPage:true`. **gh's `--paginate`
  follows only the connection that takes `$endCursor`** (reviewThreads): it made one request and did
  not chase the nested comments cursor, also when the threads' `pageInfo` is placed after `nodes`
  (`d1_threads_pageinfo_last`). `rateLimit.cost` 1.
- Follow-up `gh api graphql --paginate -F query=@thread-comments.graphql -F id=PRRT_kwDOU1zIIM6n-Zov -F first=100`
  (`d1_followup`) → exit 0, two documents (100 + 1 comments, cost 1 each); `--slurp`
  (`d1_followup_slurp`) → an array of two. Starting at the cursor from the first query
  (`d1_followup_after`, `-F endCursor=<comments.pageInfo.endCursor>`, no `--paginate`) → only the
  101st comment, `hasNextPage:false`. Either form works; the second avoids re-reading 100 comments.

### D4 · reply with `--input`

`gh api -X POST repos/yeyo11/agentry-probe/pulls/31/comments/4156242983/replies --input -`, stdin
`{"body"}` (`d4_reply_input`, both) → exit 0, the comment (`id`, `node_id:"PRRC_…"`,
`in_reply_to_id:4156242983`, `line:2`, `path`, and a **new** `pull_request_review_id`). Bad comment
id (`d4_reply_badid`) → exit 1, stdout `{"message":"Parent comment not found",…,"status":"404"}`,
stderr `gh: Parent comment not found (HTTP 404)`.

**Every reply creates its own submitted review** (`state:"COMMENTED"`, empty body): after 2 reviews
and 102 replies (104 reviews), `reviews?per_page=100` (`d12_reviews_list_end`) returned exactly 100 COMMENTED
reviews, i.e. the list was already past one page.

### D5 / D6 · resolve and unresolve

`gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved resolvedBy{login}}}}' -F id=PRRT_kwDOU1zIIM6n-Zjq`
(`d5_resolve`, both) → exit 0, `{"data":{"resolveReviewThread":{"thread":{"id":…,"isResolved":true,"resolvedBy":{"login":"yeyo11"}}}}}`;
again (`d5_resolve_again`) → exit 0, same (idempotent). `unresolveReviewThread` (`d6_unresolve`) →
`isResolved:false, resolvedBy:null`. Unknown id (`d5_resolve_badid`) → exit 1, stdout
`{"data":{"resolveReviewThread":null},"errors":[{"type":"NOT_FOUND","path":["resolveReviewThread"],…,"message":"Could not resolve to a node with the global id of 'PRRT_doesnotexist'"}]}`,
stderr `gh: Could not resolve to a node with the global id of 'PRRT_doesnotexist'`.

### D11 · request a reviewer

`gh api -X POST repos/yeyo11/agentry-probe/pulls/31/requested_reviewers --input -`:

- stdin `{"reviewers":["yeyo11"]}` (the author; `d11_request_self`, both) → exit 1, stdout
  `{"message":"Review cannot be requested from pull request author.",…,"status":"422"}`, stderr
  `gh: Review cannot be requested from pull request author. (HTTP 422)`.
- stdin `{"reviewers":["no-such-user-r0-probe-zz"]}` (`d11_request_nouser`, 2.102.0) → **exit 0**,
  stdout the whole pull request with `requested_reviewers: []`: an unknown login is dropped silently.
- `gh pr view 31 --json reviewRequests,reviewDecision,reviews` (`d11_reread`) → `reviewRequests:[]`,
  `reviewDecision:""`.

## Not recorded, and why

- GitHub `APPROVE` / `REQUEST_CHANGES`: dropped by owner decision 1.
- GitLab request changes (D10): no CLI path, not in scope.
- Applying a GitLab or GitHub suggestion: not in the matrix.
- GitLab `PUT draft_notes/:id/publish` (publishing one draft) and `bulk_publish` through the API:
  not needed, `glab mr note publish -y` was used as the plan says.
- GitLab and GitHub rate limiting: none hit (GitLab `Ratelimit-Remaining` 1995 of 2000 at the
  draft list; GitHub GraphQL `remaining` 4955).

## Contradictions with the plan

1. **D8 GitLab, failure handling.** The plan says "a failed note stops the batch →
   `review-partly-posted`". A draft on a line outside the diff is **accepted** at create
   (`line_code:null`, exit 0) and **dropped silently** by `glab mr note publish -y` (exit 0,
   "Published 4" for 3 notes). Nothing fails, so nothing stops. Agentry must validate each line
   against the diff before creating the draft (a draft with `line_code: null` and a `position.new_line`
   is the tell, visible in the create response and in D12 list), and/or count the published notes
   against the drafts by re-reading D1.
2. **D4 and D8 GitLab argv omit `-H "Content-Type: application/json"`.** With `--input -` and no
   header, GitLab answers **415** `{"error":"The provided content-type '' is not supported."}`
   (stderr `glab: HTTP 415`, no message), on both `…/discussions/<id>/notes` and `…/draft_notes`.
   D3 already has the header; D4 and D8 need it too. The 415 body uses `error`, not `message`.
3. **D8 GitHub, line refusal.** The plan maps `pull_request_review_thread.line` → `line-not-in-diff`.
   On the reviews endpoint the 422 is `{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}`
   (`errors` is an array of strings). The mapping needs this text.
4. **D8 GitLab, what a published draft becomes.** The general draft (the review body) becomes a
   resolvable `DiscussionNote` discussion with `individual_note: false`, not a top-level comment; D2's
   "discussions with `individual_note: true`" will not find it. Every published draft is its own
   discussion; there is no review object, so recovery has to look for the marker in note bodies.
5. **D11 GitLab argv.** `--reviewer <user,…>` **replaces** the reviewer list; to add without
   dropping others the value must be `+user` (and `-user` / `!user` removes). The plan's argv would
   silently remove existing reviewers. An unknown user fails client-side (exit 1, `Failed to find
   user by name`), not "1 → re-read" of a server error. Requesting the author is accepted on GitLab.
6. **D11 GitHub.** Besides the recorded 422 for the author, an unknown login returns **exit 0** with
   the reviewer silently absent; the plan's re-read of `reviewRequests` is required, not optional.
7. **D9 GitLab.** `user_can_approve` is `false` for the author even though `glab mr approve`
   succeeds; Agentry must not use it to decide whether Approve is possible. (The plan hides Approve
   when the viewer is the author; the host does not require that on this Free project.)
8. **D12 GitHub.** Each D4 reply creates a separate submitted review, so `reviews?per_page=100`
   overflows quickly; the D12 read needs `--paginate` (only `PENDING` ones matter).
9. **D1 GitLab.** The plan's "a thread with more than 100 comments gets a follow-up" applies to
   GitHub only: a GitLab discussion returns all its notes inline (102 seen); `per_page` counts
   discussions.
10. **D1 GitHub follow-up.** Confirmed as planned; the follow-up can start from the first query's
    `comments.pageInfo.endCursor` (one request for the remainder) instead of re-reading from the
    start with `--paginate`. `--paginate` never followed the nested comments cursor (no trap).
11. **D7 GitLab.** Confirmed: `suggestions[]` with `from_line,to_line,appliable,applied,from_content,to_content`;
    a suggestion block in a non-line note gives `suggestions: null`, in a line note without one `[]`.

## Cleanup (verified 14:14:46 UTC, `raw/cleanup_verify.txt`, `raw/cleanup_github.txt`)

GitLab: MR !13 deleted (`DELETE projects/87089091/merge_requests/13`, which removes its notes,
discussions and drafts; `GET …/13` → 404); branch `probe/r0` deleted. After: merge requests (all
states) `[]`; pipelines `[]` (none were created: `ref=probe/r0` and `refs/merge-requests/13/head`
both `[]`); branches identical to the 16 at the start (`raw/start-gitlab-branches.txt`); `main` at
`1af44270`, its value at the start (never written). glab's recovery file from the failed first
attempt deleted. Left: the MR iid counter moved on (next MR !14), the activity feed, and possible
notification e-mails.

GitHub: all 106 review comments on #31 deleted (`DELETE pulls/comments/<id>`, `pulls/31/comments` →
0, threads `totalCount: 0`); PR #31 closed with `gh pr close 31 --delete-branch`; branches `["main"]`;
open PRs `[]`. Left (not deletable): closed PR #31 with its now-empty COMMENTED reviews, and the
commit `1edb6cba` (unreachable from any branch).
