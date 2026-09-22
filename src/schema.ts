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
 * ONE SOURCE OF TRUTH. The DDL is not retyped here: `migrations/0001_init.sql`
 * is imported as text and executed as written, so `wrangler d1 migrations
 * apply` and this path cannot drift apart. Every statement is
 * `CREATE ... IF NOT EXISTS`, which makes running both harmless — a later
 * `migrations apply` is a no-op rather than an error.
 *
 * THIS IS NOT A MIGRATION RUNNER. It applies the initial schema and nothing
 * else. A second migration that alters existing tables still goes through
 * `wrangler d1 migrations apply`, deliberately: a schema change that runs
 * itself on first request is how you lose data at 3am.
 */

import initSql from '../migrations/0001_init.sql';

/**
 * The migration split into statements.
 *
 * A dumb split on `;` is correct for this file and is checked by a test —
 * there are no semicolons inside string literals, and the alternative
 * (`D1Database.exec`, which is line-oriented) is documented as a
 * maintenance tool rather than something to put on a request path.
 */
export function statementsOf(sql: string): string[] {
  return sql
    .split(';')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

export const SCHEMA_STATEMENTS = statementsOf(initSql);

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
