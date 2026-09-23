# Outbound mail

Nothing in `@mastra/factory`, `@mastra/code-sdk` or `@mastra/auth-better-auth`
sends email. That is the self-hosting boundary: on Mastra Cloud the platform
owns delivery, and self-hosted this deployment owns it. Samskara sends through
[Resend](https://resend.com).

## What breaks without it

Better Auth decides whether to **mount** a flow from the presence of a sender
callback, so a missing transport is not a degraded feature — the endpoint is
gone. Measured against a running server:

| Endpoint | No transport | With transport |
| --- | --- | --- |
| `POST /auth/api/request-password-reset` | `400 RESET_PASSWORD_DISABLED` | `200` "check your email" |
| `POST /auth/api/send-verification-email` | `400 VERIFICATION_EMAIL_NOT_ENABLED` | `200 {"status":true}` |
| `POST /auth/api/organization/invite-member` | writes a row, notifies nobody | sends the invitation |

A client who forgets their password cannot recover without the maintainer
editing the database by hand.

## Configuration

Two variables, both required — a key with no verified sender fails at send
time, which is worse than declining to mount the flow.

| Variable | Notes |
| --- | --- |
| `RESEND_API_KEY` | Secret. Lives in Infisical at `/samskara`, never in `.env`. |
| `MAIL_FROM` | e.g. `Samskara <noreply@send.otakusolutions.io>`. Domain must be **verified** in the Resend account. |
| `MAIL_REPLY_TO` | Optional Reply-To. |

Only `RESEND_API_KEY` is a secret, and it is the only one in
`scripts/secrets-template.env`. `MAIL_FROM` is an address, so it lives in
`.env` with a working default already set — nothing to fill in for this
deployment, one line to change for another domain. It stays a variable because
the sender is tied to whichever domain is verified in the Resend account, so it
moves together with the API key.

Every boot logs which state it is in:

```
[mail] Resend configured — password reset, email verification and invitations will send.
[mail] NO TRANSPORT (set RESEND_API_KEY + MAIL_FROM): password reset is not mounted, …
```

## Verifying the sending domain

The domain in `MAIL_FROM` must be verified in Resend or the API rejects the
message. To list the account's domains and their status without printing the
key:

```bash
infisical run --env dev --path=/samskara --silent -- node -e '
  fetch("https://api.resend.com/domains", {
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  }).then(r => r.json()).then(b =>
    console.log(b.data.map(d => `${d.name}  ${d.status}`).join("\n")));
'
```

To prove delivery end to end without emailing a person, send to Resend's sink
address `delivered@resend.dev`. A `200` with an id means the transport works.

## Sends are backgrounded, on purpose

Better Auth awaits the mail callbacks unless a background handler is
configured: `runInBackgroundOrAwait` defers only when
`advanced.backgroundTasks.handler` exists, and otherwise falls through to
`await promise` (`context/create-context.mjs:215-225`).

Awaiting would be an account-enumeration oracle.
`/auth/api/request-password-reset` returns the same body whether or not the
address is known, but a response that waits on Resend is measurably slower for
an address that exists. Better Auth's docs say it plainly: *"Avoid awaiting the
email sending to prevent timing attacks."*

Their examples hand off to a platform primitive (`waitUntil` on Vercel,
`ctx.waitUntil` on Cloudflare). This is a long-running Node process with no
such primitive, so the handler lets the promise run detached and logs failures.
The `.catch` is load-bearing — an unhandled rejection would take the process
down.

Measured at that branch, with a 400 ms stand-in for the send:

```
no handler (old behaviour)       402.2 ms   BLOCKS the response
with handler (our config)          0.1 ms   returns immediately
rejected send -> unhandledRejection: no (caught)
```

The trade is that a send failure no longer reaches the caller — the endpoint
answers "check your email" and the failure appears in the log as
`[mail] background send failed: …`. That is the correct trade for this
endpoint, whose whole design is to reveal nothing, but it means mail failures
must be watched in the logs rather than surfaced in the UI.

## Where the code lives

- `src/mastra/auth/mailer.ts` — the Resend transport and `mailConfigured`.
  Read the comment at the top before making the sender callbacks
  unconditional: a callback that silently drops the message makes the endpoint
  answer "check your email" when nothing was sent, which is a worse failure
  than no endpoint.
- `src/mastra/auth/better-auth.ts` — where the three callbacks
  (`sendResetPassword`, `sendVerificationEmail`, `sendInvitationEmail`) are
  attached.

## Why this needed a custom Better Auth instance

`@mastra/auth-better-auth` can build its own instance from just a `secret`.
That path calls `organization()` with **no options**
(`dist/index.js:495`), so `sendInvitationEmail` can never be supplied. The
provider's only escape hatch is its `auth` option, a pre-built `betterAuth()`
instance — which is what Samskara passes. The cost of that switch is schema
ownership: see [better-auth-migrations.md](./better-auth-migrations.md).
