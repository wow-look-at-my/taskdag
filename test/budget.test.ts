/**
 * What this server costs a conversation.
 *
 * WHY MEASURE IT IN A TEST. Context is the scarcest thing in the room, and
 * an MCP server spends it in two places: the tool list, paid once per
 * conversation, and every tool result, paid once and then re-sent with
 * every later turn. A result that inlines the graph is the difference
 * between a task server that costs a few hundred tokens and one that costs
 * tens of thousands, and nothing about that shows up in a correctness test
 * — it just quietly makes the model dumber for the rest of the chat.
 *
 * The numbers below are ceilings, not targets, and they are deliberately
 * close to the current figures: a change that doubles them should have to
 * say so out loud, in a diff, rather than arriving unnoticed.
 */

import { describe, expect, it } from 'vitest';

import { client, textOf } from './mcp-client.ts';

/** 40 tasks in a chain, with titles the length people actually write. */
const BIG = {
  title: 'Platform migration',
  tasks: Array.from({ length: 40 }, (_, i) => ({
    key: `step-${i + 1}`,
    title: `Task number ${i + 1} with a realistic title`,
    tags: ['area:backend'],
  })),
  edges: Array.from({ length: 39 }, (_, i) => ({ from: `step-${i + 2}`, to: `step-${i + 1}` })),
};

describe('context budget', () => {
  it('keeps the whole tool list inside a few thousand tokens', async () => {
    const tools = await client().tools();
    const bytes = JSON.stringify(tools).length;

    // Three tools, not ten: `read`, `write`, and `reset` on its own because
    // hosts grant permission per tool name.
    expect(tools.map((t) => t.name).sort()).toEqual(['read', 'reset', 'write']);
    expect(bytes).toBeLessThan(8_000);

    // A tool with no description is a tool a model has to guess at. Two of
    // these shipped that way: the JSON carried `title` and the enum's
    // description, and nothing filled the field the client actually shows.
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it('answers a 40-task plan with a receipt, not a graph', async () => {
    const mcp = client();
    const result = await mcp.tool('write', { op: 'plan', ...BIG });
    const text = textOf(result);

    // The graph this call just wrote is ~9kB of JSON. None of it is here.
    expect(text.length).toBeLessThan(700);
    expect(text).not.toContain('Task number 12');
    expect(text).toContain('"tasks":40');
  });

  it('answers show and ready in a couple of hundred characters', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...BIG });

    expect(textOf(await mcp.tool('read', { what: 'board' })).length).toBeLessThan(400);
    expect(textOf(await mcp.tool('read', { what: 'ready' })).length).toBeLessThan(400);
  });

  it('never lets a single tool result carry the whole graph', async () => {
    const mcp = client();
    const planned = await mcp.json<{ graph: string }>('write', { op: 'plan', ...BIG });

    // Every tool, including the ones the board drives. The resource is the
    // only door to the full payload, and the model chooses to open it.
    for (const [name, args] of [
      ['read', { what: 'board' }],
      ['read', { what: 'ready', limit: 50 }],
      ['write', { op: 'plan', edges: [{ from: 'step-1', to: 'step-40' }] }],
      ['write', { op: 'update', key: 'step-1', status: 'done' }],
    ] as const) {
      const text = textOf(await mcp.tool(name, { graph: planned.graph, ...args }));
      expect(text.length, `${name} result`).toBeLessThan(700);
    }
  });

  it('takes a title of any length, and repeats only the front of it', async () => {
    const mcp = client();
    const essay = `Rewrite the ingestion pipeline so ${'that '.repeat(60)}it stops dropping events`;

    const planned = await mcp.json<{ graph: string }>('write', { op: 'plan', 
      title: 'Long titles',
      tasks: [{ key: 'ingestion', title: essay, detail: 'x'.repeat(50_000) }],
    });

    // Stored whole: nothing was refused, and nothing was lost.
    const graph = await mcp.readResource<{ nodes: { title: string; detail?: string }[] }>(`taskdag://graph/${planned.graph}`);
    expect(graph.nodes[0].title).toBe(essay);
    expect(graph.nodes[0].detail).toHaveLength(50_000);

    // Repeated short: the receipt and the diagram are what cost per turn.
    // A ~330-character title and a 50kB detail, and the receipt is still a
    // receipt: the ellipsis is the proof it was shortened rather than refused.
    const receipt = textOf(await mcp.tool('read', { what: 'ready',  graph: planned.graph }));
    expect(receipt.length).toBeLessThan(500);
    expect(receipt).toContain('…');

    const drawn = await mcp.json<{ mermaid: string }>('read', { what: 'mermaid',  graph: planned.graph });
    expect(drawn.mermaid).toContain('…');
    expect(drawn.mermaid.length).toBeLessThan(700);
  });

  it('caps the one result that is meant to be read as text', async () => {
    const mcp = client();
    await mcp.json('write', { op: 'plan', ...BIG });

    const drawn = await mcp.json<{ mermaid: string | null; overflow?: true }>('read', { what: 'mermaid' });

    // 40 tasks fit; the cap is what stops 400 from arriving whole.
    expect(drawn.overflow).toBeUndefined();
    expect(drawn.mermaid!.length).toBeLessThan(4000);
  });
});
