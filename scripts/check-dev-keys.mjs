/**
 * Refuse to start `npm run dev:secure` when its keys differ from `npm run dev`'s.
 *
 * THE PROBLEM (samskara-1kl). Local development has two key sources:
 *  - `npm run dev` reads `.env` / `.env.local`, where `ensure-dev-secrets.mjs`
 *    generates FACTORY_CREDENTIAL_ENCRYPTION_KEY on a fresh clone.
 *  - `npm run dev:secure` injects Infisical dev:/samskara. Injected variables
 *    win, because the Mastra CLI loads the env files without overriding
 *    anything already set.
 * When the two keys differ, credentials saved in one mode cannot be decrypted
 * in the other. The Factory swallows the decrypt error
 * (`@mastra/factory` routes/provider-credentials.js) and reports
 * `credentials_unavailable`, so provider Sign in fails with no clue why.
 *
 * WHAT THIS DOES. Runs as `predev:secure`, inside `infisical run`, and compares
 * SHA-256 fingerprints of each key as `dev` would see it and as `dev:secure`
 * will see it. It never prints a value.
 *  - Encryption key or key id differ: exit 1. Starting would hide every saved
 *    credential.
 *  - BETTER_AUTH_SECRET differs: warn only. It signs you out, nothing more.
 * A key absent from the env files is not a conflict: `dev` has never used one.
 *
 * It does not sync the keys. Which one is right depends on which mode saved
 * the credentials you want to keep, so the fix is left to the operator.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const CHECKS = [
  { key: 'FACTORY_CREDENTIAL_ENCRYPTION_KEY', fatal: true },
  // src/mastra/index.ts falls back to 'v1' when the id is unset.
  { key: 'FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID', fatal: true, fallback: 'v1' },
  { key: 'BETTER_AUTH_SECRET', fatal: false },
];

/** The value `npm run dev` would use: the first env file that sets the key. */
function fromEnvFiles(key) {
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    const value = match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return { value, file };
  }
  return null;
}

const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 8);

let failed = false;
for (const { key, fatal, fallback } of CHECKS) {
  const local = fromEnvFiles(key);
  const injected = process.env[key]?.trim() || fallback;
  // Only the id has a fallback, and `dev` applies the same one.
  const localValue = local?.value ?? fallback;
  if (!localValue || !injected || localValue === injected) continue;

  const where = local ? local.file : 'the default';
  const message =
    `[dev-keys] ${key} differs: ${where} ${fingerprint(localValue)} vs Infisical dev:/samskara ${fingerprint(injected)}.`;
  if (fatal) {
    failed = true;
    console.error(message);
  } else {
    console.warn(`${message} Sessions from one mode are signed out in the other.`);
  }
}

if (failed) {
  console.error(
    [
      '[dev-keys] Credentials saved under `npm run dev` cannot be decrypted under `npm run dev:secure`, and the',
      '[dev-keys] reverse. Make both sources hold the same value, keeping the one that encrypted the credentials',
      '[dev-keys] you want: copy the .env.local value into Infisical dev:/samskara, or the Infisical value',
      '[dev-keys] into .env.local. See docs/setup/secrets-infisical.md.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log('[dev-keys] npm run dev and npm run dev:secure use the same credential encryption key.');
