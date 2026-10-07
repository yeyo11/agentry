# The fake youtrack-app

A small executable for the YouTrack specs: the e2e sandbox has no `youtrack-app` and no YouTrack, and
the suite never reaches a real one. It is **not** on `PATH`: `e2e/run.mjs` seeds `trackers.json` so
YouTrack uses the binary here. The address and the token are not seeded: a spec saves them through
Settings → Integrations, like a person.

It answers in the shapes and exit codes youtrack-app 1.0.3 was recorded to print
(`packages/core/test/fixtures/recordings/youtrack-app/NOTES.md`): `--version`, `rest request` on
`/api/users/me`, the issue list with its `project:` query and paging, one issue, and a `State`
field write. Anything else exits 4 with `is not part of the fake`. Every call is appended to
`$AGENTRY_DATA_DIR/fake-trackers/youtrack.calls` with the address and whether a token was set, never
the token itself, so a spec can check that the token stayed out of argv.

What it answers is read from `$AGENTRY_DATA_DIR/fake-trackers/youtrack.json`, which a State write
also updates:

| Key | Default | Effect |
| --- | --- | --- |
| `version` | `1.0.3` | The version the CLI prints |
| `token` | `perm-good` | The token the fake instance accepts; any other exits 3 (`[401] Invalid token`) |
| `user` | `e2e-user` | The login `/api/users/me` answers |
| `unreachable` | `false` | `true` exits 5 (`fetch failed`) on every request, as when the address does not answer |
| `refuseWrites` | `false` | `true` refuses every State write with exit 4 |
| `issues` | three issues of `PROJ` | `PROJ-1` (a bug, Open), `PROJ-2` (Open, no description), `PROJ-3` (In Progress, HTML in its title and body) |

The States it knows are `Open`, `In Progress`, `To Verify`, `Done` and `Duplicate`; the last two are
resolved. Another name is refused with exit 4, as YouTrack does for a field write.
