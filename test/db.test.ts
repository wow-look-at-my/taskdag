/**
 * The merge semantics, against real SQL (see fake-d1.ts).
 *
 * The promise this file exists to keep: `plan` NEVER deletes. A host that
 * auto-approves `plan` has to be able to trust that, because the only thing
 * standing between "replan the project" and "lose the project" is that
 * `plan` has no wipe in it and `reset` is a separate tool.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from './fake-d1.ts';
import { GraphError, createGraph, getTask, loadGraph, mergeGraph, patchTask, resetGraph, unlinkEdges } from '../src/db.ts';
import { readyKeys } from '../src/graph.ts';

const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';
const OTHER_TOKEN = 'zX9wQ2eR5tY7uI0oP3aS6dF8gH1jK4lZ-_cVbNmQwEr';

/**
 * The handles under test. Every function in db.ts is addressed by a graph
 * handle now, not by the token: the token's job is deciding which handles
 * exist, and `resolveGraph` is the only place the two meet. These are minted
 * per test so no case can lean on another's rows.
 */
let OWNER: string;
let OTHER: string;

let db: D1Database;

beforeEach(async () => {
  db = createTestDb();
  OWNER = (await createGraph(db, TOKEN)).id;
  OTHER = (await createGraph(db, OTHER_TOKEN)).id;
});

const SITE = {
  title: 'Site relaunch',
  tasks: [
    { key: 'brand', title: 'Brand refresh' },
    { key: 'homepage', title: 'Homepage build' },
    { key: 'cms', title: 'CMS migration' },
    { key: 'staging', title: 'Staging deploy' },
    { key: 'prod', title: 'Production cutover' },
  ],
  edges: [
    { from: 'homepage', to: 'brand' },
    { from: 'staging', to: 'homepage' },
    { from: 'staging', to: 'cms' },
    { from: 'prod', to: 'staging' },
  ],
};

describe('mergeGraph', () => {
  it('builds a graph in one call', async () => {
    const result = await mergeGraph(db, OWNER, SITE);
    expect(result.created_keys).toEqual(['brand', 'homepage', 'cms', 'staging', 'prod']);

    const state = await loadGraph(db, OWNER);
    expect(state.title).toBe('Site relaunch');
    expect(state.tasks).toHaveLength(5);
    expect(state.edges).toHaveLength(4);
    expect(readyKeys(state.tasks, state.edges)).toEqual(['brand', 'cms']);
  });

  it('builds a 12-node graph in one call', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ key: `T${i + 1}`, title: `Task ${i + 1}` }));
    const edges = tasks.slice(1).map((t, i) => ({ from: t.key, to: `T${i + 1}` }));
    await mergeGraph(db, OWNER, { tasks, edges });

    const state = await loadGraph(db, OWNER);
    expect(state.tasks).toHaveLength(12);
    expect(state.edges).toHaveLength(11);
  });

  it('merges: updates by key, appends new keys, and deletes nothing', async () => {
    await mergeGraph(db, OWNER, SITE);
    const second = await mergeGraph(db, OWNER, {
      tasks: [
        { key: 'homepage', title: 'Homepage build (v2)' },
        { title: 'Analytics' },
      ],
      edges: [{ from: 'T1', to: 'prod' }],
    });

    expect(second.updated_keys).toEqual(['homepage']);
    expect(second.created_keys).toEqual(['T1']); // auto key, next free number

    const state = await loadGraph(db, OWNER);
    expect(state.tasks).toHaveLength(6); // nothing from the first plan was lost
    expect(state.tasks.find((t) => t.key === 'homepage')?.title).toBe('Homepage build (v2)');
    expect(state.title).toBe('Site relaunch'); // no title given: not renamed
    expect(state.edges).toHaveLength(5);
  });

  it('leaves status alone unless the incoming task sets it', async () => {
    await mergeGraph(db, OWNER, SITE);
    await patchTask(db, OWNER, 'brand', { status: 'done' });

    await mergeGraph(db, OWNER, { tasks: [{ key: 'brand', title: 'Brand refresh', detail: 'with a new palette' }] });
    expect((await getTask(db, OWNER, 'brand'))?.status).toBe('done');

    await mergeGraph(db, OWNER, { tasks: [{ key: 'brand', title: 'Brand refresh', status: 'todo' }] });
    expect((await getTask(db, OWNER, 'brand'))?.status).toBe('todo');
  });

  it('is idempotent for duplicate edges', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { edges: SITE.edges });
    expect((await loadGraph(db, OWNER)).edges).toHaveLength(4);
  });

  it('rejects a cycle and changes nothing', async () => {
    await mergeGraph(db, OWNER, SITE);
    await expect(mergeGraph(db, OWNER, { edges: [{ from: 'brand', to: 'prod' }] })).rejects.toBeInstanceOf(GraphError);

    const state = await loadGraph(db, OWNER);
    expect(state.edges).toHaveLength(4);
    expect(state.tasks).toHaveLength(5);
  });

  it('rejects a cycle formed inside a single call, writing no tasks', async () => {
    await expect(
      mergeGraph(db, OWNER, {
        tasks: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(0);
  });

  it('rejects self-edges and unknown keys', async () => {
    await expect(mergeGraph(db, OWNER, { tasks: [{ key: 'a', title: 'A' }], edges: [{ from: 'a', to: 'a' }] })).rejects.toBeInstanceOf(
      GraphError,
    );
    await expect(mergeGraph(db, OWNER, { edges: [{ from: 'ghost', to: 'phantom' }] })).rejects.toBeInstanceOf(GraphError);
  });

  it('keeps two tokens apart', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OTHER, { title: 'Weekend trip', tasks: [{ title: 'Book train' }] });

    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(5);
    const other = await loadGraph(db, OTHER);
    expect(other.title).toBe('Weekend trip');
    expect(other.tasks.map((t) => t.title)).toEqual(['Book train']);
  });
});

describe('patchTask', () => {
  it('changes only the fields it is given', async () => {
    await mergeGraph(db, OWNER, { tasks: [{ key: 'T1', title: 'Write it', detail: 'the long version', priority: 3, tags: ['docs'] }] });
    await patchTask(db, OWNER, 'T1', { status: 'in_progress' });

    const task = await getTask(db, OWNER, 'T1');
    expect(task).toMatchObject({ status: 'in_progress', title: 'Write it', detail: 'the long version', priority: 3, tags: ['docs'] });
  });

  it('errors on an unknown key', async () => {
    await expect(patchTask(db, OWNER, 'nope', { status: 'done' })).rejects.toBeInstanceOf(GraphError);
  });

  it('does not reopen dependents when a done task is reopened', async () => {
    await mergeGraph(db, OWNER, SITE);
    await patchTask(db, OWNER, 'brand', { status: 'done' });
    await patchTask(db, OWNER, 'homepage', { status: 'done' });
    await patchTask(db, OWNER, 'brand', { status: 'todo' });

    const state = await loadGraph(db, OWNER);
    expect(state.tasks.find((t) => t.key === 'homepage')?.status).toBe('done');
  });
});

describe('unlinkEdges', () => {
  it('removes edges and keeps the tasks', async () => {
    await mergeGraph(db, OWNER, SITE);
    const removed = await unlinkEdges(db, OWNER, [{ from: 'staging', to: 'cms' }]);

    expect(removed).toBe(1);
    const state = await loadGraph(db, OWNER);
    expect(state.edges).toHaveLength(3);
    expect(state.tasks).toHaveLength(5);
  });

  it('is idempotent', async () => {
    await mergeGraph(db, OWNER, SITE);
    await unlinkEdges(db, OWNER, [{ from: 'staging', to: 'cms' }]);
    expect(await unlinkEdges(db, OWNER, [{ from: 'staging', to: 'cms' }])).toBe(0);
  });
});

describe('resetGraph', () => {
  it('wipes one token and leaves the other alone', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OTHER, { tasks: [{ title: 'Book train' }] });

    const deleted = await resetGraph(db, OWNER);
    expect(deleted).toEqual({ tasks_deleted: 5, edges_deleted: 4 });
    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(0);
    expect((await loadGraph(db, OTHER)).tasks).toHaveLength(1);
  });
});
