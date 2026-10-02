# The fake gh and glab

Two names for one small executable (`host`), for the code host specs: the e2e sandbox has no GitHub or
GitLab CLI, and the suite never depends on a real one or reaches a real host. They are **not** on
`PATH`: `e2e/run.mjs` seeds `hosts.json` so each host uses the binary here, and a spec points a host
somewhere else with the binary override in Settings → Integrations.

They answer what Settings → Integrations, a project's readiness and the change request flow ask:
`--version` (or `version`), the sign-in probe, the default branch, and `pr`/`mr` `create`, `list` and
`view`. Anything else exits 1 with `is not part of the fake`.

What they answer is read from `$AGENTRY_DATA_DIR/fake-hosts/<name>.json`, so a spec changes it without
restarting anything:

| Key | Default | Effect |
| --- | --- | --- |
| `version` | `2.92.0` (gh), `1.120.0` (glab) | The version the CLI prints |
| `versionExit` | `0` | A non-zero exit code for the version call: a binary that is broken |
| `signedIn` | `true` | `false` leaves gh's host list empty and makes `glab auth status` exit 1 |
| `user` | `octocat` (gh), `tanuki` (glab) | The account the sign-in probe names |
| `defaultBranch` | `main` | What the repository lookup answers |
| `next` | `7` | The number the first change request gets |
| `ci` | `none` | The CI of `view`: `none`, `pending`, `passing` or `failing` |
| `state` | `open` | The state of `view`: `open`, `merged` or `closed` |
| `checks` | `none` | gh only: the head commit's checks, `none`, `failing`, `both` (lint and unit both failed), `running`, `mixed` or `fixed` |
| `headSha` | a fixed sha | The head commit the change request reports (gh's GraphQL read, glab's `mr view`): a spec moves it between what the person looked at and what is read later |
| `draftFailAfter` | unset | glab only: the draft note call after the N-th one saved fails (exit 1), so a review stops half way with notes still saved |
| `publishLimit` | unset | glab only: `mr note publish` makes discussions of the first N drafts and drops the rest, exit 0, as a note the host cannot place is dropped |
| `mergeStatus` | `CLEAN` | gh only: the pull request's `mergeStateStatus` for the merge routes: `CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE` or `UNKNOWN` (`mergeable` follows) |
| `mergeDetail` | `mergeable` | glab only: the merge request's `detailed_merge_status` (`need_rebase`, `conflict`, `ci_must_pass`, …); a `mr rebase` makes it `mergeable` again |
| `mergeMethod`, `squashOption` | `merge`, `default_off` | glab only: the project's merge strategy (`merge`, `rebase_merge`, `ff`) and squash option, which decide the methods offered |
| `methods` | `squash merge rebase` | gh only: the methods the repository allows, a space separated list |
| `autoMergeAllowed` | `true` | gh only: `false` is a repository with auto-merge off (the settings say so, and arming is refused) |
| `deleteBranchOnMerge` | `false` | The repository's default for the branch box (gh `delete_branch_on_merge`, glab `remove_source_branch_after_merge`) |
| `requiredChecks` | none | gh only: the required status checks of the base branch, a space separated list of contexts, which turn `BLOCKED` into a failed or a running required check |
| `draft` | `false` | `true` reports the change request as a draft |
| `reviewDecision` | none | gh only: `REVIEW_REQUIRED` or `CHANGES_REQUESTED` |
| `armed` | none | A method (`SQUASH`, `squash`…) that seeds auto-merge as already armed |

The merge scenarios answer the merge routes of a change request. gh answers `pr view --json …,autoMergeRequest`,
`pr merge` (the head guard is the CLI's own: a `--match-head-commit` that is not `headSha` is refused with
"Head branch was modified", exit 1; `--disable-auto` turns auto-merge off), the arming mutation (refused when
`autoMergeAllowed` is `false` or its `oid` is not `headSha`) and the branch rules. glab answers `mr view` with
the merge fields (`head_pipeline` follows `ci`, with the head's sha, and is null for `none`), `mr merge` (a
`--sha` that is not `headSha` is refused in the boxed stderr with a 409; `--auto-merge` arms, `--auto-merge=false`
merges), `mr rebase`, the rebase status and the call that cancels auto-merge. What a spec does moves the
scenario, kept beside the JSON: `<name>.merged` (the method that merged: every read after it says merged) and
`<name>.armed` (the armed method, which a disarm or a merge removes); `glab.rebased` stands for a rebase the host
did. A spec moves the head by rewriting `headSha`, which is how the head guard is checked end to end.

The checks scenarios answer the change request routes: the GraphQL read (`gh api -i … graphql`), the
check runs and statuses of the head, a job's log (ANSI colour, a group marker and an `##[error]`
line, as a runner prints it), the annotations, and the branch rules. `run rerun` and `run cancel` move
the scenario (to `running` and `failing`) through `gh.checks`, which wins over the JSON until a spec
removes it. `failing` has one failed check, `running` one running and one queued, `mixed` a failed,
a running, a skipped and another app's check, and `fixed` has all passed.

The review scenarios answer the review routes of a change request. `reviews` is `none` (the default: no
threads, no reviewers), `threads` or `changes`; both give three threads, one open with a suggestion on
`src/cart.ts` line 12, one resolved on `README.md`, one outdated whose text tries HTML, plus a
reviewer who commented (or asked for changes) and one still asked. On gh they are GraphQL nodes
(`PRRT_kwDOe2e0001` to `0003`), on glab discussions (`111…1`, `222…2`, `333…3`, the third left on
another commit). `pendingReview: true` makes gh list a pending review of the person's own, which
stops a post. What a spec does moves the scenario, kept beside the JSON: `<name>.threadstate` (resolve
and reopen), `<name>.replies`, `<name>.requested` (reviewers asked for: gh refuses the signed-in user
with the author's 422, and a login that starts with `ghost` exits 0 and adds nobody), `gh.review-<n>`
(the body of the n-th review posted, `gh.reviews-posted` counts them) and `glab.approved` (the
approval, moved by `mr approve` and `mr revoke`). glab's draft notes are kept in `glab.drafts` (`<id> <the JSON the CLI was given>` per line, ids from
7001, `glab.draftseq` and `glab.draftposts` count): a POST saves one, a GET lists them, a DELETE takes
one off, and `mr note publish` turns every draft there is into a discussion (kept in `glab.published`
and listed ahead of the scenario's own) and empties the list. A draft of the person's own, which Agentry
never saved, is a line a spec appends there (`9001 {"note":"..."}`): it is listed and published like
any other, which is what the publish rule is checked against.

A review that stops half way is made through the real GitLab path, not stored: `draftFailAfter` or
`publishLimit` make the post stop with some notes saved or some dropped. GitHub never leaves a
partly posted review (it is one request), so nothing here makes gh do it; `pendingReview: true` only
makes gh list a pending review of the person's own, which stops a post. The thread cards in the item's
changes page need a branch: the spec commits `task/<key>` with
`src/cart.ts` rewritten on lines 12 to 14, where the threads sit. `review.triage` is answered by the
fake CLI (`e2e/fake-cli`), not by this fake: it marks the first thread `agent`.

The issue scenarios answer the trackers (GitHub Issues, GitLab Issues): `issue list`, `issue view` and `issue close`.
gh holds four open issues, `#31` to `#34` (a bug whose body tries HTML and a closing word, an enhancement, a bug, and
one with an empty body and markup in its title), and glab holds `#41` and `#42` (the first with a `<script>` in its body).
A search understands `is:open`, `label:x` and plain words of the title. `issueWriteFail: true` makes `issue close` exit 1
with a server error, so a status sync fails for real; a close the CLI took is kept beside the JSON in
`<name>.issues-closed` (one number per line), after which every read says closed and the list leaves the issue out.
`gh issue view` of a number that is not there, and glab's, exit 1 as the hosts do.

Beside the JSON, in the same directory: `<name>.calls` (one line per call, the arguments joined by
spaces), `<name>.body-<n>` (the description a create was given on stdin) and `<name>.created` (the
number the last create returned, which `list` then finds).

The default is a CLI that works and is signed in, which is what the specs that open change requests
need. The Integrations spec changes it, and puts it back before it ends.
