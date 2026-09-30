---
created_at: 2026-09-29T12:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - qa
    - security
    - chats
    - report
---
# QA report: CW-10, a chat Agentry starts gets its own API token

Branch `task/cw-10`, commit `c6361f75` on top of the spec commit `be7ffe47`.

## Verdict: fail (the checks could not be run)

The diff meets every behavioural, test and documentation criterion when read. The item fails only
because this QA session could not run `pnpm typecheck`, `pnpm test` or
`pnpm --filter @agentry/api openapi:schemas`: the flow ran in "don't ask" mode, and Bash was
denied, for the QA session and for a subagent too. That criterion cannot be marked met without
output. Run QA again with Bash allowed, or run the three commands and attach the output.

## What was read

- `packages/core/src/security/chat-tokens.ts` (new): `agc_` + `randomBytes(32).toString('base64url')`,
  held as a SHA-256 `Buffer` keyed by its hex, compared with `timingSafeEqual`, and aged out by
  `CHAT_TOKEN_MAX_AGE_MS` (24 h), both on `verify` and in a sweep on each `mint`.
- `packages/core/src/chats.ts` `spawnProcess`: always runs `delete env.AGENTRY_API_TOKEN`, mints a token only
  when `apiUrl` is set, revokes it when `spawn` throws, and revokes this process's own token on
  `error`/`exit` before the `current()` check. `stopAll` calls `revokeAll()`.
- `packages/core/src/index.ts`: `runtime.chatTokens = security.chatTokens`, so the guard reads the store that
  minted the token.
- `packages/core/src/security/auth.ts` `chatActorFor`: null under `mode: none` or when the request is not
  local. It is tried only after `actorFor` returns null, so the owner's token path is unchanged.
- `apps/api/src/security.ts` `fromLocalChat` checks:
  - the socket's `remoteAddress` is loopback;
  - the `Host` name is loopback and is not a runtime host;
  - there is no `Forwarded` or `X-Forwarded-For` header, and no client-IP header of any runtime host.

  A failure goes through the same `backoff.fail` + `refuse()` as a wrong owner token.
  `CHAT_FORBIDDEN` answers `403` on the five routes. The `421` host check runs before the credential,
  and read-only `405` after it, as before.
- `packages/shared/src/types.ts`: only the `AuditEntry.actor` doc comment changed, and `schemas.json` carries
  the same description.
- No log call in `packages/core/src` writes the child's `env`.

## Tests read

- `packages/core/test/chats.test.ts` covers:
  - the child's environment, with the inherited value replaced;
  - no token without a URL;
  - revocation on exit;
  - two turns getting two tokens;
  - a late exit from an earlier process;
  - `stopAll`;
  - expiry with an injected clock.
- `packages/core/test/chat-tokens.test.ts` covers:
  - the store holds the hash only;
  - a new store knows no token (a restart);
  - revocation;
  - `chatActorFor` under a guard and under none;
  - no token or hash of one in the data dir.
- `apps/api/test/security.test.ts` has only appended tests; the existing ones are unchanged. The new
  ones cover:
  - loopback, `localhost` and `::1` accepted;
  - the audit actor `chat:chat-42`;
  - identical `401` body and `WWW-Authenticate` for a non-loopback peer, the tunnel host, an allowed
    host, `X-Forwarded-For`, `Forwarded` and a runtime client-IP header;
  - backoff to `429`;
  - revocation, and a restart on the same data dir;
  - the five `403` routes, with `/tunnel/stop` still allowed;
  - `405` in read-only mode and `421` from the host allowlist;
  - OIDC;
  - `mode: none` staying `local`;
  - the owner's token keeping actor `token:<id>`.

## Notes, not blockers

- The expiry test in `chats.test.ts` swaps `runtime.chatTokens` for a store with its own clock, so it
  checks the runtime's store, not the guard's. The API side of expiry rests on the unit test of
  `ChatTokenStore`.
- `AGENTRY_AUTH_TOKEN_RESET` has no new test. It is unaffected by the diff (the owner's path is
  untouched) and its existing tests are unchanged.

Related: [[plans/chat-api-token.md]], [[chat-environment]].
