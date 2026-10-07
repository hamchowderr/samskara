/**
 * Team pages: invite teammates into the org, and accept an invitation.
 *
 * WHY THESE EXIST. Better Auth's organization plugin already provides every
 * endpoint (invite-member, accept-invitation, list-members, update-member-role,
 * remove-member, cancel-invitation) under /auth/api/organization/*, and
 * enforces roles there: only an owner or admin may invite, and only an owner
 * may grant owner. The Factory SPA ships no screen that calls them, and the SPA
 * is a prebuilt bundle, so these two pages are Samskara's own.
 *
 * They are thin by design. The server renders a shell carrying the viewer's
 * org and user id; the browser calls Better Auth directly with the session
 * cookie. No authorization decision is made here — a page control hidden from
 * a member is a convenience, and the endpoint still refuses them.
 *
 * The viewer is resolved with the Factory's own `createFactoryRouteAuth`,
 * exactly as its routes do (`requiresAuth: false`, then `ensureUser`). Do not
 * read `requestContext.get('user')` instead: Mastra's core auth middleware runs
 * after the Factory gate and overwrites it with the provider's raw result, and
 * the gate's personal-org bootstrap did not run for these routes when tested.
 * `ensureUser` both normalises the user and bootstraps a missing org.
 */
import { registerApiRoute } from '@mastra/core/server';
import type { createFactoryRouteAuth } from '@mastra/factory';

import { escapeHtml } from '../auth/mailer';
import { INVITATION_ROUTE, TEAM_PATH } from './paths';

type RouteAuth = ReturnType<typeof createFactoryRouteAuth>;
// The Factory is typed against its own copy of Hono, Mastra core against
// another; at runtime they are the same request context object.
type Context = Parameters<RouteAuth['ensureUser']>[0];
const asContext = (c: unknown) => c as Context;

interface Viewer {
  userId: string;
  email?: string;
  organizationId?: string;
}

async function resolveViewer(routeAuth: RouteAuth, c: Context): Promise<Viewer | undefined> {
  if (!routeAuth.enabled()) return undefined;
  const user = (await routeAuth.ensureUser(c)) as { email?: unknown } | undefined;
  const tenant = routeAuth.tenant(c);
  if (!user || !tenant) return undefined;
  return {
    userId: tenant.userId,
    organizationId: tenant.orgId,
    email: typeof user.email === 'string' ? user.email : undefined,
  };
}

/** Send a signed-out browser to sign-in, returning here afterwards. */
function toSignIn(c: Context) {
  const url = new URL(c.req.url);
  return c.redirect(`/signin?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
}

/** JSON safe to place inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#0b0b0c; --panel:#141416; --line:#26262a; --text:#ececef; --muted:#9a9aa3; --accent:#ececef; --danger:#f87171; }
  @media (prefers-color-scheme: light) { :root { --bg:#fafafa; --panel:#fff; --line:#e4e4e7; --text:#18181b; --muted:#71717a; --accent:#18181b; --danger:#b91c1c; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:720px; margin:0 auto; padding:40px 16px 64px; }
  a { color:inherit; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:14px; margin:32px 0 8px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
  .row { display:flex; gap:12px; align-items:center; padding:12px 16px; border-top:1px solid var(--line); flex-wrap:wrap; }
  .row:first-child { border-top:0; }
  .grow { flex:1 1 200px; min-width:0; overflow-wrap:anywhere; }
  .muted { color:var(--muted); }
  .danger-text { color:var(--danger); }
  .empty { padding:16px; color:var(--muted); }
  form.invite { display:flex; gap:8px; flex-wrap:wrap; padding:16px; }
  input, select, button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; }
  input { flex:1 1 220px; min-width:0; }
  button { cursor:pointer; }
  button.primary { background:var(--accent); color:var(--bg); border-color:var(--accent); }
  button.danger { color:var(--danger); }
  button:disabled { opacity:.5; cursor:default; }
  .msg { min-height:20px; margin:12px 0 0; }
  .msg.error { color:var(--danger); }
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Samskara</title>
<link rel="icon" href="/mastra.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<script>${script}</script>
</body>
</html>`;
}

// Shared browser helpers: a JSON call to Better Auth that surfaces its error
// message, and element construction that never parses user data as HTML.
const CLIENT_HELPERS = `
async function api(path, body) {
  const res = await fetch('/auth/api/organization/' + path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || ('Request failed (' + res.status + ')'));
  return data;
}
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) if (child != null) node.append(child);
  return node;
}
function say(text, isError) {
  const msg = document.getElementById('msg');
  msg.textContent = text || '';
  msg.className = 'msg' + (isError ? ' error' : '');
}
`;

const TEAM_SCRIPT = `
const ROLES = ['member', 'admin', 'owner'];
async function load() {
  const [{ members }, invitations, org] = await Promise.all([
    api('list-members?organizationId=' + encodeURIComponent(CTX.organizationId)),
    api('list-invitations?organizationId=' + encodeURIComponent(CTX.organizationId)),
    api('get-full-organization?organizationId=' + encodeURIComponent(CTX.organizationId)),
  ]);
  const me = members.find(m => m.userId === CTX.userId);
  const myRole = me ? me.role : 'member';
  const canManage = myRole === 'owner' || myRole === 'admin';
  const grantable = myRole === 'owner' ? ROLES : ROLES.filter(r => r !== 'owner');

  // Better Auth's default roles let owner and admin update the organization
  // (access/statement.mjs); the endpoint enforces it, this only hides the
  // control. Leave the field alone while someone is typing in it.
  const orgName = document.getElementById('org-name');
  if (document.activeElement !== orgName) orgName.value = org.name;
  orgName.readOnly = !canManage;
  document.getElementById('org-save').hidden = !canManage;

  document.getElementById('invite-panel').hidden = !canManage;
  document.getElementById('invite-note').hidden = canManage;
  const roleSelect = document.getElementById('invite-role');
  roleSelect.replaceChildren(...grantable.map(r => el('option', { value: r, textContent: r })));

  const memberRows = members.map(m => {
    const self = m.userId === CTX.userId;
    const editable = canManage && !self && (myRole === 'owner' || m.role !== 'owner');
    const label = el('div', { className: 'grow' },
      el('div', { textContent: (m.user && (m.user.name || m.user.email)) || m.userId }),
      el('div', { className: 'muted', textContent: (m.user && m.user.email) || '' }));
    if (!editable) return el('div', { className: 'row' }, label, el('span', { className: 'muted', textContent: m.role + (self ? ' (you)' : '') }));
    const role = el('select', { ariaLabel: 'Role' }, ...grantable.map(r => el('option', { value: r, textContent: r, selected: r === m.role })));
    role.onchange = () => act(() => api('update-member-role', { memberId: m.id, role: role.value, organizationId: CTX.organizationId }), 'Role updated.');
    const remove = el('button', { className: 'danger', textContent: 'Remove' });
    remove.onclick = () => confirmThen(remove, () => act(() => api('remove-member', { memberIdOrEmail: m.id, organizationId: CTX.organizationId }), 'Member removed.'));
    return el('div', { className: 'row' }, label, role, remove);
  });
  document.getElementById('members').replaceChildren(...memberRows);

  // Better Auth never moves a lapsed invitation out of 'pending', and its own
  // lookups skip it by comparing expiresAt with now (adapter.mjs
  // findPendingInvitation). Do the same here, so a dead link is not shown as
  // an open one (samskara-eem).
  const now = Date.now();
  const memberEmails = new Set(members.map(m => m.user && m.user.email && m.user.email.toLowerCase()));
  const pending = invitations
    .filter(i => i.status === 'pending')
    .map(i => ({ ...i, expired: new Date(i.expiresAt).getTime() <= now, joined: memberEmails.has(i.email.toLowerCase()) }))
    .sort((a, b) => a.expired - b.expired || new Date(b.expiresAt) - new Date(a.expiresAt));
  const inviteRows = pending.map(i => {
    const when = new Date(i.expiresAt).toLocaleString();
    const status = i.joined ? 'already a member' : i.expired ? 'expired ' + when : 'expires ' + when;
    const row = el('div', { className: 'row' },
      el('div', { className: 'grow' }, el('div', { textContent: i.email }),
        el('div', { className: i.expired ? 'danger-text' : 'muted', textContent: i.role + ' · ' + status })));
    if (canManage) {
      if (!i.joined) {
        const resend = el('button', { textContent: 'Resend' });
        // A live invitation is resent in place with a fresh expiry. An expired
        // one cannot be: Better Auth's resend only finds unexpired rows, and
        // would create a second invitation beside it. So it is replaced.
        resend.onclick = () => act(async () => {
          if (i.expired) await api('cancel-invitation', { invitationId: i.id });
          await api('invite-member', { email: i.email, role: i.role, organizationId: CTX.organizationId, resend: !i.expired });
        }, 'Invitation resent to ' + i.email + '.');
        row.append(resend);
      }
      const cancel = el('button', { textContent: i.expired || i.joined ? 'Dismiss' : 'Cancel' });
      cancel.onclick = () => act(() => api('cancel-invitation', { invitationId: i.id }), i.expired || i.joined ? 'Invitation dismissed.' : 'Invitation cancelled.');
      row.append(cancel);
    }
    return row;
  });
  document.getElementById('invitations').replaceChildren(...(inviteRows.length ? inviteRows : [el('div', { className: 'empty', textContent: 'No pending invitations.' })]));
}
function confirmThen(button, fn) {
  if (button.dataset.armed) return fn();
  button.dataset.armed = '1';
  button.textContent = 'Confirm remove';
  setTimeout(() => { delete button.dataset.armed; button.textContent = 'Remove'; }, 4000);
}
async function act(fn, done) {
  say('');
  try { await fn(); say(done); } catch (e) { say(e.message, true); }
  try { await load(); } catch (e) { say(e.message, true); }
}
document.getElementById('invite-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  const email = form.email.value.trim();
  const button = form.querySelector('button');
  button.disabled = true;
  await act(() => api('invite-member', { email, role: form.role.value, organizationId: CTX.organizationId }), 'Invitation sent to ' + email + '.');
  button.disabled = false;
  form.email.value = '';
};
document.getElementById('org-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = document.getElementById('org-name');
  const name = input.value.trim();
  if (!name) return say('The organization needs a name.', true);
  const button = document.getElementById('org-save');
  button.disabled = true;
  input.blur();
  await act(() => api('update', { data: { name }, organizationId: CTX.organizationId }), 'Organization renamed to ' + name + '.');
  button.disabled = false;
};
load().catch(e => say(e.message, true));
`;

const INVITATION_SCRIPT = `
async function load() {
  let invitation;
  try {
    invitation = await api('get-invitation?id=' + encodeURIComponent(CTX.invitationId));
  } catch (e) {
    document.getElementById('summary').textContent =
      'This invitation cannot be opened while signed in as ' + (CTX.email || 'this account') +
      '. It may be for a different email address, already used, or expired.';
    say(e.message, true);
    document.getElementById('switch').hidden = false;
    return;
  }
  document.getElementById('summary').textContent =
    invitation.inviterEmail + ' invited you to join ' + invitation.organizationName + ' as ' + invitation.role + '.';
  document.getElementById('actions').hidden = false;
}
async function respond(path, done) {
  for (const b of document.querySelectorAll('#actions button')) b.disabled = true;
  try {
    await api(path, { invitationId: CTX.invitationId });
    if (done) return done();
    say('Invitation declined.');
  } catch (e) {
    say(e.message, true);
    for (const b of document.querySelectorAll('#actions button')) b.disabled = false;
  }
}
// Accepting also makes the invited org this session's active org, so the
// Factory opens straight into the team's projects.
document.getElementById('accept').onclick = () => respond('accept-invitation', () => window.location.assign('/'));
document.getElementById('decline').onclick = () => respond('reject-invitation');
load();
`;

const NOT_SIGNED_IN = page(
  'Team',
  '<h1>Team</h1><p class="sub">Sign-in is not enabled on this deployment, so there is no team to manage.</p>',
  '',
);

export const createTeamRoutes = (routeAuth: RouteAuth) => [
  registerApiRoute(TEAM_PATH, {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      if (!routeAuth.enabled()) return c.html(NOT_SIGNED_IN, 404);
      const viewer = await resolveViewer(routeAuth, asContext(c));
      if (!viewer) return toSignIn(asContext(c));
      if (!viewer.organizationId) {
        return c.html(page('Team', '<h1>Team</h1><p class="sub">Your account has no organization yet. Reload in a moment.</p>', ''), 503);
      }
      const body = `
<p class="muted"><a href="/">← Back to Samskara</a></p>
<h1>Team</h1>
<p class="sub">Everyone here sees the same projects and work.</p>
<h2>Organization</h2>
<div class="panel">
  <form class="invite" id="org-form">
    <input name="name" id="org-name" required maxlength="100" aria-label="Organization name" autocomplete="organization">
    <button type="submit" id="org-save" hidden>Save name</button>
  </form>
</div>
<h2>Invite a teammate</h2>
<div class="panel" id="invite-panel" hidden>
  <form class="invite" id="invite-form">
    <input name="email" type="email" required placeholder="name@company.com" aria-label="Email address" autocomplete="off">
    <select name="role" id="invite-role" aria-label="Role"></select>
    <button class="primary" type="submit">Send invite</button>
  </form>
</div>
<p class="muted" id="invite-note" hidden>Only an owner or admin can invite teammates.</p>
<p class="msg" id="msg" role="status"></p>
<h2>Members</h2>
<div class="panel" id="members"><div class="empty">Loading…</div></div>
<h2>Pending invitations</h2>
<div class="panel" id="invitations"><div class="empty">Loading…</div></div>`;
      const ctx = { userId: viewer.userId, organizationId: viewer.organizationId };
      return c.html(page('Team', body, `const CTX = ${scriptJson(ctx)};${CLIENT_HELPERS}${TEAM_SCRIPT}`));
    },
  }),

  registerApiRoute(INVITATION_ROUTE, {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      if (!routeAuth.enabled()) return c.html(NOT_SIGNED_IN, 404);
      const viewer = await resolveViewer(routeAuth, asContext(c));
      if (!viewer) return toSignIn(asContext(c));
      const body = `
<h1>Team invitation</h1>
<p class="sub" id="summary">Loading…</p>
<div id="actions" hidden>
  <button class="primary" id="accept" type="button">Accept and open Samskara</button>
  <button id="decline" type="button">Decline</button>
</div>
<p id="switch" hidden><a href="/auth/logout">Sign out and use a different account</a></p>
<p class="msg" id="msg" role="status"></p>`;
      const ctx = { invitationId: c.req.param('invitationId'), email: viewer.email };
      return c.html(page('Invitation', body, `const CTX = ${scriptJson(ctx)};${CLIENT_HELPERS}${INVITATION_SCRIPT}`));
    },
  }),
];
