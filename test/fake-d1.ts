/**
 * A D1-shaped database backed by node:sqlite, for testing src/db.ts.
 *
 * WHY NOT A MOCK. The interesting part of `mergeGraph` is SQL — the upsert,
 * the COALESCE that makes a merge leave untouched fields alone, the UNIQUE
 * on (owner_id, key), the cascade. A hand-rolled fake would be a second
 * implementation of the thing under test and would agree with itself. This
 * runs the real migration and the real statements against real SQLite; only
 * the binding shape is faked.
 *
 * Fidelity limits worth knowing: `batch` here is a real transaction (D1's is
 * too), but D1's platform behaviours — row limits, replication, timeouts —
 * are not modelled. Tests that depend on those belong in `wrangler dev`.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;

interface FakeResult<T> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number };
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  private normalized(): unknown[] {
    // node:sqlite rejects undefined and booleans; D1 accepts null and coerces.
    return this.params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  }

  all<T = Row>(): Promise<FakeResult<T>> {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length === 0) return Promise.resolve(this.run<T>());
    const results = statement.all(...(this.normalized() as never[])) as T[];
    return Promise.resolve({ results, success: true, meta: { changes: 0, last_row_id: 0 } });
  }

  first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.normalized() as never[])) as Row | undefined;
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve((column ? (row[column] as T) : (row as T)) ?? null);
  }

  run<T = Row>(): Promise<FakeResult<T>> {
    const info = this.db.prepare(this.sql).run(...(this.normalized() as never[]));
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    });
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  async batch<T = Row>(statements: FakeStatement[]): Promise<FakeResult<T>[]> {
    this.db.exec('BEGIN');
    try {
      const out: FakeResult<T>[] = [];
      for (const statement of statements) out.push(await statement.all<T>());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

const MIGRATION = fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url));

/** A fresh in-memory database with the real schema applied. */
export function createTestDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return new FakeD1(db) as unknown as D1Database;
}
