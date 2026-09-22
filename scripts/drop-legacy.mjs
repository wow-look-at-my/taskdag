#!/usr/bin/env node
/**
 * Runs migration 0003 — dropping 0001's `graphs`/`tasks`/`edges` — but only
 * after proving the rows they hold already live under a handle.
 *
 * WHY A SCRIPT AND NOT A README LINE. 0002 COPIED those rows, it did not
 * move them, so until this runs the old tables are still the only other
 * copy. The check that the copy landed is the whole safety story, and a
 * check that lives in a comment is a check somebody skips at 2am. Here it
 * is the gate: this refuses to drop anything unless the migrated counts
 * cover the legacy ones.
 *
 *   node scripts/drop-legacy.mjs            # report only, changes nothing
 *   node scripts/drop-legacy.mjs --confirm  # drop, if the check passes
 *
 * Needs an authenticated wrangler (`npx wrangler login`).
 */

import { execFileSync } from 'node:child_process';

const DB = 'taskdag-db';
const MIGRATION = 'migrations/0003_drop_legacy_tables.sql';
const confirmed = process.argv.includes('--confirm');

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function die(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(`  ${String(detail).trim().split('\n').slice(-4).join('\n  ')}`);
  process.exit(1);
}

/** The legacy tables, if they are still there at all. */
function legacyTables() {
  const sql = "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('graphs','tasks','edges') ORDER BY name;";
  const out = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql]);
  return JSON.parse(out)[0].results.map((row) => row.name);
}

function counts() {
  const sql = 'SELECT (SELECT COUNT(*) FROM tasks) AS legacy, (SELECT COUNT(*) FROM graph_tasks) AS migrated;';
  const out = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql]);
  return JSON.parse(out)[0].results[0];
}

let present;
try {
  present = legacyTables();
} catch (err) {
  die('Could not read the database. Is wrangler logged in? (npx wrangler login)', err.stderr ?? err.message);
}

if (present.length === 0) {
  console.log('✓ Nothing to do: graphs/tasks/edges are already gone.');
  process.exit(0);
}

const { legacy, migrated } = counts();
console.log(`  legacy tasks   ${legacy}`);
console.log(`  migrated tasks ${migrated}`);

// `migrated` is normally LARGER: every graph made since the handles landed
// counts too. Smaller means the backfill did not finish, and dropping now
// would take the only remaining copy with it.
if (migrated < legacy) {
  die(`The copy is incomplete (${migrated} < ${legacy}). NOT dropping anything. Let the Worker serve a request to run the backfill, then re-run this.`);
}

if (!confirmed) {
  console.log(`\nCheck passed. Re-run with --confirm to apply ${MIGRATION}.`);
  process.exit(0);
}

try {
  wrangler(['d1', 'execute', DB, '--remote', '--file', MIGRATION, '-y']);
} catch (err) {
  die('The drop failed.', err.stderr ?? err.message);
}

const left = legacyTables();
if (left.length > 0) die(`Still present after the drop: ${left.join(', ')}`);
console.log('\n✓ Dropped graphs, tasks and edges. The bootstrap will not recreate them.');
