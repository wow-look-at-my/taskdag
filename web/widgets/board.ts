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
// The server's own Mermaid renderer, compiled into this bundle. `graph.ts`
// is pure -- no D1, no MCP -- so the Worker and the App share one
// implementation instead of drifting apart as two.
import { toMermaid } from '../../src/graph.ts';

// -- The shape the tools return -------------------------------------------------------

type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

interface BoardNode {
  key: string;
  title: string;
  status: TaskStatus;
  priority: number;
  tags?: string[];
}

/**
 * What a tool call now returns: a receipt, not a graph.
 *
 * The nodes and edges deliberately are not in here. They cost the model
 * thousands of tokens per call and it usually did not need them, so they
 * moved behind `taskdag://graph/<handle>` — which this board reads itself,
 * over the same host bridge it already uses for tool calls.
 */
interface Receipt {
  graph: string | null;
  title?: string;
  tasks?: number;
  ready?: { key: string; title: string }[];
}

/** The resource behind a handle: the whole graph. */
interface GraphData {
  graph: string;
  title: string;
  nodes: BoardNode[];
  edges: { from: string; to: string }[];
  /** EVERY startable key, uncapped. The receipt's `ready` is only the first few. */
  ready?: string[];
}

/** What `render` draws: a receipt joined to the graph it points at. */
interface BoardPayload {
  title?: string;
  ready?: { key: string; title: string }[];
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

/** How many ready keys the header line spells out before it counts them. */
const READY_HEADER_KEYS = 5;

let board: BoardPayload = {};
/** The graph every call in this card is about. Comes from the receipt. */
let handle: string | null = null;
let selectedKey: string | null = null;
let busy = false;

const app = new App({ name: 'taskdag-board', version: '0.1.0' });

const copyBtn = document.getElementById('copy') as HTMLButtonElement;
const expandBtn = document.getElementById('expand') as HTMLButtonElement;
const copyMenu = document.getElementById('copymenu') as HTMLDivElement;

/** The graph the receipt pointed at, kept for the copy formats. */
let graphData: GraphData | null = null;

// -- Rendering --------------------------------------------------------------------------

function render(payload: BoardPayload): void {
  board = payload;
  const nodes = payload.graph?.nodes ?? [];
  const edges = payload.graph?.edges ?? [];
  const readyKeys = new Set((payload.ready ?? []).map((r) => r.key));

  titleEl.textContent = payload.title ?? payload.graph?.title ?? 'TaskDAG';

  // The highlight set is every ready key; the header is a line of text, so
  // it names a handful and counts the rest.
  const ready = payload.ready ?? [];
  const named = ready.slice(0, READY_HEADER_KEYS).map((r) => r.key);
  const rest = ready.length - named.length;
  readyEl.textContent =
    ready.length > 0 ? `Ready: ${named.join(', ')}${rest > 0 ? ` +${rest} more` : ''}` : nodes.length > 0 ? 'Nothing ready' : '';

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
  // Every call names the graph explicitly. The card outlives the turn that
  // created it, and nothing about the connection says which graph it was
  // looking at — that is exactly the state the handle exists to carry.
  const withGraph = handle === null ? args : { graph: handle, ...args };
  const result = (await app.callServerTool({ name, arguments: withGraph })) as ToolResult;
  // A failed tool comes back as a RESULT with isError set, not a rejection.
  // Treating that as "no data" is how a broken server renders as a blank
  // white card instead of saying what went wrong.
  if (result.isError) throw new Error(textOf(result) || `${name} failed.`);
  return parseResult<T>(result);
}

/** Reads the graph a receipt points at. */
async function readGraph(id: string): Promise<GraphData> {
  const res = (await app.readServerResource({ uri: `taskdag://graph/${id}` })) as {
    contents?: { text?: string }[];
  };
  const text = res.contents?.find((c) => typeof c.text === 'string')?.text;
  if (!text) throw new Error('That graph resource came back empty.');
  return JSON.parse(text) as GraphData;
}

/**
 * Receipt in, board on screen. The two-step — receipt, then resource — is
 * the whole point of the design, so it lives in one function that every
 * entry point goes through.
 */
async function applyReceipt(receipt: Receipt): Promise<void> {
  handle = receipt.graph ?? null;
  if (handle === null) {
    graphData = null;
    render({ title: receipt.title, ready: [], graph: { nodes: [], edges: [] } });
    return;
  }
  const data = await readGraph(handle);
  graphData = data;
  // READY COMES FROM THE RESOURCE, NOT THE RECEIPT. The receipt names only
  // the first few (DEFAULT_READY_LIMIT on the server), and the board colours
  // a node by whether it is in this set -- so taking the receipt's list
  // would draw the 6th startable task as an ordinary todo.
  const byKey = new Map(data.nodes.map((n) => [n.key, n]));
  const ready = data.ready
    ? data.ready.filter((key) => byKey.has(key)).map((key) => ({ key, title: byKey.get(key)!.title }))
    : (receipt.ready ?? []);
  render({ title: receipt.title ?? data.title, ready, graph: { nodes: data.nodes, edges: data.edges } });
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
    const receipt = await callTool<Receipt>('update_task', { key, status });
    if (receipt) await applyReceipt(receipt);
    setBusy(false, '');
    if (selectedKey) void loadDetail(selectedKey);
  } catch (err) {
    setBusy(false, err instanceof Error ? err.message : 'Update failed.', true);
  }
}

async function refresh(): Promise<void> {
  setBusy(true, 'Refreshing…');
  try {
    const receipt = await callTool<Receipt>('show', {});
    if (receipt) await applyReceipt(receipt);
    setBusy(false, '');
  } catch (err) {
    setBusy(false, err instanceof Error ? err.message : 'Refresh failed.', true);
  }
}

// -- Copy ---------------------------------------------------------------------------------

/**
 * The board draws a canvas, and you cannot select text out of a canvas.
 * These are the three shapes somebody actually wants to paste somewhere:
 * a checklist for an issue, a diagram for a doc, the raw graph for a script.
 */
type CopyFormat = 'markdown' | 'mermaid' | 'json';

const COPY_LABEL: Record<CopyFormat, string> = { markdown: 'Markdown', mermaid: 'Mermaid', json: 'JSON' };

/** A checklist, with each task's prerequisites spelled out under it. */
function toMarkdown(data: GraphData, ready: { key: string }[]): string {
  const readyKeys = new Set(ready.map((r) => r.key));
  const lines = [`# ${data.title}`, ''];
  const counts = `${data.nodes.length} task${data.nodes.length === 1 ? '' : 's'} · ${data.edges.length} dependenc${data.edges.length === 1 ? 'y' : 'ies'}`;
  lines.push(readyKeys.size > 0 ? `${counts} · ready: ${[...readyKeys].join(', ')}` : counts, '');

  for (const node of data.nodes) {
    const box = node.status === 'done' ? '[x]' : '[ ]';
    const status = node.status === 'todo' || node.status === 'done' ? '' : ` \`${node.status}\``;
    lines.push(`- ${box} **${node.key}** — ${node.title}${status}`);
    const waits = data.edges.filter((e) => e.from === node.key).map((e) => e.to);
    if (waits.length > 0) lines.push(`  - waits on: ${waits.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * The diagram, from the server's own renderer rather than a second copy of
 * it: `src/graph.ts` is pure, so the Worker and this bundle compile the
 * same function and cannot drift.
 */
function toMermaidText(data: GraphData): string {
  return toMermaid(
    data.nodes.map((n) => ({ key: n.key, title: n.title, status: n.status, priority: n.priority, detail: '', tags: n.tags ?? [] })),
    data.edges,
  );
}

/**
 * Clipboard, with a fallback. `navigator.clipboard` needs a permission the
 * host's sandbox may not grant, and a copy button that silently does
 * nothing is worse than one that says it could not.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older path, and the one that survives a missing clipboard permission.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function openCopyMenu(open: boolean): void {
  copyMenu.hidden = !open;
  copyBtn.setAttribute('aria-expanded', String(open));
}

async function copyAs(format: CopyFormat): Promise<void> {
  openCopyMenu(false);
  if (!graphData || graphData.nodes.length === 0) {
    setBusy(false, 'Nothing to copy yet.', true);
    return;
  }
  const text =
    format === 'json'
      ? JSON.stringify(graphData, null, 2)
      : format === 'mermaid'
        ? toMermaidText(graphData)
        : toMarkdown(graphData, board.ready ?? []);

  const ok = await copyText(text);
  setBusy(false, ok ? `Copied ${COPY_LABEL[format]}.` : `Could not reach the clipboard — the host blocked it.`, !ok);
}

copyBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  openCopyMenu(copyMenu.hidden !== false);
});

copyMenu.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('button');
  const format = target?.dataset.format as CopyFormat | undefined;
  if (format) void copyAs(format);
});

document.addEventListener('click', () => openCopyMenu(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') openCopyMenu(false);
});

// -- Expanding ----------------------------------------------------------------------------

/**
 * Expanding, without leaving the document.
 *
 * `<dag-view>` ships a fullscreen button, and it is deliberately suppressed
 * (`no-fullscreen-button`): its mode is `position: fixed; inset: 0`, which
 * fills the iframe viewport and lifts the canvas out of flow. In a page
 * that is fine. In an inline chat card it is not — the title, the buttons
 * and the status line end up behind a full-bleed canvas, and a host that
 * sizes the frame to its content sees the body collapse to nothing.
 *
 * So expanding is a height on the graph and a request to the host for a
 * bigger card. Everything stays in flow, the chrome stays visible, and a
 * host that declines the display mode still gets a taller graph inside the
 * card it already had.
 */
function setExpanded(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-expanded', '');
  else document.documentElement.removeAttribute('data-expanded');
  expandBtn.textContent = on ? 'Collapse' : 'Expand';
  expandBtn.setAttribute('aria-pressed', String(on));
  // No resize call: the element keeps a ResizeObserver on itself, so
  // changing its height is enough to make the canvas repaint at the new
  // size.
}

/**
 * THE HOST OWNS THE DISPLAY MODE, AND THIS FOLLOWS IT.
 *
 * A host can leave fullscreen without telling this card first — claude.ai
 * puts an X in the corner of the expanded panel, and clicking it returns
 * the frame to inline. Anything the card latched on the way in has to come
 * back off on the way out, or it is left sized for a window it no longer
 * has. That is what made the card collapse to a sliver: the old code put
 * the canvas into the element's own `position: fixed` fullscreen, the host
 * shrank the frame behind it, and the canvas stayed pinned over a body
 * that now had no height at all.
 *
 * So `data-display` is a mirror of the host's mode, never a wish, and the
 * expanded height is defined in terms of it.
 */
function applyDisplayMode(context: McpUiHostContext | undefined): void {
  const mode = context?.displayMode ?? 'inline';
  document.documentElement.setAttribute('data-display', mode);
  if (mode !== 'fullscreen' && expandBtn.getAttribute('aria-pressed') === 'true') setExpanded(false);
}

expandBtn.addEventListener('click', () => {
  const next = expandBtn.getAttribute('aria-pressed') !== 'true';
  setExpanded(next);

  const mode = next ? 'fullscreen' : 'inline';
  const available = app.getHostContext()?.availableDisplayModes;
  if (available !== undefined && !available.includes(mode)) return;
  void app.requestDisplayMode({ mode }).catch(() => {
    // The host kept the card its current size. The taller graph inside it
    // is still the useful half of what was asked for.
  });
});

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
  const receipt = parseResult<Receipt>(result);
  if (!receipt) return;
  void applyReceipt(receipt).catch((err: unknown) => {
    // The receipt arrived but its graph did not. Saying which half failed
    // beats a blank card that looks like a dead server.
    setBusy(false, err instanceof Error ? err.message : 'Could not load that graph.', true);
  });
});

app.addEventListener('hostcontextchanged', (context) => {
  applyTheme(context);
  applyDisplayMode(context);
});

void (async () => {
  await app.connect();
  applyTheme(app.getHostContext());
  applyDisplayMode(app.getHostContext());
  // A board mounted without a result to draw (a re-opened conversation, a
  // host that does not replay) asks for one rather than sitting empty.
  if (!board.graph?.nodes.length) await refresh();
})();
