/**
 * Produce a white-labelled copy of the Factory SPA.
 *
 * WHY. Samskara's premise is clients submitting work through chat, so clients
 * reach the sign-in screen. The SPA the Mastra CLI ships is the one served
 * there, and it carries Mastra's tab title, favicon and PWA identity. That is
 * the first thing a paying client sees.
 *
 * WHAT IS ACTUALLY BRANDED — measured against the running sign-in screen with
 * a browser, not guessed from the bundle:
 *   - document.title            "Mastra Factory"      (set by JS, see below)
 *   - <link rel=icon>           /mastra.svg
 *   - <link rel=apple-touch-icon> /apple-touch-icon.png
 *   - manifest.webmanifest      name / short_name / description
 *   - /pwa-192.png, /pwa-512.png  PWA icons, also shown in the install prompt
 * The VISIBLE COPY is already generic — "Build with an agent factory",
 * "Welcome back", "Email / Password / Sign in". There is no Mastra wordmark or
 * logo element on that screen (`document.querySelectorAll('svg[aria-label]')`
 * returns none). So this does not need the SPA source vendored and rebuilt;
 * replacing assets and one string is enough.
 *
 * THE TITLE CANNOT BE FIXED IN index.html ALONE. The SPA assigns
 * `document.title` on mount from a bundled constant (`const HR="Mastra
 * Factory"`), so a patched <title> is overwritten the moment the app hydrates.
 * That constant appears EXACTLY ONCE in the 3.9 MB bundle, which is what makes
 * a string replacement safe — and the count is asserted below, so a future
 * bundle that changes shape fails the build instead of silently shipping
 * Mastra's name.
 *
 * WHY REGENERATE INSTEAD OF COMMITTING A PATCHED COPY. A committed copy goes
 * stale on every `mastra` upgrade and silently reverts to an old UI. This runs
 * from the installed package each time, so an upgrade is picked up
 * automatically and a bundle that no longer matches fails loudly.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', 'mastra', 'dist', 'factory');
/**
 * Outside `src/mastra/`, deliberately. The obvious home is
 * `src/mastra/public/factory` (resolution candidate 4/5 in
 * @mastra/factory/dist/spa-static.js:56-64, found with no env var), but that
 * path sits inside the dev server's watch tree: writing 4 MB there makes
 * `mastra dev` re-bundle and restart every time this script runs, which is a
 * ~6 minute round trip. MASTRACODE_UI_DIST (pinned below) reaches this
 * location just as well and the watcher ignores it.
 */
const DEST = join(ROOT, '.branded-ui');
/** Drop real brand files here to override the placeholders. */
const BRAND_DIR = join(ROOT, 'brand');

const BRAND = {
  name: 'Samskara',
  short: 'Samskara',
  description: 'Agent-driven software delivery.',
  /** The string the SPA bundles as its document.title base. */
  replacesTitle: 'Mastra Factory',
};

/** Icon files the SPA references, each replaceable from brand/. */
/**
 * The icon files to replace, and they KEEP UPSTREAM'S FILENAMES on purpose.
 *
 * The pre-auth allow-list in @mastra/factory/dist/auth.js:537 is hardcoded to
 * these exact paths:
 *   /signin, /assets/*, /manifest.webmanifest, /mastra.svg, /pwa-192.png,
 *   /pwa-512.png, /apple-touch-icon.png
 * Anything else 401s for a signed-out visitor. Renaming `mastra.svg` to
 * `favicon.svg` therefore breaks the favicon on the one screen this whole
 * script exists to fix (measured: /favicon.svg -> 401, /mastra.svg -> 200).
 * The filename is visible only in devtools; the rendered icon is ours.
 */
const ICONS = ['mastra.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png'];

if (!existsSync(join(SRC, 'index.html'))) {
  console.error(`[brand-ui] No Factory SPA at ${SRC}. Run npm install first.`);
  process.exit(1);
}

// Start from the installed SPA every time, so an upgrade cannot leave a stale
// build behind.
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const changes = [];

// --- index.html: title and icon hrefs -------------------------------------
const indexPath = join(DEST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const beforeHtml = html;
html = html.replace(/<title>[^<]*<\/title>/, `<title>${BRAND.name}</title>`);
if (html !== beforeHtml) changes.push('index.html <title>');
writeFileSync(indexPath, html);

// --- manifest: PWA identity ------------------------------------------------
const manifestPath = join(DEST, 'manifest.webmanifest');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = BRAND.name;
  manifest.short_name = BRAND.short;
  manifest.description = BRAND.description;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  changes.push('manifest.webmanifest name/short_name/description');
}

// --- the JS bundle: the runtime document.title ----------------------------
// Asserted, not hoped for. If the constant stops appearing exactly once the
// bundle has changed shape and this needs re-deriving — fail rather than ship
// Mastra's name in a client's browser tab.
const assetsDir = join(DEST, 'assets');
const bundles = readdirSync(assetsDir).filter(f => f.endsWith('.js'));
const needle = `"${BRAND.replacesTitle}"`;
let totalHits = 0;
for (const file of bundles) {
  const p = join(assetsDir, file);
  const js = readFileSync(p, 'utf8');
  const hits = js.split(needle).length - 1;
  if (!hits) continue;
  totalHits += hits;
  writeFileSync(p, js.split(needle).join(`"${BRAND.name}"`));
  changes.push(`assets/${file} document.title constant (${hits}x)`);
}
if (totalHits !== 1) {
  console.error(
    `[brand-ui] Expected exactly 1 occurrence of ${needle} across the JS bundles, found ${totalHits}.\n` +
      '           The SPA bundle changed shape. Re-check how document.title is set before trusting this script:\n' +
      "             grep -o '.\\{60\\}Mastra Factory.\\{60\\}' src/mastra/public/factory/assets/*.js\n" +
      '           See docs/operations/white-label-ui.md.',
  );
  process.exit(1);
}

// --- icons: real brand files when present, neutral placeholder otherwise ---
const supplied = [];
const placeholders = [];
for (const icon of ICONS) {
  const override = join(BRAND_DIR, icon);
  if (existsSync(override)) {
    cpSync(override, join(DEST, icon));
    supplied.push(icon);
  } else if (icon.endsWith('.svg')) {
    // A plain monogram, so the tab shows something neutral rather than
    // Mastra's mark. Deliberately not a designed identity — drop the real file
    // in brand/ and this is replaced.
    writeFileSync(
      join(DEST, icon),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="' +
        BRAND.name +
        '">' +
        '<rect width="64" height="64" rx="14" fill="#0f0f0f"/>' +
        '<text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" ' +
        'font-size="34" font-weight="600" fill="#f5f5f5">' +
        BRAND.name.slice(0, 1).toUpperCase() +
        '</text></svg>\n',
    );
    placeholders.push(icon);
  } else {
    // A raster placeholder is not something to invent — leave Mastra's file
    // out entirely so it 404s visibly rather than showing their logo.
    rmSync(join(DEST, icon), { force: true });
    placeholders.push(`${icon} (removed — supply one in brand/)`);
  }
}

// `mastra factory dev` sets MASTRACODE_UI_DIST to its OWN copy unless the var
// is already present (mastra/dist/index.js:4496), which would silently win
// over everything above. Pin it to this build. .env.local is gitignored and
// loaded after .env, and the path is absolute because the dev server's cwd is
// the Mastra public dir, not the repo root.
const ENV_LOCAL = join(ROOT, '.env.local');
const marker = 'MASTRACODE_UI_DIST=';
const existing = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, 'utf8') : '';
const line = `${marker}${DEST.replace(/\\/g, '/')}`;
if (existing.includes(marker)) {
  writeFileSync(ENV_LOCAL, existing.replace(new RegExp(`^${marker}.*$`, 'm'), line));
} else {
  const sep = !existing || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(ENV_LOCAL, `${existing}${sep}\n# Pinned by scripts/build-branded-ui.mjs\n${line}\n`);
}

console.log(`[brand-ui] built ${DEST}`);
console.log(`  pinned   MASTRACODE_UI_DIST in .env.local`);
for (const c of changes) console.log(`  patched  ${c}`);
if (supplied.length) console.log(`  brand/   ${supplied.join(', ')}`);
if (placeholders.length) console.log(`  PLACEHOLDER  ${placeholders.join(', ')}`);
if (placeholders.length) {
  console.log('[brand-ui] Supply real icons in brand/ before a client sees this. See docs/operations/white-label-ui.md.');
}
