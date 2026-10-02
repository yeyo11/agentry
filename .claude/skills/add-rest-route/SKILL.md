---
name: add-rest-route
description: Add or change a REST route in Agentry's API: shared types, OpenAPI summary and tag, README table row, schema regeneration and tests. Use whenever a route or a shared type changes.
---

# Adding or changing a REST route

CI fails on each of the steps below, so do them in this order.

1. **Contract first.** Add or change the types in `packages/shared/src/types.ts`. It is the API contract; the API schemas and the web client are typed against it.
2. **Persistence.** A settings-shaped document goes in a JSON file; a stream or accumulating record is a SQLite table with a migration in `packages/core/src/db.ts`, as rows. Two processes share one data dir, so a claim that must be unique uses a guarded update or `BEGIN IMMEDIATE`.
3. **Core.** Put the logic in `packages/core`, not in the route. A route validates, calls the service and answers.
4. **Route.** Add it in `apps/api/src/routes/<area>.ts`. Creating routes answer 201 when they create and 200 when nothing was added, like the other creating routes.
5. **Docs of the route.** In `apps/api/src/openapi/routes.ts` give it a **summary and a tag**; a test enforces both.
6. **README.** Add a row to the matching table under `## REST API` in `README.md`.
7. **Regenerate the schemas** when a shared type changed, and commit the result:
   ```bash
   pnpm --filter @agentry/api openapi:schemas
   ```
8. **Events.** If the change should reach the web live, emit an event and add what the web refetches in `apps/web/src/lib/events.ts`.
9. **Tests.** An API integration test with Fastify `inject`, and a core unit test for the logic. Name each after the behaviour it protects.
10. **Check.** Run `pnpm typecheck` and `pnpm test`.

Agentry's own docs (`docs/<area>.md`) get the route's behaviour and its Known gaps; the commit is `feat:` or `fix:` (Conventional Commits).
