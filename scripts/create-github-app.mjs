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
 * Credentials go to Infisical by default, or to .env with --env-file. They are
 * never printed and never pass through a command line — the script reports
 * names and lengths only, and writes via a mode-0600 temp file it then deletes.
 *
 * GitHub returns the private key exactly once, so a failed Infisical write
 * falls back to .env rather than losing it.
 *
 * Usage:
 *   node scripts/create-github-app.mjs [options]
 *
 *   --org <login>            create under an organization instead of your account
 *   --name <name>            app name (default: "Samskara Factory")
 *   --factory-url <url>      public origin of the running Factory
 *                            (default: $MASTRACODE_PUBLIC_URL, else localhost)
 *   --env-file               write credentials to .env instead of Infisical
 *   --infisical-path <path>  Infisical folder (default: /samskara)
 *   --infisical-env <env>    Infisical environment (default: dev)
 *
 * Start a tunnel and point --factory-url at it before running this: GitHub
 * rejects a manifest whose webhook is not publicly reachable, and without one
 * the app is created with no webhook and no events. See docs/setup/tunnel.md.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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
 * Whether GitHub will accept a webhook pointing at this origin. It rejects any
 * manifest whose webhook url is not reachable from the public internet ("Hook
 * url is not supported because it isn't reachable over the public Internet"),
 * which rules out localhost and any http:// origin.
 */
const WEBHOOK_CAPABLE =
  FACTORY_URL.startsWith('https://') && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(FACTORY_URL);

/**
 * Events the factory's webhook handler actually dispatches on
 * (@mastra/factory/dist/integrations/github/webhook.js). Anything else GitHub
 * delivers is accepted and ignored, so there is no reason to subscribe to it.
 */
const DEFAULT_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'status',
];

/**
 * The manifest.
 *
 * When FACTORY_URL is a public HTTPS origin, the webhook and its event
 * subscriptions are declared here and the app is complete the moment it is
 * created. GitHub generates the webhook secret and returns it in the
 * conversion response.
 *
 * When it is localhost, both are omitted because GitHub rejects the manifest
 * otherwise — and then the webhook and every event have to be set by hand in
 * the app's settings afterwards. Start a tunnel first and point
 * MASTRACODE_PUBLIC_URL at it to avoid that; see docs/setup/tunnel.md.
 *
 * `statuses: read` exists to make the `status` event selectable. GitHub only
 * offers an event when the matching permission is granted, so without it the
 * event cannot be subscribed to at all, in the manifest or in the UI.
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
    statuses: 'read',
  },
  ...(WEBHOOK_CAPABLE
    ? {
        hook_attributes: { url: `${FACTORY_URL}/web/github/webhook`, active: true },
        default_events: DEFAULT_EVENTS,
      }
    : {}),
};

const createUrl = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new`
  : 'https://github.com/settings/apps/new';

/**
 * Where the credentials land.
 *
 * Infisical is the default: these are long-lived secrets, and a repository is
 * the wrong place for them. `.env` remains available with `--env-file` for
 * anyone not using a secret manager.
 *
 * GitHub returns the private key EXACTLY ONCE. Whatever happens, this script
 * must not exit without storing it somewhere — so a failed Infisical write
 * falls back to `.env` and says so loudly rather than losing the key.
 */
const STORE = args.includes('--env-file') ? 'env' : 'infisical';
const INFISICAL_PATH = argOf('--infisical-path') ?? '/samskara';
const INFISICAL_ENV = argOf('--infisical-env') ?? 'dev';

/** Write secrets to Infisical without any value touching a command line. */
function setInfisicalKeys(pairs) {
  const tmp = path.join(os.tmpdir(), `samskara-gh-${crypto.randomBytes(8).toString('hex')}.env`);
  const body = Object.entries(pairs)
    .map(([k, v]) => {
      const s = String(v);
      return `${k}=${s.includes('\n') ? JSON.stringify(s) : s}`;
    })
    .join('\n');
  fs.writeFileSync(tmp, body + '\n', { mode: 0o600 });
  try {
    const r = spawnSync(
      'infisical',
      ['secrets', 'set', '--file', tmp, `--path=${INFISICAL_PATH}`, `--env=${INFISICAL_ENV}`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().slice(0, 300) || `exit ${r.status}`);
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

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

      const secrets = {
        GITHUB_APP_ID: app.id,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_CLIENT_ID: app.client_id,
        GITHUB_APP_CLIENT_SECRET: app.client_secret,
        GITHUB_APP_PRIVATE_KEY: app.pem,
        GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
      };

      // The private key is returned once. Store it or lose it.
      let storedIn;
      if (STORE === 'infisical') {
        try {
          setInfisicalKeys(secrets);
          storedIn = `Infisical ${INFISICAL_PATH} (${INFISICAL_ENV})`;
        } catch (err) {
          console.log(`\n!! Infisical write failed: ${err.message}`);
          console.log('!! Falling back to .env so the one-time private key is not lost.');
          console.log('!! Move these into your secret store and delete them from .env —');
          console.log('!! a value in .env shadows the one injected at runtime.');
          setEnvKeys(secrets);
          storedIn = `.env (Infisical FAILED)`;
        }
      } else {
        setEnvKeys(secrets);
        storedIn = '.env';
      }

      // Names and shapes only — never values.
      console.log(`\nStored in ${storedIn} (values not shown):`);
      for (const [k, v] of Object.entries(secrets)) {
        const s = String(v);
        const shape = k === 'GITHUB_APP_ID' || k === 'GITHUB_APP_SLUG' ? s : `set (${s.length} chars)`;
        console.log(`  ${k.padEnd(28)} ${shape}`);
      }
      if (STORE === 'infisical' && !storedIn.startsWith('.env')) {
        console.log('\nRun with secrets injected:  npm run dev:secure');
        console.log('Do NOT copy these into .env — an entry there shadows the injected value.');
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
  console.log(`Perms    : contents:write, issues:write, pull_requests:write, metadata:read, statuses:read`);
  if (WEBHOOK_CAPABLE) {
    console.log(`Webhook  : ${FACTORY_URL}/web/github/webhook (active)`);
    console.log(`Events   : ${DEFAULT_EVENTS.join(', ')}`);
  } else {
    console.log(`Webhook  : OMITTED — ${FACTORY_URL} is not publicly reachable over HTTPS.`);
    console.log(`           GitHub rejects a manifest with a webhook it cannot reach, so the`);
    console.log(`           app will receive NO events until you add the webhook URL, its`);
    console.log(`           secret and all ${DEFAULT_EVENTS.length} event subscriptions by hand.`);
    console.log(`           Start a tunnel and set MASTRACODE_PUBLIC_URL to it first —`);
    console.log(`           see docs/setup/tunnel.md.`);
  }
  console.log(`Callback : ${FACTORY_URL}/auth/github/callback`);
  console.log(
    `Secrets  : ${STORE === 'infisical' ? `Infisical ${INFISICAL_PATH} (${INFISICAL_ENV})` : '.env  [--env-file]'}`,
  );
  console.log(`\nOpen ${BASE} to start. Waiting for the approval redirect…\n`);
});
