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
    const receipt = await mcp.json<Receipt>('plan', SITE);

    expect(receipt.graph).toMatch(/^g_[0-9a-f]{16}$/);
    expect(receipt.tasks).toBe(4);
    expect(receipt.ready.map((r) => r.key)).toEqual(['brand', 'cms']);
  });

  it('reaches the same graph from a later call that shares nothing but the handle', async () => {
    const mcp = client();
    const first = await mcp.json<Receipt>('plan', SITE);

    // No session, no connection reuse, no ordering: just the handle.
    const later = await mcp.json<Receipt>('show', { graph: first.graph });

    expect(later.graph).toBe(first.graph);
    expect(later.tasks).toBe(4);
  });

  it('keeps several graphs on one connector, and lists them newest first', async () => {
    const mcp = client();
    const site = await mcp.json<Receipt>('plan', SITE);
    const trip = await mcp.json<Receipt>('plan', { new_graph: true, title: 'Weekend trip', tasks: [{ title: 'Book train' }] });

    expect(trip.graph).not.toBe(site.graph);

    const { graphs } = await mcp.json<{ graphs: { id: string; title: string; tasks: number }[] }>('graphs');
    expect(graphs.map((g) => g.title)).toEqual(['Weekend trip', 'Site relaunch']);
    expect(graphs.map((g) => g.tasks)).toEqual([1, 4]);
  });

  it('defaults to the most recent graph when no handle is passed', async () => {
    const mcp = client();
    await mcp.json<Receipt>('plan', SITE);
    const trip = await mcp.json<Receipt>('plan', { new_graph: true, title: 'Weekend trip', tasks: [{ title: 'Book train' }] });

    const implicit = await mcp.json<Receipt>('show');

    expect(implicit.graph).toBe(trip.graph);
  });

  it('will not let one token address another token\'s handle', async () => {
    const mcp = client();
    const mine = await mcp.json<Receipt>('plan', SITE);

    const theirs = mcp.as(OTHER_TOKEN);
    const stolen = await theirs.tool('show', { graph: mine.graph });

    // Indistinguishable from a handle that was never minted: a result that
    // said "exists, but not yours" would make handles probe-able.
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toContain('No graph with handle');
  });

  it('rejects a handle that is not shaped like one, without a lookup', async () => {
    const mcp = client();
    await mcp.json<Receipt>('plan', SITE);

    const bogus = await mcp.tool('show', { graph: '../../etc/passwd' });

    expect(bogus.isError).toBe(true);
    expect(textOf(bogus)).toContain('is not a graph handle');
  });

  it('survives a reset: the graph empties, the handle does not move', async () => {
    const mcp = client();
    const planned = await mcp.json<Receipt>('plan', SITE);

    await mcp.json('reset', { graph: planned.graph, confirm: 'RESET' });
    const after = await mcp.json<Receipt>('show', { graph: planned.graph });

    expect(after.graph).toBe(planned.graph);
    expect(after.tasks).toBe(0);
  });
});

describe('an empty graph is a deleted graph, for listing purposes', () => {
  it('drops out of the list when it is emptied, and comes back when it is not', async () => {
    const mcp = client();
    const kept = await mcp.json<Receipt>('plan', SITE);
    const scratch = await mcp.json<Receipt>('plan', { new_graph: true, title: 'Scratch', tasks: [{ title: 'One' }] });

    await mcp.json('reset', { graph: scratch.graph, confirm: 'RESET' });
    let listed = (await mcp.json<{ graphs: { id: string }[] }>('graphs')).graphs;
    expect(listed.map((g) => g.id)).toEqual([kept.graph]);

    // The handle never stopped working -- writing to it un-hides the graph.
    await mcp.json('plan', { graph: scratch.graph, tasks: [{ title: 'Back again' }] });
    listed = (await mcp.json<{ graphs: { id: string }[] }>('graphs')).graphs;
    expect(listed.map((g) => g.id).sort()).toEqual([kept.graph, scratch.graph].sort());
  });

  it('still resolves an emptied graph as the default, rather than jumping to an older one', async () => {
    const mcp = client();
    await mcp.json<Receipt>('plan', SITE);
    const scratch = await mcp.json<Receipt>('plan', { new_graph: true, title: 'Scratch', tasks: [{ title: 'One' }] });
    await mcp.json('reset', { graph: scratch.graph, confirm: 'RESET' });

    // Clear it, then add to it without naming it: that has to land where
    // the user was working, not in the graph before it.
    const added = await mcp.json<Receipt>('plan', { tasks: [{ title: 'Next thing' }] });

    expect(added.graph).toBe(scratch.graph);
  });
});

describe('delete_graph', () => {
  it('removes a graph, its tasks and its handle', async () => {
    const mcp = client();
    const keep = await mcp.json<Receipt>('plan', SITE);
    const scratch = await mcp.json<Receipt>('plan', { new_graph: true, title: 'Scratch', tasks: [{ title: 'One' }] });

    const gone = await mcp.json<{ deleted: string; graphs: number }>('delete_graph', { graph: scratch.graph, confirm: 'DELETE' });

    expect(gone.deleted).toBe(scratch.graph);
    expect(gone.graphs).toBe(1);
    const { graphs } = await mcp.json<{ graphs: { id: string }[] }>('graphs');
    expect(graphs.map((g) => g.id)).toEqual([keep.graph]);
  });

  it('has no default: a handle must be named', async () => {
    const mcp = client();
    await mcp.json<Receipt>('plan', SITE);

    // `reset` defaults to the most recent graph; this must not. Emptying
    // the wrong graph is recoverable, deleting it is not.
    const vague = await mcp.tool('delete_graph', { confirm: 'DELETE' });

    expect(vague.isError).toBe(true);
    const { graphs } = await mcp.json<{ graphs: unknown[] }>('graphs');
    expect(graphs).toHaveLength(1);
  });

  it('needs the exact confirmation, and changes nothing without it', async () => {
    const mcp = client();
    const planned = await mcp.json<Receipt>('plan', SITE);

    const unconfirmed = await mcp.tool('delete_graph', { graph: planned.graph, confirm: 'yes' });

    expect(unconfirmed.isError).toBe(true);
    expect((await mcp.json<Receipt>('show', { graph: planned.graph })).tasks).toBe(4);
  });

  it('will not delete another token\'s graph', async () => {
    const mcp = client();
    const mine = await mcp.json<Receipt>('plan', SITE);

    const theft = await mcp.as(OTHER_TOKEN).tool('delete_graph', { graph: mine.graph, confirm: 'DELETE' });

    expect(theft.isError).toBe(true);
    expect((await mcp.json<Receipt>('show', { graph: mine.graph })).tasks).toBe(4);
  });
});


describe('the graph itself lives behind a resource', () => {
  it('links to it from the receipt instead of inlining it', async () => {
    const mcp = client();
    const result = await mcp.tool('plan', SITE);
    const receipt = JSON.parse(textOf(result)) as Receipt;

    expect(linksOf(result)).toEqual([`taskdag://graph/${receipt.graph}`]);
    // The nodes are NOT in the text block. That is the whole point.
    expect(textOf(result)).not.toContain('Homepage build');
  });

  it('serves every node and edge to whoever asks for it', async () => {
    const mcp = client();
    const receipt = await mcp.json<Receipt>('plan', SITE);

    const graph = await mcp.readResource<{ nodes: { key: string }[]; edges: unknown[]; ready: string[] }>(
      `taskdag://graph/${receipt.graph}`,
    );

    expect(graph.nodes.map((n) => n.key).sort()).toEqual(['brand', 'cms', 'homepage', 'staging']);
    expect(graph.edges).toHaveLength(3);
    expect(graph.ready).toEqual(['brand', 'cms']);
  });

  it('refuses to serve another token\'s graph', async () => {
    const mcp = client();
    const mine = await mcp.json<Receipt>('plan', SITE);

    await expect(mcp.as(OTHER_TOKEN).readResource(`taskdag://graph/${mine.graph}`)).rejects.toThrow();
  });
});
