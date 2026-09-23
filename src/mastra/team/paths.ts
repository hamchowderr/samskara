/**
 * URLs for Samskara's team pages. Shared with the invitation email so the link
 * it sends and the route that answers it cannot drift apart.
 *
 * Both live under `/web/`. The Factory's SPA middleware answers every HTML
 * request outside `/api`, `/web`, `/auth` and `/connect` with its own
 * index.html (@mastra/factory dist/spa-static.js SERVER_PREFIXES), so a page
 * anywhere else would never reach its route. `/web/` is also covered by the
 * Factory auth gate, which redirects a signed-out visitor to
 * `/signin?returnTo=…` and brings them back after sign-in or sign-up.
 */
export const TEAM_PATH = '/web/samskara/team';
export const INVITATION_ROUTE = '/web/samskara/invitations/:invitationId';

export function invitationPath(invitationId: string): string {
  return `/web/samskara/invitations/${encodeURIComponent(invitationId)}`;
}
