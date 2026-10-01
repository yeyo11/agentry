---
created_at: 2026-10-01T16:30:00Z
updated_at: 2026-10-01T16:30:00Z
tags:
    - plan
    - decision
    - e2e
    - verification
    - flaky
    - built
---
# e2e waits on conditions, not on time

The browser suite (`e2e/`) failed under load, locally and in CI, for reasons that had nothing to do
with the app: the runner gave the API a fixed time to boot, and several specs read the page a fixed
time after loading it. The follow-ups of [post-roadmap](post-roadmap.md#follow-ups) named three of
them. This change makes each of those waits a wait on the condition it stood for.

## The decision

**A wait in the harness or a spec waits on the condition it is for, with a generous limit, and never
on a fixed delay followed by a read.** A fixed delay is either too short on a loaded machine (a flake)
or too long on a fast one (a slow suite). A spec's assertions stay as strong as they were: what was a
`check` after a delay becomes a `page.waitFor` on the same condition, labelled with the same words,
or a wait for the thing the check is about to be drawn, followed by the same `check`.

## What changed

- **The runner waits for the API's readiness.** `waitForServer` in `e2e/run.mjs` polled
  `/api/system` 80 times every 250 ms, about 20 s, and then threw `API did not start`. It now polls
  `/api/health`, which spawns nothing (`/api/system` may start a `claude` process), and takes any
  HTTP 200 as ready: the server listens only after every route is registered, and the body's `ok`
  speaks of the CLI's login, which the sandbox does not have. The limit is 120 s
  (`E2E_SERVER_START_TIMEOUT`). If the server process exits first, the run fails at once with the
  tail of the server's stderr (the runner now pipes it, and still echoes it as it comes), so a
  taken port or a crash on boot says why instead of waiting out the limit.
- **`waitFor` says where it timed out.** A timeout now names the page's address and the last error
  the check threw, so a page that never loaded or a renderer that died is told apart from a
  condition that never came true.
- **Specs.** `connectors` waits for the sidebar's links before reading them (the shell draws every
  navigation group at once). `tasks-board` waits for Select to be pressed, for each pick, for the
  bar's count and for the address after Orchestrate (an API call comes before that navigation), and
  gives the list 60 s to show every item after a full page load: in CI it timed out at the default
  20 s with the page still blank. The same conversion, after a navigation, in `orchestration-v2`
  (the list's search, three reads), `security` (the Security tab after a reload), `team-gaps` (the
  Team views), `pages` (the Accounts page without claude-swap), `shell` (the top bar, the active
  Projects link, the selected Settings tab, the phone's Tasks header and the top bar on four
  routes) and `mobile` (it waits for the tab bar before checking that Tasks is not in it).
- **The harness test of the run limit** ran with a 12 s limit, which counts from the runner's start,
  boot included: under load the probe spec never started inside it. It now runs with 45 s.

Fixed sleeps after an action that only change local UI (opening a menu, pressing a key) were left as
they were; so were sleeps before an API read, which are not about the page.

## Related

[[plans/post-roadmap.md]] · [[plans/ci-e2e-shards.md]] · [[plans/verify-faster.md]] · [[status.md]]
