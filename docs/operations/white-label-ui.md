# White-labelling the Factory UI

Samskara's premise is clients submitting work through chat, so clients reach
the sign-in screen. The SPA served there is the one the `mastra` CLI ships, and
out of the box it carries Mastra's tab title, favicon and PWA identity.

## What is actually branded

Measured against the running sign-in screen with a browser, not inferred from
the bundle:

| Surface | Value | Where it comes from |
| --- | --- | --- |
| Browser tab title | `Mastra Factory` | a **JS constant**, not `index.html` |
| Favicon | `/mastra.svg` | `index.html` `<link rel=icon>` |
| Apple touch icon | `/apple-touch-icon.png` | `index.html` |
| PWA name / description | `Mastra Factory` | `manifest.webmanifest` |
| PWA icons | `/pwa-192.png`, `/pwa-512.png` | manifest + the "Install app" prompt |

**The visible copy is already generic.** The sign-in screen reads "Build with
an agent factory", "Welcome back", "Email / Password / Sign in" — no Mastra
wordmark, and `document.querySelectorAll('svg[aria-label]')` finds no logo
element on that screen. That is why this does not require vendoring the SPA
source and rebuilding it: replacing assets and one string is enough.

## The title cannot be fixed in index.html alone

The SPA assigns `document.title` on mount from a bundled constant:

```js
const HR="Mastra Factory";  // assets/index-*.js
```

A patched `<title>` is overwritten the moment the app hydrates. `npm run dev`
with only the HTML patched still shows `Mastra Factory` in the tab.

That constant appears **exactly once** in the 3.9 MB bundle, which is what
makes a string replacement safe. `scripts/build-branded-ui.mjs` asserts the
count and **fails the build** if it is not 1 — a future bundle that changes
shape stops the build rather than silently shipping Mastra's name to a client.

## How it works

```bash
npm run dev      # predev  runs the script
npm run build    # prebuild runs it too
node scripts/build-branded-ui.mjs   # or directly
```

The script copies `node_modules/mastra/dist/factory/` to `.branded-ui/`,
applies the branding, and pins `MASTRACODE_UI_DIST` to that directory in
`.env.local`.

Three deliberate choices:

**It regenerates from the installed package every run.** A committed patched
copy goes stale on the next `mastra` upgrade and silently serves an old UI.

**It writes to `.branded-ui/`, not `src/mastra/public/factory/`.** The latter
is a supported location that needs no env var
(`@mastra/factory/dist/spa-static.js:56-64`), but it sits inside the dev
server's watch tree — writing 4 MB there makes `mastra dev` re-bundle and
restart on every run, a ~6 minute round trip. `.branded-ui/` is gitignored and
the watcher ignores it.

**It pins `MASTRACODE_UI_DIST` itself.** `mastra factory dev` sets that variable
to its *own* copy of the SPA unless it is already present
(`mastra/dist/index.js:4652`, CLI 1.33.0), which would silently win over
everything the script does.

## Supplying real brand assets

The script ships a plain monogram as `mastra.svg`. The raster icons are
Mastra's logo, and inventing replacements is not something to guess at, so they
are **deleted** — and every reference to them is removed with them:

- the `apple-touch-icon` `<link>` is dropped from `index.html`
- the manifest's `icons` array is repointed at the SVG, which is valid there
  and scales to any size

So nothing 404s and nothing shows Mastra's mark. Put real files in `brand/` and
the script uses them instead, restoring the normal raster references:

```
brand/mastra.svg              the favicon — see the filename note below
brand/apple-touch-icon.png    180x180
brand/pwa-192.png             192x192
brand/pwa-512.png             512x512
```

### Why the favicon is still called `mastra.svg`

The pre-auth allow-list in `@mastra/factory/dist/auth.js:548` is hardcoded to
an exact set of paths:

```js
path === "/signin" || path.startsWith("/assets/") || path === "/manifest.webmanifest"
  || path === "/mastra.svg" || path === "/pwa-192.png" || path === "/pwa-512.png"
  || path === "/apple-touch-icon.png" || …
```

Anything else 401s for a signed-out visitor. Renaming it to `favicon.svg` was
tried and **broke the favicon on the sign-in screen** — measured:
`/favicon.svg` → 401, `/mastra.svg` → 200. The filename appears only in
devtools; the icon a client sees is ours. Keeping the upstream name is the
correct trade.

Change the name, short name and description in the `BRAND` object at the top of
the script.

## Verifying

The acceptance test is what a browser reports, not what the files contain:

```bash
agent-browser open http://localhost:4111/signin
agent-browser eval "JSON.stringify({title:document.title, mastra:document.documentElement.outerHTML.includes('Mastra')})"
# {"title":"Samskara","mastra":false}
```

## Production

The Docker image already handles this (`Dockerfile:111-112`); nothing needs
setting in Coolify or Infisical. A deploy that does not use the image must set
`MASTRACODE_UI_DIST` in its own environment, pointing at the `.branded-ui`
produced by `npm run build`, because `.env.local` is local-only and gitignored.

**Verified 2026-09-23:** `mastra build` does NOT carry the branding. It copies
Mastra's stock UI into `.mastra/output/factory` (title "Mastra Factory"), and
the server picks that up unless `MASTRACODE_UI_DIST` points elsewhere. The
`Dockerfile` therefore copies `.branded-ui` into the image as `/app/branded-ui`
and sets `MASTRACODE_UI_DIST=/app/branded-ui`. Running the image serves
`<title>Samskara</title>` on `/signin`.

## The Team link in the sidebar

The same script adds a **Team** entry to the sidebar, beside Settings, linking to
the team page at `/web/samskara/team` (`src/mastra/team/paths.ts`). It is a plain
link rather than the SPA's router link, because the server renders that page,
not the SPA.

The bundle is minified, so the script captures the identifiers it needs (the JSX
runtime, the sidebar component, the `users` icon) from the code around the
Settings link instead of hardcoding them. It checks that the Settings link and
the icon each appear exactly once, and stops the build otherwise. A `mastra`
upgrade that reshapes the sidebar therefore fails `npm run dev` and
`npm run build` with the command to re-derive the anchor, instead of shipping a
sidebar without the link.

`e2e/invite-flow.spec.ts` clicks the link.

## Mastra's mark inside the app (samskara-jja)

The bundle draws Mastra's mark in four places. The script replaces each with
the brand's monogram, the first letter of `BRAND.short` in a rounded square
drawn in the current text colour, so it suits both themes:

| Where | In the bundle | Seen |
|-------|---------------|------|
| Top of the sidebar (labelled "Mastra", renamed `BRAND.name`), an eyebrow label, and the "Sign in with Mastra Platform" button | one inline SVG component | signed in; the button only with the `mastra-studio` provider, never under Samskara's Better Auth |
| The brand loader: "Checking sign-in", "Loading factories" | a function component | before sign-in too; ours pulses with an SVG `<animate>` |
| The "Mastra Code" logo | a function component | the supervisor and empty-thread pages |
| The tab icon during a session | `favicon-session-{initializing,working,awaiting,error}.svg` | signed in; the status dot and its colours are kept |

Each component is redefined under its own name, keeping the original's
classes and size map, and the original stays in the bundle under an unused
`<name>__mastra` name. Each is found by an anchor (the mark's SVG, or the
function's signature) asserted to match exactly once, and each favicon must
hold exactly one Mastra path, so a `mastra` upgrade that redraws any of them
fails the build. `e2e/invite-flow.spec.ts` checks the signed-in sidebar shows
an image named "Samskara" and none named "Mastra".

## What this does not cover

Beyond the marks above, only pre-auth surfaces were audited. Post-auth
screens contain further Mastra strings in the bundle — "Mastra Code", "Search MastraCode", "Ask Mastra Code…",
provider labels — which this script does not touch. Renaming those reliably
means vendoring the SPA source from the `mastra-ai/mastra` monorepo and
building it. File a separate issue if clients will see those screens.
