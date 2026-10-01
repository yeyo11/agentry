---
created_at: 2026-09-28T00:00:00Z
updated_at: 2026-10-01T13:40:00Z
tags:
    - plan
    - roadmap
    - verification
---
# Spec: close the verification of roadmap-completion and post-roadmap (CW-7)

Status: **done on 2026-10-01**: see the Verification sections of
[roadmap-completion.md](roadmap-completion.md#verification-2026-10-01) and
[post-roadmap.md](post-roadmap.md#verification-2026-10-01). It differed from this text in two ways,
both on the launch's instructions. `main` was at 0.29.1, not 0.23.x, so the Status lines say 0.29.1.
And the full `pnpm e2e` suite was not run: only the specs that prove a claim ran, one at a time, on
`E2E_PORT=8863`. The full run is the one item left open in both plans, listed with the other
follow-ups in [post-roadmap.md](post-roadmap.md#follow-ups). No work item was created for them.

## Why

[roadmap-completion.md](roadmap-completion.md) (#62) and [post-roadmap.md](post-roadmap.md) are both
tagged `verification-pending` and listed in [status.md](../status.md) as *Built; final
verification pending*. Each already has an Outcome, but the `docs` task of each orchestration wrote
it from the branches, and **no task ran `pnpm e2e`**. The rules forbade it. Nobody has since
checked those claims against `main`. Since then `main` has moved to 0.23.0 with the project
ecosystem (#118), so a claim that held on the integration branch may no longer hold.

This is a documentation and verification task. Code changes are allowed only as small fixes for
something the plans say landed and does not work. Anything bigger becomes a new work item.

## Scope

In scope:

- Every row of roadmap-completion's **Landed** table, and every bullet of its **Left out, and why**.
- Every bullet of post-roadmap's **Outcome** (stages 0–3), and its **Decided against** and **What no
  task built** lists.
- Each plan's **What "done" means** section, which is the plan's own acceptance list.

Out of scope: re-verifying the ecosystem, Night Shift or later plans, and building anything left
out on purpose.

## How to walk the items

1. Work in a worktree off `main`. The dev servers run from the main checkout.
2. For each item, read the claim, then find it in the code (the route in
   `apps/api/src/openapi/routes.ts`, the type in `packages/shared/src/types.ts`, the module in
   `packages/core`, or the screen in `apps/web`) and in the README (REST tables, Features, Known
   limitations). Give it exactly one mark:
   - **done**: present on `main` and it behaves as described. Cite the file, and the test or spec
     that covers it when one exists.
   - **done later**: listed as left out in roadmap-completion but built by post-roadmap. Link the
     post-roadmap bullet. Examples: supervisor, fixer cost limit, install step, `failGraph`, audit
     filters, default preset, schedule overlap, project export, editor settings on the server,
     Allow/Deny from a notification, server strings translated.
   - **fixed**: missing or broken, and repaired in this change. Give the commit subject.
   - **dropped**: not there, and deliberately so. Quote the reason: the plan's own reason, a
     decision in `docs/decisions/`, ROADMAP's *Decided against*, or README *Known limitations*.
   - **open → CW-n**: missing and too large to fix here. Create a work item and cite its id.
3. Items that must be looked at on purpose, because they are easy to wave through:
   - The README rows for every route either plan added. Check them against `routes.ts`.
   - `?token=` routes: post-roadmap says five. Count them in the code.
   - The OpenAPI schemas: `pnpm --filter @agentry/api openapi:schemas` must leave no diff.
   - `e2e/harness.test.mjs`: post-roadmap's "done" requires it green. CI does not run it (decided
     against), so run it by hand with `node --test e2e/harness.test.mjs`.
   - The fake-CLI specs (`fakeCli = true`) and the health action buttons.
   - The media: `pnpm media` is required only if a README still shows a screen from before Night
     Shift. Otherwise mark it *done* and say that the media was re-recorded later, or *dropped* with
     the reason.
   - The "Noticed and not fixed" chat-title item: check whether it still reproduces on 0.23.0.

## The four checks

Run them once, on the worktree, after any fixes:

```bash
timeout 900 pnpm typecheck
timeout 1800 pnpm test
timeout 900 pnpm build
E2E_PORT=8899 timeout 3600 pnpm e2e
```

Use a free `E2E_PORT` so the suite does not collide with an orchestration verifying on 8799. For
each check, quote in the Outcome the date, the commit, the pass and fail counts, and the last
summary line. A spec that fails in the full run must be re-run alone (`pnpm e2e <name>`):

- If it passes alone, record it as flaky and compare it with the known baseline in
  [redesign-night-shift.md](redesign-night-shift.md#before-launching).
- If it fails again, fix it or open a work item for it.

## What to write

- **Each plan**: a new `## Verification (2026-MM-DD)` section after its Outcome.
  - Add a table with the columns *Item · Mark · Evidence / reason*. It has one row per item listed
    in Scope, and no item may be missing.
  - Quote the results of the four checks and of `e2e/harness.test.mjs`.
  - Change the `Status:` line to **Verified on `<commit>` (0.23.x)**.
  - In the front matter, replace the `verification-pending` tag with `verified` and bump
    `updated_at`.
- **docs/status.md**:
  - Change both rows of the plans table to *Verified — see Verification*, with a link to it.
  - Delete the Known-gaps bullet "Two plans whose final verification never ran".
  - Update the "How it is checked" paragraph with this run's results.
  - While there, the ecosystem row still says it "awaits … one pull request to `main`", but #118
    merged it. Correct that row too.
- **ROADMAP.md / README Known limitations**: touch these only if a mark changes what they say. For
  example, if a limitation listed there turns out to be fixed, or a "done" item turns out to be
  missing.

## Related

[[plans/roadmap-completion.md]] · [[plans/post-roadmap.md]] · [[status.md]] ·
[[plans/redesign-night-shift.md]] · [[e2e]]
