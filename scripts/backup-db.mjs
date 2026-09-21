/**
 * Snapshot the local Samskara database.
 *
 * Two rules this script exists to enforce, both learned the hard way:
 *
 *  1. Snapshots are written OUTSIDE the project. An earlier backup attempt put
 *     them in `.mastra/`, which `mastra build` wipes — the backups were deleted
 *     by the very thing they were meant to protect against.
 *  2. It uses libSQL's own `VACUUM INTO`, not a file copy. SQLite keeps recent
 *     writes in a `-wal` sidecar that is only folded into the main file at a
 *     checkpoint, so copying `samskara.db` alone silently loses whatever is
 *     still in the WAL. `VACUUM INTO` writes a consistent, fully-checkpointed
 *     copy, and it is safe to run while the server is live.
 *
 * Usage:  npm run db:backup            (keeps the 10 most recent)
 *         node scripts/backup-db.mjs --out <dir> --keep <n>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createClient } from '@libsql/client';

// npm does not load .env, and MASTRA_DB_PATH lives there. Optional so the
// script still works when the variable is exported by the environment instead.
try {
  await import('dotenv/config');
} catch {
  /* dotenv absent — rely on the ambient environment */
}

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

// Default lives under the user profile, deliberately not under the repo.
const OUT_DIR = path.resolve(argOf('--out', path.join(os.homedir(), '.samskara-backups')));
const KEEP = Number(argOf('--keep', '10'));

const dbPath = process.env.MASTRA_DB_PATH;
if (!dbPath) {
  console.error('MASTRA_DB_PATH is not set. Run through npm so .env is loaded, or set it explicitly.');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath} — nothing to back up.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(OUT_DIR, { recursive: true });
const target = path.join(OUT_DIR, `samskara-${stamp}.db`);

const db = createClient({ url: `file:${dbPath.replace(/\\/g, '/')}` });

// VACUUM INTO refuses to overwrite, so a collision means a real name clash.
await db.execute(`VACUUM INTO '${target.replace(/\\/g, '/').replace(/'/g, "''")}'`);
await db.close();

const size = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`backed up -> ${target}  (${size} KB)`);

// Prune oldest, keeping the most recent KEEP snapshots.
const snapshots = fs
  .readdirSync(OUT_DIR)
  .filter(f => /^samskara-.*\.db$/.test(f))
  .sort()
  .reverse();
for (const stale of snapshots.slice(KEEP)) {
  fs.unlinkSync(path.join(OUT_DIR, stale));
  console.log(`pruned    -> ${stale}`);
}
console.log(`${Math.min(snapshots.length, KEEP)} snapshot(s) retained in ${OUT_DIR}`);
