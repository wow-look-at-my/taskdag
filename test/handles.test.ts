/**
 * Handles: the 2026-07-28 replacement for a session, end to end.
 *
 * The revision that deleted `Mcp-Session-Id` said what to do instead —
 * "state that needs to span multiple requests MUST be referenced by an
 * explicit identifier the client passes on each request", minted by the
 * server and passed as an ordinary tool argument. These tests are that
 * sentence, executed: a handle comes back in a result, goes out in the next
 * call, survives having nothing in common with the request that made it,
 * and is useless to anybody else.
 */

import { describe, expect, it } from 'vitest';

import { client, linksOf, textOf } from './mcp-client.ts';
import { OTHER_TOKEN } from './mcp-client.ts';

interface Receipt {
  graph: string;
  title: string;
  tasks: number;
  edges: number;
  counts: Record<string, number>;
  ready: { key: string; title: string }[];
  created?: string[];
}

const SITE = {
  title: 'Site relaunch',
  tasks: [
    { key: 'brand', title: 'Brand refresh' },
    { key: 'cms', title: 'CMS migration' },
    { key: 'homepage', title: 'Homepage build' },
    { key: 'staging', title: 'Staging deploy' },
  ],
  edges: [
    { from: 'homepage', to: 'brand' },
    { from: 'staging', to: 'homepage' },
    { from: 'staging', to: 'cms' },
  ],
};

describe('a handle addresses the state', () => {
  it('mints one on the first write and hands it back', async () => {
    const mcp = client();
    const receipt = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    expect(receipt.graph).toMatch(/^g_[0-9a-f]{16}$/);
    expect(receipt.tasks).toBe(4);
    expect(receipt.ready.map((r) => r.key)).toEqual(['brand', 'cms']);
  });

  it('reaches the same graph from a later call that shares nothing but the handle', async () => {
    const mcp = client();
    const first = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    // No session, no connection reuse, no ordering: just the handle.
    const later = await mcp.json<Receipt>('read', { what: 'board',  graph: first.graph });

    expect(later.graph).toBe(first.graph);
    expect(later.tasks).toBe(4);
  });

  it('keeps several graphs on one connector, and lists them newest first', async () => {
    const mcp = client();
    const site = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });
    const trip = await mcp.json<Receipt>('write', { op: 'plan',  new_graph: true, title: 'Weekend trip', tasks: [{ key: 'train', title: 'Book train' }] });

    expect(trip.graph).not.toBe(site.graph);

    const { graphs } = await mcp.json<{ graphs: { id: string; title: string; tasks: number }[] }>('read', { what: 'graphs' });
    expect(graphs.map((g) => g.title)).toEqual(['Weekend trip', 'Site relaunch']);
    expect(graphs.map((g) => g.tasks)).toEqual([1, 4]);
  });

  it('defaults to the most recent graph when no handle is passed', async () => {
    const mcp = client();
    await mcp.json<Receipt>('write', { op: 'plan', ...SITE });
    const trip = await mcp.json<Receipt>('write', { op: 'plan',  new_graph: true, title: 'Weekend trip', tasks: [{ key: 'train', title: 'Book train' }] });

    const implicit = await mcp.json<Receipt>('read', { what: 'board' });

    expect(implicit.graph).toBe(trip.graph);
  });

  it('will not let one token address another token\'s handle', async () => {
    const mcp = client();
    const mine = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    const theirs = mcp.as(OTHER_TOKEN);
    const stolen = await theirs.tool('read', { what: 'board',  graph: mine.graph });

    // Indistinguishable from a handle that was never minted: a result that
    // said "exists, but not yours" would make handles probe-able.
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toContain('No graph with handle');
  });

  it('rejects a handle that is not shaped like one, without a lookup', async () => {
    const mcp = client();
    await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    const bogus = await mcp.tool('read', { what: 'board',  graph: '../../etc/passwd' });

    expect(bogus.isError).toBe(true);
    // The schema carries `pattern: ^g_[0-9a-f]{16}$`, so this is refused
    // before the handler runs and before any row is read.
    expect(textOf(bogus).toLowerCase()).toContain('graph');
  });

  it('survives a reset: the graph empties, the handle does not move', async () => {
    const mcp = client();
    const planned = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    await mcp.json('reset', { graph: planned.graph, confirm: 'RESET' });
    const after = await mcp.json<Receipt>('read', { what: 'board',  graph: planned.graph });

    expect(after.graph).toBe(planned.graph);
    expect(after.tasks).toBe(0);
  });
});

describe('the branches say what they need', () => {
  // The schema does not carry allOf/if/then for these: it costs bytes in
  // every conversation to restate what the handler can say better, with the
  // name of the missing field in it.
  it('asks for a key when reading one task', async () => {
    const refused = await client().tool('read', { what: 'task' });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('needs `key`');
  });

  it('asks for a key when updating one task', async () => {
    const refused = await client().tool('write', { op: 'update', status: 'done' });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('needs `key`');
  });

  it('asks for edges when unlinking', async () => {
    const refused = await client().tool('write', { op: 'unlink' });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('needs `edges`');
  });

  it('refuses a plan that would write nothing', async () => {
    const refused = await client().tool('write', { op: 'plan' });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('nothing to write');
  });
});

describe('a key has to name something', () => {
  it('refuses to create a task keyed like a slot number', async () => {
    const mcp = client();

    const refused = await mcp.tool('write', { op: 'plan',  title: 'Release', tasks: [{ key: 'T3', title: 'Write the tests' }] });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('names nothing');
    // The message has to carry the fix, or the model just tries again.
    expect(textOf(refused)).toContain('write-tests');
  });

  it('refuses a task with no key at all', async () => {
    const mcp = client();

    // The schema rejects this one before any handler sees it: `key` used to
    // be optional and auto-assigned, which is how T3 got minted.
    const refused = await mcp.tool('write', { op: 'plan',  title: 'Release', tasks: [{ title: 'Write the tests' }] });

    expect(refused.isError).toBe(true);
  });

  it('writes nothing at all when one task in the batch is refused', async () => {
    const mcp = client();
    const planned = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    const refused = await mcp.tool('write', { op: 'plan', 
      graph: planned.graph,
      tasks: [
        { key: 'launch-checklist', title: 'Launch checklist' },
        { key: 'T9', title: 'Something else' },
      ],
    });

    expect(refused.isError).toBe(true);
    // The good task in the same call must not have landed.
    expect((await mcp.json<Receipt>('read', { what: 'board',  graph: planned.graph })).tasks).toBe(4);
  });

  it('takes any key that carries meaning', async () => {
    const mcp = client();

    const made = await mcp.json<Receipt>('write', { op: 'plan', 
      title: 'Release',
      tasks: [
        { key: 'write-tests', title: 'Write the tests' },
        { key: 'PR-1423', title: 'Land the PR' },
        { key: 'step-1', title: 'First step' },
      ],
    });

    expect(made.tasks).toBe(3);
  });
});

describe('an empty graph is a deleted graph, for listing purposes', () => {
  it('drops out of the list when it is emptied, and comes back when it is not', async () => {
    const mcp = client();
    const kept = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });
    const scratch = await mcp.json<Receipt>('write', { op: 'plan',  new_graph: true, title: 'Scratch', tasks: [{ key: 'one', title: 'One' }] });

    await mcp.json('reset', { graph: scratch.graph, confirm: 'RESET' });
    let listed = (await mcp.json<{ graphs: { id: string }[] }>('read', { what: 'graphs' })).graphs;
    expect(listed.map((g) => g.id)).toEqual([kept.graph]);

    // The handle never stopped working -- writing to it un-hides the graph.
    await mcp.json('write', { op: 'plan',  graph: scratch.graph, tasks: [{ key: 'back-again', title: 'Back again' }] });
    listed = (await mcp.json<{ graphs: { id: string }[] }>('read', { what: 'graphs' })).graphs;
    expect(listed.map((g) => g.id).sort()).toEqual([kept.graph, scratch.graph].sort());
  });

  it('still resolves an emptied graph as the default, rather than jumping to an older one', async () => {
    const mcp = client();
    await mcp.json<Receipt>('write', { op: 'plan', ...SITE });
    const scratch = await mcp.json<Receipt>('write', { op: 'plan',  new_graph: true, title: 'Scratch', tasks: [{ key: 'one', title: 'One' }] });
    await mcp.json('reset', { graph: scratch.graph, confirm: 'RESET' });

    // Clear it, then add to it without naming it: that has to land where
    // the user was working, not in the graph before it.
    const added = await mcp.json<Receipt>('write', { op: 'plan',  tasks: [{ key: 'next-thing', title: 'Next thing' }] });

    expect(added.graph).toBe(scratch.graph);
  });
});

describe('the graph itself lives behind a resource', () => {
  it('links to it from the receipt instead of inlining it', async () => {
    const mcp = client();
    const result = await mcp.tool('write', { op: 'plan', ...SITE });
    const receipt = JSON.parse(textOf(result)) as Receipt;

    expect(linksOf(result)).toEqual([`taskdag://graph/${receipt.graph}`]);
    // The nodes are NOT in the text block. That is the whole point.
    expect(textOf(result)).not.toContain('Homepage build');
  });

  it('serves every node and edge to whoever asks for it', async () => {
    const mcp = client();
    const receipt = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    const graph = await mcp.readResource<{ nodes: { key: string }[]; edges: unknown[]; ready: string[] }>(
      `taskdag://graph/${receipt.graph}`,
    );

    expect(graph.nodes.map((n) => n.key).sort()).toEqual(['brand', 'cms', 'homepage', 'staging']);
    expect(graph.edges).toHaveLength(3);
    expect(graph.ready).toEqual(['brand', 'cms']);
  });

  it('refuses to serve another token\'s graph', async () => {
    const mcp = client();
    const mine = await mcp.json<Receipt>('write', { op: 'plan', ...SITE });

    await expect(mcp.as(OTHER_TOKEN).readResource(`taskdag://graph/${mine.graph}`)).rejects.toThrow();
  });
});
