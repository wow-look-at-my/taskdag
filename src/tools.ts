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
/** What a read returns when it does not say: the cheapest useful answer. */
const DEFAULT_INCLUDE = ['summary', 'ready'] as const;
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

function countsOf(state: GraphState): Record<string, number> {
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
    counts: countsOf(state),
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
    // A pointer, so one call site can borrow a single property of a shared
    // definition: `common.json#/graph/properties/tasks`.
    const path = ref.replace('common.json#/', '').split('/');
    const definition = path.reduce<unknown>(
      (node, step) => (node === undefined ? undefined : (node as Record<string, unknown>)[step]),
      COMMON_SCHEMA as unknown,
    );
    if (definition === undefined) throw new Error(`No common definition for "${ref}"`);
    // Recurse: a shared definition may itself be built from shared pieces,
    // and copying it wholesale would ship those inner `$ref`s to a client
    // that cannot resolve them.
    Object.assign(resolved, inlineRefs(definition) as Record<string, unknown>);
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
  graph?: string;
  keys?: string[];
  depth?: number;
  direction?: 'up' | 'down' | 'both';
  status?: TaskStatus[];
  include?: ('summary' | 'ready' | 'tasks' | 'detail' | 'mermaid' | 'graphs')[];
  limit?: number;
  max_chars?: number;
  override_token?: string;
}

interface WriteArgs {
  graph?: string;
  new_graph?: boolean;
  title?: string;
  tasks?: TaskInput[];
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
  const readTool = { ...(READ_SCHEMA as unknown as ToolSchema), inputSchema: inlineRefs((READ_SCHEMA as unknown as ToolSchema).inputSchema) as JsonSchemaType };
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
    async (args) => guard(async () => readGraph(ctx, args)),
  );

  // -- write --------------------------------------------------------------------------
  const writeTool = { ...(WRITE_SCHEMA as unknown as ToolSchema), inputSchema: inlineRefs((WRITE_SCHEMA as unknown as ToolSchema).inputSchema) as JsonSchemaType };
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
    async ({ graph, new_graph, title, tasks }) =>
      guard(async () => {
        if (!tasks?.length && title === undefined) {
          return fail('Nothing to write: send `tasks` or `title`.');
        }

        const target =
          new_graph && graph === undefined
            ? await createGraph(ctx.db, ctx.owner, title)
            : (await resolveGraph(ctx.db, ctx.owner, graph, { create: true, title }))!;

        // One call adds and removes in the same breath: a task's `parents`
        // says what it waits for now, so "these three depend on that, and
        // that one no longer does" is one write and one receipt.
        const merged = await mergeGraph(ctx.db, target.id, { title, tasks });

        return receipt(await loadGraph(ctx.db, target.id), {
          created: merged.created_keys,
          updated: merged.updated_keys,
          ...(merged.linked ? { linked: merged.linked } : {}),
        });
      }),
  );

  // -- reset --------------------------------------------------------------------------
  const resetTool = { ...(RESET_SCHEMA as unknown as ToolSchema), inputSchema: inlineRefs((RESET_SCHEMA as unknown as ToolSchema).inputSchema) as JsonSchemaType };
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
        const target = await resolveGraph(ctx.db, ctx.owner, graph);
        if (!target) return fail(`No graph with handle "${graph}".`);
        const deleted = await resetGraph(ctx.db, target.id);
        return json({ graph: target.id, reset: true, ...deleted });
      }),
  );
}

/**
 * One read, selected then projected.
 *
 * SELECT, THEN SAY WHAT YOU WANT BACK. `keys`/`depth`/`direction`/`status`
 * pick a part of the graph; `include` says what to return about that part.
 * The two are independent, which is the point: "the ready queue AND a
 * diagram of what is blocking T7" is one call, where a tool per question
 * needed two and returned the summary twice.
 *
 * The default — no `include` — is the summary and the ready queue, because
 * that is what a board render needs and it is the cheapest useful answer.
 */
async function readGraph(ctx: ToolContext, args: ReadArgs) {
  const include = new Set(args.include?.length ? args.include : DEFAULT_INCLUDE);
  const target = await resolveGraph(ctx.db, ctx.owner, args.graph);
  const state = await loadGraph(ctx.db, target?.id ?? null);

  const selection: Selection = { keys: args.keys, depth: args.depth, direction: args.direction, status: args.status };
  const narrowed = isNarrowed(selection);
  const selected = narrowed ? selectSubgraph(state.tasks, state.edges, selection) : { tasks: state.tasks, edges: state.edges };
  if (narrowed && selected.tasks.length === 0) {
    return fail(`Nothing selected. ${args.keys?.length ? `No task matched ${args.keys.join(', ')}.` : 'No task matched that status filter.'}`);
  }

  const body: Record<string, unknown> = { graph: state.id };

  if (include.has('summary')) {
    body.title = state.title;
    body.tasks = state.tasks.length;
    body.edges = state.edges.length;
    body.counts = countsOf(state);
    if (narrowed) body.selected = selected.tasks.length;
  }

  if (include.has('ready')) {
    const ready = readyList(state, args.limit ?? DEFAULT_READY_LIMIT);
    body.ready = ready;
    const total = readyKeys(state.tasks, state.edges).length;
    if (total > ready.length) body.ready_more = total - ready.length;
  }

  if (include.has('tasks')) {
    const wanted = include.has('detail');
    const blocked = new Map(selected.tasks.map((task) => [task.key, blockedBy(task.key, state.tasks, state.edges)]));
    // `parents` is the same field `write` takes, so a task read back can be
    // sent straight through the other tool without being reshaped.
    const parents = new Map(selected.tasks.map((task) => [task.key, state.edges.filter((edge) => edge.from === task.key).map((edge) => edge.to)]));
    body.task_list = selected.tasks.map((task) => ({
      key: task.key,
      title: wanted ? task.title : shorten(task.title),
      status: task.status,
      ...(parents.get(task.key)?.length ? { parents: parents.get(task.key) } : {}),
      ...(task.priority !== 0 ? { priority: task.priority } : {}),
      ...(task.tags.length > 0 ? { tags: task.tags } : {}),
      ...(wanted && task.detail ? { detail: task.detail } : {}),
      ...(blocked.get(task.key)?.length ? { blocked_by: blocked.get(task.key) } : {}),
    }));
  }

  if (include.has('graphs')) body.graphs = await listGraphs(ctx.db, ctx.owner);

  if (include.has('mermaid')) {
    const drawn = await drawMermaid(ctx, target?.id ?? null, selected, narrowed, args);
    if (typeof drawn.error === 'string') return fail(drawn.error);
    Object.assign(body, drawn);
  }

  return json(
    body,
    state.id === null
      ? []
      : [
          {
            uri: graphUri(state.id),
            name: state.title,
            description: 'Every task and edge in this graph, as JSON.',
          },
        ],
  );
}

/**
 * The diagram, for whatever the read already selected.
 *
 * Returns either the fields to merge into the answer, or an `error` for the
 * caller to surface — it has no business deciding how a read reports one.
 */
async function drawMermaid(
  ctx: ToolContext,
  graph: string | null,
  selected: { tasks: Task[]; edges: Edge[] },
  narrowed: boolean,
  args: ReadArgs,
): Promise<Record<string, unknown> & { error?: string }> {
  if (graph === null || selected.tasks.length === 0) return { mermaid: null };

  const text = toMermaid(selected.tasks, selected.edges);
  const unlocked = args.override_token !== undefined && (await consumeOverflow(ctx.db, graph, args.override_token));
  if (args.override_token !== undefined && !unlocked) {
    return { error: 'That override_token is not valid for this graph, or has already been used. Ask again for a fresh one.' };
  }
  const limit = unlocked ? Number.POSITIVE_INFINITY : (args.max_chars ?? DEFAULT_MERMAID_CHARS);

  if (text.length > limit) {
    // No half-diagram: truncated Mermaid is a syntax error, not a smaller
    // picture. Hand back the measurements and the two ways forward.
    const token = await recordOverflow(ctx.db, graph, text.length);
    return {
      mermaid: null,
      overflow: { chars: text.length, limit, override_token: token },
      hint: narrowed
        ? 'Narrow further, or resend with override_token to get it whole.'
        : 'Select with keys + depth or status, or resend with override_token.',
    };
  }

  return { mermaid: text };
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
