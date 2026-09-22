/**
 * The upgrade path for a database that already has graphs in it.
 *
 * WHY THIS IS NOT OPTIONAL. There is a deployed TaskDAG with real rows
 * written under 0001, where a token owned exactly one graph and the token
 * itself was the key. 0002 gives those rows a handle. If the backfill is
 * wrong the failure is not a crash — it is somebody's plan quietly not
 * being there any more, or being there twice.
 *
 * So this starts from a genuine pre-handle database: 0001's tables, rows
 * inserted the way 0001's code inserted them, and nothing else.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, rawDb } from './fake-d1.ts';
import { SCHEMA_STATEMENTS, ensureSchema, statementsOf } from '../src/schema.ts';
import dropSql from '../migrations/0003_drop_legacy_tables.sql';
import { GraphError, createGraph, deleteGraph, listGraphs, loadGraph, mergeGraph, resolveGraph } from '../src/db.ts';

const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';
const OTHER_TOKEN = 'zX9wQ2eR5tY7uI0oP3aS6dF8gH1jK4lZ-_cVbNmQwEr';

let db: D1Database;

function tableNames(handle: D1Database): string[] {
  return rawDb(handle)
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

/** Writes rows exactly as the pre-handle code did: keyed by the token. */
function legacyGraph(owner: string, title: string, keys: string[], edges: [string, string][]): void {
  const raw = rawDb(db);
  const ts = '2026-09-01T00:00:00.000Z';
  raw.prepare('INSERT INTO graphs (owner_id, title, updated_at) VALUES (?, ?, ?)').run(owner, title, ts);
  for (const key of keys) {
    raw
      .prepare(
        `INSERT INTO tasks (id, owner_id, key, title, detail, status, priority, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 'todo', 0, '[]', ?, ?)`,
      )
      .run(`${owner}:${key}`, owner, key, `Task ${key}`, ts, ts);
  }
  for (const [from, to] of edges) {
    raw.prepare('INSERT INTO edges (owner_id, from_id, to_id) VALUES (?, ?, ?)').run(owner, `${owner}:${from}`, `${owner}:${to}`);
  }
}

beforeEach(() => {
  // `migrated: true` applies 0001 and only 0001 — the shape the deployed
  // database was in before any of this.
  db = createTestDb();
  legacyGraph(TOKEN, 'Site relaunch', ['brand', 'homepage', 'staging'], [
    ['homepage', 'brand'],
    ['staging', 'homepage'],
  ]);
  legacyGraph(OTHER_TOKEN, 'Weekend trip', ['train'], []);
});

describe('0002 backfill', () => {
  it('gives an existing graph a handle, with its tasks and edges intact', async () => {
    await ensureSchema(db);

    const graphs = await listGraphs(db, TOKEN);
    expect(graphs).toHaveLength(1);
    expect(graphs[0].id).toMatch(/^g_[0-9a-f]{16}$/);
    expect(graphs[0].title).toBe('Site relaunch');

    const state = await loadGraph(db, graphs[0].id);
    expect(state.tasks.map((t) => t.key).sort()).toEqual(['brand', 'homepage', 'staging']);
    expect(state.edges).toHaveLength(2);
  });

  it('keeps one token\'s rows out of another token\'s handle', async () => {
    await ensureSchema(db);

    const mine = await listGraphs(db, TOKEN);
    const theirs = await listGraphs(db, OTHER_TOKEN);

    expect(mine[0].id).not.toBe(theirs[0].id);
    expect((await loadGraph(db, theirs[0].id)).tasks.map((t) => t.key)).toEqual(['train']);
  });

  it('does nothing the second time, which is what lets a cold start run it', async () => {
    await ensureSchema(db);
    const first = await listGraphs(db, TOKEN);

    // Every cold start replays the whole migration set. Without the
    // WHERE NOT EXISTS guards this is where a graph would be duplicated.
    for (let run = 0; run < 3; run += 1) {
      await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
    }

    const after = await listGraphs(db, TOKEN);
    expect(after).toEqual(first);
    expect((await loadGraph(db, first[0].id)).tasks).toHaveLength(3);
  });

  it('does not resurrect the legacy tables once 0003 has dropped them', async () => {
    await ensureSchema(db);
    const before = await listGraphs(db, TOKEN);
    expect(before).toHaveLength(1);

    // Run 0003 the way `wrangler d1 migrations apply` would.
    for (const statement of statementsOf(dropSql)) rawDb(db).exec(statement);
    expect(rawDb(db).prepare("SELECT name FROM sqlite_master WHERE name = 'graphs'").all()).toHaveLength(0);

    // A cold start is a fresh isolate against the same database: no memo,
    // so the whole bootstrap runs again. It used to recreate what 0003 had
    // just dropped, which made the migration pointless.
    const coldStart = Object.create(db) as D1Database;
    await ensureSchema(coldStart);

    expect(tableNames(db)).not.toContain('graphs');
    expect(tableNames(db)).not.toContain('tasks');
    expect(await listGraphs(coldStart, TOKEN)).toEqual(before);
  });

  it('never creates the legacy tables on a database that never had them', async () => {
    const fresh = createTestDb({ migrated: false });

    await ensureSchema(fresh);

    // A new deployment has no pre-handle past to carry forward, so it gets
    // the current schema and nothing else.
    expect(tableNames(fresh)).toEqual(expect.arrayContaining(['graph_handles', 'graph_tasks', 'graph_edges']));
    expect(tableNames(fresh)).not.toContain('graphs');
  });

  it('keeps a legacy T-keyed task editable, while refusing to create another', async () => {
    // Graphs written before keys had to mean something are full of T1, T2.
    // The rule is about CREATION: stranding those graphs would be worse
    // than the placeholder keys they carry.
    legacyGraph('aB3dEf7hJ9kLmN2pQr5sT8uV1wX4yZ6-_cVbNmQ', 'Old plan', ['T1', 'T2'], []);
    const graph = (await resolveGraph(db, 'aB3dEf7hJ9kLmN2pQr5sT8uV1wX4yZ6-_cVbNmQ'))!.id;

    await mergeGraph(db, graph, { tasks: [{ key: 'T1', title: 'Renamed, still T1' }] });
    expect((await loadGraph(db, graph)).tasks.find((t) => t.key === 'T1')?.title).toBe('Renamed, still T1');

    await expect(mergeGraph(db, graph, { tasks: [{ key: 'T3', title: 'A new one' }] })).rejects.toBeInstanceOf(GraphError);
  });

  it('keeps serving the migrated graph as the default, with no handle passed', async () => {
    const graph = await resolveGraph(db, TOKEN);

    // A conversation that predates handles carries none, and still lands on
    // the graph it was working in.
    expect(graph?.title).toBe('Site relaunch');
    await mergeGraph(db, graph!.id, { tasks: [{ key: 'prod', title: 'Production cutover' }] });
    expect((await loadGraph(db, graph!.id)).tasks).toHaveLength(4);
  });
});

describe('the backfill after a delete', () => {
  it('does not resurrect a graph the owner deleted', async () => {
    await ensureSchema(db);
    const [mine] = await listGraphs(db, TOKEN);
    expect(await deleteGraph(db, TOKEN, mine.id)).toBe(true);

    // The cold start that used to bring it back: the owner has no handle
    // again, so the "has this owner got one?" guard alone would re-mint it.
    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));

    expect(await listGraphs(db, TOKEN)).toEqual([]);
    expect(await resolveGraph(db, TOKEN)).toBeNull();
    // The other token is untouched by any of it.
    expect(await listGraphs(db, OTHER_TOKEN)).toHaveLength(1);
  });

  it('does not pour a deleted graph into a surviving one', async () => {
    await ensureSchema(db);
    const [migrated] = await listGraphs(db, TOKEN);
    const fresh = await createGraph(db, TOKEN, 'Later plan');
    await mergeGraph(db, fresh.id, { tasks: [{ key: 'new', title: 'Something else' }] });
    await deleteGraph(db, TOKEN, migrated.id);

    await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));

    // Without the receipt, `tasks`/`edges` would land in the oldest
    // surviving handle, which is a plan the user never put them in.
    expect((await loadGraph(db, fresh.id)).tasks.map((t) => t.key)).toEqual(['new']);
    expect(await listGraphs(db, TOKEN)).toHaveLength(1);
  });
});
