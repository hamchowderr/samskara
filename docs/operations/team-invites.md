# Team invites

A client organization is one org with invited members. There are no sub-teams.

## The pages

| Page | Who uses it |
|---|---|
| `/web/samskara/team` | Everyone in the org. Owners and admins also see the invite form, role controls and pending invitations. |
| `/web/samskara/invitations/<id>` | The invitee. The invitation email links here. |

A signed-out visitor to either page goes to `/signin` and returns to the page
after signing in or signing up. The Factory UI has no link to the team page.
Give owners the URL directly.

## Roles

Better Auth enforces the roles. The pages only hide controls:

- **owner** can invite, change any role (including granting owner) and remove members.
- **admin** can invite and manage members, but cannot grant or change owner.
- **member** can view the team. Invite and role changes return 403.

An invitation expires after 48 hours (Better Auth's default). Only the address
it was sent to can open or accept it.

## Which org a user signs in to

The Factory reads the org from the session's `activeOrganizationId`. Better
Auth never sets it at sign-in, and the provider then uses the user's **oldest**
membership. That is wrong for an invitee. The Factory creates a personal org
for them on their first visit, so that org is always older than the team they
join.

`databaseHooks.session.create.before` in `src/mastra/auth/better-auth.ts` sets
each new session to the **most recently joined** org. Two consequences:

- The personal org created for an invitee stays in the database, unused.
- A user in more than one org always lands in the newest one. There is no org
  switcher.

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
