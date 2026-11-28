# Outside-app intake

Outside apps can send support tickets to the Factory. A platform admin in the app
picks which tickets to send. Each sent ticket becomes a **bead** in the app's own
repository, and the [beads integration](beads.md) turns that bead into a card,
just like any other ready bead. When the card reaches Done, the bead closes and
the app is told "fixed". This work is tracked in beads `samskara-rvq`.

This is a stopgap. Mastra's Factory has no custom intake source yet. The
2026-11-26 livestream (youtube `PGW-6NYst8Y`, at about 38:04) says an API for
custom input sources is planned. Revisit this once it ships.

## How it works

- **Pull, not push.** Factory calls the app, so samskara opens no new public
  endpoint. The code is in `packages/factory-app-intake`. It runs inside each
  beads sweep as a repository hook (`packages/factory-beads/src/repo-hooks.ts`),
  under the same writer lease, after write-back and before intake. A bead it
  files is published and carded in that same sweep.
- **Order in each sweep:**
  1. Closed app beads that haven't been reported get a `fixed` call. The call
     is retried with backoff, from 1 minute up to 1 hour, until the app returns
     2xx. Success is then written on the bead (`app_ticket_fixed_at`), so a
     restart doesn't send it again.
  2. The app's ticket list is read, at most once per 60 s. Each ticket is filed
     as one bead, or the existing bead is updated if the ticket's `updatedAt`
     changed. A ticket whose bead is closed is never filed again.
- **Bead shape:**
  - The title is the ticket title.
  - The type is `feature` for category `idea` or `feature`, otherwise `bug`.
  - Labels are `app-ticket`, `app:<id>` and the category.
  - `--external-ref` is the ticket URL.
  - Metadata is `app_ticket_app`, `app_ticket_id` and `app_ticket_updated`.
  - The description holds the report and the failed run's step log, up to
    8,000 characters (the newest part of the log is kept).
- **Privacy.** Every bead description tells the agent to use only the bead title
  and ticket id in pull requests and commits. The app must send a title that's
  safe to make public. A public repository makes every PR public.

## The contract an app serves

Both calls carry `Authorization: Bearer <token>` (`src/client.ts`).

```
GET  <baseUrl>/factory/tickets[?cursor=<c>]
     200 {"tickets": Ticket[], "nextCursor": string | null}
     Only tickets a platform admin sent to Factory that are not fixed yet.

     Ticket = {"id", "title", "category"?, "page"?, "team"?, "description"?,
               "stepLog"?, "url"?, "updatedAt"?}
     id: [A-Za-z0-9_.:-], title: at most 200 characters, public-safe.

POST <baseUrl>/factory/tickets/<id>/fixed
     body {"beadId", "reason", "closedAt"?}  ->  any 2xx; a repeat is harmless.
```

A wrong token should get a 403. Redirects are refused, and each call times out
after 15 s.

## Configuration

`APP_INTAKE_APPS` is a JSON array with one entry per app. Each token lives in
its own env var, named by `tokenEnv`, so the list itself holds no secret
(`src/apps.ts`):

```
APP_INTAKE_APPS=[{"id":"takewon","name":"Takewon support","baseUrl":"https://<convex-site>","repo":"hamchowderr/takewon","tokenEnv":"APP_INTAKE_TAKEWON_TOKEN"}]
APP_INTAKE_TAKEWON_TOKEN=<long random string, the same value the app checks>
```

- `baseUrl` must be `https`. `http` is accepted only for `localhost`.
- An app whose token variable is empty is left out.
- A malformed list leaves every app out and never stops startup.
- Startup prints one line, for example
  `[app-intake] apps: takewon -> hamchowderr/takewon`, or
  `[app-intake] off: APP_INTAKE_APPS is not set`. Tokens are never printed.

In production these variables go in Coolify, like the other production secrets.

## Adding an app

1. In the app, serve the two endpoints above. Let only a platform admin mark a
   ticket "sent to Factory".
2. Generate a token, for example with `openssl rand -base64 32`. Set it in the
   app's server environment and in Coolify as `APP_INTAKE_<APP>_TOKEN`.
3. Add the app's entry to `APP_INTAKE_APPS` in Coolify and redeploy.
4. Make sure the app's repository uses beads (`.beads/` with a DoltHub
   `sync.remote`, or `refs/dolt/data`). It must also be linked to a Factory
   project, and the GitHub App must be able to see it. See
   [beads.md](beads.md#single-writer) and
   [setup/github-app.md](../setup/github-app.md).
5. Send one test ticket. Within about a minute, a bead labelled `app:<id>`
   appears and its card lands on the Beads board. When the card is Done, the
   ticket shows fixed.

The beads integration must be on (it is by default), because the intake runs
inside its sweep.
