/**
 * The rules that decide what is ready and what is a cycle, tested where
 * they live: pure functions, no database, no MCP.
 */

import { describe, expect, it } from 'vitest';

import { assignKeys, blockedBy, findCycle, isAcyclic, nextAutoKey, readyKeys, selectSubgraph, toMermaid } from '../src/graph.ts';
import type { Edge, Task, TaskStatus } from '../src/graph.ts';
import { isOwnerToken } from '../src/token.ts';

function task(key: string, status: TaskStatus = 'todo', priority = 0): Task {
  return { key, title: `task ${key}`, detail: '', status, priority, tags: [] };
}

describe('findCycle', () => {
  it('finds a simple cycle and reports it as task keys', () => {
    const edges: Edge[] = [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T3' },
      { from: 'T3', to: 'T1' },
    ];
    const cycle = findCycle(['T1', 'T2', 'T3'], edges);
    expect(cycle).not.toBeNull();
    // Closed loop: the first key repeats at the end.
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['T1', 'T2', 'T3']));
  });

  it('accepts a diamond', () => {
    const edges: Edge[] = [
      { from: 'prod', to: 'staging' },
      { from: 'staging', to: 'homepage' },
      { from: 'staging', to: 'cms' },
      { from: 'homepage', to: 'brand' },
      { from: 'cms', to: 'brand' },
    ];
    expect(findCycle(['prod', 'staging', 'homepage', 'cms', 'brand'], edges)).toBeNull();
    expect(isAcyclic(['prod', 'staging', 'homepage', 'cms', 'brand'], edges)).toBe(true);
  });

  it('treats a self-edge as a cycle', () => {
    expect(findCycle(['T1'], [{ from: 'T1', to: 'T1' }])).toEqual(['T1', 'T1']);
  });

  it('does not blow the stack on a long chain', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `T${i}`);
    const edges = keys.slice(1).map((key, i) => ({ from: key, to: keys[i] }));
    expect(findCycle(keys, edges)).toBeNull();
  });

  it('is unbothered by a graph with no edges', () => {
    expect(findCycle(['T1', 'T2'], [])).toBeNull();
  });
});

describe('readyKeys', () => {
  const edges: Edge[] = [
    { from: 'homepage', to: 'brand' },
    { from: 'staging', to: 'homepage' },
    { from: 'staging', to: 'cms' },
    { from: 'prod', to: 'staging' },
  ];

  it('is todo tasks whose dependencies are all done', () => {
    const tasks = [task('brand', 'done'), task('cms'), task('homepage'), task('staging'), task('prod')];
    expect(readyKeys(tasks, edges)).toEqual(['cms', 'homepage']);
  });

  it('excludes tasks that are not todo', () => {
    const tasks = [task('brand', 'done'), task('cms', 'in_progress'), task('homepage', 'blocked')];
    expect(readyKeys(tasks, edges)).toEqual([]);
  });

  it('does not treat a cancelled dependency as satisfied', () => {
    const tasks = [task('brand', 'cancelled'), task('homepage')];
    expect(readyKeys(tasks, edges)).toEqual([]);
  });

  it('ignores edges pointing at tasks that no longer exist', () => {
    expect(readyKeys([task('homepage')], edges)).toEqual(['homepage']);
  });

  it('sorts by priority, then key', () => {
    const tasks = [task('T1', 'todo', 0), task('T2', 'todo', 5), task('T10', 'todo', 5)];
    expect(readyKeys(tasks, [])).toEqual(['T2', 'T10', 'T1']);
  });

  it('reports what a blocked task is waiting on', () => {
    const tasks = [task('brand'), task('homepage')];
    expect(blockedBy('homepage', tasks, edges)).toEqual(['brand']);
    expect(blockedBy('brand', tasks, edges)).toEqual([]);
  });
});

describe('keys', () => {
  it('takes the next free number rather than filling gaps', () => {
    expect(nextAutoKey([])).toBe('T1');
    expect(nextAutoKey(['T1', 'T2', 'T9'])).toBe('T10');
    expect(nextAutoKey(['T1', 'T3'])).toBe('T4');
    expect(nextAutoKey(['brand', 'cms'])).toBe('T1');
  });

  it('assigns without colliding with each other or with existing keys', () => {
    expect(assignKeys(['T1'], [undefined, 'brand', undefined])).toEqual(['T2', 'brand', 'T3']);
  });
});

describe('toMermaid', () => {
  it('draws arrows from prerequisite to dependent', () => {
    const mermaid = toMermaid([task('brand', 'done'), task('homepage')], [{ from: 'homepage', to: 'brand' }]);
    expect(mermaid).toContain('graph TD');
    // Stored edge is homepage -> brand ("homepage depends on brand");
    // the drawing points the other way, brand first.
    expect(mermaid).toContain('nbrand --> nhomepage');
    expect(mermaid).toContain(':::done');
  });

  it('escapes quotes and skips edges to missing tasks', () => {
    const quoted: Task = { ...task('T1'), title: 'ship "the" thing' };
    const mermaid = toMermaid([quoted], [{ from: 'T1', to: 'gone' }]);
    expect(mermaid).toContain("ship 'the' thing");
    expect(mermaid).not.toContain('ngone');
  });
});

describe('isOwnerToken', () => {
  const real = 'A'.repeat(0) + 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';

  it('accepts a 43-char base64url token with real entropy', () => {
    expect(real).toHaveLength(43);
    expect(isOwnerToken(real)).toBe(true);
  });

  it('rejects the obvious guesses', () => {
    for (const bad of ['test', 'foobar', 'mcp', '', 'a'.repeat(43), '0'.repeat(43), 'ab'.repeat(22).slice(0, 43)]) {
      expect(isOwnerToken(bad)).toBe(false);
    }
  });

  it('rejects near misses: wrong length, wrong alphabet, a UUID', () => {
    expect(isOwnerToken(real.slice(0, 42))).toBe(false);
    expect(isOwnerToken(`${real}x`)).toBe(false);
    expect(isOwnerToken(`${real.slice(0, 42)}+`)).toBe(false);
    expect(isOwnerToken('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });
});

describe('selectSubgraph', () => {
  const tasks: Task[] = ['a', 'b', 'c', 'd'].map((key, i) => ({
    key,
    title: key.toUpperCase(),
    detail: '',
    status: i === 3 ? 'done' : 'todo',
    priority: 0,
    tags: [],
  }));
  // a <- b <- c <- d, i.e. b depends on a, c on b, d on c.
  const edges: Edge[] = [
    { from: 'b', to: 'a' },
    { from: 'c', to: 'b' },
    { from: 'd', to: 'c' },
  ];

  it('returns everything when nothing is selected', () => {
    expect(selectSubgraph(tasks, edges).tasks).toHaveLength(4);
  });

  it('walks out from the seeds, both ways, one hop by default', () => {
    const { tasks: kept } = selectSubgraph(tasks, edges, { keys: ['b'] });
    expect(kept.map((t) => t.key).sort()).toEqual(['a', 'b', 'c']);
  });

  it('follows depth, and only the direction asked for', () => {
    expect(selectSubgraph(tasks, edges, { keys: ['d'], depth: 2, direction: 'up' }).tasks.map((t) => t.key).sort()).toEqual(['b', 'c', 'd']);
    expect(selectSubgraph(tasks, edges, { keys: ['a'], depth: 5, direction: 'up' }).tasks.map((t) => t.key)).toEqual(['a']);
  });

  it('keeps only edges with both ends still standing', () => {
    const { edges: kept } = selectSubgraph(tasks, edges, { keys: ['a'], depth: 1 });
    expect(kept).toEqual([{ from: 'b', to: 'a' }]);
  });

  it('filters by status but never drops a seed', () => {
    // `d` is done and is the seed, so it survives its own filter; `c` is
    // todo and one hop away, so it comes along.
    const { tasks: kept } = selectSubgraph(tasks, edges, { keys: ['d'], status: ['todo'] });
    expect(kept.map((t) => t.key).sort()).toEqual(['c', 'd']);
  });

  it('selects NOTHING for keys that do not exist, rather than everything', () => {
    // The expensive failure mode: a misspelled key quietly meaning "the
    // whole graph" is both the wrong answer and the priciest one.
    expect(selectSubgraph(tasks, edges, { keys: ['ghost'] }).tasks).toEqual([]);
  });
});
