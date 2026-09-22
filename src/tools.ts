/**
 * The MCP surface: ten tools and three resources, all owned by one token.
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
import { ResourceTemplate, fromJsonSchema } from '@modelcontextprotocol/server';
import type { JsonSchemaType, McpServer } from '@modelcontextprotocol/server';

import COMMON_SCHEMA from './schemas/common.json';
import READ_SCHEMA from './schemas/read.json';
import RESET_SCHEMA from './schemas/reset.json';
import WRITE_SCHEMA from './schemas/write.json';

import { blockedBy, compareKeys, dependenciesOf, dependentsOf, isNarrowed, readyKeys, selectSubgraph, toMermaid } from './graph.ts';
import type { Edge, Selection, Task, TaskStatus } from './graph.ts';
import {
  GraphError,
  consumeOverflow,
  createGraph,
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
import type { GraphHandle, GraphState, TaskInput } from './db.ts';
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
/** How much of a title gets repeated into a receipt or a diagram label. */
const LABEL_CHARS = 80;
/**
 * The default character budget for a Mermaid render. Roughly a thousand
 * tokens: enough for the graphs people actually read, small enough that a
 * 200-node monster cannot land in the conversation by accident.
 */
const DEFAULT_MERMAID_CHARS = 4000;

export interface ToolContext {
  db: D1Database;
  owner: string;
  /** The public `/<token>/mcp` URL, used only to derive the App's origin. */
  publicUrl: string;
  /** The bundled board HTML, compiled at build time. No runtime fetch. */
  boardHtml: string;
}

// -- Result shaping -------------------------------------------------------------------

/**
 * BOUND WHAT IS REPEATED, NOT WHAT IS STORED.
 *
 * A title is echoed into every receipt and every diagram, so an essay as a
 * title would be paid for on every turn. That is a reason to shorten it
 * where it is repeated — not a reason to refuse the write, which is what a
 * schema maximum does: `plan` is one transaction, so one long field would
 * throw away a whole batch of good tasks to protect a label.
 */
function shorten(title: string, limit = LABEL_CHARS): string {
  return title.length <= limit ? title : `${title.slice(0, limit - 1).trimEnd()}…`;
}

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
  return keys.slice(0, limit).map((key) => ({ key, title: shorten(byKey.get(key)!.title) }));
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

// -- Argument types -------------------------------------------------------------------

/**
 * What the handlers see. These mirror `src/tool-schemas.json`; the schema is
 * what validates, this is only what TypeScript reads. Every branch-specific
 * field is optional here because it is optional in the schema too — `if`/
 * `then` makes it required for one value of the discriminator, which a type
 * cannot express and a host is not obliged to enforce, so the handlers check.
 */
/**
 * Inlines `{ "$ref": "common.json#/thing" }` before the schema is
 * registered.
 *
 * WHY INLINE RATHER THAN SHIP THE REF. A `$ref` is only useful to something
 * that can fetch what it points at, and the schema goes over the wire to
 * clients that have no `common.json` and no way to ask for one. So the
 * shared definitions are a source-level convenience -- one place to change
 * the handle's pattern or the status enum -- and what a client sees is
 * still a self-contained document. A test asserts no `$ref` survives.
 *
 * A sibling key alongside the `$ref` wins, which is what lets one call site
 * say "a task key, and here is what it means HERE".
 */
function inlineRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(inlineRefs);
  if (node === null || typeof node !== 'object') return node;

  const entries = Object.entries(node as Record<string, unknown>);
  const ref = entries.find(([key]) => key === '$ref')?.[1];
  const resolved: Record<string, unknown> = {};
  if (typeof ref === 'string') {
    const name = ref.replace('common.json#/', '');
    const definition = (COMMON_SCHEMA as Record<string, unknown>)[name];
    if (definition === undefined) throw new Error(`No common definition for "${ref}"`);
    Object.assign(resolved, definition as Record<string, unknown>);
  }
  for (const [key, value] of entries) {
    if (key === '$ref') continue;
    resolved[key] = inlineRefs(value);
  }
  return resolved;
}

/** One file in `src/schemas/`. The cast is because a JSON import types
 * enums as `string`, which is not assignable to `JsonSchemaType`. */
interface ToolSchema {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  inputSchema: JsonSchemaType;
}

interface ReadArgs {
  what: 'board' | 'ready' | 'task' | 'graphs' | 'mermaid';
  graph?: string;
  key?: string;
  limit?: number;
  keys?: string[];
  depth?: number;
  direction?: 'up' | 'down' | 'both';
  status?: TaskStatus[];
  max_chars?: number;
  override_token?: string;
}

interface WriteArgs {
  op: 'plan' | 'update' | 'unlink';
  graph?: string;
  new_graph?: boolean;
  title?: string;
  tasks?: TaskInput[];
  edges?: Edge[];
  key?: string;
  task_title?: string;
  status?: TaskStatus;
  detail?: string;
  priority?: number;
  tags?: string[];
}

// -- Registration ---------------------------------------------------------------------

/**
 * The three tools, registered from `src/tool-schemas.json` verbatim.
 *
 * WHY THREE AND NOT TEN. Ten names cost ten bytes each and carried a lot of
 * meaning, so collapsing them is worth less than it looks — measured, 7.3kB
 * against 9.2kB. What it does buy is one obvious door in and one obvious
 * door out, and no pairs of tools that do the same thing, which is the bug
 * `add_tasks` and `link` both were.
 *
 * WHY RESET IS NOT `write`. Hosts grant permission per tool NAME. One writer
 * would make "yes, you may tick tasks off" and "yes, you may wipe the graph"
 * the same grant, and `destructiveHint` is per tool too, so a merged writer
 * is either always destructive (every edit prompts) or never (a wipe does
 * not). There is no `delete_graph`: reset empties a graph and an empty graph
 * is not listed, so emptying already IS deleting.
 *
 * WHY THE SCHEMAS ARE JSON, AND IN THEIR OWN FILES. `src/schemas/*.json`
 * is handed to `fromJsonSchema`, so what a client sees is those files: one
 * per tool, plus `common.json` for the things more than one of them needs
 * (the handle's pattern, the status enum, an edge). Those shared bits are
 * inlined on the way out — see `inlineRefs` — because a `$ref` is no use to
 * a client that cannot fetch it.
 *
 * They state branch requirements in the discriminator's description rather
 * than in `allOf`/`if`/`then`: a conditional costs bytes in every
 * conversation to restate what the handler says better, naming the field
 * that was missing. So every branch is re-checked below.
 */
export function registerTaskDag(server: McpServer, ctx: ToolContext): void {
  registerResources(server, ctx);

  /** Reads the graph a call is about, without creating one. */
  const read = async (handle?: string): Promise<GraphState> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle);
    return loadGraph(ctx.db, graph?.id ?? null);
  };

  /** Resolves the graph a write lands in, minting one only where that is right. */
  const write = async (handle?: string, title?: string): Promise<GraphHandle> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle, { create: true, title });
    return graph!;
  };

  /** The graph a call names, or a message saying there is none. */
  const existing = async (handle?: string): Promise<GraphHandle> => {
    const graph = await resolveGraph(ctx.db, ctx.owner, handle);
    if (!graph) throw new GraphError('There is no graph yet. Call write(op="plan") first.');
    return graph;
  };

  // -- read ---------------------------------------------------------------------------
  const readTool = { ...(READ_SCHEMA as ToolSchema), inputSchema: inlineRefs((READ_SCHEMA as ToolSchema).inputSchema) as JsonSchemaType };
  registerAppTool(
    server,
    'read',
    {
      title: readTool.title,
      description: readTool.description,
      inputSchema: fromJsonSchema<ReadArgs>(readTool.inputSchema),
      annotations: readTool.annotations,
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async (args) =>
      guard(async () => {
        const { what, graph } = args;

        if (what === 'graphs') {
          // The listing, plus the current graph drawn: a card with nothing
          // in it would be a worse answer than a card with your latest plan.
          const graphs = await listGraphs(ctx.db, ctx.owner);
          return receipt(await read(), { graphs });
        }

        if (what === 'task') {
          if (!args.key) return fail('read(what="task") needs `key`: which task?');
          const target = await existing(graph);
          const task = await getTask(ctx.db, target.id, args.key);
          if (!task) return fail(`No task with key "${args.key}".`);
          const state = await loadGraph(ctx.db, target.id);
          return json({
            graph: target.id,
            task,
            depends_on: dependenciesOf(args.key, state.edges).sort(compareKeys),
            dependents: dependentsOf(args.key, state.edges).sort(compareKeys),
            blocked_by: blockedBy(args.key, state.tasks, state.edges).sort(compareKeys),
            ready: readyKeys(state.tasks, state.edges).includes(args.key),
          });
        }

        if (what === 'mermaid') return drawMermaid(ctx, args);

        // board and ready differ only in how much of the queue they name.
        return receipt(await read(graph), {}, what === 'ready' ? (args.limit ?? DEFAULT_READY_LIMIT) : DEFAULT_READY_LIMIT);
      }),
  );

  // -- write --------------------------------------------------------------------------
  const writeTool = { ...(WRITE_SCHEMA as ToolSchema), inputSchema: inlineRefs((WRITE_SCHEMA as ToolSchema).inputSchema) as JsonSchemaType };
  registerAppTool(
    server,
    'write',
    {
      title: writeTool.title,
      description: writeTool.description,
      inputSchema: fromJsonSchema<WriteArgs>(writeTool.inputSchema),
      annotations: writeTool.annotations,
      _meta: { ui: { resourceUri: BOARD_URI, prefersBorder: true, visibility: ['model', 'app'] } },
    },
    async (args) =>
      guard(async () => {
        const { op, graph } = args;

        if (op === 'update') {
          if (!args.key) return fail('write(op="update") needs `key`: which task?');
          const target = await existing(graph);
          const task = await patchTask(ctx.db, target.id, args.key, {
            ...(args.task_title !== undefined ? { title: args.task_title } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
          });
          return receipt(await loadGraph(ctx.db, target.id), { updated: { key: task.key, status: task.status } });
        }

        if (op === 'unlink') {
          if (!args.edges || args.edges.length === 0) return fail('write(op="unlink") needs `edges`: which dependencies to remove?');
          const target = await existing(graph);
          const removed = await unlinkEdges(ctx.db, target.id, args.edges);
          return receipt(await loadGraph(ctx.db, target.id), { unlinked: removed });
        }

        // plan
        if (!args.tasks?.length && !args.edges?.length && args.title === undefined) {
          return fail('write(op="plan") needs `tasks`, `edges` or `title` — otherwise there is nothing to write.');
        }
        const target =
          args.new_graph && graph === undefined ? await createGraph(ctx.db, ctx.owner, args.title) : await write(graph, args.title);
        const merged = await mergeGraph(ctx.db, target.id, { title: args.title, tasks: args.tasks, edges: args.edges });
        return receipt(await loadGraph(ctx.db, target.id), { created: merged.created_keys, updated: merged.updated_keys });
      }),
  );

  // -- reset --------------------------------------------------------------------------
  const resetTool = { ...(RESET_SCHEMA as ToolSchema), inputSchema: inlineRefs((RESET_SCHEMA as ToolSchema).inputSchema) as JsonSchemaType };
  registerAppTool(
    server,
    'reset',
    {
      title: resetTool.title,
      description: resetTool.description,
      inputSchema: fromJsonSchema<{ graph: string; confirm: string }>(resetTool.inputSchema),
      annotations: resetTool.annotations,
      _meta: { ui: { visibility: ['model'] } },
    },
    async ({ graph, confirm }) =>
      guard(async () => {
        if (confirm !== 'RESET') return fail('reset requires { "confirm": "RESET" } exactly. Nothing was changed.');
        const target = await existing(graph);
        const deleted = await resetGraph(ctx.db, target.id);
        return json({ graph: target.id, reset: true, ...deleted });
      }),
  );
}

/** The `read(what="mermaid")` branch, lifted out to keep the switch readable. */
async function drawMermaid(ctx: ToolContext, args: ReadArgs) {
  const target = await resolveGraph(ctx.db, ctx.owner, args.graph);
  if (!target) return fail('There is no graph yet. Call write(op="plan") first.');
  const state = await loadGraph(ctx.db, target.id);
  if (state.tasks.length === 0) return json({ graph: target.id, title: state.title, tasks: 0, mermaid: null });

  const selection: Selection = { keys: args.keys, depth: args.depth, direction: args.direction, status: args.status };
  const selected = selectSubgraph(state.tasks, state.edges, selection);
  if (selected.tasks.length === 0) {
    return fail(`Nothing selected. ${args.keys?.length ? `No task matched ${args.keys.join(', ')}.` : 'No task matched that status filter.'}`);
  }

  const text = toMermaid(selected.tasks, selected.edges);
  const unlocked = args.override_token !== undefined && (await consumeOverflow(ctx.db, target.id, args.override_token));
  if (args.override_token !== undefined && !unlocked) {
    return fail('That override_token is not valid for this graph, or has already been used. Ask for the diagram again to get a fresh one.');
  }
  // The budget as asked for. The default is there so a 200-node graph
  // cannot land whole by accident; a caller naming a number is not an
  // accident, so it is taken at face value. The token stays because it
  // answers "give me all of it" without having to know the size first.
  const limit = unlocked ? Number.POSITIVE_INFINITY : (args.max_chars ?? DEFAULT_MERMAID_CHARS);

  if (text.length > limit) {
    // No half-diagram: truncated Mermaid is a syntax error, not a smaller
    // picture. Hand back the measurements and the two ways forward.
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
