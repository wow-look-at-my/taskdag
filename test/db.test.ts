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
import { GraphError, createGraph, getTask, loadGraph, mergeGraph, patchTask, resetGraph } from '../src/db.ts';
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
    { key: 'homepage', title: 'Homepage build', parents: ['brand'] },
    { key: 'cms', title: 'CMS migration' },
    { key: 'staging', title: 'Staging deploy', parents: ['homepage', 'cms'] },
    { key: 'prod', title: 'Production cutover', parents: ['staging'] },
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
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      key: `step-${i + 1}`,
      title: `Task ${i + 1}`,
      ...(i > 0 ? { parents: [`step-${i}`] } : {}),
    }));
    await mergeGraph(db, OWNER, { tasks });

    const state = await loadGraph(db, OWNER);
    expect(state.tasks).toHaveLength(12);
    expect(state.edges).toHaveLength(11);
  });

  it('merges: updates by key, appends new keys, and deletes nothing', async () => {
    await mergeGraph(db, OWNER, SITE);
    const second = await mergeGraph(db, OWNER, {
      tasks: [
        { key: 'homepage', title: 'Homepage build (v2)' },
        { key: 'analytics', title: 'Analytics', parents: ['prod'] },
      ],
    });

    expect(second.updated_keys).toEqual(['homepage']);
    expect(second.created_keys).toEqual(['analytics']);

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

  it('is idempotent: re-declaring the same parents changes nothing', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, SITE);
    expect((await loadGraph(db, OWNER)).edges).toHaveLength(4);
  });

  it('rejects a cycle and changes nothing', async () => {
    await mergeGraph(db, OWNER, SITE);
    await expect(mergeGraph(db, OWNER, { tasks: [{ key: 'brand', parents: ['prod'] }] })).rejects.toBeInstanceOf(GraphError);

    const state = await loadGraph(db, OWNER);
    expect(state.edges).toHaveLength(4);
    expect(state.tasks).toHaveLength(5);
  });

  it('rejects a cycle formed inside a single call, writing no tasks', async () => {
    await expect(
      mergeGraph(db, OWNER, {
        tasks: [
          { key: 'a', title: 'A', parents: ['b'] },
          { key: 'b', title: 'B', parents: ['a'] },
        ],
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(0);
  });

  it('rejects a self-parent and an unknown parent', async () => {
    await expect(mergeGraph(db, OWNER, { tasks: [{ key: 'a', title: 'A', parents: ['a'] }] })).rejects.toBeInstanceOf(GraphError);
    await expect(
      mergeGraph(db, OWNER, { tasks: [{ key: 'ghost', title: 'Ghost', parents: ['phantom'] }] }),
    ).rejects.toBeInstanceOf(GraphError);
  });

  it('keeps two tokens apart', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OTHER, { title: 'Weekend trip', tasks: [{ key: 'train', title: 'Book train' }] });

    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(5);
    const other = await loadGraph(db, OTHER);
    expect(other.title).toBe('Weekend trip');
    expect(other.tasks.map((t) => t.title)).toEqual(['Book train']);
  });
});

describe('patchTask', () => {
  it('changes only the fields it is given', async () => {
    await mergeGraph(db, OWNER, { tasks: [{ key: 'write-it', title: 'Write it', detail: 'the long version', priority: 3, tags: ['docs'] }] });
    await patchTask(db, OWNER, 'write-it', { status: 'in_progress' });

    const task = await getTask(db, OWNER, 'write-it');
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

/**
 * The one rule for every list-valued field: an array IS the list, and
 * `{ add, remove }` edits the one that is there. There is no third verb,
 * and "unlink" is just a shorter list.
 */
describe('parents, as a list', () => {
  it('replaces the list, which is how an edge is removed', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', parents: ['homepage'] }] });

    const state = await loadGraph(db, OWNER);
    expect(state.edges).toHaveLength(3);
    expect(state.tasks).toHaveLength(5); // the task it pointed at is untouched
  });

  it('clears the list with []', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', parents: [] }] });
    expect((await loadGraph(db, OWNER)).edges.filter((e) => e.from === 'staging')).toEqual([]);
  });

  it('leaves the list alone when the key does not mention it', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', status: 'in_progress' }] });
    expect((await loadGraph(db, OWNER)).edges).toHaveLength(4);
  });

  it('adds and removes without restating the rest', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', parents: { add: ['brand'], remove: ['cms'] } }] });

    const parents = (await loadGraph(db, OWNER)).edges.filter((e) => e.from === 'staging').map((e) => e.to);
    expect(parents.sort()).toEqual(['brand', 'homepage']);
  });

  it('applies the same two spellings to tags', async () => {
    await mergeGraph(db, OWNER, { tasks: [{ key: 'brand', title: 'Brand refresh', tags: ['design', 'q3'] }] });
    await mergeGraph(db, OWNER, { tasks: [{ key: 'brand', tags: { add: ['urgent'], remove: ['q3'] } }] });
    expect((await getTask(db, OWNER, 'brand'))?.tags).toEqual(['design', 'urgent']);

    await mergeGraph(db, OWNER, { tasks: [{ key: 'brand', tags: [] }] });
    expect((await getTask(db, OWNER, 'brand'))?.tags).toEqual([]);
  });

  it('is idempotent: removing what is not there is not an error', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', parents: { remove: ['cms'] } }] });
    await mergeGraph(db, OWNER, { tasks: [{ key: 'staging', parents: { remove: ['cms'] } }] });
    expect((await loadGraph(db, OWNER)).edges).toHaveLength(3);
  });
});

describe('resetGraph', () => {
  it('wipes one token and leaves the other alone', async () => {
    await mergeGraph(db, OWNER, SITE);
    await mergeGraph(db, OTHER, { tasks: [{ key: 'train', title: 'Book train' }] });

    const deleted = await resetGraph(db, OWNER);
    expect(deleted).toEqual({ tasks_deleted: 5, edges_deleted: 4 });
    expect((await loadGraph(db, OWNER)).tasks).toHaveLength(0);
    expect((await loadGraph(db, OTHER)).tasks).toHaveLength(1);
  });
});
