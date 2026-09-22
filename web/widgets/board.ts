/**
 * The TaskDAG board: the MCP App that Claude renders inline after `plan`,
 * `show` or `ready`.
 *
 * WHAT THIS FILE IS ALLOWED TO BE. The graph element itself is
 * `<dag-view>`, vendored as a pinned submodule and compiled in at build
 * time; fixes to the drawing belong in js-snippets, not here. This wrapper
 * does four things and no more: mount the element, map a tool result onto
 * its node/edge shape, follow selection, and make writes through the host.
 *
 * THE IFRAME IS UNTRUSTED AND HAS NO NETWORK. It never sees the D1 database
 * and never fetches `/mcp`; every write goes View -> host `tools/call` ->
 * Worker, which is also why the host's permission prompts still mean
 * something.
 */

import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

// SIDE-EFFECT IMPORT: this is what registers <dag-view>. Every other use
// below is a type position, and a type-only import is elided at compile
// time — without this line the element never upgrades.
import '../../third_party/js-snippets/src/ui/dag-view.ts';
import type { DagEdge, DagNode, DagStyleMap, DagViewElement } from '../../third_party/js-snippets/src/ui/dag-view.ts';

// -- The shape the tools return -------------------------------------------------------

type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

interface BoardNode {
  key: string;
  title: string;
  status: TaskStatus;
  priority: number;
  tags?: string[];
}

interface BoardPayload {
  title?: string;
  ready?: { key: string; title: string; priority: number }[];
  graph?: { title?: string; nodes: BoardNode[]; edges: { from: string; to: string }[] };
}

interface TaskDetail {
  task: { key: string; title: string; detail: string; status: TaskStatus; priority: number; tags: string[] };
  depends_on: string[];
  dependents: string[];
  blocked_by: string[];
  ready: boolean;
}

// -- Status presentation ---------------------------------------------------------------

/**
 * TaskDAG status -> `<dag-view>` state key. `in_progress` and `ready` are
 * ours; the rest are the element's built-ins.
 */
const STATE_FOR: Record<TaskStatus, string> = {
  todo: 'pending',
  in_progress: 'doing',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'missing',
};

const STYLES: DagStyleMap = {
  pending: { pattern: 'outline', dashed: true },
  doing: { pattern: 'solid', emphasis: true },
  done: { pattern: 'solid' },
  blocked: { pattern: 'hatch', emphasis: true },
  missing: { pattern: 'outline', dim: true, dashed: true },
  // A ready task is a todo task with nothing left in its way. Solid against
  // the dashed outline every other todo gets is the whole signal — an
  // emphasis border on top of that reads as an alarm, which ready is not.
  ready: { pattern: 'solid' },
};

const COLOR_FOR: Record<string, string> = {
  pending: '#8b93a5',
  doing: '#2563eb',
  done: '#16a34a',
  blocked: '#dc2626',
  missing: '#9aa1ad',
  ready: '#0ea5e9',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'todo',
  in_progress: 'in progress',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

// -- DOM ------------------------------------------------------------------------------

const titleEl = document.getElementById('title') as HTMLDivElement;
const readyEl = document.getElementById('ready') as HTMLDivElement;
const graphEl = document.getElementById('graph') as DagViewElement;
const selectedEl = document.getElementById('selected') as HTMLDivElement;
const actionsEl = document.getElementById('actions') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const doneBtn = document.getElementById('done') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

let board: BoardPayload = {};
let selectedKey: string | null = null;
let busy = false;

const app = new App({ name: 'taskdag-board', version: '0.1.0' });

// -- Rendering --------------------------------------------------------------------------

function render(payload: BoardPayload): void {
  board = payload;
  const nodes = payload.graph?.nodes ?? [];
  const edges = payload.graph?.edges ?? [];
  const readyKeys = new Set((payload.ready ?? []).map((r) => r.key));

  titleEl.textContent = payload.title ?? payload.graph?.title ?? 'TaskDAG';

  const ready = payload.ready ?? [];
  readyEl.textContent = ready.length > 0 ? `Ready: ${ready.map((r) => r.key).join(', ')}` : nodes.length > 0 ? 'Nothing ready' : '';

  graphEl.setData({
    nodes: nodes.map((node): DagNode => {
      const state = node.status === 'todo' && readyKeys.has(node.key) ? 'ready' : STATE_FOR[node.status];
      return {
        id: node.key,
        label: node.title,
        sublabel: `${node.key} · ${state === 'ready' ? 'ready' : STATUS_LABEL[node.status]}`,
        state,
        meta: node,
      };
    }),
    // EDGES FLIP HERE, AND ONLY HERE. TaskDAG stores "from depends on to";
    // <dag-view> reads { from, to } as "to depends on from" and draws the
    // prerequisite first. Same picture, opposite field order.
    edges: edges.map((edge): DagEdge => ({ from: edge.to, to: edge.from })),
  });

  if (selectedKey && !nodes.some((n) => n.key === selectedKey)) select(null);
  else renderSelected();
}

function renderSelected(detail?: TaskDetail): void {
  if (!selectedKey) {
    selectedEl.innerHTML = '<span class="hint">Click a task to see what it is waiting on.</span>';
    actionsEl.hidden = true;
    return;
  }
  const node = board.graph?.nodes.find((n) => n.key === selectedKey);
  const status = detail?.task.status ?? node?.status ?? 'todo';
  const title = detail?.task.title ?? node?.title ?? selectedKey;

  const parts: string[] = [
    `<div class="sel-head"><span class="key">${escapeHtml(selectedKey)}</span> ${escapeHtml(title)} <span class="pill ${status}">${STATUS_LABEL[status]}</span></div>`,
  ];
  if (detail?.task.detail) parts.push(`<div class="detail">${escapeHtml(detail.task.detail)}</div>`);
  if (detail) {
    if (detail.blocked_by.length > 0) parts.push(`<div class="deps">Waiting on ${escapeHtml(detail.blocked_by.join(', '))}</div>`);
    else if (detail.depends_on.length > 0) parts.push(`<div class="deps">Depends on ${escapeHtml(detail.depends_on.join(', '))}</div>`);
    if (detail.dependents.length > 0) parts.push(`<div class="deps">Blocks ${escapeHtml(detail.dependents.join(', '))}</div>`);
  }
  selectedEl.innerHTML = parts.join('');

  actionsEl.hidden = false;
  // Two actions, and they change with the task rather than multiplying: an
  // inline chat card is not a toolbar farm.
  startBtn.textContent = status === 'in_progress' ? 'Pause' : 'Start';
  startBtn.dataset.next = status === 'in_progress' ? 'todo' : 'in_progress';
  doneBtn.textContent = status === 'done' ? 'Reopen' : 'Done';
  doneBtn.dataset.next = status === 'done' ? 'todo' : 'done';
  startBtn.disabled = busy || status === 'done' || status === 'cancelled';
  doneBtn.disabled = busy;
}

function select(key: string | null): void {
  selectedKey = key;
  graphEl.selected = key;
  renderSelected();
  if (key) void loadDetail(key);
}

function setBusy(on: boolean, message = '', isError = false): void {
  busy = on;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  refreshBtn.disabled = on;
  renderSelected();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

// -- Talking to the server, through the host ---------------------------------------------

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** The first text block of a tool result, error or not. */
function textOf(result: ToolResult): string {
  return result.content?.find((c) => c.type === 'text')?.text ?? '';
}

/** Tool results are one JSON text block; this is the only place that knows. */
function parseResult<T>(result: ToolResult): T | null {
  const text = textOf(result);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
  // A failed tool comes back as a RESULT with isError set, not a rejection.
  // Treating that as "no data" is how a broken server renders as a blank
  // white card instead of saying what went wrong.
  if (result.isError) throw new Error(textOf(result) || `${name} failed.`);
  return parseResult<T>(result);
}

async function loadDetail(key: string): Promise<void> {
  try {
    const detail = await callTool<TaskDetail>('get_task', { key });
    if (detail && selectedKey === key) renderSelected(detail);
  } catch {
    // A detail panel that cannot load is a thinner panel, not a broken board.
  }
}

async function update(key: string, status: string): Promise<void> {
  setBusy(true, `Setting ${key} to ${status.replace('_', ' ')}…`);
  try {
    const payload = await callTool<BoardPayload>('update_task', { key, status });
    if (payload?.graph) render(payload);
    setBusy(false, '');
    if (selectedKey) void loadDetail(selectedKey);
  } catch (err) {
    setBusy(false, err instanceof Error ? err.message : 'Update failed.', true);
  }
}

async function refresh(): Promise<void> {
  setBusy(true, 'Refreshing…');
  try {
    const payload = await callTool<BoardPayload>('show', { format: 'json' });
    if (payload?.graph) render(payload);
    setBusy(false, '');
  } catch (err) {
    setBusy(false, err instanceof Error ? err.message : 'Refresh failed.', true);
  }
}

// -- Theme -------------------------------------------------------------------------------

/**
 * The host owns the theme; `<dag-view>` reads `--dag-*`. This maps one onto
 * the other so the card sits in the conversation rather than on top of it.
 */
function applyTheme(context: McpUiHostContext | undefined): void {
  // LIGHT NEEDS PROOF; dark is what this card does otherwise. The only
  // proof available is the host saying so: `getDocumentTheme()` reads the
  // data-theme attribute rather than the media query and falls back to
  // "light", and inside a sandboxed iframe the media query itself cannot
  // tell "the user likes light" from "nobody said". Guessing light from
  // either is what renders a white box inside a dark conversation.
  const theme = context?.theme;
  if (theme === 'light') {
    applyDocumentTheme('light');
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
    applyDocumentTheme('dark');
  }
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

// -- Wiring --------------------------------------------------------------------------------

graphEl.styles = STYLES;
graphEl.colorFor = (node: DagNode) => COLOR_FOR[node.state ?? 'pending'] ?? null;
graphEl.addEventListener('nodeclick', (event) => {
  select((event as CustomEvent<{ node: DagNode }>).detail.node.id);
});
graphEl.addEventListener('selectionchange', (event) => {
  const node = (event as CustomEvent<{ node: DagNode | null }>).detail.node;
  if ((node?.id ?? null) !== selectedKey) select(node?.id ?? null);
});

startBtn.addEventListener('click', () => {
  if (selectedKey) void update(selectedKey, startBtn.dataset.next ?? 'in_progress');
});
doneBtn.addEventListener('click', () => {
  if (selectedKey) void update(selectedKey, doneBtn.dataset.next ?? 'done');
});
refreshBtn.addEventListener('click', () => void refresh());

app.addEventListener('toolresult', (params) => {
  const result = params as ToolResult;
  if (result.isError) {
    // The tool that opened this card failed. Say so here — the model's own
    // reply may be scrolled away, and an empty board reads as a broken one.
    setBusy(false, textOf(result) || 'That call failed.', true);
    return;
  }
  const payload = parseResult<BoardPayload>(result);
  if (payload?.graph) render(payload);
});

app.addEventListener('hostcontextchanged', (context) => applyTheme(context));

void (async () => {
  await app.connect();
  applyTheme(app.getHostContext());
  // A board mounted without a result to draw (a re-opened conversation, a
  // host that does not replay) asks for one rather than sitting empty.
  if (!board.graph) await refresh();
})();
