/**
 * The graph half of TaskDAG: pure functions over tasks and edges, with no
 * D1 and no MCP in sight, so the rules that decide what is ready and what
 * is a cycle are unit-testable without a live database.
 *
 * EDGE DIRECTION, ONCE. A TaskDAG edge `{ from, to }` reads "`from` depends
 * on `to`": `to` must be done before `from` can start. Every function here
 * uses that direction, and the two places that flip it (the Mermaid text
 * and the `<dag-view>` payload, both of which draw prerequisites first) say
 * so where they flip it.
 */

/** The five states a task can be in. Mirrors the D1 CHECK constraint. */
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'cancelled'] as const satisfies readonly TaskStatus[];

/** One task, as the rest of the server passes it around. */
export interface Task {
  key: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: number;
  tags: string[];
}

/** One dependency: `from` depends on `to`. */
export interface Edge {
  from: string;
  to: string;
}

/** A task with only the fields the graph rules need. */
type TaskLike = Pick<Task, 'key' | 'status'>;

// -- Keys ---------------------------------------------------------------------------

const AUTO_KEY = /^T(\d+)$/;

/**
 * A key that names nothing.
 *
 * `T3` is a slot number, not a name. A graph full of them reads as
 * `T1 -> T2 -> T5` and the model has to fetch every node to say anything
 * about the plan, which is both useless to a person and expensive to a
 * conversation. Earlier versions of this server *minted* these when a task
 * arrived without a key; they are now refused at creation instead.
 *
 * Refused: `T3`, `t12`, `3`, `x`, and anything under two characters.
 * Existing tasks keyed this way stay addressable — a graph written before
 * this rule keeps working, and `update_task`, `get_task` and edges all
 * still take whatever key a task already has.
 */
const PLACEHOLDER_KEY = /^(?:[a-z]\d+|\d+)$/i;

export function isPlaceholderKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length < 2 || PLACEHOLDER_KEY.test(trimmed);
}

/**
 * The complaint to hand back, phrased so the caller can act on it without a
 * second round trip.
 */
export function placeholderKeyMessage(key: string): string {
  return (
    `"${key}" names nothing — task keys are how people and models refer to the work, so they have to mean something. ` +
    `Use a short slug drawn from the title, like "write-tests" or "brand". ` +
    `(Keys of the form T3, a bare letter or a bare number are refused; existing tasks keyed that way still work.)`
  );
}

// -- Cycles -------------------------------------------------------------------------

/**
 * The first dependency cycle in `edges`, as task keys in dependency order
 * and closed (`["T1", "T2", "T1"]`), or `null` when the graph is acyclic.
 *
 * An iterative DFS rather than a recursive one: a 5000-node chain out of D1
 * would blow the stack, and a tool that dies on a big graph is worse than a
 * slightly longer function.
 */
export function findCycle(keys: Iterable<string>, edges: readonly Edge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const key of keys) adjacency.set(key, []);
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const key of adjacency.keys()) color.set(key, WHITE);

  for (const root of adjacency.keys()) {
    if (color.get(root) !== WHITE) continue;
    // Each frame is a node plus how far through its neighbours we are.
    const stack: { key: string; i: number }[] = [{ key: root, i: 0 }];
    color.set(root, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = adjacency.get(frame.key)!;
      if (frame.i >= neighbours.length) {
        color.set(frame.key, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbours[frame.i++];
      const state = color.get(next) ?? WHITE;
      if (state === GREY) {
        // `next` is on the current path: the cycle is the tail of the stack
        // from `next` onwards, closed back onto itself.
        const at = stack.findIndex((f) => f.key === next);
        return [...stack.slice(at).map((f) => f.key), next];
      }
      if (state === WHITE) {
        color.set(next, GREY);
        stack.push({ key: next, i: 0 });
      }
    }
  }
  return null;
}

/** True when `edges` contains no cycle. Self-edges count as cycles. */
export function isAcyclic(keys: Iterable<string>, edges: readonly Edge[]): boolean {
  return findCycle(keys, edges) === null;
}

// -- Ready --------------------------------------------------------------------------

/**
 * The tasks that can be picked up right now: status `todo`, with every
 * dependency `done`.
 *
 * A cancelled dependency does NOT count as satisfied. Cancelling a
 * prerequisite is a decision about that task, not a quiet approval of
 * everything waiting on it — unlink it to actually unblock the dependent.
 *
 * Ordering is priority descending, then key, so "what's ready?" answers the
 * same way twice in a row.
 */
export function readyKeys(tasks: readonly Task[], edges: readonly Edge[]): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const deps = new Map<string, string[]>();
  for (const edge of edges) {
    const list = deps.get(edge.from);
    if (list) list.push(edge.to);
    else deps.set(edge.from, [edge.to]);
  }

  const ready = tasks.filter((task) => {
    if (task.status !== 'todo') return false;
    for (const dep of deps.get(task.key) ?? []) {
      const upstream = byKey.get(dep);
      // An edge to a task that no longer exists blocks nothing.
      if (upstream && upstream.status !== 'done') return false;
    }
    return true;
  });

  ready.sort((a, b) => b.priority - a.priority || compareKeys(a.key, b.key));
  return ready.map((t) => t.key);
}

/** `T2` before `T10`: the auto keys sort as numbers, everything else as text. */
export function compareKeys(a: string, b: string): number {
  const ma = AUTO_KEY.exec(a);
  const mb = AUTO_KEY.exec(b);
  if (ma && mb) return Number(ma[1]) - Number(mb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Direct dependencies of `key` (what it is waiting on). */
export function dependenciesOf(key: string, edges: readonly Edge[]): string[] {
  return edges.filter((e) => e.from === key).map((e) => e.to);
}

/** Direct dependents of `key` (what is waiting on it). */
export function dependentsOf(key: string, edges: readonly Edge[]): string[] {
  return edges.filter((e) => e.to === key).map((e) => e.from);
}

/** Why a `todo` task is not ready: the dependencies that are not `done`. */
export function blockedBy(key: string, tasks: readonly Task[], edges: readonly Edge[]): string[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  return dependenciesOf(key, edges).filter((dep) => {
    const upstream = byKey.get(dep);
    return upstream !== undefined && upstream.status !== 'done';
  });
}

// -- Mermaid ------------------------------------------------------------------------

/** How much of a title a diagram label carries. Matches the receipts. */
const LABEL_CHARS = 80;

const MERMAID_CLASS: Record<TaskStatus, string> = {
  todo: 'todo',
  in_progress: 'doing',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

/**
 * The graph as Mermaid text — the fallback for hosts that do not render MCP
 * Apps, and the thing a model can read back without a picture.
 *
 * ARROWS POINT THE WAY WORK FLOWS: `prerequisite --> dependent`, which is
 * the reverse of the stored edge and the same direction `<dag-view>` draws.
 * One direction, stated here, used everywhere.
 */
export function toMermaid(tasks: readonly Task[], edges: readonly Edge[]): string {
  const lines: string[] = ['graph TD'];
  const known = new Set(tasks.map((t) => t.key));
  const sorted = [...tasks].sort((a, b) => compareKeys(a.key, b.key));

  for (const task of sorted) {
    // The label is repeated per node and counts against the render budget,
    // so it is shortened here rather than being refused on the way in.
    const label = task.title.length <= LABEL_CHARS ? task.title : `${task.title.slice(0, LABEL_CHARS - 1).trimEnd()}\u2026`;
    lines.push(`  ${mermaidId(task.key)}["${escapeMermaid(`${task.key}: ${label}`)}"]:::${MERMAID_CLASS[task.status]}`);
  }
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    lines.push(`  ${mermaidId(edge.to)} --> ${mermaidId(edge.from)}`);
  }

  lines.push('  classDef todo fill:#eef1f6,stroke:#8b93a5,color:#1d2433');
  lines.push('  classDef doing fill:#dbeafe,stroke:#2563eb,color:#11224a');
  lines.push('  classDef done fill:#dcfce7,stroke:#16a34a,color:#0d2a17');
  lines.push('  classDef blocked fill:#fee2e2,stroke:#dc2626,color:#3c1010');
  lines.push('  classDef cancelled fill:#f3f4f6,stroke:#c3c7d1,color:#9aa1ad');
  return lines.join('\n');
}

/** Mermaid node ids may not be arbitrary text; task keys can be. */
function mermaidId(key: string): string {
  return `n${[...key].map((c) => (/[A-Za-z0-9]/.test(c) ? c : '_')).join('')}`;
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

// -- Selection ------------------------------------------------------------------------

/**
 * Which part of a graph to render or return.
 *
 * WHY THIS EXISTS. A whole dependency graph is the wrong default answer to
 * almost every question asked about one. "What is blocking the launch?" is a
 * neighbourhood; "what is left?" is a status filter. Selecting server-side
 * is what keeps a 200-node graph out of the conversation when three nodes
 * were the question.
 */
export interface Selection {
  /** Seed keys. Omitted (or empty) means every task, subject to `status`. */
  keys?: string[];
  /** How many dependency hops to follow out from the seeds. Default 1. */
  depth?: number;
  /** Which way to walk: prerequisites, dependents, or both. Default 'both'. */
  direction?: 'up' | 'down' | 'both';
  /** Keep only these statuses. Omitted means every status. */
  status?: TaskStatus[];
}

/**
 * The selected subgraph: the tasks that survive, and the edges with both
 * ends still standing.
 *
 * Seeds always survive a `status` filter — asking about T7 and getting an
 * empty answer because T7 is done would be a worse lie than showing it.
 * The filter applies to what the walk *reaches*.
 */
export function selectSubgraph(
  tasks: readonly Task[],
  edges: readonly Edge[],
  selection: Selection = {},
): { tasks: Task[]; edges: Edge[] } {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const statuses = selection.status && selection.status.length > 0 ? new Set<TaskStatus>(selection.status) : null;
  const asked = selection.keys ?? [];
  const seeds = asked.filter((key) => byKey.has(key));

  // Asking about keys that do not exist selects NOTHING, never everything.
  // The caller misspelled a key or is looking at a stale plan; answering
  // with the entire graph would be both wrong and the most expensive
  // possible way to be wrong.
  if (asked.length > 0 && seeds.length === 0) return { tasks: [], edges: [] };

  let keep: Set<string>;
  if (seeds.length === 0) {
    keep = new Set(tasks.filter((t) => !statuses || statuses.has(t.status)).map((t) => t.key));
  } else {
    const depth = Math.max(0, selection.depth ?? 1);
    const direction = selection.direction ?? 'both';
    keep = new Set(seeds);
    let frontier = seeds;
    for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const key of frontier) {
        const reached = [
          ...(direction === 'up' || direction === 'both' ? dependenciesOf(key, edges) : []),
          ...(direction === 'down' || direction === 'both' ? dependentsOf(key, edges) : []),
        ];
        for (const found of reached) {
          const task = byKey.get(found);
          if (!task || keep.has(found)) continue;
          if (statuses && !statuses.has(task.status)) continue;
          keep.add(found);
          next.push(found);
        }
      }
      frontier = next;
    }
  }

  const keptTasks = tasks.filter((t) => keep.has(t.key));
  const keptEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { tasks: keptTasks, edges: keptEdges };
}

/** True when a selection asks for less than everything. */
export function isNarrowed(selection: Selection = {}): boolean {
  return (selection.keys?.length ?? 0) > 0 || (selection.status?.length ?? 0) > 0;
}
