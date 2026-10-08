/**
 * Report Samskara's stored Factory state straight from the libSQL database,
 * without going through the UI.
 *
 * The Factory SPA hides a lot behind gates (no linked repository means every
 * board renders an empty state, signed-out means 401 everywhere), so "the UI
 * doesn't show it" is not evidence about what the server actually stored. This
 * reads the tables directly.
 *
 * Columns whose names look secret-bearing are redacted; long values truncated.
 *
 * Usage:  node scripts/factory-state.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// data/, not .mastra/: mastra build deletes .mastra/ (CLAUDE.md, samskara-7p5).
const DB = process.env.MASTRA_DB_PATH ?? path.join(REPO, 'data', 'samskara.db');

const TABLES = [
  'integration_connections',
  'source_control_installations',
  'source_control_repositories',
  'factory_projects',
  'factory_project_repositories',
  'factory_project_source_control_connections',
  'work_items',
];

const SECRETISH = /token|secret|key|pem|credential|password/i;

const db = createClient({ url: `file:${DB.replace(/\\/g, '/')}` });

console.log(`\ndb: ${DB}\n`);

for (const table of TABLES) {
  try {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
    const n = Number(rows[0].n);
    console.log(`${table.padEnd(46)} ${n} row(s)`);
    if (n === 0 || n > 8) continue;

    const detail = await db.execute(`SELECT * FROM "${table}" LIMIT 8`);
    for (const row of detail.rows) {
      const safe = {};
      for (const [k, v] of Object.entries(row)) {
        if (SECRETISH.test(k)) safe[k] = v == null ? null : '<redacted>';
        else if (typeof v === 'string' && v.length > 50) safe[k] = v.slice(0, 47) + '…';
        else safe[k] = v;
      }
      console.log('    ' + JSON.stringify(safe));
    }
  } catch (e) {
    console.log(`${table.padEnd(46)} — ${e.message.split('\n')[0]}`);
  }
}
console.log();
