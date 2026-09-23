/**
 * The invitation email, end to end through Better Auth's real invite endpoint.
 * Only the Resend HTTP call is mocked — that is the boundary.
 *
 * Guards two properties from samskara-9t9:
 * - the link is built from MASTRACODE_PUBLIC_URL, or localhost, and never
 *   from the request's Host header, which the inviter controls;
 * - the org and inviter names are escaped before they go into HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signUp, tempAuthDatabase, TEST_SECRET } from '../helpers/auth-db';

const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (mail: (typeof sent)[number]) => {
        sent.push(mail);
        return { data: { id: 'test' }, error: null };
      },
    };
  },
}));

let db: ReturnType<typeof tempAuthDatabase>;

interface OrgApi {
  createOrganization(input: { body: { name: string; slug: string }; headers: Headers }): Promise<unknown>;
  createInvitation(input: {
    body: { email: string; role: string; organizationId: string };
    headers: Headers;
  }): Promise<unknown>;
}

beforeEach(() => {
  sent.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // mailer.ts reads these at import, so set them before the dynamic import.
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('MAIL_FROM', 'Samskara <noreply@example.test>');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db?.cleanup();
});

async function inviteFrom(orgName: string, publicUrl: string | undefined, host: string) {
  const { buildBetterAuth } = await import('../../src/mastra/auth/better-auth');
  db = tempAuthDatabase();
  const auth = await buildBetterAuth({ secret: TEST_SECRET, database: db.database, publicUrl });
  const { headers } = await signUp(auth, 'owner@example.test');
  headers.set('host', host);

  // buildBetterAuth() returns the plain Auth type, which does not carry the
  // organization plugin's endpoints; they exist at runtime.
  const api = auth.api as unknown as OrgApi;
  const org = (await api.createOrganization({
    body: { name: orgName, slug: 'acme' },
    headers,
  })) as { id: string };
  const invitation = (await api.createInvitation({
    body: { email: 'mate@example.test', role: 'member', organizationId: org.id },
    headers,
  })) as { id: string };

  // Sends run detached (advanced.backgroundTasks), so wait for the mock.
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return { mail: sent[0]!, invitationId: invitation.id };
}

describe('invitation email (samskara-9t9)', () => {
  it('links to the public URL and the invitation page', async () => {
    const { mail, invitationId } = await inviteFrom('Acme', 'https://app.example.test', 'app.example.test');
    expect(mail.to).toBe('mate@example.test');
    expect(mail.text).toContain(`https://app.example.test/web/samskara/invitations/${invitationId}`);
  });

  it('never builds the link from the Host header', async () => {
    const { mail } = await inviteFrom('Acme', undefined, 'evil.example.test');
    expect(mail.text).not.toContain('evil.example.test');
    expect(mail.html).not.toContain('evil.example.test');
    expect(mail.text).toMatch(/http:\/\/localhost:\d+\/web\/samskara\/invitations\//);
  });

  it('escapes the org name in the HTML body', async () => {
    const { mail } = await inviteFrom('<img src=x onerror=alert(1)>', 'https://app.example.test', 'app.example.test');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
