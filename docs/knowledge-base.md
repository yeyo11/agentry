---
created_at: 2026-09-24T13:51:47.97356172Z
updated_at: 2026-09-24T14:09:56Z
tags:
    - knowledge-base
    - pando
    - convention
    - docs
    - search
---
# The knowledge base

What Agentry knows about itself lives in two indexes that [pando](https://github.com/digiogithub/pando)
keeps beside the repo: the **knowledge base**, which is this `docs/` folder chunked and embedded, and
the **code index**, which is every source file parsed into symbols. Both answer semantic questions —
"where is a chat's permission mode decided", "what did we decide about the app stores" — that a
`grep` cannot.

Neither is a second source of truth. The documents are the markdown files in this folder, tracked in
git and reviewed like code; the indexes are derived and disposable. They live in
`.pando/data/pando.db`, which is gitignored, so nothing here is committed and a lost database is one
re-index away.

## The rule

**Every new feature, every decision, and anything else worth remembering becomes a document here,
and goes into the knowledge base.** A decision that only exists in a chat transcript or a commit
message is a decision the next session will not find. Write it as markdown under `docs/` (plans go
in `docs/plans/`), then store it with pando's `kb_add_document`, using the path the knowledge base
already uses for this folder — `deploy.md`, `plans/mobile.md` — plus tags and links.

Search before writing. `kb_search_documents` says whether a document already covers the ground, and
updating it beats adding a second one that disagrees with the first.

The rule is stated in [CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) as well,
because those two travel with the repository: an orchestration worker starts in its own worktree,
with none of the memory of the session that planned the work, and CLAUDE.md is what reaches it.

## Search before answering

The other half of the rule, and the one that gets skipped. **Any question about this project is
answered by searching the knowledge base first** — what the project does, how a piece of it works,
where it stands, why something was decided, where something lives. `kb_search_documents` is the
first tool call of the turn, then `code_hybrid_search` when the answer is in the source rather than
in the prose. `git log` and opening the likely file come after, to verify what the search returned.

The failure mode is not forgetting the tools exist; it is deciding, question by question, that this
particular one is factual enough to answer straight from the repository. It never is: the
repository says what the code is, and the documents say what it means and why. So the trigger is not
a judgment about the question. Search unless the user named the exact file, unless you are after a
literal string or a known identifier — grep's job — or unless the turn is pure editing with nothing
asked. A search that returns nothing costs one call and rules out a whole folder.

A search that comes back empty on a question this folder should have covered is itself the finding:
the document is missing, and writing it is the rule above.

## Write through the tools, not around them

A new document enters through `kb_add_document`, never through the REST upsert or by dropping a file
and waiting for the watcher. The tool does three things the plain write does not: it merges **front
matter** into the file — `created_at` kept from the first version, `updated_at` refreshed, and the
`tags` passed with the call — it **mirrors the document back to `docs/`** with that front matter,
and it **indexes the `[[wiki links]]`**, answering with how many were resolved and which targets
nothing defines yet. Those dates and tags are what later filter and rank a search; a document
imported around the tools has none of them.

That front matter is rebuilt from the tags on every update, so anything else written into it by
hand — `aliases`, a status field — does not survive the next `kb_add_document`. Tags are the durable
metadata; keep them meaningful.

## The format every document follows

```markdown
---
created_at: 2026-09-21T07:35:14Z      # when the document was first written
updated_at: 2026-09-23T23:12:12Z      # when its content last changed
tags:
    - deploy
    - operations
---
# Title

…the document…

## Related

[[desktop.md]] · [[status.md]] · [[plans/mobile.md]]
```

The dates are the document's own history: for the documents that predate the knowledge base they
were taken from git — first commit and last commit touching the file. They are for the reader, and
for us: pando strips the front matter before storing a document and stamps its rows with the moment
it imported them, so a search sorted by date sorts by import, not by authorship. Tags are the
metadata that does cross over — lowercase, few, and filterable with the `tags` argument of
`kb_search_documents`.

When a document changes, edit the file and re-sync; do not re-add it with `kb_add_document`, which
rebuilds the front matter from the row it already has and would overwrite these dates with the
import timestamp. The tool is for a document's first entry, where `created_at` really is now.

```bash
curl -sk -X POST -H "X-Pando-Token: $T" https://localhost:8765/api/v1/remembrances/kb/reindex
```

That re-sync is deterministic and idempotent — it answers with what it scanned, updated and linked,
and a second run reports everything unchanged. The file watcher does the same work on its own, but
it processes one document at a time and can be left behind by a bulk edit; the endpoint is how you
know.

## Links, and which kind

The prose links with ordinary markdown, so the documents read correctly on GitHub, and each one ends
with a **Related** list of `[[wiki links]]`. That list is what pando indexes as a graph:
`kb_related_documents` walks outgoing links, backlinks and shared tags from it. The brackets are
visible on GitHub — that is the price of the graph, and confining them to one list at the end keeps
it cheap.

A wiki link to something that does not exist yet is not a mistake. It records a concept worth
writing about, and `kb_related_documents` with no arguments lists those wanted concepts, most
requested first: the queue for the next document.

A target resolves by path or by basename, so `[[status.md]]` and `[[status]]` both find `status.md`.
Pando can also resolve declared aliases, but do not rely on them here: they live in front matter,
and front matter is rebuilt from the tags on every update.

## Ollama has to be up

Every embedding — documents through `nomic-embed-text`, code symbols through `CodeRankEmbed` — is
computed locally by **ollama, which runs as a Docker container**, not as a systemd service:

```bash
docker ps --filter name=ollama     # expect "Up …", publishing 11434
docker start ollama                # if it is not
```

With the container stopped, `kb_add_document` and every semantic search fail or come back empty, and
an index job started without it produces nothing. `systemctl is-active ollama` says `inactive` even
when everything is fine — do not trust it. Being local, embedding costs time and never money.

## The code index

`code_hybrid_search` (by meaning) and `code_find_symbol` (by name) answer from a snapshot, not from
the working tree, and the snapshot does not follow later commits. Check it before trusting it:

```
code_get_project_stats(project_id: "home_yeyo_Escritorio_claude-wrapper")
```

The project id is the repo path with separators replaced; `indexing_status` must be `completed`. As
of 2026-09-24 the index holds 508 files and 4,629 symbols — every tracked source file except the
contents of dotdirs such as `.github/`.

Re-indexing needs an instance that outlives the request. A job started through the MCP server dies
when the Claude Code session that spawned it exits, which is how the project was once left stuck at
`in_progress` after two files. What works is a detached server, driven over its REST API:

```bash
cd /path/to/claude-wrapper
setsid nohup pando serve > .pando/serve.log 2>&1 < /dev/null &   # HTTPS on 8765
T=$(curl -sk https://localhost:8765/api/v1/token | jq -r .token) # loopback only
curl -sk -X POST -H "X-Pando-Token: $T" -H 'Content-Type: application/json' \
  -d '{"path":"'"$PWD"'","project_id":"home_yeyo_Escritorio_claude-wrapper"}' \
  https://localhost:8765/api/v1/remembrances/projects/index
```

A full pass over the monorepo takes about fifteen minutes. Watch it with
`GET /api/v1/remembrances/projects`, and stop the server when it says `completed`.

## How pando is wired in

Pando is an MCP server declared in [`.mcp.json`](../.mcp.json), speaking stdio, started by the
Claude Code CLI with the repo as its working directory:

```json
{ "mcpServers": { "pando": { "type": "stdio", "command": "pando", "args": ["mcp-server", "--no-http"] } } }
```

It is there for these two indexes and nothing else: fetch, browser, Context7 and the mesnada
orchestrator are off in `~/.pando.toml`, so the tool surface stays at the `kb_*`, `code_*` and
memory tools. Claude Code already has its own file, grep and shell tools, and a smaller surface
keeps context cheap.

Both databases are resolved **relative to the working directory** (`[Data] Directory =
'./.pando/data'`), so pando must always be started from the repo root. Started anywhere else it
opens an empty knowledge base and reports, truthfully and uselessly, that it knows nothing.

## Related

[[status.md]] · [[deploy.md]] · [[desktop.md]] · [[plans/ui-redesign.md]]
