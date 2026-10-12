# Team invites

A client organization is one org with invited members. There are no sub-teams.

## The pages

| Page | Who uses it |
|---|---|
| `/web/samskara/team` | Everyone in the org. Owners and admins can also rename the organization, invite, change roles and manage pending invitations. |
| `/web/samskara/invitations/<id>` | The invitee. The invitation email links here. |

A signed-out visitor to either page goes to `/signin` and returns to the page
after signing in or signing up. The Factory UI is Mastra's, unmodified (owner
decision 2026-10-11, samskara-96u): it has no team screen and no supported way
to add a nav entry, so the team page is reached by its URL, `/web/samskara/team`.

## Roles

Better Auth enforces the roles. The pages only hide controls:

- **owner** can rename the organization, invite, change any role (including granting owner) and remove members.
- **admin** can rename the organization, invite and manage members, but cannot grant or change owner.
- **member** can view the team and the organization's name. Rename, invite and role changes return 403.

An invitation expires after 48 hours (Better Auth's default). Only the address
it was sent to can open or accept it. The team page shows a lapsed invitation as
expired, with Resend and Dismiss.

## The organization's name

Sign-up names every organization `<email>'s org`. Rename it on the team page; the
name is what invitation emails and the invitation page show. Only the name
changes: members, projects, model keys, GitHub installations and sessions are
tied to the organization's id, so a rename moves nothing.

## Which org a user signs in to

The Factory reads the org from the session's `activeOrganizationId`. Better
Auth never sets it at sign-in, and the provider then uses the user's **oldest**
membership. That is wrong for an invitee. The Factory creates a personal org
for them on their first visit, so that org is always older than the team they
join.

`databaseHooks.session.create.before` in `src/mastra/auth/better-auth.ts` sets
each new session to the org the user **was last in**, and the first time (or
after they leave that org) to the **most recently joined** one:

- A deliberate change of a session's active org, from the switcher below,
  accepting an invitation or creating an org, is recorded on the user as
  `lastActiveOrganizationId` (`databaseHooks.session.update.after`, keyed on
  the endpoint). A user who signs out in one org signs back in to it. Other
  session updates, such as the daily refresh, are not recorded, so a second
  device's session never overwrites the choice. Recording is best effort: a
  failure is logged and never fails the request. The field is a Better Auth
  `user.additionalFields` entry with `input: false` and `returned: false`, so no
  request can set it and no response carries it; it is nullable, so the boot
  migration adds the column with no backfill.
- An invitee lands in the team they accepted, not the personal org the
  Factory created on their first visit.
- The team page switches between them (samskara-cai). A user in two or more
  orgs sees **Your organizations** there, listed with Better Auth's
  `GET /organization/list`; **Switch** calls `POST /organization/set-active`,
  which checks membership and updates the session, then opens the Factory in
  that org. The Factory reads `session.activeOrganizationId` on each request
  (`@mastra/auth-better-auth` 1.1.5 `dist/index.js:819-828`; the oldest
  membership is only the fallback when it is unset, `:541-575`), and the
  session update clears Samskara's session cache through the
  `databaseHooks.session.update` hook before set-active returns. The next
  sign-in opens in the org switched to.

## Invitation links

The link in the email is built from `MASTRACODE_PUBLIC_URL`. When that is not
set, the link points at `http://localhost:$PORT`, and never at the request's
`Host` header. The inviter controls that header, so a link built from it could
point a Samskara email at any site.

Invitation email needs a mail transport. See [mail.md](mail.md). Without one,
the invitation is still created and shows as pending on the team page, but
nobody is notified.

## Where the code lives

- `src/mastra/team/routes.ts` — both pages. The server resolves the viewer
  with the Factory's `createFactoryRouteAuth`. The browser calls
  `/auth/api/organization/*` directly.
- `src/mastra/team/paths.ts` — the URLs, shared with the email.
- `src/mastra/auth/better-auth.ts` — the session hook and the invitation email.

The pages are under `/web/` because the Factory's SPA middleware returns its own
`index.html` for every HTML request outside `/api`, `/web`, `/auth` and
`/connect` (`@mastra/factory` `dist/spa-static.js`).
