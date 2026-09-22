/**
 * The Mermaid dump: selectable, and capped by default.
 *
 * WHY A CAP AT ALL. A diagram is the one tool result that is *meant* to be
 * read as text, which makes it the one place where a big graph can quietly
 * cost thousands of tokens per call. The cap makes that a decision rather
 * than an accident — but only an accident. A caller naming `max_chars` gets
 * that number, and an overflow hands back a token that renders the graph
 * whole without needing to know its size first. There is no adversary here
 * to withhold anything from; it is the same caller on both sides.
 */

import { describe, expect, it } from 'vitest';

import { client, textOf } from './mcp-client.ts';

interface Drawn {
  graph: string;
  tasks: number;
  selected?: number;
  mermaid: string | null;
  overflow?: { chars: number; limit: number; override_token: string };
  hint?: string;
}

/** A chain step-1 -> step-2 -> … of `n` tasks, with realistic titles. */
function chain(n: number) {
  return {
    title: 'Big plan',
    tasks: Array.from({ length: n }, (_, i) => ({
      key: `step-${i + 1}`,
      title: `Task number ${i + 1}, with a title of a realistic length`,
      ...(i > 0 ? { parents: [`step-${i}`] } : {}),
    })),
  };
}

describe('mermaid', () => {
  it('draws the whole graph when it fits', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(6) });

    const drawn = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'] });

    expect(drawn.mermaid!.startsWith('graph TD')).toBe(true);
    expect(drawn.tasks).toBe(6);
    expect(drawn.selected).toBeUndefined();
    expect(drawn.mermaid).toContain('Task number 1');
  });

  it('draws a neighbourhood when asked for one', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(20) });

    const drawn = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], keys: ['step-10'], depth: 1 });

    // step-9 (prerequisite), step-10 (seed), step-11 (dependent), no more.
    expect(drawn.selected).toBe(3);
    expect(drawn.tasks).toBe(20);
    expect(drawn.mermaid).toContain('Task number 10');
    expect(drawn.mermaid).not.toContain('Task number 12');
  });

  it('walks one direction when told to', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(20) });

    const up = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], keys: ['step-10'], depth: 2, direction: 'up' });

    expect(up.selected).toBe(3);
    expect(up.mermaid).toContain('Task number 8');
    expect(up.mermaid).not.toContain('Task number 11');
  });

  it('filters by status, and never drops the seed', async () => {
    const mcp = client();
    const planned = await mcp.json<{ graph: string }>('write', { ...chain(6) });
    await mcp.json('write', { graph: planned.graph, tasks: [{ key: 'step-3', status: 'done' }] });

    const kept = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], keys: ['step-3'], depth: 1, status: ['todo'] });

    // step-3 is done and still drawn: it is what was asked about.
    expect(kept.mermaid).toContain('Task number 3');
    expect(kept.selected).toBe(3);
  });

  it('refuses to render a selection that matches nothing', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(4) });

    const empty = await mcp.tool('read', { include: ['summary', 'mermaid'], keys: ['nope'] });

    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('Nothing selected');
  });
});

describe('the cap, and the one way past it', () => {
  it('reports the size instead of returning a half diagram', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(120) });

    const over = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'] });

    expect(over.overflow!.chars).toBeGreaterThan(over.overflow!.limit);
    expect(over.tasks).toBe(120);
    expect(over.overflow!.override_token).toMatch(/^ov_[0-9a-f]{12}$/);
    // Not a truncated diagram: half a Mermaid document is a syntax error,
    // not a smaller picture.
    expect(over.mermaid).toBeNull();
  });

  it('suggests narrowing first, and says so differently once narrowed', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(120) });

    const whole = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'] });
    // Narrowed, but not narrowed *enough* — every task is todo, so the
    // filter selects the whole graph and it still does not fit. That is the
    // case where the hint has to say something other than "try narrowing".
    const narrowed = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], status: ['todo'] });

    expect(whole.hint).toContain('Select with keys');
    expect(narrowed.hint).toContain('Narrow further');
  });

  it('honours the token it minted, once', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(120) });
    const over = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'] });

    const whole = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], override_token: over.overflow!.override_token });
    expect(whole.tasks).toBe(120);
    expect(whole.mermaid!.length).toBeGreaterThan(over.overflow!.limit);

    // Single use: the same token does not work twice.
    const again = await mcp.tool('read', { include: ['summary', 'mermaid'], override_token: over.overflow!.override_token });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('already been used');
  });

  it('will not take a token minted for another graph', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(120) });
    const over = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'] });
    const other = await mcp.json<{ graph: string }>('write', { new_graph: true, title: 'Elsewhere', tasks: [{ key: 'one', title: 'One' }] });

    const rejected = await mcp.tool('read', { include: ['summary', 'mermaid'], graph: other.graph, override_token: over.overflow!.override_token });

    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('not valid for this graph');
  });

  it('takes a bigger budget at face value when one is asked for', async () => {
    const mcp = client();
    await mcp.json('write', { ...chain(120) });

    // The default cap is there so a big graph cannot arrive whole by
    // accident. Naming a number is not an accident, and there is no
    // adversary here to withhold it from -- it is the same caller either way.
    const asked = await mcp.json<Drawn>('read', { include: ['summary', 'mermaid'], max_chars: 500_000 });

    expect(asked.tasks).toBe(120);
    expect(asked.mermaid!.length).toBeGreaterThan(4000);
  });
});
