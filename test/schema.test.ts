/**
 * The bootstrap that makes a freshly deployed Worker work without anyone
 * remembering to run `wrangler d1 migrations apply`.
 */

import { describe, expect, it } from 'vitest';

import initSql from '../migrations/0001_init.sql';
import { MIGRATIONS, SCHEMA_STATEMENTS, ensureSchema, statementsOf } from '../src/schema.ts';
import { createTestDb, rawDb } from './fake-d1.ts';
import { createGraph, loadGraph, mergeGraph } from '../src/db.ts';

const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';

function tableNames(db: D1Database): string[] {
  return rawDb(db)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('statementsOf', () => {
  it('splits every migration into executable statements', () => {
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
    for (const statement of SCHEMA_STATEMENTS) {
      expect(statement).toMatch(/^(CREATE (TABLE|INDEX)|INSERT (OR IGNORE )?INTO)/);
      expect(statement).not.toContain(';');
    }
  });

  it('every statement is idempotent, because this runs on a live database', () => {
    // Three shapes are allowed and no others: DDL that no-ops when the
    // object exists, a backfill that no-ops when the rows are already
    // there, and an `INSERT OR IGNORE` whose primary key makes it no-op on
    // its own. A bare INSERT here would duplicate somebody's graph on every
    // cold start.
    for (const statement of SCHEMA_STATEMENTS) {
      if (statement.startsWith('INSERT OR IGNORE INTO')) continue;
      else if (statement.startsWith('INSERT INTO')) expect(statement).toMatch(/NOT EXISTS \(SELECT/);
      else expect(statement).toContain('IF NOT EXISTS');
    }
  });

  it('keeps semicolons and -- out of the string literals the dumb split would trip on', () => {
    for (const migration of MIGRATIONS) {
      // Comments go before the split, so prose apostrophes ("owner's") are
      // not literals and prose semicolons are already gone. What is left is
      // what the splitter actually sees.
      const code = migration.sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      for (const literal of code.match(/'[^']*'/g) ?? []) {
        expect(literal).not.toContain(';');
        expect(literal).not.toContain('--');
      }
    }
  });

  it('never puts a DROP on the request path', () => {
    // The bootstrap replays this whole set on every cold start, so it can
    // only ever hold statements that are safe to run again. 0003 drops
    // 0001's tables and is deliberately absent from MIGRATIONS for exactly
    // that reason; this fails if someone adds it, or writes another like it.
    for (const statement of SCHEMA_STATEMENTS) expect(statement).not.toMatch(/^\s*(DROP|ALTER|DELETE|UPDATE)\b/i);
    expect(MIGRATIONS.map((m) => m.name)).not.toContain('0003_drop_legacy_tables.sql');
  });

  it('carries no PRAGMA: remote D1 rejects them and enforces foreign keys itself', () => {
    expect(initSql).not.toMatch(/^\s*PRAGMA/im);
  });

  it('drops comment-only chunks rather than sending them as statements', () => {
    expect(statementsOf('-- just a comment\nCREATE TABLE IF NOT EXISTS a(b);\n-- trailing\n')).toEqual([
      'CREATE TABLE IF NOT EXISTS a(b)',
    ]);
  });
});

describe('ensureSchema', () => {
  it('creates the schema on an empty database', async () => {
    const db = createTestDb({ migrated: false });
    expect(tableNames(db)).toEqual([]);

    await ensureSchema(db);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['graph_edges', 'graph_handles', 'graph_tasks']));
  });

  it('is safe to run against a database that already has the schema', async () => {
    const db = createTestDb();
    const graph = (await createGraph(db, TOKEN)).id;
    await mergeGraph(db, graph, { tasks: [{ key: 'T1', title: 'Survive the bootstrap' }] });

    await ensureSchema(db);
    await ensureSchema(db);

    // The data is still there: the DDL is CREATE ... IF NOT EXISTS and the
    // backfill is guarded, so a re-run is not a reset and not a duplicate.
    expect((await loadGraph(db, graph)).tasks.map((t) => t.key)).toEqual(['T1']);
  });

  it('lets the first tool call succeed against a database nobody migrated', async () => {
    const db = createTestDb({ migrated: false });
    // This is the deployed-but-unmigrated case, which used to answer
    // `no such table: graphs` to every single call.
    const graph = (await createGraph(db, TOKEN)).id;
    await mergeGraph(db, graph, { title: 'Fresh', tasks: [{ title: 'First task' }] });
    const state = await loadGraph(db, graph);
    expect(state.title).toBe('Fresh');
    expect(state.tasks).toHaveLength(1);
  });
});
