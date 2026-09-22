/**
 * The Mermaid dump: selectable, capped, and only uncapped on purpose.
 *
 * WHY A CAP AT ALL. A diagram is the one tool result that is *meant* to be
 * read as text, which makes it the one place where a big graph can quietly
 * cost thousands of tokens per call. The cap makes that a decision instead
 * of an accident: the default answer to "draw the graph" is a diagram that
 * fits, and the whole thing is available to a caller that has been told it
 * does not fit and asks anyway.
 */

import { describe, expect, it } from 'vitest';

import { client, textOf } from './mcp-client.ts';

interface Mermaid {
  graph: string;
  nodes: number;
  edges: number;
  of_nodes?: number;
  mermaid: string;
}

interface Overflow {
  overflow: true;
  chars: number;
  limit: number;
  nodes: number;
  override_token: string;
  hint: string;
}

/** A chain T1 -> T2 -> ... of `n` tasks, with titles long enough to be realistic. */
function chain(n: number) {
  return {
    title: 'Big plan',
    tasks: Array.from({ length: n }, (_, i) => ({ key: `step-${i + 1}`, title: `Task number ${i + 1}, with a title of a realistic length` })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `step-${i + 2}`, to: `step-${i + 1}` })),
  };
}

describe('mermaid', () => {
  it('draws the whole graph when it fits', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(6) });

    const drawn = await mcp.json<Mermaid>('read', { what: 'mermaid' });

    expect(drawn.mermaid.startsWith('graph TD')).toBe(true);
    expect(drawn.nodes).toBe(6);
    expect(drawn.of_nodes).toBeUndefined();
    expect(drawn.mermaid).toContain('Task number 1');
  });

  it('draws a neighbourhood when asked for one', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(20) });

    const drawn = await mcp.json<Mermaid>('read', { what: 'mermaid',  keys: ['step-10'], depth: 1 });

    // T9 (prerequisite), T10 (seed), T11 (dependent), and nothing else.
    expect(drawn.nodes).toBe(3);
    expect(drawn.of_nodes).toBe(20);
    expect(drawn.mermaid).toContain('Task number 10');
    expect(drawn.mermaid).not.toContain('Task number 12');
  });

  it('walks one direction when told to', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(20) });

    const up = await mcp.json<Mermaid>('read', { what: 'mermaid',  keys: ['step-10'], depth: 2, direction: 'up' });

    expect(up.nodes).toBe(3);
    expect(up.mermaid).toContain('Task number 8');
    expect(up.mermaid).not.toContain('Task number 11');
  });

  it('filters by status, and never drops the seed', async () => {
    const mcp = client();
    const planned = await mcp.json<{ graph: string }>('write', { op: 'plan', ...chain(6) });
    await mcp.json('write', { op: 'update',  graph: planned.graph, key: 'step-3', status: 'done' });

    const kept = await mcp.json<Mermaid>('read', { what: 'mermaid',  keys: ['step-3'], depth: 1, status: ['todo'] });

    // T3 is done and still drawn: it is what was asked about.
    expect(kept.mermaid).toContain('Task number 3');
    expect(kept.nodes).toBe(3);
  });

  it('refuses to render a selection that matches nothing', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(4) });

    const empty = await mcp.tool('read', { what: 'mermaid',  keys: ['nope'] });

    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('Nothing selected');
  });
});

describe('the cap, and the one way past it', () => {
  it('reports the size instead of returning a half diagram', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(120) });

    const over = await mcp.json<Overflow>('read', { what: 'mermaid' });

    expect(over.overflow).toBe(true);
    expect(over.chars).toBeGreaterThan(over.limit);
    expect(over.nodes).toBe(120);
    expect(over.override_token).toMatch(/^ov_[0-9a-f]{12}$/);
    // Not a truncated diagram: half a Mermaid document is a syntax error,
    // not a smaller picture.
    expect(over).not.toHaveProperty('read', { what: 'mermaid' });
  });

  it('suggests narrowing first, and says so differently once narrowed', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(120) });

    const whole = await mcp.json<Overflow>('read', { what: 'mermaid' });
    // Narrowed, but not narrowed *enough* — every task is todo, so the
    // filter selects the whole graph and it still does not fit. That is the
    // case where the hint has to say something other than "try narrowing".
    const narrowed = await mcp.json<Overflow>('read', { what: 'mermaid',  status: ['todo'] });

    expect(whole.hint).toContain('Select a part of it');
    expect(narrowed.hint).toContain('Narrow further');
  });

  it('honours the token it minted, once', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(120) });
    const over = await mcp.json<Overflow>('read', { what: 'mermaid' });

    const whole = await mcp.json<Mermaid>('read', { what: 'mermaid',  override_token: over.override_token });
    expect(whole.nodes).toBe(120);
    expect(whole.mermaid.length).toBeGreaterThan(over.limit);

    // Single use: the same token does not work twice.
    const again = await mcp.tool('read', { what: 'mermaid',  override_token: over.override_token });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('already been used');
  });

  it('will not take a token minted for another graph', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(120) });
    const over = await mcp.json<Overflow>('read', { what: 'mermaid' });
    const other = await mcp.json<{ graph: string }>('write', { op: 'plan',  new_graph: true, title: 'Elsewhere', tasks: [{ key: 'one', title: 'One' }] });

    const rejected = await mcp.tool('read', { what: 'mermaid',  graph: other.graph, override_token: over.override_token });

    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('not valid for this graph');
  });

  it('cannot be talked past the cap by asking for a bigger budget', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...chain(120) });

    // The schema itself stops this: no amount of asking raises the ceiling,
    // only a token from a render that actually overflowed does.
    const greedy = await mcp.tool('read', { what: 'mermaid',  max_chars: 500000 });

    expect(greedy.isError).toBe(true);
  });
});
