/**
 * D1 access, partitioned by capability-URL token.
 *
 * ONE RULE, EVERYWHERE IN THIS FILE: every statement binds `owner_id` to the
 * token that came out of the request path. There is no query here that can
 * see two owners at once, and none should ever be added — the token is the
 * only thing standing between one person's graph and everyone else's.
 *
 * Tasks carry an opaque row id as well as the human `key` ("T3") because a
 * key is renameable-in-spirit and the edges need something stable to point
 * at. Callers outside this file speak keys; ids stay in here.
 */

import type { Edge, Task, TaskStatus } from './graph.ts';
import { assignKeys, findCycle } from './graph.ts';
import { ensureSchema } from './schema.ts';

/** The whole working graph for one token, in key space. */
export interface GraphState {
  title: string;
  tasks: Task[];
  edges: Edge[];
}

/** One task as `plan` / `add_tasks` accept it. */
export interface TaskInput {
  key?: string;
  title: string;
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
 * The graph row is created on first write, never on read: a token that has
 * only ever been shown a board leaves no trace in D1.
 */
function ensureGraphStatement(db: D1Database, owner: string, title?: string): D1PreparedStatement[] {
  const ts = now();
  const statements = [
    db
      .prepare('INSERT INTO graphs (owner_id, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET updated_at = excluded.updated_at')
      .bind(owner, title ?? DEFAULT_TITLE, ts),
  ];
  // A title given explicitly renames the graph; one defaulted does not.
  if (title !== undefined) {
    statements.push(db.prepare('UPDATE graphs SET title = ?, updated_at = ? WHERE owner_id = ?').bind(title, ts, owner));
  }
  return statements;
}

/** Reads the whole graph for one token. Never writes. */
export async function loadGraph(db: D1Database, owner: string): Promise<GraphState> {
  await ensureSchema(db);
  const [graphRow, taskRows, edgeRows] = await db.batch<unknown>([
    db.prepare('SELECT title FROM graphs WHERE owner_id = ?').bind(owner),
    db
      .prepare('SELECT id, key, title, detail, status, priority, tags FROM tasks WHERE owner_id = ? ORDER BY priority DESC, key')
      .bind(owner),
    db
      .prepare(
        `SELECT f.key AS from_key, t.key AS to_key
           FROM edges e
           JOIN tasks f ON f.id = e.from_id
           JOIN tasks t ON t.id = e.to_id
          WHERE e.owner_id = ?`,
      )
      .bind(owner),
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
  return { title, tasks, edges };
}

/** key -> row id, for the token's existing tasks. */
async function keyIndex(db: D1Database, owner: string): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT id, key FROM tasks WHERE owner_id = ?').bind(owner).all<{ id: string; key: string }>();
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
  owner: string,
  input: { title?: string; tasks?: TaskInput[]; edges?: Edge[] },
): Promise<MergeResult> {
  await ensureSchema(db);
  const incomingTasks = input.tasks ?? [];
  const incomingEdges = input.edges ?? [];

  for (const task of incomingTasks) {
    if (!task.title || !task.title.trim()) throw new GraphError('Every task needs a non-empty title.');
  }
  for (const edge of incomingEdges) {
    if (edge.from === edge.to) throw new GraphError(`Self-dependency on "${edge.from}" is not a dependency.`);
  }

  const existing = await keyIndex(db, owner);
  const current = await loadGraph(db, owner);

  // Keys first: an incoming task without one gets the next free T<n>, and
  // edges may name those same new keys, so this has to settle before the
  // edges are resolved.
  const keys = assignKeys(
    existing.keys(),
    incomingTasks.map((t) => t.key),
  );

  const created: string[] = [];
  const updated: string[] = [];
  const statements: D1PreparedStatement[] = ensureGraphStatement(db, owner, input.title);
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
            `INSERT INTO tasks (id, owner_id, key, title, detail, status, priority, tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(fresh, owner, key, task.title, task.detail ?? '', task.status ?? 'todo', task.priority ?? 0, tags ?? '[]', ts, ts),
      );
    } else {
      updated.push(key);
      // COALESCE keeps every field the caller did not mention — status
      // included, so re-planning a graph never silently reopens work that
      // is already done.
      statements.push(
        db
          .prepare(
            `UPDATE tasks
                SET title = ?, detail = COALESCE(?, detail), status = COALESCE(?, status),
                    priority = COALESCE(?, priority), tags = COALESCE(?, tags), updated_at = ?
              WHERE owner_id = ? AND id = ?`,
          )
          .bind(task.title, task.detail ?? null, task.status ?? null, task.priority ?? null, tags, ts, owner, id),
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
        .prepare('INSERT INTO edges (owner_id, from_id, to_id) VALUES (?, ?, ?) ON CONFLICT(from_id, to_id) DO NOTHING')
        .bind(owner, idByKey.get(edge.from)!, idByKey.get(edge.to)!),
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
export async function unlinkEdges(db: D1Database, owner: string, edges: readonly Edge[]): Promise<number> {
  await ensureSchema(db);
  const index = await keyIndex(db, owner);
  const statements: D1PreparedStatement[] = [];
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) throw new GraphError(`Unknown task key in unlink: ${!from ? edge.from : edge.to}`);
    statements.push(db.prepare('DELETE FROM edges WHERE owner_id = ? AND from_id = ? AND to_id = ?').bind(owner, from, to));
  }
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Patches one task. Absent fields are left alone. */
export async function patchTask(db: D1Database, owner: string, key: string, patch: TaskPatch): Promise<Task> {
  await ensureSchema(db);
  const index = await keyIndex(db, owner);
  const id = index.get(key);
  if (!id) throw new GraphError(`No task with key "${key}".`);
  await db
    .prepare(
      `UPDATE tasks
          SET title = COALESCE(?, title), detail = COALESCE(?, detail), status = COALESCE(?, status),
              priority = COALESCE(?, priority), tags = COALESCE(?, tags), updated_at = ?
        WHERE owner_id = ? AND id = ?`,
    )
    .bind(
      patch.title ?? null,
      patch.detail ?? null,
      patch.status ?? null,
      patch.priority ?? null,
      patch.tags ? JSON.stringify(patch.tags) : null,
      now(),
      owner,
      id,
    )
    .run();
  const task = await getTask(db, owner, key);
  if (!task) throw new GraphError(`No task with key "${key}".`);
  return task;
}

export async function getTask(db: D1Database, owner: string, key: string): Promise<Task | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT id, key, title, detail, status, priority, tags FROM tasks WHERE owner_id = ? AND key = ?')
    .bind(owner, key)
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
 * Scoped to one token: it cannot touch another graph even if it tried.
 */
export async function resetGraph(db: D1Database, owner: string): Promise<{ tasks_deleted: number; edges_deleted: number }> {
  await ensureSchema(db);
  const [edgeResult, taskResult] = await db.batch([
    db.prepare('DELETE FROM edges WHERE owner_id = ?').bind(owner),
    db.prepare('DELETE FROM tasks WHERE owner_id = ?').bind(owner),
    db.prepare('UPDATE graphs SET title = ?, updated_at = ? WHERE owner_id = ?').bind(DEFAULT_TITLE, now(), owner),
  ]);
  return { edges_deleted: edgeResult.meta.changes ?? 0, tasks_deleted: taskResult.meta.changes ?? 0 };
}
