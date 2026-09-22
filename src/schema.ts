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

export const SCHEMA_STATEMENTS = MIGRATIONS.flatMap((migration) => statementsOf(migration.sql));

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
      .batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
      .then(() => undefined)
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
