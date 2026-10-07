---
created_at: 2026-10-07T18:00:00Z
updated_at: 2026-10-07T18:00:00Z
tags:
    - decision
    - trackers
    - jira
    - code-hosts
---
# Jira is not supported

**Decided by the owner on 2026-10-07:** Agentry does not support Jira, at least for now, and keeps
no trace of it in the product.

## What it was

Phase 5 of [the code hosts plan](../plans/code-hosts.md) listed four issue trackers: GitHub Issues,
GitLab Issues, Jira through Atlassian's `acli`, and YouTrack through JetBrains' `youtrack-app`. Jira
was a seam only: `acli` works against a Jira Cloud site, nobody recorded it, so it sat in the
registry as `unknown` / `not-recorded`, with no adapter and no action.

## What was removed

- `jira` from `TrackerId`, the tracker registry and settings, and `acli` from the CLIs the
  execution layer knows (its environment, its classifier, the replay fake).
- Jira's row in Settings → Integrations, its option in a project's tracker form, its brand mark and
  colour token, its strings, its tests and fixtures, and its parts of the docs, the OpenAPI
  descriptions and the design reference screens (regenerated).

## What stays, and why

- **Existing data reads cleanly.** A `trackers.json` written while Jira was listed keeps its other
  entries; a project that had saved Jira as its tracker reads as having none.
- **GitLab's own merge blocker** `jira_association_missing` (a GitLab project whose Jira integration
  asks for a key in the title) keeps its wording: it is GitLab's rule, read through `glab`, and the
  person needs it explained to merge.
- **The `not-recorded` path** of the tracker registry stays, so a future tracker can be listed
  before its CLI is recorded, as Jira was.
- Recordings of `glab` keep the Jira fields GitLab's API prints; they are vendor output.

## Related

[[trackers.md]] · [[plans/code-hosts.md]] · [[status.md]]
