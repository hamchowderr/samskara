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
// Same reason as the manifest: the apple-touch-icon PNG is Mastra's and is
// deleted, so drop the link rather than leave iOS fetching a 404. Safari falls
// back to the SVG favicon.
if (!existsSync(join(BRAND_DIR, 'apple-touch-icon.png'))) {
  html = html.replace(/\s*<link[^>]*rel="apple-touch-icon"[^>]*>/g, '');
}
if (html !== beforeHtml) changes.push('index.html <title> + dropped icon links that would 404');
writeFileSync(indexPath, html);

// --- manifest: PWA identity ------------------------------------------------
const manifestPath = join(DEST, 'manifest.webmanifest');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = BRAND.name;
  manifest.short_name = BRAND.short;
  manifest.description = BRAND.description;
  // Point the PWA at the SVG we actually ship. Upstream lists pwa-192.png and
  // pwa-512.png — Mastra's logo, deleted below rather than faked — so leaving
  // them listed would make the install prompt fetch two 404s. An SVG icon is
  // valid in a manifest and scales to every size.
  if (!existsSync(join(BRAND_DIR, 'pwa-192.png'))) {
    manifest.icons = [{ src: '/mastra.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }];
    changes.push('manifest.webmanifest icons -> the SVG (no raster 404s)');
  }
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

// --- the JS bundle: a "Team" entry in the sidebar ----------------------------
// The team page (src/mastra/team/routes.ts) is Samskara's own; the Factory has
// no member screen and no supported way to add a nav entry (samskara-ht9). So
// the entry is inserted beside Settings, in the sidebar's bottom list. It is a
// plain <a>, not the SPA's router link: the page is served by the server, not
// the SPA, so it needs a full navigation.
//
// The bundle is minified, so the identifiers (JSX runtime, sidebar component,
// the lucide "users" icon) are captured from the code rather than hardcoded,
// and each anchor is asserted to match exactly once. A bundle that changed
// shape fails the build here instead of shipping a sidebar without the link.
const TEAM_PATH = '/web/samskara/team'; // keep in step with src/mastra/team/paths.ts
const settingsLink = /([\w$]+)\.jsx\(([\w$]+)\.NavLink,\{asChild:!0,link:\{name:"Settings",url:"#",icon:/g;
const usersIcon = /(?<![\w$.])([\w$]+)=[\w$]+\("users",/g;
let teamLinks = 0;
for (const file of bundles) {
  const p = join(assetsDir, file);
  const js = readFileSync(p, 'utf8');
  const anchors = [...js.matchAll(settingsLink)];
  if (!anchors.length) continue;
  const icons = [...js.matchAll(usersIcon)];
  if (anchors.length !== 1 || icons.length !== 1) {
    console.error(
      `[brand-ui] Sidebar Team link: expected 1 Settings nav link and 1 "users" icon in assets/${file}, ` +
        `found ${anchors.length} and ${icons.length}.\n` +
        '           The SPA bundle changed shape. Re-derive the anchor before trusting this script:\n' +
        `             grep -o '.\\{200\\}name:"Settings",url:"#".\\{200\\}' .branded-ui/assets/*.js\n` +
        '           See docs/operations/white-label-ui.md.',
    );
    process.exit(1);
  }
  const [anchor, jsx, sidebar] = anchors[0];
  const icon = icons[0][1];
  const team =
    `${jsx}.jsx(${sidebar}.NavLink,{asChild:!0,link:{name:"Team",url:"${TEAM_PATH}",icon:${jsx}.jsx(${icon},{})},` +
    `children:${jsx}.jsxs("a",{href:"${TEAM_PATH}","aria-label":"Team",` +
    `children:[${jsx}.jsx(${icon},{}),${jsx}.jsx(${sidebar}.NavLabel,{children:"Team"})]})}),`;
  writeFileSync(p, js.slice(0, anchors[0].index) + team + js.slice(anchors[0].index));
  teamLinks += 1;
  changes.push(`assets/${file} sidebar "Team" link -> ${TEAM_PATH} (before ${anchor.slice(0, 24)}…)`);
}
if (teamLinks !== 1) {
  console.error(`[brand-ui] Sidebar Team link: found the Settings nav link in ${teamLinks} bundles, expected 1.`);
  process.exit(1);
}

// --- the JS bundle: Mastra's mark inside the app (samskara-jja) --------------
// Signed in, the app draws Mastra's mark from one inline SVG component: the
// sidebar header (labelled "Mastra"), an eyebrow label and a sign-in button.
// The component is redefined under its own name to draw the brand's "S"
// monogram in the current text colour, so all three uses change, and
// Mastra's original stays in the bundle under a name nothing calls. The
// component is found by its SVG (Mastra's 34x21 mark and the start of its
// path), asserted to match exactly once, and its name and the JSX runtime are
// captured from the match. The sidebar's "Mastra" label is renamed with it.
const mastraMark =
  /(?<![\w$.])([\w$]+)=e=>([\w$]+)\.jsx\("svg",\{xmlns:"http:\/\/www\.w3\.org\/2000\/svg",viewBox:"0 0 34 21",fill:"none",\.\.\.e,children:\2\.jsx\("path",\{d:"M4\.49805 11\.6934/g;
const markLabel = '"aria-label":"Mastra",role:"img"';
let marks = 0;
for (const file of bundles) {
  const p = join(assetsDir, file);
  const js = readFileSync(p, 'utf8');
  const found = [...js.matchAll(mastraMark)];
  if (!found.length) continue;
  const labels = js.split(markLabel).length - 1;
  if (found.length !== 1 || labels !== 1) {
    console.error(
      `[brand-ui] Mastra mark: expected 1 mark component and 1 "Mastra" label in assets/${file}, found ${found.length} and ${labels}.\n` +
        '           The SPA bundle changed shape. Re-derive the anchor before trusting this script:\n' +
        `             grep -o '.\\{40\\}viewBox:"0 0 34 21".\\{120\\}' .branded-ui/assets/*.js\n` +
        '           See docs/operations/white-label-ui.md.',
    );
    process.exit(1);
  }
  const [match, name, jsx] = found[0];
  const ours =
    `${name}=e=>${jsx}.jsxs("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 21 21",fill:"none",...e,children:[` +
    `${jsx}.jsx("rect",{x:"0.75",y:"0.75",width:"19.5",height:"19.5",rx:"5",stroke:"currentColor",strokeWidth:"1.5"}),` +
    `${jsx}.jsx("text",{x:"10.5",y:"15",textAnchor:"middle",fontFamily:"system-ui,sans-serif",fontSize:"13",fontWeight:"600",fill:"currentColor",children:"${BRAND.short.slice(0, 1).toUpperCase()}"})]}),` +
    `${name}__mastra=e=>`;
  const patched = js.slice(0, found[0].index) + ours + js.slice(found[0].index + match.indexOf('=e=>') + 4);
  writeFileSync(p, patched.split(markLabel).join(`"aria-label":"${BRAND.name}",role:"img"`));
  marks += 1;
  changes.push(`assets/${file} Mastra's in-app mark (${name}) -> "${BRAND.short.slice(0, 1)}" monogram, sidebar label -> ${BRAND.name}`);
}
if (marks !== 1) {
  console.error(`[brand-ui] Mastra mark: found the mark component in ${marks} bundles, expected 1.`);
  process.exit(1);
}

// --- the JS bundle: Mastra's logo and loader components (samskara-jja) -------
// Two more components draw Mastra's mark: the brand loader (the "Checking
// sign-in" and "Loading factories" screens, shown before sign-in too) and the
// "Mastra Code" logo (the supervisor and empty-thread pages). Each is a
// function declaration; a new declaration of the same name is inserted before
// it, drawing the brand monogram with the original's classes and size map, and
// the original is renamed so nothing calls it. The loader pulses with an SVG
// <animate>, so it needs no stylesheet. Anchored on each function's signature,
// asserted to match exactly once.
const monogram = (jsx, extra = '') =>
  `${jsx}.jsxs("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 21 21",fill:"none",width:"100%",height:"100%","aria-hidden":"true",children:[` +
  `${jsx}.jsx("rect",{x:"0.75",y:"0.75",width:"19.5",height:"19.5",rx:"5",stroke:"currentColor",strokeWidth:"1.5"}),` +
  `${jsx}.jsx("text",{x:"10.5",y:"15",textAnchor:"middle",fontFamily:"system-ui,sans-serif",fontSize:"13",fontWeight:"600",fill:"currentColor",children:"${BRAND.short.slice(0, 1).toUpperCase()}"})${extra}]})`;
const components = [
  {
    what: 'brand loader',
    signature: /function ([\w$]+)\(\{className:[\w$]+,size:[\w$]+="md","aria-label":[\w$]+="Loading"\}\)\{const [\w$]+=`brand-loader-/g,
    classes: /className:([\w$]+)\("brand-loader inline-block text-foreground",([\w$]+)\[/,
    body: (name, jsx, cx, sizes) =>
      `function ${name}({className:e,size:t="md","aria-label":n="Loading"}){return ${jsx}.jsx("div",{role:"status","aria-label":n,` +
      `className:${cx}("inline-block text-foreground",${sizes}[t],e),children:` +
      monogram(jsx, `,${jsx}.jsx("animate",{attributeName:"opacity",values:"1;0.35;1",dur:"1.4s",repeatCount:"indefinite"})`) +
      `})}`,
  },
  {
    what: 'logo',
    signature: /function ([\w$]+)\(\{className:[\w$]+,size:[\w$]+="md",animateOnHover:[\w$]+=!1,"aria-label":[\w$]+="Mastra"\}\)\{/g,
    classes: /className:([\w$]+)\("logo inline-block text-foreground",([\w$]+)\[/,
    body: (name, jsx, cx, sizes) =>
      `function ${name}({className:e,size:t="md","aria-label":r="${BRAND.name}"}){return ${jsx}.jsx("div",{role:"img","aria-label":r,` +
      `className:${cx}("inline-block text-foreground",${sizes}[t],e),children:${monogram(jsx)}})}`,
  },
];
for (const component of components) {
  let done = 0;
  for (const file of bundles) {
    const p = join(assetsDir, file);
    const js = readFileSync(p, 'utf8');
    const found = [...js.matchAll(component.signature)];
    if (!found.length) continue;
    const classes = found.length === 1 ? component.classes.exec(js.slice(found[0].index, found[0].index + 1500)) : null;
    const jsx = /return ([\w$]+)\.jsx\("div"/.exec(js.slice(found[0].index, found[0].index + 1500))?.[1];
    if (found.length !== 1 || !classes || !jsx) {
      console.error(
        `[brand-ui] Mastra ${component.what}: expected 1 component with its classes in assets/${file}, found ${found.length}.\n` +
          '           The SPA bundle changed shape. Re-derive the anchor before trusting this script:\n' +
          `             grep -o '.\\{20\\}${component.what === 'logo' ? '"aria-label":r="Mastra"' : 'brand-loader-'}.\\{200\\}' .branded-ui/assets/*.js\n` +
          '           See docs/operations/white-label-ui.md.',
      );
      process.exit(1);
    }
    const name = found[0][1];
    const head = `function ${name}(`;
    const at = found[0].index;
    writeFileSync(p, js.slice(0, at) + component.body(name, jsx, classes[1], classes[2]) + `function ${name}__mastra(` + js.slice(at + head.length));
    done += 1;
    changes.push(`assets/${file} Mastra's ${component.what} (${name}) -> "${BRAND.short.slice(0, 1).toUpperCase()}" monogram`);
  }
  if (done !== 1) {
    console.error(`[brand-ui] Mastra ${component.what}: found it in ${done} bundles, expected 1.`);
    process.exit(1);
  }
}

// --- the session favicons (samskara-jja) --------------------------------------
// During a session the SPA swaps the tab icon for favicon-session-<state>.svg:
// Mastra's mark with a coloured status dot. The mark's path is replaced with
// the monogram, drawn with the file's own light/dark colours; the dot and its
// colours stay. Each file must hold exactly one "logo" path, or the build fails.
for (const file of readdirSync(DEST).filter(f => /^favicon-session-.+\.svg$/.test(f))) {
  const p = join(DEST, file);
  const svg = readFileSync(p, 'utf8');
  const paths = svg.match(/<path class="logo" d="[^"]*"\s*\/>/g) ?? [];
  if (paths.length !== 1 || !svg.includes('.logo { fill: white; }') || !svg.includes('.logo { fill: black; }')) {
    console.error(`[brand-ui] ${file}: expected one Mastra "logo" path and its light/dark fills. The favicon changed shape; see docs/operations/white-label-ui.md.`);
    process.exit(1);
  }
  const letter = BRAND.short.slice(0, 1).toUpperCase();
  writeFileSync(
    p,
    svg
      .replace('.logo { fill: white; }', '.logo { fill: white; } .frame { fill: none; stroke: white; }')
      .replace('.logo { fill: black; }', '.logo { fill: black; } .frame { fill: none; stroke: black; }')
      .replace(
        paths[0],
        `<rect class="frame" x="8.5" y="0.75" width="19.5" height="19.5" rx="5" stroke-width="1.5"/>` +
          `<text class="logo" x="18.25" y="15" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600">${letter}</text>`,
      ),
  );
  changes.push(`${file} Mastra's mark -> "${letter}" monogram (status dot kept)`);
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
