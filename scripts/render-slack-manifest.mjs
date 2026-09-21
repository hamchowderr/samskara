#!/usr/bin/env node
/**
 * Render the Slack app manifest with this deployment's public URL.
 *
 *   node scripts/render-slack-manifest.mjs              # writes slack-app-manifest.json
 *   node scripts/render-slack-manifest.mjs --stdout     # prints instead
 *   node scripts/render-slack-manifest.mjs --url https://example.com
 *
 * The URL comes from --url, then MASTRACODE_CHANNELS_PUBLIC_URL, then
 * MASTRACODE_PUBLIC_URL. Slack requires HTTPS, so a localhost URL is rejected
 * here rather than failing later as an unverifiable request URL.
 *
 * The rendered file is gitignored: it holds one deployment's hostname, and
 * committing it is how the previous copy ended up pointing at a dead tunnel.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, 'slack-app-manifest.template.json');
const outputPath = join(here, 'slack-app-manifest.json');

const args = process.argv.slice(2);
const toStdout = args.includes('--stdout');
const urlFlag = args.indexOf('--url');

if (urlFlag !== -1 && !args[urlFlag + 1]) {
  console.error('--url needs a value');
  process.exit(1);
}

// dotenv is optional — the URL may come from the environment or the flag.
if (urlFlag === -1) {
  try {
    const { config } = await import('dotenv');
    config({ path: join(here, '..', '.env'), quiet: true });
  } catch {
    // not installed, or no .env; fall through to the checks below
  }
}

const publicUrl = (
  urlFlag !== -1
    ? args[urlFlag + 1]
    : process.env.MASTRACODE_CHANNELS_PUBLIC_URL || process.env.MASTRACODE_PUBLIC_URL
)?.trim().replace(/\/+$/, '');

if (!publicUrl) {
  console.error(
    'No public URL. Pass --url, or set MASTRACODE_CHANNELS_PUBLIC_URL or\n' +
      'MASTRACODE_PUBLIC_URL in .env. See docs/setup/tunnel.md.',
  );
  process.exit(1);
}

if (!publicUrl.startsWith('https://')) {
  console.error(
    `Slack requires HTTPS; got ${publicUrl}\n` +
      'Start a tunnel and use its address — see docs/setup/tunnel.md.',
  );
  process.exit(1);
}

if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(publicUrl)) {
  console.error(`Slack cannot reach ${publicUrl} — it must be a public address.`);
  process.exit(1);
}

const template = readFileSync(templatePath, 'utf8');
const rendered = template.replaceAll('{{PUBLIC_URL}}', publicUrl);

if (rendered.includes('{{')) {
  console.error('Template still contains an unreplaced placeholder; not writing.');
  process.exit(1);
}

// Drop the template-only comment key so the manifest Slack sees is clean.
const manifest = JSON.parse(rendered);
delete manifest._comment;
const json = `${JSON.stringify(manifest, null, 2)}\n`;

// Slack pre-fills the create-app form from a manifest passed in the query
// string, so the human clicks through instead of pasting JSON.
const createUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

if (toStdout) {
  process.stdout.write(json);
} else {
  writeFileSync(outputPath, json);
  console.log(`Wrote ${outputPath}`);
  console.log(`Public URL: ${publicUrl}`);
  console.log('');
  console.log('Open this link and click through — the manifest is already filled in:');
  console.log('');
  console.log(createUrl);
  console.log('');
  console.log('If the link is too long for your terminal or browser, use');
  console.log('"Create New App -> From a manifest" and paste the file above instead.');
}
