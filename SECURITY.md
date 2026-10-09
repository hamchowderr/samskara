# Security

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/hamchowderr/samskara/security/advisories/new).
It is private between you and the maintainer until an advisory is published.

If that form is unavailable to you, email **admin@otakusolutions.io** with
`SECURITY` in the subject.

### What to include

- What an attacker can do, and what they need in order to do it — an
  unauthenticated request, a signed-in user in another organisation, a
  repository the Factory can reach.
- The steps to reproduce it, and the file and line if you have them.
- What you actually observed. Evidence rather than inference: the response, the
  log line, the row that should not have been readable.
- Whether it is reachable in a default configuration or needs a specific one.

**Please do not include working exploit code** in the initial report. Describe
the class of problem and the reachable path; that is enough to confirm and fix
it.

### What to expect

Acknowledgement within a few days. After that, an assessment of whether it is
reachable, what the ceiling on impact is, and where the fix belongs — this
repository or upstream.

This is a one-person project maintained alongside other work. No response-time
guarantee is offered, and pretending otherwise would be worse than saying so.

Credit in the advisory if you want it.

## Supported versions

Version 0.1.x, pre-1.0, `main` only. There are no maintained release branches
and no backports. Fixes land on `main`.

## Scope

**In scope** — the parts this repository decides:

- Storage selection and the refusal to honour an injected `DATABASE_URL`.
- Sandbox provider selection, and the rule that an explicitly requested
  provider missing its credentials must throw rather than fall back to a less
  isolated one. **A path that silently downgrades to running agent commands on
  the host is a vulnerability, not a convenience.**
- Handling of credentials in `.env`, in the setup scripts, and in the runbooks.
- The Better Auth instance this repository builds and owns
  (`src/mastra/auth/better-auth.ts`): cookie attributes, `trustedOrigins`,
  `baseURL`, schema migrations (`auth/migrate.ts`), the construction of
  invitation links, and the session hook that pins which organization a user
  signs in to.
- The mailer (`src/mastra/auth/mailer.ts`) and the session cache in front of
  the Factory gate (`src/mastra/auth/session-cache.ts`).
- The team and invitation pages (`src/mastra/team/`).
- The beads integration (`packages/factory-beads`), including how it passes
  the GitHub App installation token to `bd` and `git`
  (`packages/factory-beads/src/runner.ts`).
- The custom board in `src/mastra/boards/`.
- Anything in `scripts/`.

**Upstream** — report to
[mastra-ai/mastra](https://github.com/mastra-ai/mastra/security) instead:

- The Factory's authentication gate, tenant isolation and organisation
  membership checks — these belong to `@mastra/factory`.
- The internals of `@mastra/auth-better-auth` and of `better-auth` itself, as
  opposed to how this repository configures them.
- Agent execution, sandbox implementations, and tool permissions.
- Anything in `node_modules/@mastra/*`.

If you are unsure which side a problem falls on, report it here and it will be
forwarded with the reporter credited.

## Notes for anyone self-hosting this

These are properties of the deployment, not defects, and they decide how safe
an install is:

- **`FACTORY_CREDENTIAL_ENCRYPTION_KEY` encrypts stored provider credentials.**
  Losing it makes every stored credential unreadable. Rotating it needs the old
  value kept in `FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` through the
  transition.
- **The `local` sandbox runs agent commands on the host filesystem**, against
  whatever repository is connected. **On Windows there is no isolation backend
  at all** — neither `seatbelt` nor `bwrap` exists there, so nothing confines
  those commands. This is upstream and acknowledged
  ([mastra-ai/mastra#20304](https://github.com/mastra-ai/mastra/issues/20304));
  what shipped raises an error when an unavailable backend is explicitly
  requested, rather than providing a Windows one. Use a cloud sandbox for
  anything you would not run a stranger's script against, and set
  `FACTORY_SANDBOX_PROVIDER` explicitly rather than relying on auto-detection.
- **Secrets belong in a secret manager, not `.env`.** See
  [docs/setup/secrets-infisical.md](docs/setup/secrets-infisical.md). An entry
  in `.env` shadows an injected value, so a key in both places is the stale one
  winning.
- **`MASTRACODE_PUBLIC_URL` is the origin OAuth callbacks are built from.**
  Pointing it at an address you do not control redirects the callback there.
