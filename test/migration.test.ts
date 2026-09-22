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
import { SCHEMA_STATEMENTS, ensureSchema } from '../src/schema.ts';
import { listGraphs, loadGraph, mergeGraph, resolveGraph } from '../src/db.ts';

const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';
const OTHER_TOKEN = 'zX9wQ2eR5tY7uI0oP3aS6dF8gH1jK4lZ-_cVbNmQwEr';

let db: D1Database;

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

  it('keeps serving the migrated graph as the default, with no handle passed', async () => {
    const graph = await resolveGraph(db, TOKEN);

    // A conversation that predates handles carries none, and still lands on
    // the graph it was working in.
    expect(graph?.title).toBe('Site relaunch');
    await mergeGraph(db, graph!.id, { tasks: [{ key: 'prod', title: 'Production cutover' }] });
    expect((await loadGraph(db, graph!.id)).tasks).toHaveLength(4);
  });
});
