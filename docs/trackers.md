---
created_at: 2026-10-02T12:00:00Z
updated_at: 2026-10-02T12:00:00Z
tags:
    - trackers
    - issues
    - code-hosts
    - work-items
    - github
    - gitlab
---
# Issue trackers

Phase 5 of [the code hosts plan](plans/code-hosts.md#phase-5-trackers). A tracker is where a
project's issues live. Agentry imports them as work items, writes their keys into change requests,
and tells the tracker when the work moved. This document is the reference for what is built; the
plan keeps the reasoning and the owner's decisions.

## What ships, and what does not

The phase ships in two steps ([why](plans/code-hosts.md#phase-5-in-two-steps-2026-10-02)). This
step is **GitHub Issues** and **GitLab Issues**, complete: manifests, settings, import, links,
sync and `issue.triage`.

**Jira (`acli`) and YouTrack (`youtrack-app`) are a seam only.** Nobody has recorded what those
CLIs print (`t0b` is the owner's). So they exist in the registry as trackers whose readiness is
`unknown` with the reason `not-recorded`, have no adapter (`trackerAdapter('jira')` is null), offer
no action, and an import or a sync against them answers 409 `not-recorded` without running
anything. The `jira` and `youtrack` keys exist in `trackers.json`, in a project's `tracker.id` and
in `IssueRef.tracker`, so the data does not change shape when they arrive. The YouTrack credentials
store and its routes wait for the same recording. Nothing here describes an `acli` or
`youtrack-app` argument, because none has been seen.

## Reaching a tracker

The one rule applies ([CONTRIBUTING](../CONTRIBUTING.md)): a tracker is reached only through its
vendor's CLI. `github-issues` uses `gh` and `gitlab-issues` uses `glab`, with the session the
person already has, so a tracker's readiness is its host's readiness and the project's host must be
that host (`unsupported-host` otherwise). Agentry has no token of its own for either.

An adapter (`packages/core/src/trackers/tracker.ts`, the `TrackerAdapter` interface) is stateless
like a code host's: it builds a `HostCall` and parses the CLI's recorded output; it never runs
anything. `hosts/exec.ts` is still the only place that spawns a CLI. Every argument and every
output shape comes from the recordings in `packages/core/test/fixtures/recordings/` (`gh` 2.92.0,
`glab` 1.120.0), through the action matrix F in the plan. Where a recording disagrees with the
matrix, the recording wins; the `t0a` recording closed the two GitLab cells that were documented
only (`issue update -u` removes a label, but says so even if the label was not there, so Agentry
re-reads; the labels endpoint) and showed that GitLab addresses an issue as `work_items/<iid>`
while its key stays the `iid`.

| Action | GitHub (`gh`) | GitLab (`glab`) |
|---|---|---|
| List, search | `issue list --search … --json …` | `issue list -O json -P 100 -p <n> [--search]` |
| Get | `issue view <n> --json …` (a `/pull/` url is `issue-is-pull-request`) | `issue view <iid> -F json` |
| Create | `issue create --body-file -` (never `--type`) | `issue create -t -d -y` |
| Close | `issue close --reason completed` | `issue close` (idempotent) |
| Reopen, comment, update, labels | as matrix F | as matrix F |

A key is an issue number: `issueNumber` accepts digits (and `#12`) and nothing else, so a key can
never be read as a flag. A body is cut at 60 000 characters (`MAX_ISSUE_BODY`).

## Settings

- **`trackers.json`** in the data directory: per tracker, `enabled` and `binaryPath` (absolute or
  null). Absent reads as every tracker on, searching for its binary. A hand edit that does not
  parse reads as the defaults rather than switching everything off (`trackers/settings.ts`).
- **A project's tracker** is the `tracker` key of its settings document:
  `{ id, scope, query, statusMap }`. `scope` is the repository (`group/project`) for GitHub and
  GitLab. `query` is the tracker's own query the import starts from; empty means the open issues.
  `statusMap` maps `in_progress`, `in_review` and `done` to a tracker status; a missing column is
  not synced. GitHub and GitLab have a single status, so only `done` does anything (it closes the
  issue as completed); the other two are accepted and write nothing.
- **`work_item_issues`** (SQLite, appended last in `packages/core/src/db.ts`): one row per link of
  an issue to an item, unique on `(project_id, tracker, key)`, with the state last read, `synced_at`,
  `sync_state` (`none`, `synced`, `failed`) and `sync_reason`. Removing an item deletes its rows.

## Import

`TrackerImportService` (`trackers/import.ts`, `core.trackerImport`).

1. **List.** The person runs the tracker's own query (prefilled from the project's `query`); a page
   is 100 issues and the ceiling is 500. Each issue is marked with the item it was already imported
   as in this project.
2. **Import.** Each chosen key is read again, so a stale list never decides what an item says, and
   becomes one work item in **backlog**: the title as it is, a type of `bug` when a label says
   `bug`, a `work_item_issues` row. An issue already imported in the project is skipped, not
   imported twice. A key the tracker cannot give (gone, a pull request, a failing host) is skipped
   with its reason and the rest go on. One import takes at most 100 keys; a malformed key refuses
   the whole request before anything is read.
3. **Link by hand.** `link` ties an existing item to an issue by key, and `unlinkIssue` removes the
   tie. Both only change the row; they write nothing to the tracker.

The board module must be on for the project; the service does not check it, the route does.

### Issue text is untrusted

The body of an issue is a stranger's text. It is stored as a **quoted source block** under a head
that says where it came from (`> **From GitHub Issues #12**`), never as instructions, and an agent
that works the item reads it as quoted material. It is cut at 60 000 characters. The same goes for
issue text sent to `issue.triage`: it is data, after the engine's redaction.

Open risk, decided by nobody yet: a change request's body starts with the item's description,
which for an imported item is that quoted block. A body that contains `Closes #99` might make
GitHub close that other issue on merge. It was not possible to confirm how GitHub treats a closing
word inside a blockquote, so no workaround is built; the owner decides whether the quoted text is
left out of the body or has its closing words defanged.

## In change requests

`trackers/links.ts`, used by the pull request service when it builds the title and body.

- **Title.** Unchanged for GitHub and GitLab, because they link from the body. A Jira or YouTrack
  issue's key would be added after the item's key (`feat: … (CW-22, PROJ-12)`); that is in
  `pullRequestTitle` and only runs once those trackers can be linked.
- **Body.** A `## Linked issue` section with a line per issue of the project's tracker.
  `Closes #12` is written only when the tracker is the request's own host **and** the base is the
  project's default branch; otherwise the bare reference (`#12`, or `group/project#12` when the
  issue is in another repository). Into any other base a closing word does not work (recorded for
  both hosts), so Agentry never writes one there. An issue of a tracker the project no longer uses
  is left out. Keys that are not plain (`[A-Za-z0-9_-]`) are left out.
- The branch stays `task/<key>`; Agentry never uses `gh issue develop`, which creates a branch and
  then exits 1 outside a clone.

## Status sync

`TrackerSyncService` (`trackers/sync.ts`, `core.trackerSync`). It runs from Agentry's own events.

- **Item moved** (`workitem.moved`, seen through `observe`) to `in_progress` or `in_review`, and
  **change request merged** (`merged`, called by the pull request service after the host reported
  the merge) for `done`. Only the columns the project mapped are synced.
- **One write per event, never retried.** One pass is: read the issue, write if the column asks for
  a write and nothing else did it, read again. For `done`: an issue already closed is `synced` with
  no write; if the closing word could have worked (default base, the tracker's own host) nothing is
  written and the state stays `none`, and Agentry closes the issue only when a person asks, because
  the closing word may still be on its way; otherwise it closes the issue as `completed`, and the
  re-read must show it closed or the sync is `failed` with `write-unconfirmed`.
- **A failure shows on the item**, on the issue's chip: `sync_state` `failed` with a reason
  (`tracker-signed-out`, `cli-missing`, `cli-incompatible`, `unsupported-host`, `not-found`,
  `issue-is-pull-request`, `write-unconfirmed`, `unreachable`, …), and a **Sync again** action.
  That is the only second attempt, and it is the person's; it does not wait for a closing word.
  Two syncs of the same issue never run at once (409).
- Nothing in the sync moves an item or merges. The merge click is the person's.

## `issue.triage`

A suggest point at project scope, off by default, in the [decision engine](decision-engine.md#issuetriage).
It marks each issue in the import dialog and on imported cards (`ready`, `needs-refining`,
`not-for-agents`); it moves nothing and starts nothing. `TrackerIssue.triage` is null while the point
is off or has not answered.

## Routes

Reads (`GET /trackers`, `GET /trackers/:id`, `GET /trackers/settings`,
`GET /projects/:id/tracker`, `GET /projects/:id/tracker/issues`) and writes
(`POST /trackers/refresh`, `PUT /trackers/settings`, `PUT /projects/:id/tracker`,
`POST /projects/:id/tracker/import`, `POST /work-items/:itemId/issues`,
`DELETE /work-items/:itemId/issues/:key`, `POST /work-items/:itemId/issues/:key/sync`). A chat
token gets 403 on every write. A `TrackerError` answers with its status, its `reason` and the CLI's
first line as `detail`. The README's REST tables list them; the schemas are in `apps/api`.
`PUT|DELETE /trackers/youtrack/credentials` is not built, with the rest of YouTrack.

## Reasons

The tracker reasons live in the host reasons' list (`HostReason`), so the remedy text and the
screens have one vocabulary: `tracker-signed-out`, `transition-unknown`, `issue-is-pull-request`,
`not-recorded`, `tracker-disabled`, and the host's own (`cli-missing`, `not-found`, `write-unconfirmed`, …). See
[Reason codes](plans/code-hosts.md#reason-codes-and-remedy-text).

A tracker turned off in `trackers.json` reads and writes nothing: listing, import and every sync
(a merge's closing write included) pass one door in core that refuses it with `tracker-disabled`
before the host is touched, and the change request body gets no closing word for it. A chat's token
cannot change a project's tracker: the general `PUT /projects/:id/settings` keeps the stored
`tracker` whatever a chat sends.

## How it is tested

A conformance suite for trackers (`packages/core/test/trackers/conformance.ts`) runs every adapter
against the recordings; the import, the links and the sync have their own tests with the CLI faked
on a temporary PATH. Jira and YouTrack have no fakes until they have recordings.

## Related

[[plans/code-hosts.md]] · [[code-hosts.md]] · [[work-items.md]] · [[decision-engine.md]] · [[providers.md]] · [[status.md]]
