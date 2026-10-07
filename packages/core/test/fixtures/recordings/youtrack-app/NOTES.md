# youtrack-app recordings

`youtrack-app` 1.0.3 (`@jetbrains/youtrack-apps-tools`, npm) run on 2026-10-07 against a YouTrack
2026.2.19562 instance started for the purpose from JetBrains' Docker image (`jetbrains/youtrack`,
bound to 127.0.0.1, free up to ten users), with a permanent token of its administrator. This is
task `t0b`'s YouTrack half in [the code hosts plan](../../../../../../docs/plans/code-hosts.md#phase-5-in-two-steps-2026-10-02):
no external account was used, and nothing here comes from a person's YouTrack.

Every call ran under `env -i` with an empty `HOME`, `NO_COLOR=1`, `LC_ALL=C`, stdin closed and no
terminal; stdout, stderr and the exit code are kept apart (`.out`, `.err`, `.rc`, `.meta` as for
`gh` and `glab`). The address and token were given as `YOUTRACK_HOST` and `YOUTRACK_TOKEN`, never in
argv, and no capture holds the token. The scratch project is `AGP` (`0-1`); `DEMO` is the sample
project the image ships.

The labels starting `yt_` are the exact argv the adapter (`src/trackers/youtrack/adapter.ts`)
builds, so the tests replay them through `fake-cli.mjs`; the others are the exploration that
decided it. `comment_60k` is not indexed: its argv holds a 60 000-character body.

## What the recordings showed

1. **Versions.** `--version` prints `1.0.3` and a newline, exit 0.
2. **Exit codes.** The documented ones hold, and there is one more:
   - 0 success; 2 usage or validation: no host (`Error: Option "--host" is required`), a body that is
     not JSON, and some HTTP 400s; 3 authentication: a bad token (`Error: [401] Invalid token`) and
     no token at all (`Error: Token is required. Please create one at <host>/users/me?tab=account-security`);
     4 not found: HTTP 404, and some HTTP 400s whose message says "not found".
   - **5 when the address does not answer** (`TypeError: fetch failed`), which the README does not
     list. Agentry reads it as `host-unreachable`.
   - Every error goes to stderr as one `Error: [<status>] <message>` line; stdout is empty.
3. **HTTP 400 is 2 or 4 by its message.** `State expected: Nonsense` (a command) and "unable to
   locate an Issue" exit 2; "An Nonsense-type entity with the specified name was not found" (a field
   write) exits 4. So Agentry never reads 2 or 4 alone as "the issue is gone": the sync, which has
   just read the issue, takes a refused status write as `transition-unknown`.
4. **JSON.** `rest request` prints the answer pretty-printed. Objects carry `$type`. An issue with no
   description leaves the `description` field out rather than null. `updated` and `resolved` are
   epoch milliseconds; `resolved` is null while the State is not a resolved one (`Done`,
   `Duplicate` in the scrum template). Single-value custom fields are `{ value: { name }, name }`,
   empty ones `value: null`, multi-value ones `value: []`.
5. **Lists.** `/api/issues` answers a bare array; a page past the end is `[]`. `project list --json`
   answers `{ items, pagination: { skip, limit, returned, nextSkip, hasMore } }`.
6. **Queries.** `project: AGP #Unresolved` works; `project: NOPE` is a parse error (400, exit 2), not
   an empty list.
7. **Writing a status.** Through `/api/commands`, `State In Progress` works unquoted, while
   `State {To Verify}` and `State "In Progress"` are refused: a value with spaces is written bare,
   and the command language would read anything after it as more commands. Setting the field
   instead (`POST /api/issues/<id>` with `customFields`) takes the name as JSON data and answers
   with the issue after the write, `resolved` set for a resolved State. Agentry writes the field.
8. **Idempotence.** Setting the State an issue already has exits 0 and changes nothing.
9. **A 60 000-character body in argv** is taken (a comment of that size was created).

## Cleanup

The instance was a throwaway container; the scratch project and its issues went with it.
