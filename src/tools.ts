/**
 * The MCP surface: eleven tools and three resources, all owned by one token.
 *
 * THREE THINGS SHAPE THIS FILE.
 *
 * 1. RESULTS GO TO THE MODEL, AND STAY THERE. Every byte returned here
 *    lands in the conversation and is re-sent with every later turn, so a
 *    result is a receipt — handle, title, counts, the first few ready tasks
 *    — and never a dump of the graph. The graph itself lives behind
 *    `taskdag://graph/<handle>`, which the App reads directly and the model
 *    reads only if it actually needs to.
 * 2. STATE IS ADDRESSED BY A HANDLE, NOT BY THE CONNECTION. Protocol
 *    revision 2026-07-28 deleted sessions and said cross-call state must be
 *    "referenced by an explicit identifier the client passes on each
 *    request". That identifier is `graph`, minted by the server, echoed in
 *    every result, and accepted as an ordinary argument on every tool.
 * 3. PERMISSIONS ARE PER TOOL NAME. `reset` is its own tool rather than a
 *    flag on `plan` precisely so a host can auto-run `plan` and still stop
 *    and ask before a wipe. Never fold a wipe into another tool.
 */

import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { TASK_STATUSES, blockedBy, compareKeys, dependenciesOf, dependentsOf, isNarrowed, readyKeys, selectSubgraph, toMermaid } from './graph.ts';
import type { Edge, Selection, Task } from './graph.ts';
import {
  GraphError,
  consumeOverflow,
  createGraph,
  deleteGraph,
  getTask,
  listGraphs,
  loadGraph,
  mergeGraph,
  overflowExists,
  patchTask,
  recordOverflow,
  resetGraph,
  resolveGraph,
  unlinkEdges,
} from './db.ts';
import type { GraphHandle, GraphState } from './db.ts';
import { tokenTail } from './token.ts';

/** The board App, referenced by every UI-linked tool. */
export const BOARD_URI = 'ui://taskdag/board';
/** Read-only identity. Never carries the token itself. */
export const ME_URI = 'taskdag://me';
/** One graph, in full. The expensive payload, fetched only on purpose. */
export const GRAPH_URI_TEMPLATE = 'taskdag://graph/{graph}';

export function graphUri(handle: string): string {
  return `taskdag://graph/${handle}`;
}

/** How many ready tasks a receipt names before it stops. */
const DEFAULT_READY_LIMIT = 5;
/**
 * The default character budget for a Mermaid render. Roughly a thousand
 * tokens: enough for the graphs people actually read, small enough that a
 * 200-node monster cannot land in the conversation by accident.
 */
const DEFAULT_MERMAID_CHARS = 4000;
/** The most a caller may ask for without having first been told it is too big. */
const MAX_MERMAID_CHARS = 8000;

export interface ToolContext {
  db: D1Database;
  owner: string;
  /** The public `/<token>/mcp` URL, used only to derive the App's origin. */
  publicUrl: string;
  /** The bundled board HTML, compiled at build time. No runtime fetch. */
  boardHtml: string;
}

// -- Result shaping -------------------------------------------------------------------

/** One JSON text block. Every tool in this file returns through here. */
function json(value: unknown, links: { uri: string; name: string; description: string }[] = []) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(value) },
      ...links.map((link) => ({
        type: 'resource_link' as const,
        uri: link.uri,
        name: link.name,
        description: link.description,
        mimeType: 'application/json',
      })),
    ],
  };
}

function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function counts(state: GraphState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const task of state.tasks) out[task.status] = (out[task.status] ?? 0) + 1;
  return out;
}

function readyList(state: GraphState, limit: number): { key: string; title: string }[] {
  const keys = readyKeys(state.tasks, state.edges);
  const byKey = new Map(state.tasks.map((t) => [t.key, t]));
  return keys.slice(0, limit).map((key) => ({ key, title: byKey.get(key)!.title }));
}

/**
 * The receipt every tool returns: what graph this was, how big it is, what
 * is startable, and where the rest lives.
 *
 * WHAT IS DELIBERATELY ABSENT: the nodes and the edges. A 40-task graph is
 * ~9kB of JSON, and a tool that hands that back on every call has spent
 * more context on bookkeeping than the conversation spends on the work. The
 * `resource_link` is the affordance instead — the App reads it without the
 * model paying for it, and the model can read it when the shape of the
 * whole graph is genuinely the question.
 */
function receipt(state: GraphState, extra: Record<string, unknown> = {}, readyLimit = DEFAULT_READY_LIMIT) {
  const ready = readyList(state, readyLimit);
  const body: Record<string, unknown> = {
    graph: state.id,
    title: state.title,
    tasks: state.tasks.length,
    edges: state.edges.length,
    counts: counts(state),
    ready,
    ...extra,
  };
  const readyTotal = readyKeys(state.tasks, state.edges).length;
  if (readyTotal > ready.length) body.ready_more = readyTotal - ready.length;
  return json(
    body,
    state.id === null
      ? []
      : [
          {
            uri: graphUri(state.id),
            name: state.title,
            description: 'Every task and edge in this graph, as JSON. Read it only when the whole shape matters.',
          },
        ],
  );
}

async function guard<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GraphError) return fail(err.message);
    throw err;
  }
}

// -- Schemas --------------------------------------------------------------------------

const statusSchema = z.enum(TASK_STATUSES);

/**
 * The handle argument, on every tool.
 *
 * It is optional on purpose: a connector with one graph behaves exactly as
 * it did before handles existed, and a model that has not seen a handle yet
 * is never stuck. Omitting it means "the one I touched last", which is the
 * only sane default when the protocol guarantees nothing about which
 * conversation a request came from.
 */
const graphArg = z.string().optional().describe('Graph handle ("g_…"); omit for the most recent.');

const taskInputSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(64)
    .describe('Required. A slug from the title, e.g. "write-tests". "T3" and bare numbers are refused.'),
  title: z.string().min(1).max(200).describe('Short imperative title, up to 200 chars.'),
  detail: z
    .string()
    .max(4000)
    .optional()
    .describe('Up to 4000 chars, and free per call: it lives in the resource and `get_task`, never in a result.'),
  priority: z.number().int().min(-100).max(100).optional().describe('Higher sorts first in the ready queue. Default 0.'),
  tags: z.array(z.string().max(40)).max(20).optional(),
  status: statusSchema.optional().describe('Omitted leaves the existing status alone.'),
});

const edgeSchema = z.object({
  from: z.string().min(1).describe('Dependent key (waits).'),
  to: z.string().min(1).describe('Prerequisite key (first).'),
});

const EDGE_NOTE = 'An edge { from, to } reads "from depends on to": to must be done before from can start.';

// -- Registration ---------------------------------------------------------------------

export function registerTaskDag(server: McpServer, ctx: ToolContext): void {
  registerResources(server, ctx);

  /** Reads the graph a call is about, without creating one. */
  const read = async (handle?: string): Promise<GraphState> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle);
    return loadGraph(ctx.db, graph?.id ?? null);
  };

  /** Resolves the graph a write lands in, minting one the first time. */
  const write = async (handle?: string, title?: string): Promise<GraphHandle> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle, { create: true, title });
    return graph!;
  };

  /**
   * The graph an edge-only write lands in. Deliberately NOT `write`: an edge
   * names tasks that have to exist already, so minting a graph here can only
   * ever produce an empty one that the call then fails against -- and that
   * husk would become the owner's most recent graph, silently stealing the
   * next handle-less call.
   */
  const existing = async (handle: string | undefined, what: string): Promise<GraphHandle> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle);
    if (!graph) throw new GraphError(`There is no graph to ${what} yet. Call \`plan\` first.`);
    return graph;
  };

  // 1. reset — the ONLY tool that deletes tasks. Kept separate from `plan`
  //    so hosts can require confirmation for it alone.
  registerAppTool(
    server,
    'reset',
    {
      title: 'Reset graph',
      description:
        'Irreversible. Empties one graph; the handle survives. Only when the user says clear, wipe or start over. ' +
        'Never to make room for a new plan — plan merges.',
      inputSchema: z.object({
        graph: graphArg,
        confirm: z.literal('RESET').describe('Must be the exact string "RESET".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, confirm }) =>
      guard(async () => {
        if (confirm !== 'RESET') return fail('reset requires { "confirm": "RESET" } exactly. Nothing was changed.');
        const target = await resolveGraph(ctx.db, ctx.owner, graph);
        if (!target) return fail('There is no graph to reset yet.');
        const deleted = await resetGraph(ctx.db, target.id);
        return json({ graph: target.id, reset: true, ...deleted });
      }),
  );

  // 2. plan — the constructor. Tasks, edges, or both; always a merge.
  registerAppTool(
    server,
    'plan',
    {
      title: 'Plan / merge tasks',
      description:
        'Create or update tasks and dependencies, and show the board. MERGES: an existing key is updated in place, new keys and ' +
        `edges are added, nothing is deleted. Also the way to add one task. \`new_graph\` starts a separate plan. ${EDGE_NOTE}`,
      inputSchema: z.object({
        graph: graphArg,
        new_graph: z.boolean().optional().describe('Mint a separate graph. Ignored when `graph` is given.'),
        title: z.string().max(120).optional().describe('Names the graph. Omit to leave it alone.'),
        tasks: z.array(taskInputSchema).max(200).default([]),
        edges: z.array(edgeSchema).max(400).default([]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async ({ graph, new_graph, ...args }) =>
      guard(async () => {
        const target = new_graph && graph === undefined ? await createGraph(ctx.db, ctx.owner, args.title) : await write(graph, args.title);
        const merged = await mergeGraph(ctx.db, target.id, args);
        const state = await loadGraph(ctx.db, target.id);
        return receipt(state, { created: merged.created_keys, updated: merged.updated_keys });
      }),
  );

  // 3. link / unlink — dependency edges on their own.
  registerAppTool(
    server,
    'link',
    {
      title: 'Add dependencies',
      description: `Add dependency edges between existing tasks. Cycles and self-edges are rejected, duplicates ignored. ${EDGE_NOTE}`,
      inputSchema: z.object({ graph: graphArg, edges: z.array(edgeSchema).min(1).max(400) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, edges }) =>
      guard(async () => {
        const target = await existing(graph, 'link in');
        const merged = await mergeGraph(ctx.db, target.id, { edges });
        const state = await loadGraph(ctx.db, target.id);
        return receipt(state, { linked: merged.linked });
      }),
  );

  registerAppTool(
    server,
    'unlink',
    {
      title: 'Remove dependencies',
      description: 'Remove dependency edges. The tasks stay.',
      inputSchema: z.object({ graph: graphArg, edges: z.array(edgeSchema).min(1).max(400) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, edges }) =>
      guard(async () => {
        const target = await existing(graph, 'unlink in');
        const removed = await unlinkEdges(ctx.db, target.id, edges);
        const state = await loadGraph(ctx.db, target.id);
        return receipt(state, { unlinked: removed });
      }),
  );

  // 4. ready — the queue, and an App.
  registerAppTool(
    server,
    'ready',
    {
      title: 'Ready queue',
      description:
        'Tasks startable now: todo, with every dependency done. Answers "what is ready / next / can I work on?".',
      inputSchema: z.object({ graph: graphArg, limit: z.number().int().min(1).max(50).default(DEFAULT_READY_LIMIT) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async ({ graph, limit }) => guard(async () => receipt(await read(graph), {}, limit ?? DEFAULT_READY_LIMIT)),
  );

  // 5. update_task — the write the board's buttons make.
  registerAppTool(
    server,
    'update_task',
    {
      title: 'Update task',
      description:
        'Change one task; omitted fields are untouched. Status moves it: in_progress, done, todo, cancelled. ' +
        'Reopening a done task does not reopen its dependents.',
      inputSchema: z.object({
        graph: graphArg,
        key: z.string().min(1).describe('The task key, e.g. "T3".'),
        status: statusSchema.optional(),
        title: z.string().min(1).max(200).optional(),
        detail: z.string().max(4000).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async ({ graph, key, ...patch }) =>
      guard(async () => {
        const target = await resolveGraph(ctx.db, ctx.owner, graph);
        if (!target) return fail('There is no graph yet. Call `plan` first.');
        const task = await patchTask(ctx.db, target.id, key, patch);
        const state = await loadGraph(ctx.db, target.id);
        return receipt(state, { updated: { key: task.key, status: task.status } });
      }),
  );

  // 6. get_task — one task in full, which is almost always cheaper than the graph.
  registerAppTool(
    server,
    'get_task',
    {
      title: 'Get task',
      description: 'Read one task in full, with its dependencies, its dependents, and what is currently blocking it.',
      inputSchema: z.object({ graph: graphArg, key: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async ({ graph, key }) =>
      guard(async () => {
        const target = await resolveGraph(ctx.db, ctx.owner, graph);
        if (!target) return fail('There is no graph yet. Call `plan` first.');
        const task = await getTask(ctx.db, target.id, key);
        if (!task) return fail(`No task with key "${key}".`);
        const state = await loadGraph(ctx.db, target.id);
        return json({
          graph: target.id,
          task,
          depends_on: dependenciesOf(key, state.edges).sort(compareKeys),
          dependents: dependentsOf(key, state.edges).sort(compareKeys),
          blocked_by: blockedBy(key, state.tasks, state.edges).sort(compareKeys),
          ready: readyKeys(state.tasks, state.edges).includes(key),
        });
      }),
  );

  // 7. show — draw the board. The receipt, and nothing more, in text.
  registerAppTool(
    server,
    'show',
    {
      title: 'Show board',
      description:
        'Draw the interactive board and return its summary. For a diagram in text call `mermaid`; for the nodes and edges as ' +
        'data read taskdag://graph/<handle>.',
      inputSchema: z.object({ graph: graphArg }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async ({ graph }) => guard(async () => receipt(await read(graph))),
  );

  // 8. mermaid — the whole graph as a diagram, capped, with selection.
  registerAppTool(
    server,
    'mermaid',
    {
      title: 'Mermaid diagram',
      description:
        'The graph as a Mermaid flowchart. Narrow it with `keys` (+`depth`, `direction`) or `status`: a neighbourhood is usually ' +
        `the answer and always cheaper. Capped at ${DEFAULT_MERMAID_CHARS} chars — an overflow returns the size and a one-shot ` +
        '`override_token`, the only way past the cap.',
      inputSchema: z.object({
        graph: graphArg,
        keys: z.array(z.string().min(1)).max(50).optional().describe('Seed keys. Omit for the whole graph.'),
        depth: z.number().int().min(0).max(10).optional().describe('Hops out from `keys`. Default 1.'),
        direction: z.enum(['up', 'down', 'both']).optional().describe('up = prerequisites, down = dependents. Default both.'),
        status: z.array(statusSchema).max(5).optional().describe('Keep only these statuses; seeds always survive.'),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(MAX_MERMAID_CHARS)
          .optional()
          .describe(`Budget. Default ${DEFAULT_MERMAID_CHARS}, max ${MAX_MERMAID_CHARS} without a token.`),
        override_token: z.string().optional().describe('From a previous overflow. Single use; lifts the cap for this call.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, keys, depth, direction, status, max_chars, override_token }) =>
      guard(async () => {
        const target = await resolveGraph(ctx.db, ctx.owner, graph);
        if (!target) return fail('There is no graph yet. Call `plan` first.');
        const state = await loadGraph(ctx.db, target.id);
        if (state.tasks.length === 0) return json({ graph: target.id, title: state.title, tasks: 0, mermaid: null });

        const selection: Selection = { keys, depth, direction, status };
        const selected = selectSubgraph(state.tasks, state.edges, selection);
        if (selected.tasks.length === 0) {
          return fail(`Nothing selected. ${keys?.length ? `No task matched ${keys.join(', ')}.` : 'No task matched that status filter.'}`);
        }

        const text = toMermaid(selected.tasks, selected.edges);
        const capped = Math.min(max_chars ?? DEFAULT_MERMAID_CHARS, MAX_MERMAID_CHARS);

        // A BAD TOKEN IS ALWAYS AN ERROR; A GOOD ONE IS SPENT ONLY WHEN IT
        // IS NEEDED. Mixing up graphs has to be said out loud either way.
        // But a receipt is single use, so burning it on a call that fit
        // under the cap anyway -- "here is the token, and also a narrower
        // selection" -- would cost the model the one override it earned.
        let limit = capped;
        if (override_token !== undefined) {
          const live = text.length > capped
            ? await consumeOverflow(ctx.db, target.id, override_token)
            : await overflowExists(ctx.db, target.id, override_token);
          if (!live) {
            return fail('That override_token is not valid for this graph, or has already been used. Call mermaid again to get a fresh one.');
          }
          limit = Number.POSITIVE_INFINITY;
        }

        if (text.length > limit) {
          // No half-diagram: truncated Mermaid is not a diagram, it is a
          // syntax error the model then has to reason about. Hand back the
          // measurements and the two ways forward instead.
          const token = await recordOverflow(ctx.db, target.id, text.length);
          return json({
            graph: target.id,
            overflow: true,
            chars: text.length,
            limit,
            nodes: selected.tasks.length,
            edges: selected.edges.length,
            override_token: token,
            hint: isNarrowed(selection)
              ? 'Narrow further (fewer keys, lower depth, one direction), or resend with override_token to get it whole.'
              : 'Select a part of it with keys + depth, or filter by status. Resend with override_token to get the whole thing anyway.',
          });
        }

        return json({
          graph: target.id,
          title: state.title,
          nodes: selected.tasks.length,
          edges: selected.edges.length,
          ...(selected.tasks.length < state.tasks.length ? { of_nodes: state.tasks.length } : {}),
          mermaid: text,
        });
      }),
  );

  // 9. delete_graph — the only way a handle stops existing.
  registerAppTool(
    server,
    'delete_graph',
    {
      title: 'Delete graph',
      description:
        'Irreversible. Removes a graph entirely — tasks, edges, handle. `reset` empties one and keeps it; this makes it gone. ' +
        'Only when the user says delete or remove a whole plan.',
      inputSchema: z.object({
        // NOT `graphArg`: this is the one tool that must never fall back to
        // "the most recent one". A default that empties the wrong graph is
        // recoverable; a default that deletes it is not.
        graph: z.string().describe('Handle to delete. Required — this tool has no default.'),
        confirm: z.literal('DELETE').describe('Must be the exact string "DELETE".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, confirm }) =>
      guard(async () => {
        if (confirm !== 'DELETE') return fail('delete_graph requires { "confirm": "DELETE" } exactly. Nothing was changed.');
        // An unknown or foreign handle throws out of `resolveGraph` inside
        // `deleteGraph`, and `guard` turns that into the "no graph with
        // handle" message. There is no falsy return to test for here.
        await deleteGraph(ctx.db, ctx.owner, graph);
        return json({ deleted: graph, graphs: (await listGraphs(ctx.db, ctx.owner)).length });
      }),
  );

  // 10. graphs — how the model finds state it no longer remembers.
  registerAppTool(
    server,
    'graphs',
    {
      title: 'List graphs',
      description:
        'Every non-empty graph here, newest first: handle, title, task count. Use it to recover a handle you lost. ' +
        'An emptied graph is not listed; its handle still works.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async () => {
      const graphs = await listGraphs(ctx.db, ctx.owner);
      return json({ graphs });
    },
  );
}

// -- Resources ------------------------------------------------------------------------

function registerResources(server: McpServer, ctx: ToolContext): void {
  // Identity is a resource, not a tool: it takes no arguments and writes
  // nothing. The token itself never appears — only its last four characters,
  // which is enough for a person to tell two bookmarks apart.
  server.registerResource(
    'Who am I',
    ME_URI,
    { description: 'Which connector this is, and how many graphs it holds.', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: ME_URI,
          mimeType: 'application/json',
          text: JSON.stringify({ owner: 'capability-url', token_tail: tokenTail(ctx.owner), graphs: (await listGraphs(ctx.db, ctx.owner)).length }),
        },
      ],
    }),
  );

  /**
   * One graph, whole.
   *
   * This is where the nodes and edges went. A resource is fetched when
   * something wants it — the App on every render, the model only when the
   * shape of the graph is the actual question — instead of being pushed
   * into the conversation by every tool call that happens to touch a graph.
   *
   * The handle in the URI is resolved against this connection's token, so a
   * handle belonging to another token reads as "not found", exactly as it
   * does through the tools.
   */
  server.registerResource(
    'TaskDAG graph',
    new ResourceTemplate(GRAPH_URI_TEMPLATE, { list: undefined }),
    {
      description: 'Every task and edge in one graph, as JSON. The full payload the tool receipts leave out.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const handle = Array.isArray(variables.graph) ? variables.graph[0] : variables.graph;
      const target = await resolveGraph(ctx.db, ctx.owner, handle);
      if (!target) throw new Error(`No graph with handle "${handle}".`);
      const state = await loadGraph(ctx.db, target.id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              graph: state.id,
              title: state.title,
              nodes: state.tasks.map((t) => ({
                key: t.key,
                title: t.title,
                status: t.status,
                priority: t.priority,
                ...(t.tags.length > 0 ? { tags: t.tags } : {}),
                ...(t.detail ? { detail: t.detail } : {}),
              })),
              edges: state.edges,
              ready: readyKeys(state.tasks, state.edges),
            }),
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    'TaskDAG board',
    BOARD_URI,
    {
      description: 'Interactive dependency board: the graph, the ready queue, and the selected task.',
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: BOARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: ctx.boardHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              // The bundle is self-contained: no script, style, font or
              // fetch leaves the iframe, so every CSP list stays empty and
              // the default no-network sandbox is exactly what we want.
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
              domain: await claudeAppDomain(ctx.publicUrl),
            },
          },
        },
      ],
    }),
  );
}

/**
 * Claude's host-specific sandbox origin: sha256 of the public MCP URL, first
 * 32 hex characters, under claudemcpcontent.com. Hashing the *token* URL is
 * deliberate — the origin is per-graph, and a hash is not a way back to the
 * token.
 */
export async function claudeAppDomain(publicUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicUrl));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 32)}.claudemcpcontent.com`;
}

export type { Task };
