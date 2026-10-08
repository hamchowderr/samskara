# Session cache

The Factory auth gate is served from a short in-process cache in front of
Better Auth's `getSession`. Tracked in beads `samskara-lx1`.

Code: `src/mastra/auth/session-cache.ts`, wired in
`src/mastra/index.ts:344-355` and cleared from
`src/mastra/auth/better-auth.ts:129` and `:220-223`.

## Why

The Factory gate (`@mastra/factory` `dist/auth.js:529`,
`createFactoryAuthGate`) authenticates every request outside `/auth/*`. It
calls the provider, and the provider calls `auth.api.getSession({ headers })`
on every call (`@mastra/auth-better-auth` `dist/index.js:819`). Each call sends
two statements: one for the session row, one for the user row.

Production uses Turso in `aws-us-west-2`. Every connection to it stalls for
about one second roughly every six seconds (see `samskara-lx1`). A page that
fires a dozen API calls waits on a dozen pairs of queries, and any of them can
land in a stall.

With the cache, a repeat request from the same session sends no statements
until the entry expires. `tests/auth/session-cache.test.ts` measures this
against a real libSQL file: two statements per request without the cache, zero
on a cache hit.

## Better Auth features that were not used

### `secondaryStorage`

Better Auth can keep sessions in a key-value store beside the database. With an
in-memory store this does not help after a deploy:

- The store is written only when a session is created
  (`better-auth` 1.7.5 `dist/db/internal-adapter.mjs:278-306`).
  `updateSession` rewrites a key only when it already exists
  (`:416-417`). After a restart the store is empty, and every session that
  existed before the deploy stays on the database path until the user signs in
  again. The daily `updateAge` refresh keeps an active session alive
  indefinitely, so that can be a long time.
- Verification tokens (password reset, email verification, invitations) move
  into the store (`:709-734`), so a restart would drop them.
- The rate limiter moves into the store as well
  (`dist/context/create-context.mjs:175`).

### `session.cookieCache`

The cookie cache keeps the session in a signed cookie that only a response can
refresh. The gate calls `getSession` server-side and never returns its
`Set-Cookie`. The SPA reads the session through the Factory's `/auth/me`, which
also validates server-side and returns only JSON (`@mastra/factory`
`dist/auth.js:284-310`). The cookie would be set at sign-in and never renewed
after its `maxAge`, so every request after that would fall back to the
database.

## Behaviour

- **Scope.** Only `api.getSession` called with exactly `{ headers }` is cached.
  That is the shape the provider uses. Any other shape, and every other method
  on the instance, goes straight to Better Auth (`session-cache.ts:83`).
- **Key.** The signed session cookie value, signature included
  (`session-cache.ts:128-147`). An entry is created only after Better Auth
  verified that exact string, so a cookie with a changed signature misses and
  is verified by Better Auth. A header that carries the session cookie twice
  is not cached.
- **What is cached.** Successful lookups only. A null result, an error, or a
  session that is already past `expiresAt` is never stored
  (`session-cache.ts:110-123`). Concurrent lookups for the same cookie share
  one database call.
- **Lifetime.** 15 seconds, and never past the session's own `expiresAt`
  (`session-cache.ts:68`, `:122`). At most 1,000 entries; the oldest goes
  first.
- **Invalidation.** `buildBetterAuth` registers `after` hooks on `session`
  update and delete and on `user` update and delete
  (`better-auth.ts:220-223`). Each one clears the whole cache. That covers
  sign-out, revoking a session, revoking all sessions, a password change that
  revokes other sessions, switching the active organization, profile edits,
  deleting a user and the `updateAge` refresh. Better Auth runs `after` hooks
  once the write has committed (`dist/db/with-hooks.mjs`), so a lookup that
  starts after the clear reads the new row. A lookup that was in flight when
  the cache cleared is returned to its caller but not stored.
- **Copies.** Callers get a `structuredClone` of the cached value, so a caller
  that mutates its result cannot change the cache (`session-cache.ts:152`).
- **Restart.** The cache lives in memory and starts empty. The first request
  from each session after a deploy goes to the database, then fills the cache.
  There is nothing to migrate or flush.

## Limits

- **Several containers.** The cache is per process. With more than one
  container, a sign-out or revoke on one leaves the session valid on the others
  for up to 15 seconds. Production runs one container today.
- **Writes that bypass Better Auth.** Raw SQL against `session` or `user`
  fires no hooks and is seen only after the entry expires.
- **Bulk deletes.** Better Auth fires delete hooks only for rows its pre-delete
  lookup found (`dist/db/with-hooks.mjs`, `deleteManyWithHooks`). If that
  lookup fails, the rows are still deleted but the cache is not cleared, and
  the deleted sessions stay valid for up to 15 seconds.
- **Organization membership.** The cached value is the session and user rows.
  When a session has no `activeOrganizationId`, the provider looks up
  membership itself on every request, outside the cache.
