/**
 * Puts the compiled MCP App in front of a real browser and a stand-in host.
 *
 * WHY THIS EXISTS. `vitest` covers the graph rules and the SQL; neither can
 * tell you that the board actually draws, that the App handshake completes,
 * or that clicking Done reaches the host as a `tools/call`. This does: a
 * minimal host that speaks the same JSON-RPC over postMessage Claude does,
 * an iframe with the real bundle in it, and assertions on what came out.
 *
 *   node scripts/check-board.mjs [--headed] [--shot out.png]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BUNDLE = fileURLToPath(new URL('../dist/ui/board.html', import.meta.url));
const HEADED = process.argv.includes('--headed');
const SHOT = process.argv.includes('--shot') ? process.argv[process.argv.indexOf('--shot') + 1] : null;

/** The fixture the host hands the board, in the exact shape `plan` returns. */
const BOARD = {
  title: 'Site relaunch',
  ready: [
    { key: 'brand', title: 'Brand refresh', priority: 0 },
    { key: 'cms', title: 'CMS migration', priority: 0 },
  ],
  graph: {
    title: 'Site relaunch',
    counts: { todo: 5 },
    nodes: [
      { key: 'brand', title: 'Brand refresh', status: 'todo', priority: 0 },
      { key: 'cms', title: 'CMS migration', status: 'todo', priority: 0 },
      { key: 'homepage', title: 'Homepage build', status: 'todo', priority: 0 },
      { key: 'prod', title: 'Production cutover', status: 'todo', priority: 0 },
      { key: 'staging', title: 'Staging deploy', status: 'todo', priority: 0 },
    ],
    edges: [
      { from: 'homepage', to: 'brand' },
      { from: 'staging', to: 'homepage' },
      { from: 'staging', to: 'cms' },
      { from: 'prod', to: 'staging' },
    ],
  },
};

const HOST_PAGE = `<!doctype html>
<meta charset="utf-8" />
<style>html,body{margin:0;background:#fff}iframe{border:0;width:680px;height:520px;display:block}</style>
<iframe id="view" src="/board.html"></iframe>
<script type="module">
  // A minimal MCP Apps host: ui/initialize, then the tool result, then
  // whatever tools the View calls get proxied — here, answered from fixtures.
  const BOARD = ${JSON.stringify(BOARD)};
  const frame = document.getElementById('view');
  window.__calls = [];

  const send = (msg) => frame.contentWindow.postMessage(msg, '*');
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.method === 'ui/initialize') {
      result(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        hostInfo: { name: 'check-board', version: '0.1.0' },
        hostCapabilities: {},
        hostContext: { theme: 'light', displayMode: 'inline', containerDimensions: { width: 680, maxHeight: 520 } },
      });
      return;
    }
    if (msg.method === 'ui/notifications/initialized') {
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(BOARD) }] } });
      return;
    }
    if (msg.method === 'tools/call') {
      window.__calls.push(msg.params);
      const name = msg.params.name;
      if (name === 'get_task') {
        const key = msg.params.arguments.key;
        const node = BOARD.graph.nodes.find((n) => n.key === key);
        result(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({
            task: { key, title: node.title, detail: 'Fixture detail for ' + key, status: node.status, priority: 0, tags: [] },
            depends_on: BOARD.graph.edges.filter((e) => e.from === key).map((e) => e.to),
            dependents: BOARD.graph.edges.filter((e) => e.to === key).map((e) => e.from),
            blocked_by: [],
            ready: true,
          }) }],
        });
        return;
      }
      if (name === 'update_task') {
        // Stateful on purpose: a host that forgets the write cannot catch a
        // board that re-draws from a stale result.
        const key = msg.params.arguments.key;
        BOARD.graph.nodes.find((n) => n.key === key).status = msg.params.arguments.status;
        BOARD.ready = BOARD.ready.filter((r) => r.key !== key);
        result(msg.id, { content: [{ type: 'text', text: JSON.stringify(BOARD) }] });
        return;
      }
      result(msg.id, { content: [{ type: 'text', text: JSON.stringify(BOARD) }] });
      return;
    }
    if (msg.id !== undefined && msg.method) result(msg.id, {});
  });
</script>`;

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HOST_PAGE);
    return;
  }
  if (req.url === '/board.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(BUNDLE, 'utf8'));
    return;
  }
  res.writeHead(404).end('nope');
});

const failures = [];
function check(name, ok, extra = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${extra}`);
    failures.push(name);
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// This box pins Chromium outside node_modules (PLAYWRIGHT_BROWSERS_PATH);
// honour an explicit CHROME_PATH so the check runs where the bundled
// browser revision does not match.
const executablePath = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ headless: !HEADED, executablePath });
const page = await browser.newPage({ viewport: { width: 760, height: 620 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto(`http://127.0.0.1:${port}/`);
const view = page.frameLocator('#view');

// 1. The board draws the graph it was handed.
await view.locator('#title').filter({ hasText: 'Site relaunch' }).waitFor({ timeout: 15000 });
check('title comes from the tool result', true);
check('ready queue is listed', (await view.locator('#ready').textContent()).includes('brand'));

const info = await view.locator('#graph').evaluate((el) => el.info);
check('all five nodes laid out', info.nodeCount === 5, JSON.stringify(info));
check('all four edges drawn', info.edgeCount === 4, JSON.stringify(info));
check('layout found no cycles', info.cycles.length === 0 && info.rejected.length === 0, JSON.stringify(info));

// Edge direction: prerequisites come first, so brand sits in an earlier
// layer than the homepage that depends on it.
const layers = await view.locator('#graph').evaluate((el) =>
  Object.fromEntries(el.snapshot.nodes.map((n) => [n.id, n.layer])),
);
check('prerequisites are drawn before dependents', layers.brand < layers.homepage && layers.homepage < layers.staging, JSON.stringify(layers));

// 2. Selecting a node loads its detail through the host.
await view.locator('#graph').evaluate((el) => {
  const node = el.snapshot.nodes.find((n) => n.id === 'homepage');
  el.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
  el.selected = 'homepage';
  el.dispatchEvent(new CustomEvent('selectionchange', { detail: { node: { id: 'homepage' } } }));
});
await view.locator('#selected').filter({ hasText: 'Homepage build' }).waitFor({ timeout: 5000 });
check('selection panel shows the task', true);
await view.locator('#selected').filter({ hasText: 'Fixture detail' }).waitFor({ timeout: 5000 });
check('detail arrived via get_task through the host', true);

// 3. The buttons write through the host, never straight to the server.
await view.locator('#done').click();
await view.locator('#selected .pill').filter({ hasText: 'done' }).waitFor({ timeout: 5000 });
const calls = await page.evaluate(() => window.__calls);
const update = calls.find((c) => c.name === 'update_task');
check('Done called update_task through the host', update?.arguments.key === 'homepage' && update?.arguments.status === 'done', JSON.stringify(calls));
check('the board re-drew from the tool result', (await view.locator('#done').textContent()) === 'Reopen');

await view.locator('#refresh').click();
await page.waitForFunction(() => window.__calls.some((c) => c.name === 'show'), null, { timeout: 5000 });
check('Refresh called show', true);

check('no page errors', errors.length === 0, errors.join(' | '));

if (SHOT) {
  await page.screenshot({ path: SHOT });
  console.log(`  screenshot: ${SHOT}`);
}

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nboard checks passed');
