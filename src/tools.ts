/**
 * The MCP surface: nine tools and two resources, all scoped to one token.
 *
 * TWO THINGS SHAPE THIS FILE.
 *
 * 1. RESULTS GO TO THE MODEL. There is no private channel to the App —
 *    every byte returned here also lands in the conversation, so results are
 *    one compact JSON block with capped lists, not a dump of the graph.
 * 2. PERMISSIONS ARE PER TOOL NAME. `reset` is its own tool rather than a
 *    flag on `plan` precisely so a host can auto-run `plan` and still stop
 *    and ask before a wipe. Never fold a wipe into another tool.
 */

import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { TASK_STATUSES, blockedBy, compareKeys, dependenciesOf, dependentsOf, readyKeys, toMermaid } from './graph.ts';
import type { Edge, Task } from './graph.ts';
import { GraphError, getTask, loadGraph, mergeGraph, patchTask, resetGraph, unlinkEdges } from './db.ts';
import type { GraphState } from './db.ts';
import { tokenTail } from './token.ts';

/** The board App, referenced by every UI-linked tool. */
export const BOARD_URI = 'ui://taskdag/board';
/** Read-only identity. Never carries the token itself. */
export const ME_URI = 'taskdag://me';

/**
 * How many nodes a tool result will spell out before it starts truncating.
 * A 200-node graph in every turn's context is how a task server becomes the
 * most expensive thing in the conversation.
 */
const MAX_NODES = 120;
const MAX_EDGES = 240;
/** Mermaid is for reading; past this it is noise, and the App has the graph. */
const MERMAID_MAX_NODES = 60;
const DEFAULT_READY_LIMIT = 5;

export interface ToolContext {
  db: D1Database;
  owner: string;
  /** The public `/<token>/mcp` URL, used only to derive the App's origin. */
  publicUrl: string;
  /** The bundled board HTML, compiled at build time. No runtime fetch. */
  boardHtml: string;
}

// -- Result shaping -------------------------------------------------------------------

interface GraphPayload {
  title: string;
  counts: Record<string, number>;
  nodes: { key: string; title: string; status: string; priority: number; tags?: string[] }[];
  edges: Edge[];
  truncated?: { nodes: number; edges: number };
}

function graphPayload(state: GraphState): GraphPayload {
  const counts: Record<string, number> = {};
  for (const task of state.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;

  const sorted = [...state.tasks].sort((a, b) => compareKeys(a.key, b.key));
  const nodes = sorted.slice(0, MAX_NODES).map((t) => ({
    key: t.key,
    title: t.title,
    status: t.status,
    priority: t.priority,
    ...(t.tags.length > 0 ? { tags: t.tags } : {}),
  }));
  const shown = new Set(nodes.map((n) => n.key));
  const edges = state.edges.filter((e) => shown.has(e.from) && shown.has(e.to)).slice(0, MAX_EDGES);

  const payload: GraphPayload = { title: state.title, counts, nodes, edges };
  if (sorted.length > nodes.length || state.edges.length > edges.length) {
    payload.truncated = { nodes: sorted.length - nodes.length, edges: state.edges.length - edges.length };
  }
  return payload;
}

function readyPayload(state: GraphState, limit: number): { key: string; title: string; priority: number }[] {
  const keys = readyKeys(state.tasks, state.edges).slice(0, limit);
  const byKey = new Map(state.tasks.map((t) => [t.key, t]));
  return keys.map((key) => {
    const task = byKey.get(key)!;
    return { key, title: task.title, priority: task.priority };
  });
}

/** One JSON text block. Every tool in this file returns through here. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * The payload every UI-linked tool returns: enough for `<dag-view>` to draw
 * the whole board, plus the Mermaid fallback for hosts that render no App.
 */
function boardResult(state: GraphState, extra: Record<string, unknown> = {}, readyLimit = DEFAULT_READY_LIMIT) {
  const graph = graphPayload(state);
  const body: Record<string, unknown> = {
    ...extra,
    title: state.title,
    ready: readyPayload(state, readyLimit),
    graph,
  };
  if (state.tasks.length > 0 && state.tasks.length <= MERMAID_MAX_NODES) {
    body.mermaid = toMermaid(state.tasks, state.edges);
  }
  return json(body);
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

const taskInputSchema = z.object({
  key: z.string().min(1).max(64).optional().describe('Stable key such as "T3". Omit to auto-assign the next free T<n>.'),
  title: z.string().min(1).max(200).describe('Short imperative title.'),
  detail: z.string().max(4000).optional(),
  priority: z.number().int().min(-100).max(100).optional().describe('Higher sorts first in the ready queue. Default 0.'),
  tags: z.array(z.string().max(40)).max(20).optional(),
  status: statusSchema.optional().describe('Only set this when you mean to change it; omitted leaves the existing status alone.'),
});

const edgeSchema = z.object({
  from: z.string().min(1).describe('The dependent task key: it waits.'),
  to: z.string().min(1).describe('The prerequisite task key: it must be done first.'),
});

const EDGE_NOTE = 'An edge { from, to } reads "from depends on to": to must be done before from can start.';

// -- Registration ---------------------------------------------------------------------

export function registerTaskDag(server: McpServer, ctx: ToolContext): void {
  registerResources(server, ctx);

  const load = () => loadGraph(ctx.db, ctx.owner);

  // 1. reset — the ONLY tool that deletes tasks. Kept separate from `plan`
  //    so hosts can require confirmation for it alone.
  registerAppTool(
    server,
    'reset',
    {
      title: 'Reset graph',
      description:
        'Irreversible. Clears the entire working graph (all tasks and all dependencies) for this connection. ' +
        'Use only when the user explicitly says to clear, wipe, or start over with the current graph. ' +
        'Never call this to make room for a new plan — plan merges, so a new plan needs no wipe.',
      inputSchema: z.object({ confirm: z.literal('RESET').describe('Must be the exact string "RESET".') }),
      annotations: { title: 'Reset graph', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ confirm }) => {
      if (confirm !== 'RESET') return fail('reset requires { "confirm": "RESET" } exactly. Nothing was changed.');
      const deleted = await resetGraph(ctx.db, ctx.owner);
      return json({ reset: true, ...deleted });
    },
  );

  // 2. plan — the main constructor, and the primary App.
  registerAppTool(
    server,
    'plan',
    {
      title: 'Plan / merge tasks',
      description:
        'Create or update a set of tasks and their dependencies in one call, and show the board. ' +
        'MERGES into the existing graph: a task whose key already exists is updated in place, new keys are appended, ' +
        'new edges are added, and nothing is ever deleted. Call reset only if the user explicitly asks to start over. ' +
        EDGE_NOTE,
      inputSchema: z.object({
        title: z.string().max(120).optional().describe('Renames the working graph. Omit to leave the title alone.'),
        tasks: z.array(taskInputSchema).max(200).default([]),
        edges: z.array(edgeSchema).max(400).default([]),
      }),
      annotations: { title: 'Plan / merge tasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async (args) =>
      guard(async () => {
        const merged = await mergeGraph(ctx.db, ctx.owner, args);
        const state = await load();
        return boardResult(state, { created_keys: merged.created_keys, updated_keys: merged.updated_keys });
      }),
  );

  // 3. add_tasks — plan without the edges, for "add one more thing".
  registerAppTool(
    server,
    'add_tasks',
    {
      title: 'Add tasks',
      description:
        'Append tasks to the working graph without touching dependencies. Merges by key like plan: an existing key is updated, never duplicated. ' +
        'Use plan instead when the new tasks also need dependencies.',
      inputSchema: z.object({ tasks: z.array(taskInputSchema).min(1).max(200) }),
      annotations: { title: 'Add tasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ tasks }) =>
      guard(async () => {
        const merged = await mergeGraph(ctx.db, ctx.owner, { tasks });
        const state = await load();
        return json({
          created_keys: merged.created_keys,
          updated_keys: merged.updated_keys,
          ready: readyPayload(state, DEFAULT_READY_LIMIT),
          counts: graphPayload(state).counts,
        });
      }),
  );

  // 4. link / unlink — dependency edges on their own.
  registerAppTool(
    server,
    'link',
    {
      title: 'Add dependencies',
      description: `Add dependency edges between existing tasks. Rejects cycles and self-edges; duplicate edges are ignored. ${EDGE_NOTE}`,
      inputSchema: z.object({ edges: z.array(edgeSchema).min(1).max(400) }),
      annotations: { title: 'Add dependencies', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ edges }) =>
      guard(async () => {
        const merged = await mergeGraph(ctx.db, ctx.owner, { edges });
        const state = await load();
        return json({ linked: merged.linked, ready: readyPayload(state, DEFAULT_READY_LIMIT) });
      }),
  );

  registerAppTool(
    server,
    'unlink',
    {
      title: 'Remove dependencies',
      description:
        'Remove dependency edges. Deletes edges only — the tasks themselves stay. ' +
        'Use this when a task turns out not to depend on another after all.',
      inputSchema: z.object({ edges: z.array(edgeSchema).min(1).max(400) }),
      annotations: { title: 'Remove dependencies', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ edges }) =>
      guard(async () => {
        const removed = await unlinkEdges(ctx.db, ctx.owner, edges);
        const state = await load();
        return json({ unlinked: removed, ready: readyPayload(state, DEFAULT_READY_LIMIT) });
      }),
  );

  // 5. ready — the queue, and an App.
  registerAppTool(
    server,
    'ready',
    {
      title: 'Ready queue',
      description:
        'List the tasks that can be started right now: status todo with every dependency done. ' +
        'Use this to answer "what is ready?", "what can I work on?", or "what is next?".',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(DEFAULT_READY_LIMIT) }),
      annotations: { title: 'Ready queue', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async ({ limit }) => {
      const state = await load();
      return boardResult(state, {}, limit ?? DEFAULT_READY_LIMIT);
    },
  );

  // 6. update_task — the write the board's buttons make.
  registerAppTool(
    server,
    'update_task',
    {
      title: 'Update task',
      description:
        'Change one task: its status, title, detail, priority or tags. Fields left out are untouched. ' +
        'Use this to start a task (in_progress), finish one (done), reopen one (todo), or cancel one (cancelled). ' +
        'Reopening a done task does not reopen the tasks that depend on it.',
      inputSchema: z.object({
        key: z.string().min(1).describe('The task key, e.g. "T3".'),
        status: statusSchema.optional(),
        title: z.string().min(1).max(200).optional(),
        detail: z.string().max(4000).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
      }),
      annotations: { title: 'Update task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async ({ key, ...patch }) =>
      guard(async () => {
        const task = await patchTask(ctx.db, ctx.owner, key, patch);
        const state = await load();
        // The board calls this and re-draws from the result, so it carries
        // the whole graph back rather than just the one row.
        return boardResult(state, { updated: { key: task.key, status: task.status } });
      }),
  );

  // 7. get_task — the detail panel's source, and the model's.
  registerAppTool(
    server,
    'get_task',
    {
      title: 'Get task',
      description: 'Read one task in full, with its dependencies, its dependents, and what is currently blocking it.',
      inputSchema: z.object({ key: z.string().min(1) }),
      annotations: { title: 'Get task', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async ({ key }) => {
      const task = await getTask(ctx.db, ctx.owner, key);
      if (!task) return fail(`No task with key "${key}".`);
      const state = await load();
      return json({
        task,
        depends_on: dependenciesOf(key, state.edges).sort(compareKeys),
        dependents: dependentsOf(key, state.edges).sort(compareKeys),
        blocked_by: blockedBy(key, state.tasks, state.edges).sort(compareKeys),
        ready: readyKeys(state.tasks, state.edges).includes(key),
      });
    },
  );

  // 8. show — the whole board on demand.
  registerAppTool(
    server,
    'show',
    {
      title: 'Show graph',
      description:
        'Show the current graph. format "summary" (default) returns counts plus the ready queue, "mermaid" returns a Mermaid diagram, ' +
        '"json" returns every node and edge. Use this to render or re-render the board.',
      inputSchema: z.object({ format: z.enum(['summary', 'mermaid', 'json']).default('summary') }),
      annotations: { title: 'Show graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async ({ format }) => {
      const state = await load();
      if (format === 'mermaid') {
        // Still carries `graph`, because the App draws from the same result.
        return json({ title: state.title, mermaid: toMermaid(state.tasks, state.edges), graph: graphPayload(state) });
      }
      if (format === 'json') {
        return json({ title: state.title, graph: graphPayload(state), ready: readyPayload(state, 50) });
      }
      return boardResult(state);
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
    { description: 'Which working graph this connection is bound to.', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: ME_URI,
          mimeType: 'application/json',
          text: JSON.stringify({ owner: 'capability-url', token_tail: tokenTail(ctx.owner) }),
        },
      ],
    }),
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
