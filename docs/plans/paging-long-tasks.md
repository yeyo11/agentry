---
created_at: 2026-10-07T16:40:00Z
updated_at: 2026-10-07T16:40:00Z
tags:
    - plan
    - decision
    - e2e
    - flaky
    - performance
    - built
---
# paging.spec's long-task check against an idle baseline (CW-32)

`e2e/specs/paging.spec.mjs` ends by typing 30 characters into the composer with the whole
2,000-entry transcript held, and watching for long tasks (over 50 ms) with a `PerformanceObserver`.
The check was "no long task at all". It failed on the owner's machine alone and in the full suite:
in the final verification of CW-7 (2026-10-07, load averages 22 to 41 on 12 cores) every run had 16
to 27 long tasks of 52 to 268 ms, and on 2026-09-28 it failed with tasks of 55 to 72 ms. CI's shards
pass it. A check that cannot tell a regression from a busy CPU is waved through every time, which
is as useless as a threshold raised until it never trips.

## The decision

Three steps, in this order:

1. **Profile at idle first.** Run the spec alone, three times, at a load average below 2, with the
   check as it was. Long tasks that show up there are ours: find them with a Chrome trace and fix
   them, or open a card and record it in the spec.
2. **An interleaved idle baseline.** Each of the 30 keystroke windows is followed by an idle window
   of the same shape: the driver's 150 ms after the input (a plain 150 ms pause for the idle one),
   then two animation frames. Interleaving gives both kinds the same load. A long task belongs to
   the window its start falls in.
   - `K` is the number of keystroke windows with a long task over 50 ms.
   - `I` is the number of idle windows with one.
   - The check fails when `K − I > 5`.
3. **A skip on the run's own measurement.** When `I ≥ 10`, the run cannot measure typing. The spec
   logs `paging: long-task check skipped: …` with the counts, the load average and the core count,
   and passes. The load average explains the skip; it never decides it.

Rejected: a fixed threshold raised until the spec passes, and a skip based on `os.loadavg()` alone.

Kept as they were: every earlier check in the spec, the 1,500 ms drain before the observer starts,
and the check that the textarea took every keystroke. The harness (`e2e/run.mjs`,
`e2e/driver.mjs`) is unchanged. Every run's summary line now ends with `K` and `I` and the
durations it saw, so a pass also says what it measured.

## Measurements (2026-10-07)

**The machine never reached a load below 2.** It was sampled every 30 s for 15 minutes before the
idle runs (16:10 to 16:26 UTC): 9.7 at the start, between 5.2 and 9.1 throughout, 6.2 at the end.
What kept it there belongs to the owner and was left running: two embedding servers re-indexing the
knowledge base (about 275 % and 160 % CPU), the desktop app, and a trading process. So step 1 ran
at the lowest load there was, not below 2.

**Step 1, the check as it was:** 3 of 3 passed, with no long task while typing.

| Run | Load (1, 5, 15 min) | Long tasks while typing |
| --- | --- | --- |
| 1 | 6.28, 6.75, 7.23 | none |
| 2 | 6.14, 6.70, 7.20 | none |
| 3 | 8.22, 7.15, 7.34 | none |

Nothing of ours showed up, so there was nothing to trace and no change in `packages/chat-ui` or
`apps/web`. The composer is a controlled `<textarea>` whose `onChange` calls `setText`, and with the
transcript windowed (747 nodes on landing, 868 with all 2,000 entries held) a keystroke does not
reach anything heavy enough to block for 50 ms on this machine at a load near 6.

**Step 2 and 3, the new check:**

| Run | Load (1, 5, 15 min) | Extra load | K | I | Long tasks | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 9.47, 7.63, 7.49 | none | 0 | 0 | none | passed |
| 2 | 8.79, 7.63, 7.50 | none | 0 | 0 | none | passed |
| 3 | 8.70, 7.69, 7.52 | none | 0 | 0 | none | passed |
| 4 | 10.07, 8.14, 7.68 | 24 busy threads | 8 | 0 | 54, 66, 62, 82, 71, 59, 55, 69 ms | **failed** |
| 5 | 25.19, 12.60, 9.22 | 24 busy threads | 4 | 0 | 57, 52, 54, 56 ms | passed |

The load in runs 4 and 5 was made on purpose, with 24 busy threads on 12 cores, and was stopped
after those two runs.

## What the measurements say about the baseline

**Under load, the idle windows stay clean.** In runs 4 and 5 every long task fell in a keystroke
window, and `I` stayed at 0. A long task needs work on the main thread: a starved CPU stretches the
work a keystroke does (the input event, React's render, layout and paint) past 50 ms, but an idle
window has no work to stretch. The baseline therefore subtracts little, and the decision's tolerance
of 5 is what lets a loaded run pass. Run 4 failed at `K = 8`. The CW-7 runs, with 16 to 27 long tasks
at loads of 22 to 41, would most likely fail too unless their idle windows also caught long tasks,
which these runs never saw.

This is a finding, not a change: the spec implements the card's decision as written. If the check
keeps failing on the shared machine, the next step is a decision for the owner, for example:

- an idle window that does work of the same kind without typing (a forced layout and a React
  re-render of the composer), so the baseline sees what load does to rendering;
- comparing durations rather than counts (typing's long tasks against a short CPU-bound probe timed
  in the same run);
- keeping the check for CI and idle machines only, said in the spec.

## Related

[[plans/e2e-harness-waits.md]] · [[plans/roadmap-completion.md]] · [[plans/post-roadmap.md]] · [[status.md]]
