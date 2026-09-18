/**
 * Create the self-hosted GitHub App for Samskara via GitHub's manifest flow.
 *
 * GitHub has no "create app" API endpoint, but the manifest flow is scriptable
 * except for one approval screen:
 *
 *   1. POST a manifest to https://github.com/settings/apps/new  (form POST — a
 *      plain fetch will not do; GitHub renders a confirmation page)
 *   2. You approve on that screen
 *   3. GitHub redirects back here with a temporary ?code=
 *   4. POST /app-manifests/<code>/conversions returns id, slug, client_id,
 *      client_secret and pem in one call
 *
 * All three steps must complete within one hour.
 *
 * Credentials are written straight into .env. They are never printed, and never
 * pass through the conversation — the script reports names and lengths only.
 *
 * Usage:  node scripts/create-github-app.mjs [--org <login>] [--name <name>]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(REPO, '.env');
const PORT = 4321;
const BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
};
const ORG = argOf('--org');
const APP_NAME = argOf('--name') ?? 'Samskara Factory';

// The running Factory's public origin — where the OAuth callback lands. Must
// match MASTRACODE_PUBLIC_URL; the setup server on PORT is a separate thing.
const FACTORY_URL = argOf('--factory-url') ?? process.env.MASTRACODE_PUBLIC_URL ?? 'http://localhost:4111';

/**
 * The manifest. Two deliberate omissions for local development:
 *
 * `hook_attributes` — GitHub rejects a manifest whose webhook url is localhost
 *   ("Hook url is not supported because it isn't reachable over the public
 *   Internet"). Omitting it also omits the webhook entirely, which matches
 *   Mastra's own instruction to clear Webhook → Active for local work.
 * `default_events` — meaningless without a webhook, and rejected alongside it.
 *
 * Permissions are exactly what Mastra's self-hosted docs call for.
 */
const manifest = {
  name: APP_NAME,
  // The app's homepage — the running Factory, NOT this throwaway setup server.
  url: FACTORY_URL,
  // Where GitHub sends the ONE-TIME app-creation code (this setup server).
  redirect_url: `${BASE}/callback`,
  // The app's ONGOING OAuth callback — a DIFFERENT field, and easy to miss.
  // Without it GitHub refuses the connect flow with "This GitHub App must be
  // configured with a callback URL". The factory derives it as
  // publicUrl + /auth/github/callback (integrations/github/routes.js:308), so
  // it must match MASTRACODE_PUBLIC_URL, not this setup server's port.
  callback_urls: [`${FACTORY_URL}/auth/github/callback`],
  // Where GitHub returns the user AFTER they install the app. Without it the
  // user is stranded on GitHub post-install and the installation is never
  // reported back, so source_control_installations stays empty and the board
  // never unlocks. The callback handles this case: with no ?code it re-runs
  // the OAuth identify, which then finds the installation and persists it.
  setup_url: `${FACTORY_URL}/auth/github/callback`,
  public: false,
  default_permissions: {
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    metadata: 'read',
  },
};

const createUrl = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new`
  : 'https://github.com/settings/apps/new';

function setEnvKeys(pairs) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  for (const [name, value] of Object.entries(pairs)) {
    const re = new RegExp('^' + name + '=.*$', 'm');
    // Multi-line values (the PEM) must be quoted to survive dotenv parsing.
    const encoded = String(value).includes('\n') ? JSON.stringify(String(value)) : String(value);
    if (re.test(env)) env = env.replace(re, `${name}=${encoded}`);
    else env = env.replace(/\s*$/, '') + `\n${name}=${encoded}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>Samskara — GitHub App</title>` +
  `<style>body{font:15px/1.6 system-ui;background:#0f0f0f;color:#e4e4e7;display:grid;place-items:center;min-height:100vh;margin:0}` +
  `main{max-width:34rem;padding:2rem}code{background:#1c1c1f;padding:.15em .4em;border-radius:4px}` +
  `h1{font-size:1.25rem}.ok{color:#4ade80}.err{color:#f87171}</style><main>${body}</main>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);

  if (url.pathname === '/') {
    // GitHub requires a real form POST here, so the page self-submits.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page(
        `<h1>Creating “${APP_NAME}”${ORG ? ` under <code>${ORG}</code>` : ''}…</h1>` +
          `<p>Redirecting to GitHub. Review the app on GitHub's screen and click <b>Create GitHub App</b>.</p>` +
          `<form id="f" method="post" action="${createUrl}">` +
          `<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&apos;')}'>` +
          `<noscript><button type="submit">Continue to GitHub</button></noscript></form>` +
          `<script>document.getElementById('f').submit()</script>`,
      ),
    );
    return;
  }

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end(page(`<h1 class="err">No code returned</h1><p>GitHub redirected without a <code>code</code>.</p>`));
      return;
    }

    try {
      const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'samskara-setup' },
      });
      if (!resp.ok) throw new Error(`conversion failed: ${resp.status} ${await resp.text()}`);
      const app = await resp.json();

      // webhook_secret comes back empty when no webhook is declared, but the
      // generated entry uses GITHUB_APP_WEBHOOK_SECRET as the OAuth `state`
      // signer — without one, stateSecretConfigured stays false and the
      // GitHub connect flow cannot sign its state. So mint one.
      const webhookSecret = app.webhook_secret || crypto.randomBytes(32).toString('hex');

      setEnvKeys({
        GITHUB_APP_ID: app.id,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_PRIVATE_KEY: app.pem,
        GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
      });

      // Names and shapes only — never values.
      console.log('\nWrote to .env (values not shown):');
      for (const [k, v] of Object.entries({
        GITHUB_APP_ID: app.id,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_PRIVATE_KEY: app.pem,
        GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
      })) {
        const s = String(v);
        const shape = k === 'GITHUB_APP_ID' || k === 'GITHUB_APP_SLUG' ? s : `set (${s.length} chars)`;
        console.log(`  ${k.padEnd(28)} ${shape}`);
      }
      console.log(`\nApp page: ${app.html_url}`);
      console.log('Next: restart the dev server, then Connect GitHub in the UI.\n');

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        page(
          `<h1 class="ok">GitHub App created</h1>` +
            `<p>All five <code>GITHUB_APP_*</code> variables plus a generated ` +
            `<code>GITHUB_APP_WEBHOOK_SECRET</code> were written to <code>.env</code>.</p>` +
            `<p>Restart the dev server, then use <b>Connect GitHub</b> in the Factory UI — ` +
            `not the Install button on GitHub.</p><p>You can close this tab.</p>`,
        ),
      );
      setTimeout(() => server.close(() => process.exit(0)), 500);
    } catch (err) {
      console.error('\nConversion failed:', err.message, '\n');
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end(page(`<h1 class="err">Conversion failed</h1><pre>${String(err.message)}</pre>`));
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`\nApp name : ${APP_NAME}`);
  console.log(`Owner    : ${ORG ?? 'your personal account (set ORG for an organization)'}`);
  console.log(`Perms    : contents:write, issues:write, pull_requests:write, metadata:read`);
  console.log(`Webhook  : omitted (localhost is rejected by the manifest endpoint)`);
  console.log(`Callback : ${FACTORY_URL}/auth/github/callback`);
  console.log(`\nOpen ${BASE} to start. Waiting for the approval redirect…\n`);
});
