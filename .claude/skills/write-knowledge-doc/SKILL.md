---
name: write-knowledge-doc
description: Write or update a document under docs/ in the format Agentry's knowledge base expects: front matter, tags, a Related list of wiki links. Use for every feature and every decision.
---

# Writing a document for the knowledge base

CLAUDE.md asks that every feature and every decision becomes a document under `docs/` (plans in `docs/plans/`, decisions in `docs/decisions/`), in the same pull request that builds it. `docs/` is indexed for semantic search, so the format matters.

1. **Search first.** Run `kb_search_documents` (then Grep). Update the document that already covers the ground instead of adding one that disagrees with it.
2. **Format.**
   ```markdown
   ---
   created_at: 2026-09-21T07:35:14Z
   updated_at: 2026-09-23T23:12:12Z
   tags:
       - deploy
       - operations
   ---
   # Title

   ...the document...

   ## Related

   [[desktop.md]] · [[status.md]] · [[plans/mobile.md]]
   ```
   Tags are lowercase and few. Prose links use ordinary markdown links so the document reads on GitHub; the `## Related` list at the end holds the `[[wiki links]]`, and only there.
3. **When you edit an existing document**, change the file and bump `updated_at`; do not re-add it with `kb_add_document`, which would overwrite the dates. A new document enters through `kb_add_document` once.
4. **Say why.** Record what was decided, what was rejected and the reason, with the date, and the file paths it concerns.
5. **Status documents move too.** If the change alters where the project stands, update `docs/status.md` and the plan's Outcome in the same change.
6. **Language.** Documents are English; only the UI copy is translated.
7. Never edit `CHANGELOG.md`: release-please writes it from the commit messages.
