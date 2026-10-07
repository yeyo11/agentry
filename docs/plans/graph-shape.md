---
created_at: 2026-09-28T18:00:00Z
updated_at: 2026-09-28T18:00:00Z
tags:
    - plan
    - spec
    - orchestration
    - planner
    - web
    - performance
    - built
---
# Spec: shorter orchestration chains (CW-16)

Workstream E (`graph-shape`) of [plans/orchestration-speed.md](orchestration-speed.md), story CW-16
of the epic CW-11 "Faster orchestrations". Status: **built** (the guide is [orchestrations.md](../orchestrations.md)).

## Why

The plan measured that the task phase of an orchestration lasts almost exactly as long as its
critical path. Effective parallelism is only 1.4–1.6 at a concurrency of 3–4, and every recent graph
has the same five-stage shape:

```
types → core → web → web-review → docs
```

- The `review` + `docs` tail always runs in series and adds 25–50 min per graph.
- A leading `types` task (8–15 min) holds back every other task.

The shape comes from whoever writes the graph: a person, in a plan or in the launch form, or the
planner (`startPlan`). This story changes all three: a guide for people, the same guidance in the
planner prompt, and a hint in the UI when a graph has too many stages in series. Expected saving
from the plan: 20–25 min per typical graph.

## What changes

No type, route or OpenAPI schema changes. The shape is computed in the browser from the tasks the
form already holds.

### 1. `docs/orchestrations.md` (new)

A knowledge-base document (front matter, tags, a Related list; see
[knowledge-base.md](../knowledge-base.md)) on how to write a graph. The plan already links to it as
`[[orchestrations.md]]`. It covers, each with a sentence on why:

1. **Stages in series are the cost.** The task phase lasts as long as the longest chain, not the sum
   of the tasks. Aim for at most four stages in series. Name the launch form's hint (section 3).
2. **No stand-alone `types` task.** Put the contract (the shared types, the route shapes) in the
   plan or in the task prompts, so the core and web tasks start in parallel against it, or fold it
   into the first core task.
3. **`docs` runs in parallel with `review`.** `docs` depends on the implementation tasks, not on
   `review`. Or leave the Outcome to the synthesis and drop the `docs` task.
4. **`review` does not re-run the suite when verification is on.** Its prompt says it looks at the
   design and at what the checks cannot see, because the verification phase runs the full suite on
   the merged branch anyway.
5. **`sonnet` for prose-only tasks** (docs, changelog-style notes): set the task's `model`.
6. **Name the files and routes each task touches** in its prompt, so the worker does not spend
   turns finding them.
7. A worked example: the five-stage shape above rewritten into three stages, as an ASCII graph like
   the "How it is built" graph of the plan.

The wording must hold for any repository Agentry drives, as the planner prompt does. Repo-specific
names (`pnpm`, `types.ts`) appear only as examples.

### 2. The planner prompt

`startPlan` in `packages/core/src/orchestrator.ts` (around line 1641) builds the prompt from
`PROMPT_HEAD`, the objective, `PROMPT_TAIL` and an inline string. Add the same guidance, briefly,
after "Maximize parallelism…":

- keep the longest chain of dependencies to four tasks or fewer;
- no task that only writes shared types or a contract: put the contract in the prompts of the
  tasks that need it, or in the first implementation task;
- a documentation task depends on the implementation tasks, not on a review task;
- a review task, when there is one, reviews the design and what automated checks cannot see, and
  does not re-run the whole test suite;
- a task that only writes prose (documentation) sets `model` to `sonnet`;
- every task prompt names the files, modules or routes it will touch.

The last two need the planner to be able to set them. `PLAN_SCHEMA` (line ~198) has no `model` on a
task today: add an optional `model: { type: 'string' }` to the task item, with a description that
says "only `sonnet` for tasks that only write prose; leave it out otherwise". Check that
`draftFrom` carries it into the draft's `OrchestrationTaskSpec.model` (the type already has
`model?`). `PLAN_SCHEMA` is a CLI `--json-schema`, not a REST schema, so no OpenAPI regeneration is
needed.

Keep the prompt in one place: extract the guidance into an exported constant or function (for
example `PLANNER_GRAPH_GUIDANCE`) so the test can import it.

### 3. The shape hint in the launch form and the graph editor

**Computation.** A pure function in `apps/web/src/lib/orchestration-steps.ts`, next to
`layerTasks`, for example:

```ts
export function graphShape(tasks: ReadonlyArray<Pick<OrchestrationTaskSpec, 'id' | 'dependsOn'>>):
  { stages: number; chain: string[] } | null
```

- `stages` is the number of tasks on the longest dependency chain (a graph with no dependencies has
  1 stage; `a → b → c` has 3). It equals `layerTasks(tasks).length` for an acyclic graph.
- `chain` is the ids along one longest chain, from the first task to the last. On a tie, it takes
  the chain that ends at the task that comes first in `tasks`, then the first dependency in
  `dependsOn` order, so the result is stable.
- Dependencies on ids that are not in `tasks` (being typed, or removed) are ignored, as
  `layerTasks` does. Tasks with an empty id are ignored.
- Returns `null` for an empty list or when the dependencies have a cycle. `validateGraph` reports
  neither as an error today (the core does), so the hint must not crash or loop on them.
- `layerTasks` may be generalised to the same `Pick<…>` input and reused, as long as its current
  callers and `orchestration-steps.test.ts` keep passing.

**Component.** A `GraphShape` component (in `apps/web/src/components/GraphExtras.tsx`, next to
`DefaultLimits` and `VerificationFields`), rendered under the task list, above the error box and the
form actions, in:

- the launch form: `CreateForm` in `apps/web/src/pages/Orchestration.tsx` (the `.stack` of
  `TaskEditor`s, around line 397);
- the graph editor: `apps/web/src/components/RelaunchPanel.tsx` ("Edit and relaunch", around line
  92).

It shows, for any graph with at least one task and a non-null shape:

- always, a quiet line: the number of stages in series and the longest chain, for example
  `3 stages in series · survey → build → docs`. Muted text, `.form-hint` style; the count and the
  ids in Geist Mono with tabular numbers. A graph of one stage reads "1 stage, all in parallel" (or
  similar) instead of a one-id chain.
- when `stages > 4`, a hint under it: a neutral notice (the `.callout` / `.alert` family with the
  `--info` colour, which the design system reserves for neutral notices) with an icon and one or
  two sentences: long chains set the orchestration's time, and the usual fixes (no stand-alone
  types task, docs in parallel with review). It is not warn or bad: nothing is near a limit and
  nothing failed.
- it **never blocks**: the Launch / Relaunch button stays enabled, `validateGraph` does not change,
  and the notice has `role="note"` (or `status`), never `role="alert"`.
- it updates as the person edits `dependsOn` or ids, with no animation (nothing live is happening).
- hidden or omitted while the shape is `null` (empty graph or a cycle).

Long chains wrap on a phone (no horizontal scroll at 390 px), and the chain's ids break at the
arrows, not inside an id.

**Copy.** New keys in the `config` namespace (the launch form's, `config:orchestration.*`), in
`apps/web/src/i18n/locales/en/config.json` and `es/config.json`, with plural forms for the stage
count (`_one` / `_other`). Spanish follows `apps/web/src/i18n/GLOSSARY.md`: "Stage" is "Etapa",
Spain Spanish, sentence case. For example `"shape": "{{count}} etapas en serie"`.

**Design reference.** The launch form lives on the Orchestrations screen:
`docs/design-system/reference/DesktopOrquestaciones.html` and
`MobileOrquestaciones.html`, with their dark and light screenshots. The relaunch panel is on
`DesktopOrquestacion.html` / `MobileOrquestacion.html`. The hint adds no new component; if it needs
a variant of the callout, the variant goes into `docs/design-system.md` and `agentry-ds.css` in the
same PR.

## Tests

- `apps/web/test/orchestration-steps.test.ts` (or a new `graph-shape.test.ts`) for `graphShape`:
  empty list → `null`; independent tasks → 1 stage; the plan's five-task chain `types → core → web →
  web-review → docs` → 5 stages and that exact chain; a diamond (`a → b`, `a → c`, `b,c → d`) → 3
  stages; a tie picks the stable chain described above; an unknown dependency is ignored; a cycle
  (`a → b → a`) → `null`, without throwing or hanging.
- A component test (`apps/web/test/orchestration-ui.test.tsx`, which already renders orchestration
  UI) for `GraphShape`: 4 stages → the count and chain are shown and no hint; 5 stages → the hint is
  shown with `role="note"` (or `status`) and not `alert`; a cycle → nothing rendered.
- `packages/core/test/orchestrator.test.ts`: the planner prompt includes the guidance (import the
  constant, or capture the prompt `startPlan` passes), matched by patterns such as `/four/`,
  `/review/`, `/sonnet/`, `/files/`. `PLAN_SCHEMA`'s task item accepts an optional `model` and still
  has `additionalProperties: false`.
- `apps/web/test/i18n.test.ts` and `hardcoded-strings.test.ts` stay green (parity, no literal
  strings); `design-tokens.test.ts` stays green (no hex, px radius or ms).
- `e2e/specs/a11y.spec.mjs` and `mobile.spec.mjs` stay green. Optionally,
  `e2e/specs/orchestration-v2.spec.mjs` checks the line appears in the launch form.

## Out of scope

- Blocking a launch on the chain length, or reshaping a graph automatically.
- A separate `e2e-specs` task in graphs (open question 1 of the plan, see
  [plans/worker-checks.md](worker-checks.md)).
- The critical path of a finished graph and where its time went (workstream A, `timings`).
- The shape of the workflow engine's script: the hint is shown for both engines, since both honour
  `dependsOn`, but nothing else changes for workflows.
- Rewriting existing plans in `docs/plans/` to the new shape.

## How it is measured

From the plan: the next graphs have at most four stages in series, and the task phase stays within
10 % of the longest single chain, as reported by `scripts/orchestration-timings.mjs` (workstream A).

## Related

[[plans/orchestration-speed.md]] · [[plans/worker-checks.md]] · [[orchestrations.md]] · [[design-system.md]]
