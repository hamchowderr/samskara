/**
 * Beads data on DoltHub instead of `refs/dolt/data` on origin.
 *
 * A repository can keep its beads database on DoltHub: its committed
 * `.beads/config.yaml` then names the database under `sync.remote` (samskara
 * and braynee do, so their public git repositories carry no issue data), and
 * `bd bootstrap` clones from there. Checked with bd 1.3.4 on
 * hamchowderr/braynee (`sync.remote: chowderr/braynee`): a fresh clone
 * bootstraps the whole database given DoltHub credentials, and `bd dolt pull`
 * fails with PermissionDenied without them.
 *
 * Dolt reads its credentials from `<root>/.dolt/creds/<key id>.jwk`, picked by
 * `user.creds` in `<root>/.dolt/config_global.json`, where `<root>` is
 * `DOLT_ROOT_PATH` when set, else the home directory (the layout `dolt creds
 * import` writes). The integration writes one such root under its cache
 * directory and points every bd and git child at it.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A DoltHub credential: `dolt creds ls` key id and the JWK `dolt creds import` reads. */
export interface DoltHubCredentials {
  keyId: string;
  jwk: string;
}

/**
 * The credentials from the environment (`DOLT_CREDS_KEY_ID`, `DOLT_CREDS_JWK`),
 * or undefined when either is missing. Throws when the JWK is not a JSON object
 * with the `d` and `x` members of an Ed25519 key, so a mangled secret fails at
 * startup instead of as a DoltHub PermissionDenied later. Never echoes the value.
 */
export function doltHubCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): DoltHubCredentials | undefined {
  const keyId = env.DOLT_CREDS_KEY_ID?.trim();
  const jwk = env.DOLT_CREDS_JWK?.trim();
  if (!keyId || !jwk) return undefined;
  if (!/^[a-z0-9]+$/.test(keyId)) throw new Error('DOLT_CREDS_KEY_ID is not a dolt key id (lowercase letters and digits)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jwk);
  } catch {
    throw new Error('DOLT_CREDS_JWK is not valid JSON');
  }
  const key = parsed as Record<string, unknown> | null;
  if (!key || typeof key !== 'object' || typeof key.d !== 'string' || typeof key.x !== 'string') {
    throw new Error('DOLT_CREDS_JWK is not a dolt JWK (needs "d" and "x")');
  }
  return { keyId, jwk };
}

/** Write a Dolt root holding `credentials` under `root`; returns `root`, for `DOLT_ROOT_PATH`. */
export function writeDoltRoot(root: string, credentials: DoltHubCredentials, user: { name: string; email: string }): string {
  const creds = join(root, '.dolt', 'creds');
  mkdirSync(creds, { recursive: true, mode: 0o700 });
  const file = join(creds, `${credentials.keyId}.jwk`);
  writeFileSync(file, credentials.jwk, { mode: 0o600 });
  chmodSync(file, 0o600);
  writeFileSync(
    join(root, '.dolt', 'config_global.json'),
    JSON.stringify({ 'user.creds': credentials.keyId, 'user.name': user.name, 'user.email': user.email }),
    { mode: 0o600 },
  );
  return root;
}

/**
 * `sync.remote` from a `.beads/config.yaml`, in either spelling bd accepts
 * (a flat `sync.remote:` key, or `remote:` nested under `sync:`), or
 * undefined. A deliberately small reader: the file is bd's own flat config,
 * and only this one key matters here.
 */
export function syncRemoteOf(yaml: string): string | undefined {
  let inSync = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      const flat = /^sync\.remote:\s*(.*)$/.exec(line);
      if (flat) return unquote(flat[1]!);
      inSync = /^sync:\s*$/.test(line);
      continue;
    }
    if (!inSync) continue;
    const nested = /^\s+remote:\s*(.*)$/.exec(line);
    if (nested) return unquote(nested[1]!);
  }
  return undefined;
}

function unquote(value: string): string | undefined {
  const v = value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return v || undefined;
}

/**
 * Whether a Dolt remote is a DoltHub database: `owner/db`, or its
 * `https://doltremoteapi.dolthub.com/owner/db` form. A `git+…` remote is a git
 * repository (refs/dolt/data), and other schemes (file://, aws://, gs://) are
 * not something this integration has credentials for.
 */
export function isDoltHubRemote(remote: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote) || /^https:\/\/doltremoteapi\.dolthub\.com\/[^/]+\/[^/]+\/?$/.test(remote);
}
