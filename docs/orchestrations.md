---
created_at: 2026-09-29T00:00:00Z
updated_at: 2026-09-29T00:00:00Z
tags:
    - orchestration
    - planner
    - guide
    - performance
    - convention
---
# Writing an orchestration graph

How to shape the tasks of a graph orchestration so it finishes early. It applies to a graph written
by hand (a plan in `docs/plans/`, the launch form, "Edit and relaunch") and to the planner, whose
prompt carries the same rules (`PLANNER_GRAPH_GUIDANCE` in `packages/core/src/orchestrator.ts`).
The rules hold for any repository Agentry drives; names such as `pnpm` or `types.ts` below are only
examples.

The measurements behind it are in [plans/orchestration-speed.md](plans/orchestration-speed.md):
effective parallelism of 1.4–1.6 at a concurrency of 3–4, and every recent graph shaped
`types → core → web → web-review → docs`.

## The rules

### 1. Stages in series are the cost: at most four

The task phase lasts as long as the longest chain of dependencies, not the sum of the tasks: tasks
on different branches of the graph run side by side, tasks on one chain wait for each other. So the
number to watch is how many tasks run one after another. Aim for **four or fewer**.

The launch form and the graph editor show it under the task list: "3 stages in series · survey →
build → docs". Above four stages they add a neutral notice. It is a hint, never a block: a graph
that really needs five stages still launches.

### 2. No stand-alone `types` task

A task that only writes the shared types or the route shapes (8–15 min) holds back every other task,
because all of them depend on it. Instead:

- write the contract (the type names and fields, the route and its body) **in the plan or in the
  task prompts**, so the core and web tasks start in parallel against it; or
- **fold it into the first core task**, and let only the tasks that truly need the generated
  artefacts (an OpenAPI schema, say) depend on that task.

### 3. `docs` runs beside `review`, not after it

A documentation task describes what was built, so it depends on the **implementation tasks**, not on
the review task. That turns the `review → docs` tail, which added 25–50 min to every graph, into two
tasks that run at the same time. When the synthesis writes the Outcome anyway, drop the `docs` task.

### 4. `review` does not re-run the suite when verification is on

With verification on, the verification phase runs the full suite on the merged branch after the
tasks. A review task that runs it again spends its time on a result nobody reads. Its prompt says it
reviews the design, the conventions and what the checks cannot see (copy, naming, a missed case),
and runs at most the one test it wants to read.

### 5. `sonnet` for prose-only tasks

A task that only writes prose (documentation, changelog-style notes) sets its `model` to `sonnet`:
it is faster and cheaper, and writing about finished code does not need the stronger model. Every
other task leaves `model` out and runs on the graph's.

### 6. Name the files and routes in each task prompt

A worker starts in a fresh worktree with none of the planner's context. A prompt that names the
files, modules and routes it touches (`packages/core/src/orchestrator.ts`, `GET /orchestrations/:id`)
saves the turns the worker would spend finding them, and keeps two parallel tasks off the same file.

## A worked example

The usual shape, five stages in series:

```
types → core → web → web-review → docs
```

Rewritten with the rules above, three stages:

```
core ── web ─┬─ web-review
             └─ docs (sonnet)
```

- `types` is gone: its contract is written in the prompts of `core` and `web`, and `core` owns the
  `types.ts` change and the generated schemas.
- `web` depends on `core` only because it needs the generated schema; if it can build against the
  contract in its prompt, it starts with `core` and the graph drops to two stages.
- `docs` depends on the implementation (`web`, and through it `core`), not on `web-review`, and
  runs on `sonnet`.
- `web-review` reviews the design and the copy; verification runs the suite on the merge.

The hint reads "3 stages in series · core → web → web-review", with no notice.

## Related

[[plans/orchestration-speed.md]] · [[plans/graph-shape.md]] · [[plans/worker-checks.md]] · [[design-system.md]]
