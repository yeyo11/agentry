---
created_at: 2026-09-28T18:00:00Z
updated_at: 2026-09-29T18:00:00Z
tags:
    - plan
    - spec
    - orchestration
    - verification
    - e2e
    - performance
    - built
---
# Spec: a shorter verification phase (CW-14)

This is workstream C (`verify-faster`) of [plans/orchestration-speed.md](orchestration-speed.md),
story CW-14 of the epic CW-11 "Faster orchestrations". Status: **built.** §1 (sharded e2e) was
built on 2026-09-29 in `ci/e2e-shards` (#128), together with CW-3's CI matrix, with the deviations
listed under [What §1 built](#what-1-built). §2 (parallel groups) and §3 (failed specs in the
fixer's prompt) were built on 2026-09-29 in `task/cw-14`; see
[What §2 and §3 built](#what-2-and-3-built). The target of the plan is measured after the merge
(see [How the target is measured](#how-the-target-is-measured)).

## Why

The plan measured where the time goes after the last task (section 2):

- Verification runs the whole e2e suite on the merged branch. That suite grew from 5.8 min to
  18.3 min, and it runs in series on one server, one Chrome and the fixed port 8799.
- After a fix, every check runs again from the first. `checkAll` in
  `packages/core/src/orchestrator.ts` does this on purpose, because one fix can break another
  check. So whenever the fixer works, the suite runs twice.
- `pnpm typecheck` and `pnpm test` do not depend on each other, yet they run one after the other.
- The fixer gets the last 4,000 characters of the output. For a long e2e run, that tail can miss the
  line that names the failed spec, so the fixer first has to find it.

This card makes three changes. It does not change what gets checked:

1. `E2E_SHARDS` in `e2e/run.mjs` splits the suite across several isolated runs.
2. Parallel groups in `VerificationSpec.commands`.
3. The fixer's prompt names the specs that failed.

## Relation to CW-3 (sharded e2e in CI)

CW-3 shards the same suite across a GitHub Actions matrix. The **split** belongs to this card.
CW-3 uses it and changes nothing in it:

- `E2E_SHARD=k/N` runs only shard `k` of `N` (1-based) in this process, with no children. A CI
  matrix job sets it.
- `E2E_SHARDS=N` starts `N` children on this machine, each one with `E2E_SHARD=k/N`, and merges
  what they print.
- Both use one split function, exported from a module under `e2e/` (for example
  `e2e/shards.mjs`). Given the same specs and the same timings, it returns the same split every
  time. CI has no timings file, so every matrix job must compute the same split on its own.

This card does **not** touch `.github/workflows/ci.yml`. That file belongs to CW-3.

## 1. Sharded e2e (`e2e/run.mjs`)

### Behaviour

- **Number of shards.** It comes from `E2E_SHARDS` when set, which must be a whole number ≥ 1, or
  the run exits with code 2. When it is unset, the default is
  `min(4, max(1, floor(os.availableParallelism() / 2)))`. Each shard runs a server and a Chrome, so
  it gets two cores. The count is then capped at the number of spec groups to run (see "Split"), so
  `pnpm e2e config` with one spec runs a single shard.
- **One shard behaves exactly as today.** With `E2E_SHARDS=1`, or a count capped down to 1, there
  are no children: the current code path runs in the current process, including `E2E_PORT`
  (default 8799) and `E2E_CDP_PORT`.
- **Isolation per shard.** Each child has its own `mkdtemp` sandbox (claude, workspace, data), its
  own release fixture, its own API server and its own Chrome. The parent picks a free port for each
  child (listen on port 0, read the port, close it) and passes it as `E2E_PORT`. When `N > 1`, an
  `E2E_PORT` set by the caller is ignored, and the run says so in one line. `E2E_CDP_PORT` is
  forced to `0`. `E2E_LIVE`, `E2E_SHOTS`, `E2E_SPECS_DIR`, `E2E_SPEC_TIMEOUT` and `E2E_KEEP` pass
  through unchanged.
- **Split.**
  1. Specs are grouped first. Every spec that exports `fakeCli = true` goes into **one** group, so
     the shard that gets it restarts its server once, as today. Every other spec is a group of one.
     A spec that fails to load is a group of one, and it still reports `✗` from the shard that
     gets it.
  2. Groups are assigned longest first, each to the shard with the least total time so far (greedy
     LPT). A group's weight is the sum of its specs' last known durations.
  3. A spec with no recorded duration weighs the median of the known ones, or 1 when none is known.
  4. Ties are broken by file name, so the split is deterministic.
  5. Inside a shard, specs run in the order they run today: file-name order, with the fakeCli specs
     last.
- **Timings file.** Durations live in `e2e/.timings.json`, as `{ "<spec file>": <ms> }`, and the
  file is added to `.gitignore`.
  - After a run, whether sharded or not, the durations of the specs that ran (`✓` or `✗`) are
    merged into the file. The entries of specs that did not run are kept.
  - `E2E_SPECS_DIR` runs keep their own file in that directory, so the harness test never touches
    the real one.
  - A file that is missing or unreadable counts as empty. It is never an error.
- **Merged output.** Each child's output is buffered per spec, from its `✓`/`✗`/`-` line and the
  lines that belong to it. The parent prints the blocks in **global spec order** (the order a
  single run would use), each block as soon as every block before it has been printed. Lines a
  child prints outside a spec block, such as "restarting the server", are not shown as-is: each is
  printed with a `[shard k]` prefix.
- **Summary.** The final line keeps today's format and counts over all shards: `all N spec file(s)
  passed` or `N spec(s) failed`. When anything failed, it is **preceded by one `✗ <file>` line per
  failed spec**, in spec order, under the heading `failed:`. That way the fixer's output tail
  (`OUTPUT_TAIL` = 6000) always contains them. When there is more than one shard, it also prints
  one line per shard with its specs and wall time.
- **Exit code.** It is 0 only when every child exited 0. A child that crashed (non-zero exit with
  no summary) counts as one failure, and its unfinished specs are reported as
  `✗ <file>\n  not run: shard k ended early`.
- **A spec that timed out** stops only its own shard, as today. The other shards go on.
- **Ways out.** `E2E_TIMEOUT` bounds the whole run in the parent. On a timeout, a signal
  (SIGINT/SIGTERM/SIGHUP) or an uncaught error, the parent kills every child's process group by
  PID. It uses `killGroup` from `e2e/processes.mjs`, never `pkill -f`. Each child still closes its
  own server, Chrome and sandbox from its `exit` handler.

### Files

- `e2e/run.mjs`: the header comment documents `E2E_SHARDS`, `E2E_SHARD` and the timings file.
- A new `e2e/shards.mjs` (the name is a suggestion): the pure split and merge functions, so they
  can be tested without a browser.
- `.gitignore`: `e2e/.timings.json`.
- `README.md`, "Local development": `E2E_SHARDS` goes next to `E2E_SPEC_TIMEOUT`. The same edit
  fixes the stated `E2E_TIMEOUT` default. The README says 900000 ms, but `run.mjs` uses 1500000.

### What §1 built

`e2e/shards.mjs` (the split: `parseShard`, `groupSpecs`, `splitSpecs`, `defaultShardCount`),
`e2e/parallel.mjs` (the children and the merged report) and `e2e/run.mjs` behave as above, except:

- **The timings are a checked-in table, not a gitignored file.** `e2e/timings.json` holds
  **seconds** per spec, seeded from the per-spec times of PR #124's CI run, and the runner never
  writes it. CI computes the split on each matrix job from the checkout alone, so the weights have
  to be in the checkout; CW-3's fallback, every spec weighing the same, would have left one shard
  with the 212 s accessibility spec and another with a dozen 3 s ones. A table rewritten after every
  local run would dirty the working tree and give each machine its own split. Refresh it by hand
  from a CI run when the shards drift apart (a spec missing from it weighs the median). The table
  sits next to the specs directory, so an `E2E_SPECS_DIR` run reads its own (the harness test has
  none, and every probe weighs 1).
- **`E2E_PORT`, with more than one shard, is the first of N consecutive ports** instead of being
  ignored: an orchestration that sets it to stay off another suite's port keeps that promise. Unset,
  each child gets a free port from the system.
- **Any spec a failed shard never reached is `✗ … not run`**, not only after a crash: after a
  timed-out spec the shard stops too, and nothing proved the rest.
- A child's stderr (the server's warnings) is printed at once with its `[shard k]` prefix.
- The `failed:` list before the summary is printed by a single run as well, so a shard's tail names
  its failures the same way.
- `a11y.spec.mjs` (212 s on CI, which alone would bound its shard) became four specs by screen
  group, `a11y-core`, `a11y-shell`, `a11y-projects` and `a11y-team`, sharing their seed through
  `e2e/specs/a11y-shared.mjs`; every page and check it had is still scanned.

Tests: `e2e/shards.test.mjs` (the split and the merged report, no browser) and
`e2e/harness.test.mjs` (the real runner with `E2E_SHARD=k/N` and `E2E_SHARDS=N` over probe specs:
every spec once, the `fakeCli` specs in one shard, the same `k/N` the same specs, the report in a
single run's order, `SIGTERM` to a sharded run, no survivors).

Measured on the dev machine (12 cores, after `pnpm build`), 2026-09-29: `pnpm e2e` with the default
of 4 shards ran all 58 spec files (one live spec skipped) in **312 s** wall time, every spec passing,
the shards taking 286, 303, 312 and 285 s against an estimate of 262 s each; `E2E_SHARD=2/4` alone
took 269 s. The suite in one process took about 17 min on CI; an `E2E_SHARDS=1` run on the same
machine was not timed, so the 40 % check of "How the target is measured" is still to be stated.

## 2. Parallel groups in `VerificationSpec.commands`

### Contract (`packages/shared/src/types.ts`)

```ts
export interface VerificationSpec {
  /**
   * Run in order on the integration branch, each one under a timeout. An entry that is a list runs
   * its commands at the same time; the next entry starts once all of them have ended.
   */
  commands: Array<string | string[]>;
  // …unchanged
}

export interface VerificationCommand {
  // …unchanged
  /** Index of the `commands` entry it came from; commands of one parallel group share it. Absent on the install step */
  group?: number;
}
```

Regenerate `apps/api/src/openapi/schemas.json` (`pnpm --filter @agentry/api openapi:schemas`). No
route is added or renamed, so neither `routes.ts` nor the README's REST tables change. The README
row for `POST /orchestrations/:id/verify` gets one clause saying that an entry may be a list that
runs in parallel.

### Validation (`normalizeVerification`, `packages/core/src/verification.ts`)

- An entry is a string, or a list of **at least 2** strings. A list of one is normalized to its
  string.
  - Nested lists, an empty list, or a non-string item are refused with a message that names the
    index.
  - Every string is trimmed and checked like today: not empty, and at most `MAX_COMMAND_LENGTH`.
- `MAX_COMMANDS` (12) counts **commands**, not entries.
- `installStep` compares the detected install command against the flattened list.
- Existing specs (all strings) normalize to exactly what they do today, so stored orchestrations and
  templates keep working unchanged.

### Running (`checkAll`, `packages/core/src/orchestrator.ts`)

- `state.commands` stays flat: the install step first, then each command in entry order, each one
  with its `group`. The web UI and the stored state stay readable.
- **One step at a time.** A step is either the install step or the commands that share a `group`,
  and it runs all of them at once with `runCommand`. Each command keeps its own output, duration,
  status and timeout. The next step starts when every command of this one has ended.
- **Cancelling.** `VerificationControl.command` becomes a set of handles, so cancelling stops every
  running command of the step.
- **Failures.** When any command of the step fails, the other commands of that step still run to
  the end, so every failure is known.
  - When the fixer is off, the verification fails, and the report names every failed command of the
    step.
  - When the fixer is on, **one** fixer attempt covers every failed command of the step. The prompt
    lists each one with its own failure and output tail. The attempt counts against each failed
    command's `maxAttempts`, and `state.attempts` goes up by one. Every other rule holds as today:
    the budget, the cancel, `mended`, and re-running everything from the first step after a fix.
- **The count on the orchestration page.** The `n/m` on the verification step
  (`apps/web/src/pages/OrchestrationDetail.tsx`, `stepCount`) keeps counting commands.

### Web form (`apps/web/src/lib/orchestration-v2.ts`, `GraphExtras.tsx`)

The commands box stays a textarea with one command per line. **A line that starts with `& ` runs at
the same time as the line above it.** Because no shell command can start with `&`, the marker is
never ambiguous.

```
pnpm typecheck
& pnpm test
pnpm build
pnpm e2e
```

This parses to `[["pnpm typecheck","pnpm test"],"pnpm build","pnpm e2e"]`.

- `parseCommands` returns `Array<string | string[]>`, and `draftOfVerification` writes the same
  syntax back, so the draft round-trips.
- A leading `& ` on the first line is dropped.
- The field's hint says how to write a group, through i18n with `en`/`es` parity. The `es` wording
  follows `apps/web/src/i18n/GLOSSARY.md`.
- No new control, token or style is needed. If a group is shown on the verification card, it uses
  existing classes only.

## 3. The fixer is told which specs failed

- A new `failedSpecs(output: string): string[]` in `packages/core/src/verification.ts`:
  - It collects the names from lines that match `^✗ (\S+)` (the runner's format).
  - It removes duplicates (the summary repeats them) and keeps the order.
  - It keeps at most 20 names.
  - Output with no such line gives `[]`.
- `FixerContext` gets `failedSpecs?: string[]`. `fixerPrompt` adds one paragraph only when the list
  is not empty: `These spec files failed: a.spec.mjs, b.spec.mjs. Start with them, one at a time;
  do not run the whole suite to find them.` The wording holds for any repository: it names no
  `pnpm`, `e2e/` or port.
- `fix()` fills `failedSpecs` from the **full** output of the failing command. It must not use the
  6000-character `entry.output` tail, so `runCommand` has to hand the full text (or the parsed list)
  to the caller before it trims.

## What §2 and §3 built

Everything above, as written, with these choices where the spec left room:

- **The steps come from the rows.** `verificationSteps(rows)` in `orchestrator.ts` groups the flat
  `state.commands` into steps: the install row alone, then consecutive rows that share a `group`.
  A row stored before groups has none and is a step of its own, so a verification recorded by an
  older wrapper reads and re-runs as it did.
- **A stop that lands while a group is starting** still reaches every command: each handle joins
  `VerificationControl.commands` as it starts, and one that starts after the stop is cancelled at
  once.
- **Running out of attempts.** One attempt at a group adds one to the count of each failed command
  in it. When any failed command of a step has spent its `maxAttempts`, the verification stops and
  the report names those commands and the last thing an attempt that covered them said. The
  "earlier attempts" the fixer is told about are those that covered any of the commands failing now.
- **The fixer's prompt** takes `failed: FailedCheck[]` (command, why, output) instead of a single
  `command`/`failure`/`output`: one failed check reads as before ("This one failed: …"); several read
  as "These ran at the same time and failed, and this attempt is at all of them", each with its own
  output tail. The list of checks shows a group as `at the same time: a | b`.
- **The failed specs come from the whole output.** `runCommand` reads `✗ <file>` lines from every
  chunk as it arrives (`CommandOutcome.failedSpecs`), without keeping the output, and trims only
  after; `failedSpecs(output)` is the same reader over a string. The line must start with `✗ `: a
  failure message the runner prints under a spec is indented, so it never reads as a spec. One
  fixer attempt at a group gets the specs of all its failed commands, at most 20.
- **Web.** `parseCommands` returns `Array<string | string[]>` and a new `commandsText` writes it
  back, so `draftOfVerification` round-trips a group; a line of just `&` is no command. The
  orchestration page's verification card lists rows as before; no class or token was added.
- **Route docs.** No route changed. The description of `POST /orchestrations/:id/verify` in
  `apps/api/src/openapi/routes.ts` and its README row say that an entry may be a parallel group.

Tests: `packages/core/test/verification.test.ts` (groups in `normalizeVerification`, the install
check against a group, `verificationSteps`, `failedSpecs` on runner output with its `failed:`
repeat, the failed specs read beyond the kept tail, the prompt paragraph, a group running at once,
a group's failures with the fixer off, one fixer attempt for a whole group, a stop reaching every
command of a group) and `apps/web/test/orchestration-v2.test.ts` (the `& ` syntax and the round
trip).

Still open: the 40 % wall-time check of §1 (an `E2E_SHARDS=1` run was never timed) and the
25/40-minute target, both measured after the merge, into an Outcome section of
[plans/orchestration-speed.md](orchestration-speed.md).

## Out of scope

- CI sharding (`ci.yml`): CW-3.
- `startedAt`/`endedAt`, `runs[]` and the timings route: workstream A.
- What workers run: CW-15 ([plans/worker-checks.md](worker-checks.md)).
- Changing the "re-run everything from the first check after a fix" rule. The plan keeps it on
  purpose.

Nothing here reaches Claude Code other than through its CLI: the fixer is still a normal run.

## How the target is measured

The plan's target is that a graph with verification on ends at most **25 min** after its last task
when the fixer has nothing to do, and at most **40 min** with one fixer attempt.

- This depends on the machine and on the graph, so it is measured on the next graphs after the
  merge. The time from the last task's `endedAt` to the orchestration's end is read from
  `GET /orchestrations/:id`, or with `scripts/orchestration-timings.mjs` once workstream A has
  landed.
- The results go into an Outcome section of [plans/orchestration-speed.md](orchestration-speed.md).
- A check the PR itself can pass: on the dev machine, `pnpm e2e` with the default shard count takes
  at most 40 % of the wall time of `E2E_SHARDS=1 pnpm e2e` on the same build. Both times are stated
  in the PR.

## Related

[[plans/orchestration-speed.md]] · [[plans/worker-checks.md]] · [[plans/agent-observability.md]] · [[plans/roadmap-completion.md]]
