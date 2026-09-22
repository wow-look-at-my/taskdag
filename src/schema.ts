/**
 * Applies the schema on first use, from the migration file itself.
 *
 * WHY A DEPLOYED WORKER SHOULD NOT NEED A HUMAN FIRST. A fresh D1 database
 * is empty, and a Worker pointed at one answers every tool call with
 * `no such table: graphs` until somebody remembers to run
 * `wrangler d1 migrations apply`. That is a deployment that looks finished
 * and is not, and the failure surfaces to whoever is chatting rather than
 * to whoever deployed.
 *
 * ONE SOURCE OF TRUTH. The DDL is not retyped here: the migration files are
 * imported as text and executed as written, so `wrangler d1 migrations
 * apply` and this path cannot drift apart. Every statement is idempotent —
 * `CREATE ... IF NOT EXISTS`, or an `INSERT ... WHERE NOT EXISTS` backfill —
 * which makes running both harmless: a later `migrations apply` is a no-op
 * rather than an error, and so is the next cold start.
 *
 * WHAT IT WILL NOT DO IS RESURRECT THE PAST. The legacy half — 0001's DDL
 * and 0002's backfill out of it — runs only while `graphs`/`tasks`/`edges`
 * are still there. Once `0003_drop_legacy_tables.sql` has removed them by
 * hand, the next cold start skips that half instead of recreating the
 * tables it just dropped, and a fresh database never creates them at all.
 *
 * THIS IS STILL NOT A MIGRATION RUNNER, and there is no ledger here. What it
 * can carry is a migration that only ever adds: new tables beside the old
 * ones, and a backfill guarded so a second run does nothing. A migration
 * that alters or drops an existing table is a different animal and still
 * goes through `wrangler d1 migrations apply` by hand, deliberately — a
 * schema change that runs itself on first request is how you lose data at
 * 3am. The test suite is what holds that line: it fails on a statement here
 * that is not idempotent.
 */

import initSql from '../migrations/0001_init.sql';
import handlesSql from '../migrations/0002_graph_handles.sql';

/**
 * The migration split into statements.
 *
 * COMMENTS GO FIRST, THEN THE SPLIT. Splitting on `;` and stripping comments
 * afterwards looks equivalent and is not: a prose semicolon inside a `--`
 * comment then cuts the statement that follows it in half, and the leftover
 * words arrive at D1 as SQL. Stripping whole comment lines up front makes
 * the split see only statements.
 *
 * A dumb split on `;` is correct for these files and is checked by a test:
 * no string literal in them contains a semicolon or a `--`. The alternative
 * (`D1Database.exec`, which is line-oriented) is documented as a maintenance
 * tool rather than something to put on a request path.
 */
export function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Every migration, in order. Order matters twice over: 0002 backfills from
 * the tables 0001 creates, so on an empty database the two have to arrive
 * in this sequence within the one batch.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: '0001_init.sql', sql: initSql },
  { name: '0002_graph_handles.sql', sql: handlesSql },
];

/**
 * The statements that build the current schema. Always applied.
 *
 * Only 0002's `CREATE`s: a database that has never held a pre-handle row
 * needs `graph_handles`/`graph_tasks`/`graph_edges` and nothing else, so a
 * fresh deployment no longer creates 0001's tables just to leave them
 * empty forever.
 */
export const CURRENT_STATEMENTS = statementsOf(handlesSql).filter((statement) => statement.startsWith('CREATE'));

/**
 * The statements that carry a pre-handle database forward: 0001's DDL (all
 * `IF NOT EXISTS`, so a no-op on a database that already has it) and 0002's
 * backfill, which reads from those tables.
 *
 * Applied ONLY when the legacy tables are still present. That conditional
 * is what lets `0003_drop_legacy_tables.sql` mean something: without it the
 * bootstrap recreates `graphs`/`tasks`/`edges` on the next cold start and
 * the drop achieves nothing. It is also what stops the backfill running
 * against tables that no longer exist.
 */
export const LEGACY_STATEMENTS = [...statementsOf(initSql), ...statementsOf(handlesSql).filter((statement) => !statement.startsWith('CREATE'))];

/** Everything the bootstrap can ever run, for the tests that police it. */
export const SCHEMA_STATEMENTS = [...CURRENT_STATEMENTS, ...LEGACY_STATEMENTS];

/** The tables 0001 made, and 0003 removes. */
const LEGACY_TABLES = ['graphs', 'tasks', 'edges'];

async function legacyTablesPresent(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${LEGACY_TABLES.map(() => '?').join(', ')}) LIMIT 1`)
    .bind(...LEGACY_TABLES)
    .first<{ name: string }>();
  return row !== null && row !== undefined;
}

/**
 * Per-isolate memo. Concurrent cold starts racing each other is fine:
 * every statement is idempotent, so the worst case is the same harmless
 * DDL twice.
 */
const applied = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let inFlight = applied.get(db);
  if (!inFlight) {
    inFlight = db
      .batch(CURRENT_STATEMENTS.map((statement) => db.prepare(statement)))
      // One extra round trip, and only on a cold start: ask whether this
      // database still has a pre-handle past before replaying it.
      .then(async () => {
        if (await legacyTablesPresent(db)) await db.batch(LEGACY_STATEMENTS.map((statement) => db.prepare(statement)));
      })
      // A failure must not be cached, or one bad cold start poisons the
      // isolate for as long as it lives.
      .catch((err: unknown) => {
        applied.delete(db);
        throw err;
      });
    applied.set(db, inFlight);
  }
  return inFlight;
}
