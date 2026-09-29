---
created_at: 2026-09-28T19:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - plan
    - spec
    - ci
    - e2e
    - performance
    - in-progress
---
# Spec: headroom for the e2e suite in CI (CW-3)

Story CW-3 of the epic CW-11 "Faster orchestrations", and the CI half of workstream C of
[plans/orchestration-speed.md](orchestration-speed.md). Status: **part 3 built** on 2026-09-29 in
`ci/e2e-shards`, together with CW-14's §1 (the split it uses), as described under
[What was built](#what-was-built); part 1 was measured on a pull request rather than on `main`, and
parts 2 (the three specs that fail only in the full run) and 4 (the new CI times) are open.

## Why

- `.github/workflows/ci.yml` runs install, audit, the OpenAPI drift check, typecheck, tests, build,
  the Claude Code install and the whole e2e suite in **one** job, `test`, with
  `timeout-minutes: 20`. That 20 comes from a run on #62 that took 7.5 minutes.
- The suite has grown since then. On orchestration branches it went from 5.8 min
  (`post-roadmap`) to 18.3 min (`ecosystem-gaps`), and `main` now has 51 specs
  ([status.md](../status.md)). On a GitHub runner the job may no longer fit in 20 minutes. Nobody
  has measured it on `main` since the ecosystem merge.
- Three specs fail in the full run and pass alone: `config.spec.mjs` ("project-scope instructions
  shown"), `home.spec.mjs` ("every widget names itself with a heading") and
  `observability.spec.mjs` ("the worktree link uses the template and the host path"). See
  [redesign-night-shift.md, Before launching](redesign-night-shift.md#before-launching). A spec
  that only fails in company fails because of state that an earlier spec left in the shared sandbox
  (settings, projects, the worktree template, layout). Sharding changes which specs run together, so
  it could hide that flakiness without fixing it.

## Relation to CW-14 (already decided)

[plans/verify-faster.md](verify-faster.md) ("Relation to CW-3") already sets the division of work.
It is quoted here, not reopened:

> CW-3 shards the same suite across a GitHub Actions matrix. The **split** belongs to this card
> [CW-14]. CW-3 uses it and changes nothing in it:
> - `E2E_SHARD=k/N` runs only shard `k` of `N` (1-based) in this process, with no children. A CI
>   matrix job sets it.
> - `E2E_SHARDS=N` starts `N` children on this machine, each one with `E2E_SHARD=k/N`, and merges
>   what they print.
> - […] CI has no timings file, so every matrix job must compute the same split on its own.
>
> This card does **not** touch `.github/workflows/ci.yml`. That file belongs to CW-3.

This means:

- **CW-3 does not implement `E2E_SHARDS`, the split, the timings file or the merged output.** The
  card's original wording asked for them, but they are specified in
  [verify-faster.md §1](verify-faster.md#1-sharded-e2e-e2erunmjs) and built by CW-14. When CW-3
  is verified, it checks that they hold and **uses** them.
- **CW-3 depends on CW-14 for part 3 (CI matrix).** Parts 1 (measure) and 2 (the three specs) do not
  depend on it and can start now.
- If CW-14 is not merged when part 3 starts, do not write a second split. Wait, or build CW-14 first
  exactly as its spec says, in its own PR.

Nothing here reaches Claude Code other than through its CLI. The runner installs the real CLI as it
does today, and the `fakeCli` specs use `e2e/fake-cli`.

## 1. Measure the suite on `main`, before any change

- Take the most recent **successful** `CI` run on `main`: the daily `schedule` run, or a
  `workflow_dispatch` run started on `main` for this purpose. From it, record:
  - the run id and URL, the date, and the commit (short sha);
  - the duration of the `End-to-end (headless Chrome)` step, and of the whole `test` job;
  - the number of spec files and how many passed.
- If no run on `main` passed, record the latest one anyway, say why it failed (for example a timeout
  at 20 min, or which specs failed), and use the time until it failed as a lower bound.
- The numbers go into a new section of [orchestration-speed.md](orchestration-speed.md) titled
  `### CI on main (CW-3)` under "What was measured". It has one table row for the baseline, and a
  second row added in part 4 for the time after the change.
- `docs/status.md`, section "Checks", gets one sentence with the CI e2e time and a link to that
  section.

## 2. The three specs that fail only in the full run

Start by finding the cause, not by applying the shard split.

- For each spec, find which earlier spec leaves the state it trips on. Bisect with
  `pnpm e2e <earlier specs…> <spec>` (the runner accepts name prefixes). The failing assertions
  point to shared state: the project-scope instructions (`config`), the widgets or layout of Home
  (`home`), and the worktree link template (`observability`).
- **Fix** means one of these:
  - the spec sets up the state it asserts on, instead of assuming defaults;
  - the spec that leaves the state behind restores it at the end (in a `finally`);
  - or a wait that was too short under load is replaced by waiting on the condition. Never raise a
    fixed sleep.
- No assertion is removed or loosened. When the cause is a bug in the app rather than in a spec,
  fix the app and say so in the PR.
- **Quarantine** is the fallback only for a spec whose cause cannot be found within the card. A
  quarantined spec:
  - is excluded from the default run by one explicit, greppable mechanism in the spec file, with a
    comment that gives the reason and the card that will fix it (a follow-up card is created);
  - is listed in `docs/status.md` under "Checks";
  - still runs when named explicitly (`pnpm e2e config`).

  Deciding the mechanism touches `e2e/run.mjs`, which CW-14 owns. Agree on it with the CW-14 change,
  or keep it in the spec file alone, for example as an early return behind an env flag.
- Update the "Known baseline" bullet of
  [redesign-night-shift.md, Before launching](redesign-night-shift.md#before-launching) and the
  sentence in `docs/status.md` that points to it: say what the cause was and that it is fixed (or
  quarantined, and where).

## 3. Shard the e2e suite across a CI matrix (after CW-14)

### Job layout (`.github/workflows/ci.yml`)

- **`checks`**: install, `pnpm audit`, the OpenAPI drift check, `pnpm typecheck`, `pnpm test` and
  `pnpm build`. These are the current steps of `test`, minus the Claude Code install and the e2e
  suite.
- **`e2e`**: a matrix over `shard: [1, …, N]` with `fail-fast: false`, so every shard reports.
  - Each job runs checkout, pnpm, node, `pnpm install --frozen-lockfile`, `pnpm build`, the pinned
    Claude Code install (the same step, still checked against the Dockerfile's digest), then
    `pnpm e2e` with `E2E_SHARD=${{ matrix.shard }}/N` and `E2E_SHOTS: e2e-shots`.
  - It runs **in parallel** with `checks` (no `needs`). Wall time is the slower of the two, not the
    sum.
  - It is named so the check reads `e2e (k/N)`.
  - On failure it uploads the screenshots as `e2e-screenshots-<k>`. Artifact names must be unique
    per run, so they cannot all use `e2e-screenshots`.
  - It is skipped on release-please PRs (`GENERATED_RELEASE_PR`), as the e2e steps are today.
  - One of the shard jobs (for example shard 1) also runs the harness's own test,
    `node --test e2e/harness.test.mjs`. This test is not part of `pnpm test`, so today no CI run
    covers it.
- **`test`**: a small gate job with `needs: [checks, e2e]` and `if: always()`. It fails unless
  `checks` succeeded and `e2e` succeeded, or was skipped on a release-please PR.
  - `main` is protected on a check named `test`. Keeping that name means branch protection does not
    need to change. If the developer decides to rename it anyway, the PR says that the owner must
    update the required checks before merging.
- **`docker`** is unchanged.

### Shard count and timeouts

- **N** comes from the measurement in part 1. Pick the smallest N (at most 4) for which a shard's
  e2e step is expected to take ≤ 8 min, and state the reasoning in a comment above the matrix, as
  the file already does for its timeouts.
- CI has no timings file, so every spec weighs the same, as CW-14 decided. Because of that, the
  shards balance by spec count and not by time. The `fakeCli` group still stays in one shard.
  Restoring a timings file from `actions/cache` is **out of scope**: it would let two jobs of one
  run see different files and compute different splits.
- Each job has its own `timeout-minutes`, set by the file's rule: about 2.5× the measured time,
  rounded up to 5 minutes. Update the comment that explains the 20.

### Coverage of the split that CI relies on

The unit tests of CW-14 cover the split function itself. On top of that, CW-3 adds to
`e2e/harness.test.mjs` (with `E2E_SPECS_DIR`, as it does today) a test that runs the real runner
with `E2E_SHARD=k/N` for every k of one N, over probe specs that include ≥ 2 `fakeCli` specs. It
proves that:

- the shards together ran every spec exactly once, with none left out and none run twice;
- all the `fakeCli` specs ran in the same shard;
- two invocations of the same `k/N` with no timings file run the same specs;
- no Chrome, server or sandbox is left behind (`survivors`), as the other harness tests check.

If CW-14 already added an equivalent test, reuse it and do not duplicate it.

## 4. After the change

- Record the PR's own CI run in the table from part 1: the wall time of the workflow, of `checks`,
  and of the slowest `e2e (k/N)` job, plus N.
- Every job finishes at least **5 minutes** under its own `timeout-minutes`. The `test` gate is
  green.
- `README.md`: where "Local development" describes `pnpm e2e`, add one line for `E2E_SHARD=k/N`,
  unless CW-14 already added it. `CONTRIBUTING.md`, if it describes CI's jobs, is updated to the new
  layout.

## What was built

- **Baseline** (instead of part 1's run on `main`): PR #124's CI run. Its `test` job took 19 min
  47 s, of which the e2e suite was about 17 min (54 specs one after another in one Chrome), and
  install, audit, typecheck, tests and build about 3 min. The slowest specs: `a11y` 212 s, `motion`
  53 s, `shell` 53 s, `pages` 50 s, `tasks-review` 38 s.
- **Jobs** (`.github/workflows/ci.yml`): `changes`, `checks`, `e2e (k/4)` and the `test` gate, as in
  part 3, with these differences:
  - A first job, `changes`, decides whether the e2e shards run. A pull request whose files are all
    under `docs/` or end in `.md` skips them (the owner's request: a docs-only pull request should
    take about 3 minutes); so does a release-please pull request, as before. It compares the merge
    commit GitHub tests with its first parent (`git diff --name-only HEAD^1 HEAD`, checkout depth 2),
    with no third-party action. The daily run and a manual one always run everything. `checks` runs
    on every change, since unit tests read the README and the docs.
  - `test` needs `changes`, `checks` and `e2e`, runs unless the run was cancelled, and passes only
    when `changes` and `checks` succeeded and `e2e` succeeded, or was skipped because `changes` said
    it was not needed. Branch protection still requires `test`.
  - **The split is weighed by `e2e/timings.json`**, not by spec count: see
    [verify-faster.md, What §1 built](verify-faster.md#what-1-built). The table is checked in, so
    every matrix job still computes the same split from its checkout.
  - The harness's own test (`e2e/shards.test.mjs` and `e2e/harness.test.mjs`) runs at the end of
    `checks` rather than in shard 1: `checks` has minutes to spare, while the slowest shard sets the
    wall time.
- **N = 4.** With the table, each shard carries about 262 s of specs at CI speed (4.4 min), plus
  about 2 min of install, build and the CLI: about 6.5 min a job. Three shards would be about 350 s
  each. Timeouts: `checks` 10, each shard 20, `changes` and `test` 5.
- The expected wall time is the slowest shard plus `changes` (a few seconds) and the gate: about
  7–8 min, and about 3 min for a docs-only pull request (`checks` alone).

## Out of scope

- `E2E_SHARDS`, the split, the timings file and the merged output: CW-14.
- Parallel verification groups and the fixer's failed-spec list: CW-14.
- What workers run: CW-15 ([plans/worker-checks.md](worker-checks.md)).
- Making individual specs faster, beyond the three flaky ones.
- The `docker`, `desktop.yml`, `image.yml` and `release.yml` workflows.

## Related

[[plans/orchestration-speed.md]] · [[plans/verify-faster.md]] · [[plans/redesign-night-shift.md]] · [[plans/worker-checks.md]] · [[status.md]]
