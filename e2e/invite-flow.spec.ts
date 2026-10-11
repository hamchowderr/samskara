/**
 * The team invite flow in a real browser against the real server
 * (samskara-9t9, samskara-cuf).
 *
 * Owner signs up from the team page, invites a teammate and creates a
 * project. The invitee opens the invitation link signed out, signs up,
 * accepts, and lands in the owner's org with the owner's project. Signing in
 * again later still lands them there.
 */
import { expect, test, type Page } from '@playwright/test';

const run = Date.now();
const owner = { name: 'Owner', email: `owner-${run}@example.test` };
const mate = { name: 'Mate', email: `mate-${run}@example.test` };
const PASSWORD = 'Passw0rd!long-enough';

/** On /signin: switch to sign-up and create the account. */
async function signUpOnSigninPage(page: Page, who: { name: string; email: string }) {
  await expect(page).toHaveURL(/\/signin\?returnTo=/);
  await page.getByRole('button', { name: /sign up/i }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(who.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(who.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function me(page: Page): Promise<{ email: string; organizationId: string }> {
  return page.evaluate(async () => ((await (await fetch('/auth/me')).json()) as { user: { email: string; organizationId: string } }).user);
}

test('owner invites a teammate who joins the same org and sees its projects', async ({ browser }) => {
  // --- Owner ---
  const ownerPage = await (await browser.newContext()).newPage();
  await ownerPage.goto('/web/samskara/team');
  await signUpOnSigninPage(ownerPage, owner);

  await expect(ownerPage).toHaveURL(/\/web\/samskara\/team$/);
  await expect(ownerPage.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();
  const ownerOrg = (await me(ownerPage)).organizationId;
  expect(ownerOrg).toBeTruthy();

  // --- Rename the organization (samskara-tdx) ---
  // Sign-up names it "<email>'s org"; that name is what invitees see.
  const orgName = ownerPage.getByRole('textbox', { name: 'Organization name' });
  await expect(orgName).toHaveValue(`${owner.email}'s org`);
  const companyName = `Owner Co ${run}`;
  await orgName.fill(companyName);
  await ownerPage.getByRole('button', { name: 'Save name' }).click();
  await expect(ownerPage.getByText(`Organization renamed to ${companyName}.`)).toBeVisible();
  await ownerPage.reload();
  await expect(orgName).toHaveValue(companyName);

  await ownerPage.getByRole('textbox', { name: 'Email address' }).fill(mate.email);
  await ownerPage.getByRole('button', { name: 'Send invite' }).click();
  await expect(ownerPage.getByText(`Invitation sent to ${mate.email}.`)).toBeVisible();
  await expect(ownerPage.locator('#invitations')).toContainText(mate.email);

  const invitationId = await ownerPage.evaluate(
    async ({ org, email }) => {
      const list = (await (await fetch(`/auth/api/organization/list-invitations?organizationId=${org}`)).json()) as Array<{
        id: string;
        email: string;
        status: string;
      }>;
      const pending = list.find(i => i.email === email && i.status === 'pending');
      if (!pending) throw new Error(`no pending invitation for ${email}`);
      return pending.id;
    },
    { org: ownerOrg, email: mate.email },
  );

  const projectName = `E2E shared project ${run}`;
  await ownerPage.evaluate(async name => {
    const res = await fetch('/web/factory/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`create project ${res.status}`);
  }, projectName);

  // --- The sidebar links to the team page (samskara-ht9) ---
  // Inserted into the Factory SPA by scripts/build-branded-ui.mjs.
  await ownerPage.goto('/');
  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/web\/samskara\/team$/);

  // --- Invitee, signed out, from the email link ---
  const mateContext = await browser.newContext();
  const matePage = await mateContext.newPage();
  await matePage.goto(`/web/samskara/invitations/${invitationId}`);
  await signUpOnSigninPage(matePage, mate);

  await expect(matePage).toHaveURL(new RegExp(`/web/samskara/invitations/${invitationId}$`));
  await expect(matePage.locator('#summary')).toContainText(`${owner.email} invited you to join ${companyName}`);
  await matePage.getByRole('button', { name: 'Accept and open Samskara' }).click();
  await expect(matePage).not.toHaveURL(/\/web\/samskara\/invitations\//);

  expect((await me(matePage)).organizationId).toBe(ownerOrg);
  const projects = await matePage.evaluate(
    async () => ((await (await fetch('/web/factory/projects')).json()) as { projects: Array<{ name: string }> }).projects,
  );
  expect(projects.map(p => p.name)).toContain(projectName);

  // --- Invitee signs in again: a new session must still land in the team ---
  await mateContext.close();
  const againPage = await (await browser.newContext()).newPage();
  await againPage.goto('/web/samskara/team');
  await expect(againPage).toHaveURL(/\/signin\?returnTo=/);
  await againPage.getByRole('textbox', { name: 'Email' }).fill(mate.email);
  await againPage.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await againPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(againPage).toHaveURL(/\/web\/samskara\/team$/);
  expect((await me(againPage)).organizationId).toBe(ownerOrg);

  // --- The org switcher (samskara-cai) ---
  // The invitee belongs to two orgs: the personal one the Factory made on their
  // first visit, and the owner's. The team page lists both and switches.
  const orgRows = againPage.locator('#orgs .row');
  await expect(againPage.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
  await expect(orgRows).toHaveCount(2);
  await expect(orgRows.filter({ hasText: companyName })).toContainText('current');
  await orgRows.filter({ hasNotText: companyName }).getByRole('button', { name: 'Switch' }).click();
  await expect(againPage).not.toHaveURL(/\/web\/samskara\/team/);
  const personalOrg = (await me(againPage)).organizationId;
  expect(personalOrg).toBeTruthy();
  expect(personalOrg).not.toBe(ownerOrg);
  await againPage.goto('/web/samskara/team');
  await orgRows.filter({ hasText: companyName }).getByRole('button', { name: 'Switch' }).click();
  await expect(againPage).not.toHaveURL(/\/web\/samskara\/team/);
  expect((await me(againPage)).organizationId).toBe(ownerOrg);
  await againPage.goto('/web/samskara/team');
  // The owner is in one org: no switcher.
  await ownerPage.goto('/web/samskara/team');
  await expect(ownerPage.locator('#members')).toContainText(owner.email);
  await expect(ownerPage.getByRole('heading', { name: 'Your organizations' })).toBeHidden();

  // A member sees the team but not the invite form.
  await expect(againPage.getByText('Only an owner or admin can invite teammates.')).toBeVisible();
  await expect(againPage.getByRole('button', { name: 'Send invite' })).toBeHidden();
  // ...and the organization's name, but cannot change it.
  await expect(againPage.getByRole('textbox', { name: 'Organization name' })).toHaveValue(companyName);
  await expect(againPage.getByRole('textbox', { name: 'Organization name' })).not.toBeEditable();
  await expect(againPage.getByRole('button', { name: 'Save name' })).toBeHidden();

  // --- An expired invitation is not shown as open (samskara-eem) ---
  // Better Auth leaves it at status 'pending'; only expiresAt says it is dead.
  // The page compares that with the browser clock, so moving the clock past
  // the 48-hour expiry is enough to exercise it.
  const lapsed = `lapsed-${run}@example.test`;
  await ownerPage.goto('/web/samskara/team');
  await ownerPage.getByRole('textbox', { name: 'Email address' }).fill(lapsed);
  await ownerPage.getByRole('button', { name: 'Send invite' }).click();
  await expect(ownerPage.getByText(`Invitation sent to ${lapsed}.`)).toBeVisible();
  const liveRow = ownerPage.locator('#invitations .row', { hasText: lapsed });
  await expect(liveRow).toContainText('expires');
  await expect(liveRow.getByRole('button', { name: 'Cancel' })).toBeVisible();

  await ownerPage.clock.install({ time: Date.now() + 49 * 3600_000 });
  await ownerPage.reload();
  const lapsedRow = ownerPage.locator('#invitations .row', { hasText: lapsed });
  await expect(lapsedRow).toContainText('expired');
  await expect(lapsedRow.getByRole('button', { name: 'Resend' })).toBeVisible();
  await lapsedRow.getByRole('button', { name: 'Dismiss' }).click();
  await expect(ownerPage.getByText('Invitation dismissed.')).toBeVisible();
  await expect(ownerPage.locator('#invitations')).not.toContainText(lapsed);
});
