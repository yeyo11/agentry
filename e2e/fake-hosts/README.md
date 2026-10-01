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
| `checks` | `none` | gh only: the head commit's checks, `none`, `failing`, `running`, `mixed` or `fixed` |
| `headSha` | a fixed sha | gh only: the head commit the change request reports |

The checks scenarios answer the change request routes: the GraphQL read (`gh api -i … graphql`), the
check runs and statuses of the head, a job's log (ANSI colour, a group marker and an `##[error]`
line, as a runner prints it), the annotations, and the branch rules. `run rerun` and `run cancel` move
the scenario (to `running` and `failing`) through `gh.checks`, which wins over the JSON until a spec
removes it. `failing` has one failed check, `running` one running and one queued, `mixed` a failed,
a running, a skipped and another app's check, and `fixed` has all passed.

Beside the JSON, in the same directory: `<name>.calls` (one line per call, the arguments joined by
spaces), `<name>.body-<n>` (the description a create was given on stdin) and `<name>.created` (the
number the last create returned, which `list` then finds).

The default is a CLI that works and is signed in, which is what the specs that open change requests
need. The Integrations spec changes it, and puts it back before it ends.
