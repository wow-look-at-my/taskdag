/**
 * The bootstrap that makes a freshly deployed Worker work without anyone
 * remembering to run `wrangler d1 migrations apply`.
 */

import { describe, expect, it } from 'vitest';

import initSql from '../migrations/0001_init.sql';
import { SCHEMA_STATEMENTS, ensureSchema, statementsOf } from '../src/schema.ts';
import { createTestDb, rawDb } from './fake-d1.ts';
import { loadGraph, mergeGraph } from '../src/db.ts';

const OWNER = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';

function tableNames(db: D1Database): string[] {
  return rawDb(db)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('statementsOf', () => {
  it('splits the migration into executable statements', () => {
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
    for (const statement of SCHEMA_STATEMENTS) {
      expect(statement).toMatch(/^CREATE (TABLE|INDEX)/);
      expect(statement).not.toContain(';');
    }
  });

  it('every statement is idempotent, because this runs on a live database', () => {
    for (const statement of SCHEMA_STATEMENTS) expect(statement).toContain('IF NOT EXISTS');
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
    expect(tableNames(db)).toEqual(expect.arrayContaining(['edges', 'graphs', 'tasks']));
  });

  it('is safe to run against a database that already has the schema', async () => {
    const db = createTestDb();
    await mergeGraph(db, OWNER, { tasks: [{ key: 'T1', title: 'Survive the bootstrap' }] });

    await ensureSchema(db);
    await ensureSchema(db);

    // The data is still there: the DDL is CREATE ... IF NOT EXISTS, not a reset.
    expect((await loadGraph(db, OWNER)).tasks.map((t) => t.key)).toEqual(['T1']);
  });

  it('lets the first tool call succeed against a database nobody migrated', async () => {
    const db = createTestDb({ migrated: false });
    // This is the deployed-but-unmigrated case, which used to answer
    // `no such table: graphs` to every single call.
    await mergeGraph(db, OWNER, { title: 'Fresh', tasks: [{ title: 'First task' }] });
    const state = await loadGraph(db, OWNER);
    expect(state.title).toBe('Fresh');
    expect(state.tasks).toHaveLength(1);
  });
});
