/**
 * D1 access: owned by a capability-URL token, addressed by a graph handle.
 *
 * TWO IDENTIFIERS, AND THEY DO DIFFERENT JOBS.
 *
 * `owner` is the path token. It is the credential, it never appears in a
 * tool result, and it decides what exists at all.
 *
 * `graph` is a handle this file mints — `g_` and 8 random bytes. It says
 * *which* working set, it is safe to hand to the model, and it is the
 * 2026-07-28 answer to a question that used to be answered by a session:
 * "state that needs to span multiple requests MUST be referenced by an
 * explicit identifier the client passes on each request".
 *
 * ONE RULE, EVERYWHERE IN THIS FILE: a handle is only ever turned into rows
 * by `resolveGraph`, which binds the owner alongside it. Past that point a
 * `graph` argument is already authorized, and a handle belonging to someone
 * else is indistinguishable from one that was never minted. No query below
 * may take a handle without having come through there.
 *
 * Tasks carry an opaque row id as well as the human `key` ("T3") because a
 * key is renameable-in-spirit and the edges need something stable to point
 * at. Callers outside this file speak keys; ids stay in here.
 */

import type { Edge, Task, TaskStatus } from './graph.ts';
import { findCycle, isPlaceholderKey, placeholderKeyMessage } from './graph.ts';
import { ensureSchema } from './schema.ts';

/** The whole working graph behind one handle, in key space. */
export interface GraphState {
  /** The handle this state came from; `null` before a token has any graph. */
  id: string | null;
  title: string;
  tasks: Task[];
  edges: Edge[];
}

/** A graph handle and what it is called. */
export interface GraphHandle {
  id: string;
  title: string;
}

/** One row of `graphs`: a handle with enough about it to choose from a list. */
export interface GraphSummary extends GraphHandle {
  updated_at: string;
  tasks: number;
}

/** One task as `plan` accepts it. */
export interface TaskInput {
  key: string;
  /** Required when the key is new; omitted leaves an existing title alone. */
  title?: string;
  detail?: string;
  priority?: number;
  tags?: string[];
  status?: TaskStatus;
}

/** The fields `update_task` can change. All optional; absent means "leave it". */
export interface TaskPatch {
  title?: string;
  detail?: string;
  priority?: number;
  tags?: string[];
  status?: TaskStatus;
}

export interface MergeResult {
  created_keys: string[];
  updated_keys: string[];
  linked: number;
}

/** A rejected write, with a message meant for the model to read out loud. */
export class GraphError extends Error {}

const DEFAULT_TITLE = 'Working graph';

function now(): string {
  return new Date().toISOString();
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

interface TaskRow {
  id: string;
  key: string;
  title: string;
  detail: string;
  status: string;
  priority: number;
  tags: string | null;
}

interface EdgeRow {
  from_key: string;
  to_key: string;
}
/**
 * A fresh handle. `g_` plus 8 random bytes: short enough that a model
 * repeats it back without mangling it, random enough that two graphs never
 * collide, and meaningless on its own — a handle is an address inside one
 * owner's partition, never a credential. The token in the URL is the
 * credential, and it is bound alongside the handle on every lookup below.
 */
export function mintHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `g_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The shape `mintHandle` produces. Anything else is rejected unread. */
export function isGraphHandle(s: string): boolean {
  return /^g_[0-9a-f]{16}$/.test(s);
}

interface GraphRow {
  id: string;
  title: string;
}

/**
 * Turns an owner (and optionally a handle) into a graph, and is the ONLY
 * place in this file that may do so.
 *
 * With a handle: the owner is bound alongside it, so another token's handle
 * comes back as "unknown", which is also what a made-up one does. The model
 * cannot tell those apart, and that is deliberate — a handle in a result is
 * not supposed to be probe-able for other people's graphs.
 *
 * Without one: the owner's most recently touched graph, which is what makes
 * a single-graph connector feel exactly like it did before handles existed.
 * `create` decides what an owner with no graphs at all gets: a fresh handle
 * on a write, and `null` on a read, because a token that has only ever
 * looked at an empty board should leave no row behind.
 */
export async function resolveGraph(
  db: D1Database,
  owner: string,
  handle?: string,
  options: { create?: boolean; title?: string } = {},
): Promise<GraphHandle | null> {
  await ensureSchema(db);

  if (handle !== undefined) {
    if (!isGraphHandle(handle)) throw new GraphError(`"${handle}" is not a graph handle. Call \`graphs\` to list the ones that exist.`);
    const row = await db.prepare('SELECT id, title FROM graph_handles WHERE id = ? AND owner_id = ?').bind(handle, owner).first<GraphRow>();
    if (!row) throw new GraphError(`No graph with handle "${handle}". Call \`graphs\` to list the ones that exist.`);
    return { id: row.id, title: row.title };
  }

  const latest = await db
    .prepare('SELECT id, title FROM graph_handles WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT 1')
    .bind(owner)
    .first<GraphRow>();
  if (latest) return { id: latest.id, title: latest.title };
  if (!options.create) return null;
  return createGraph(db, owner, options.title);
}

/** Mints a handle and the row behind it. Only ever called on a write. */
export async function createGraph(db: D1Database, owner: string, title?: string): Promise<GraphHandle> {
  await ensureSchema(db);
  const id = mintHandle();
  const ts = now();
  await db
    .prepare('INSERT INTO graph_handles (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, owner, title ?? DEFAULT_TITLE, ts, ts)
    .run();
  return { id, title: title ?? DEFAULT_TITLE };
}

/**
 * Every graph this owner has that still has something in it, newest first.
 *
 * This is the half of the design that keeps state out of the context: the
 * model does not have to remember handles across a compaction or a new
 * chat, because it can always ask for them back. One row per graph, with a
 * count rather than its contents.
 *
 * EMPTY GRAPHS ARE NOT LISTED. A graph with no tasks is a deleted graph in
 * every way that matters to a reader, and a list that fills up with the
 * husks of `reset` calls is a list nobody can use. The row survives, and so
 * does the handle — a conversation holding one keeps working, and writing
 * to it puts the graph back in the list. What is hidden is the noise, not
 * the state.
 *
 * Deliberately NOT applied to `resolveGraph`: reset-then-add has to land
 * back in the graph you just cleared, not silently in an older one.
 */
export async function listGraphs(db: D1Database, owner: string): Promise<GraphSummary[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      `SELECT g.id, g.title, g.updated_at, COUNT(t.id) AS tasks
         FROM graph_handles g
         LEFT JOIN graph_tasks t ON t.graph_id = g.id
        WHERE g.owner_id = ?
        GROUP BY g.id
       HAVING COUNT(t.id) > 0
        ORDER BY g.updated_at DESC, g.id`,
    )
    .bind(owner)
    .all<{ id: string; title: string; updated_at: string; tasks: number }>();
  return results.map((row) => ({ id: row.id, title: row.title, updated_at: row.updated_at, tasks: row.tasks ?? 0 }));
}

/** Marks a graph as the owner's most recent, which is what `resolveGraph` picks by default. */
function touchStatement(db: D1Database, graph: string, title?: string): D1PreparedStatement {
  const ts = now();
  return title === undefined
    ? db.prepare('UPDATE graph_handles SET updated_at = ? WHERE id = ?').bind(ts, graph)
    : db.prepare('UPDATE graph_handles SET title = ?, updated_at = ? WHERE id = ?').bind(title, ts, graph);
}

/** Reads one graph whole. Never writes. */
export async function loadGraph(db: D1Database, graph: string | null): Promise<GraphState> {
  await ensureSchema(db);
  if (graph === null) return { id: null, title: DEFAULT_TITLE, tasks: [], edges: [] };
  const [graphRow, taskRows, edgeRows] = await db.batch<unknown>([
    db.prepare('SELECT title FROM graph_handles WHERE id = ?').bind(graph),
    db
      .prepare('SELECT id, key, title, detail, status, priority, tags FROM graph_tasks WHERE graph_id = ? ORDER BY priority DESC, key')
      .bind(graph),
    db
      .prepare(
        `SELECT f.key AS from_key, t.key AS to_key
           FROM graph_edges e
           JOIN graph_tasks f ON f.id = e.from_id
           JOIN graph_tasks t ON t.id = e.to_id
          WHERE e.graph_id = ?`,
      )
      .bind(graph),
  ]);

  const title = ((graphRow.results as { title?: string }[])[0]?.title ?? DEFAULT_TITLE) as string;
  const tasks: Task[] = (taskRows.results as TaskRow[]).map((row) => ({
    key: row.key,
    title: row.title,
    detail: row.detail ?? '',
    status: row.status as TaskStatus,
    priority: row.priority ?? 0,
    tags: parseTags(row.tags),
  }));
  const edges: Edge[] = (edgeRows.results as EdgeRow[]).map((row) => ({ from: row.from_key, to: row.to_key }));
  return { id: graph, title, tasks, edges };
}

/** key -> row id, for one graph's existing tasks. */
async function keyIndex(db: D1Database, graph: string): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT id, key FROM graph_tasks WHERE graph_id = ?').bind(graph).all<{ id: string; key: string }>();
  return new Map(results.map((r) => [r.key, r.id]));
}

/**
 * The merge behind `plan`, `add_tasks` and `link`. MERGE ONLY: a key that
 * already exists is updated in place, a new key is appended, new edges are
 * added, and nothing is ever deleted. `reset` is the only tool that wipes,
 * which is what lets a host grant `plan` blanket permission and still ask
 * before a wipe.
 *
 * The whole merge goes out as one `db.batch`, so a rejected cycle or a
 * failed statement leaves the graph exactly as it was.
 */
export async function mergeGraph(
  db: D1Database,
  graph: string,
  input: { title?: string; tasks?: TaskInput[]; edges?: Edge[] },
): Promise<MergeResult> {
  await ensureSchema(db);
  const incomingTasks = input.tasks ?? [];
  const incomingEdges = input.edges ?? [];

  // A title is required to CREATE a task and optional to update one: the
  // caller changing a status by key should not have to repeat the title it
  // is not changing.
  for (const edge of incomingEdges) {
    if (edge.from === edge.to) throw new GraphError(`Self-dependency on "${edge.from}" is not a dependency.`);
  }

  const existing = await keyIndex(db, graph);
  const current = await loadGraph(db, graph);

  // A key that names nothing is refused, but only when it would CREATE a
  // task. Updating one that already carries such a key has to keep working:
  // graphs written before this rule exist, and refusing to touch them would
  // strand them.
  for (const task of incomingTasks) {
    const key = task.key.trim();
    if (!key) throw new GraphError('Every task needs a key.');
    if (!existing.has(key)) {
      if (isPlaceholderKey(key)) throw new GraphError(placeholderKeyMessage(task.key));
      if (!task.title?.trim()) throw new GraphError(`New task "${key}" needs a title.`);
    }
  }

  const keys = incomingTasks.map((task) => task.key.trim());

  const created: string[] = [];
  const updated: string[] = [];
  const statements: D1PreparedStatement[] = [touchStatement(db, graph, input.title)];
  const ts = now();
  const idByKey = new Map(existing);

  incomingTasks.forEach((task, i) => {
    const key = keys[i];
    const id = idByKey.get(key);
    const tags = task.tags ? JSON.stringify(task.tags) : null;
    if (id === undefined) {
      const fresh = crypto.randomUUID();
      idByKey.set(key, fresh);
      created.push(key);
      statements.push(
        db
          .prepare(
            `INSERT INTO graph_tasks (id, graph_id, key, title, detail, status, priority, tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(fresh, graph, key, task.title!, task.detail ?? '', task.status ?? 'todo', task.priority ?? 0, tags ?? '[]', ts, ts),
      );
    } else {
      updated.push(key);
      // COALESCE keeps every field the caller did not mention — status
      // included, so re-planning a graph never silently reopens work that
      // is already done.
      statements.push(
        db
          .prepare(
            `UPDATE graph_tasks
                SET title = COALESCE(?, title), detail = COALESCE(?, detail), status = COALESCE(?, status),
                    priority = COALESCE(?, priority), tags = COALESCE(?, tags), updated_at = ?
              WHERE graph_id = ? AND id = ?`,
          )
          .bind(task.title ?? null, task.detail ?? null, task.status ?? null, task.priority ?? null, tags, ts, graph, id),
      );
    }
  });

  // Edges resolve against tasks that exist after the merge, so an edge may
  // name a key this same call is creating — but not one nobody ever sent.
  const resolved: Edge[] = [];
  for (const edge of incomingEdges) {
    if (!idByKey.has(edge.from)) throw new GraphError(`Unknown task key "${edge.from}" in edges.`);
    if (!idByKey.has(edge.to)) throw new GraphError(`Unknown task key "${edge.to}" in edges.`);
    resolved.push(edge);
  }

  const mergedEdges = dedupeEdges([...current.edges, ...resolved]);
  const cycle = findCycle(idByKey.keys(), mergedEdges);
  if (cycle) {
    throw new GraphError(`These edges would create a dependency cycle: ${cycle.join(' -> ')}. Nothing was changed.`);
  }

  let linked = 0;
  for (const edge of resolved) {
    linked += 1;
    statements.push(
      db
        .prepare('INSERT INTO graph_edges (graph_id, from_id, to_id) VALUES (?, ?, ?) ON CONFLICT(from_id, to_id) DO NOTHING')
        .bind(graph, idByKey.get(edge.from)!, idByKey.get(edge.to)!),
    );
  }

  await db.batch(statements);
  return { created_keys: created, updated_keys: updated, linked };
}

function dedupeEdges(edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const id = `${edge.from}\u0000${edge.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(edge);
  }
  return out;
}

/** Removes edges. Missing edges are not an error — unlink is idempotent. */
export async function unlinkEdges(db: D1Database, graph: string, edges: readonly Edge[]): Promise<number> {
  await ensureSchema(db);
  const index = await keyIndex(db, graph);
  const statements: D1PreparedStatement[] = [];
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) throw new GraphError(`Unknown task key in unlink: ${!from ? edge.from : edge.to}`);
    statements.push(db.prepare('DELETE FROM graph_edges WHERE graph_id = ? AND from_id = ? AND to_id = ?').bind(graph, from, to));
  }
  if (statements.length === 0) return 0;
  statements.push(touchStatement(db, graph));
  const results = await db.batch(statements);
  return results.slice(0, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Patches one task. Absent fields are left alone. */
export async function patchTask(db: D1Database, graph: string, key: string, patch: TaskPatch): Promise<Task> {
  await ensureSchema(db);
  const index = await keyIndex(db, graph);
  const id = index.get(key);
  if (!id) throw new GraphError(`No task with key "${key}".`);
  await db.batch([
    db
      .prepare(
        `UPDATE graph_tasks
            SET title = COALESCE(?, title), detail = COALESCE(?, detail), status = COALESCE(?, status),
                priority = COALESCE(?, priority), tags = COALESCE(?, tags), updated_at = ?
          WHERE graph_id = ? AND id = ?`,
      )
      .bind(
        patch.title ?? null,
        patch.detail ?? null,
        patch.status ?? null,
        patch.priority ?? null,
        patch.tags ? JSON.stringify(patch.tags) : null,
        now(),
        graph,
        id,
      ),
    touchStatement(db, graph),
  ]);
  const task = await getTask(db, graph, key);
  if (!task) throw new GraphError(`No task with key "${key}".`);
  return task;
}

export async function getTask(db: D1Database, graph: string, key: string): Promise<Task | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT id, key, title, detail, status, priority, tags FROM graph_tasks WHERE graph_id = ? AND key = ?')
    .bind(graph, key)
    .first<TaskRow>();
  if (!row) return null;
  return {
    key: row.key,
    title: row.title,
    detail: row.detail ?? '',
    status: row.status as TaskStatus,
    priority: row.priority ?? 0,
    tags: parseTags(row.tags),
  };
}

/**
 * The wipe. Only `reset` reaches this, and only with `confirm: "RESET"`.
 * Scoped to one handle, which `resolveGraph` has already proved belongs to
 * the token that asked: it cannot touch another graph even if it tried.
 * The handle survives the wipe — the graph is emptied, not unmade — so a
 * conversation holding it keeps working.
 */
export async function resetGraph(db: D1Database, graph: string): Promise<{ tasks_deleted: number; edges_deleted: number }> {
  await ensureSchema(db);
  const [edgeResult, taskResult] = await db.batch([
    db.prepare('DELETE FROM graph_edges WHERE graph_id = ?').bind(graph),
    db.prepare('DELETE FROM graph_tasks WHERE graph_id = ?').bind(graph),
    db.prepare('UPDATE graph_handles SET title = ?, updated_at = ? WHERE id = ?').bind(DEFAULT_TITLE, now(), graph),
  ]);
  return { edges_deleted: edgeResult.meta.changes ?? 0, tasks_deleted: taskResult.meta.changes ?? 0 };
}

// -- Render overflow ------------------------------------------------------------------

/**
 * Remembers that a render did not fit, and hands back the token that buys
 * one uncapped retry.
 *
 * The token is the receipt for a failed attempt. `mermaid` will not render
 * past its cap without one, so "give me the whole 80k-character graph" is
 * not something a model can decide on its own — it has to have asked for
 * the graph, been told it is too big, and come back.
 */
export async function recordOverflow(db: D1Database, graph: string, chars: number): Promise<string> {
  await ensureSchema(db);
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const token = `ov_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  // ONE OUTSTANDING RECEIPT PER GRAPH. A token is only ever spent by the
  // call that comes straight back, so an older one is already dead weight;
  // without this sweep a model that overflows repeatedly and never
  // overrides leaves a row behind every time.
  await db.batch([
    db.prepare('DELETE FROM render_overflow WHERE graph_id = ?').bind(graph),
    db.prepare('INSERT INTO render_overflow (token, graph_id, chars, created_at) VALUES (?, ?, ?, ?)').bind(token, graph, chars, now()),
  ]);
  return token;
}

/**
 * Whether a token is a live receipt for this graph, without spending it.
 * A token from another graph, or one already used, reads as false here
 * exactly as it does through `consumeOverflow`.
 */
export async function overflowExists(db: D1Database, graph: string, token: string): Promise<boolean> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT token FROM render_overflow WHERE token = ? AND graph_id = ?').bind(token, graph).first<{ token: string }>();
  return row !== null;
}

/**
 * Spends an overflow token. Single use, and only for the graph that minted
 * it: a token from one graph cannot unlock another, and a second attempt
 * with the same token gets the cap back.
 */
export async function consumeOverflow(db: D1Database, graph: string, token: string): Promise<boolean> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT token FROM render_overflow WHERE token = ? AND graph_id = ?').bind(token, graph).first<{ token: string }>();
  if (!row) return false;
  await db.prepare('DELETE FROM render_overflow WHERE token = ?').bind(token).run();
  return true;
}
