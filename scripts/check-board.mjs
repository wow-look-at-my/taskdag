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

/**
 * The fixtures, in the two halves the real server now uses: a receipt the
 * tool result carries, and a graph the board has to go and read.
 */
const HANDLE = 'g_0123456789abcdef';

const GRAPH = {
  graph: HANDLE,
  title: 'Site relaunch',
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
  // The resource carries EVERY ready key; the receipt below carries only
  // the first few. The board has to colour from this one.
  ready: ['brand', 'cms'],
};

const RECEIPT = {
  graph: HANDLE,
  title: 'Site relaunch',
  tasks: GRAPH.nodes.length,
  edges: GRAPH.edges.length,
  counts: { todo: 5 },
  ready: [
    { key: 'brand', title: 'Brand refresh' },
    { key: 'cms', title: 'CMS migration' },
  ],
};

const HOST_PAGE = `<!doctype html>
<meta charset="utf-8" />
<style>html,body{margin:0;background:#fff}iframe{border:0;width:680px;height:520px;display:block}</style>
<iframe id="view" src="/board.html"></iframe>
<script type="module">
  // A minimal MCP Apps host: ui/initialize, then the tool result, then
  // whatever tools the View calls get proxied — here, answered from fixtures.
  const HANDLE = ${JSON.stringify(HANDLE)};
  const GRAPH = ${JSON.stringify(GRAPH)};
  const RECEIPT = ${JSON.stringify(RECEIPT)};
  const receipt = () => ({ content: [{ type: 'text', text: JSON.stringify(RECEIPT) }] });
  const PARAMS = new URLSearchParams(location.search);
  // ?theme=  (empty) reproduces a host that reports no theme at all.
  const THEME = PARAMS.has('theme') ? PARAMS.get('theme') : 'light';
  const FAIL = PARAMS.has('fail');
  const frame = document.getElementById('view');
  window.__calls = [];
  window.__reads = [];
  window.__displayModes = [];

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
        hostContext: {
          ...(THEME ? { theme: THEME } : {}),
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen'],
          containerDimensions: { width: 680, maxHeight: 520 },
        },
      });
      return;
    }
    if (msg.method === 'ui/notifications/initialized') {
      const params = FAIL
        ? { isError: true, content: [{ type: 'text', text: 'D1_ERROR: no such table: graphs: SQLITE_ERROR' }] }
        : receipt();
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params });
      return;
    }
    if (msg.method === 'ui/request-display-mode') {
      window.__displayModes.push(msg.params.mode);
      result(msg.id, { mode: msg.params.mode });
      return;
    }
    if (msg.method === 'resources/read') {
      // The half that used to ride in the tool result. The board asks for
      // it by handle, exactly as it would from the deployed Worker.
      window.__reads.push(msg.params.uri);
      if (FAIL) {
        result(msg.id, { contents: [] });
        return;
      }
      result(msg.id, { contents: [{ uri: msg.params.uri, mimeType: 'application/json', text: JSON.stringify(GRAPH) }] });
      return;
    }
    if (msg.method === 'tools/call') {
      window.__calls.push(msg.params);
      const name = msg.params.name;
      if (FAIL) {
        result(msg.id, { isError: true, content: [{ type: 'text', text: 'D1_ERROR: no such table: graphs: SQLITE_ERROR' }] });
        return;
      }
      if (name === 'get_task') {
        const key = msg.params.arguments.key;
        const node = GRAPH.nodes.find((n) => n.key === key);
        result(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({
            task: { key, title: node.title, detail: 'Fixture detail for ' + key, status: node.status, priority: 0, tags: [] },
            depends_on: GRAPH.edges.filter((e) => e.from === key).map((e) => e.to),
            dependents: GRAPH.edges.filter((e) => e.to === key).map((e) => e.from),
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
        GRAPH.nodes.find((n) => n.key === key).status = msg.params.arguments.status;
        RECEIPT.ready = RECEIPT.ready.filter((r) => r.key !== key);
        result(msg.id, receipt());
        return;
      }
      result(msg.id, receipt());
      return;
    }
    if (msg.id !== undefined && msg.method) result(msg.id, {});
  });
</script>`;

const server = createServer((req, res) => {
  // Route on the PATH: the checks below pass options in the query string.
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HOST_PAGE);
    return;
  }
  if (pathname === '/board.html') {
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

check('no task actions until something is selected', await view.locator('#actions').isHidden());

// The graph is not in the tool result any more: the board must have gone
// and read it by handle. This is the check that would have caught shipping
// the receipt without the fetch behind it.
const reads = await page.evaluate(() => window.__reads);
check('board read the graph resource by handle', reads.includes(`taskdag://graph/${HANDLE}`), JSON.stringify(reads));

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
// A card outlives its turn, and nothing about the connection says which
// graph it was drawing. So every call has to name one -- except the very
// first, made by a cold-mounted card that has not been told a handle yet
// and is asking the server for its most recent graph.
const [coldMount, ...afterReceipt] = calls;
check('the cold-mount refresh asks without a handle', coldMount.name === 'show' && coldMount.arguments.graph === undefined, JSON.stringify(coldMount));
check('every later tool call names the graph handle', afterReceipt.every((c) => c.arguments.graph === HANDLE), JSON.stringify(afterReceipt));
check('the board re-drew after the write', (await view.locator('#done').textContent()) === 'Reopen');

await view.locator('#refresh').click();
await page.waitForFunction(() => window.__calls.some((c) => c.name === 'show'), null, { timeout: 5000 });
check('Refresh called show', true);

// 4. Copy: a canvas has no selectable text, so the card has to hand it over.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
check('copy menu starts closed', await view.locator('#copymenu').isHidden());
await view.locator('#copy').click();
check('copy menu opens with three formats', (await view.locator('#copymenu button').count()) === 3);

await view.locator('#copymenu button[data-format="mermaid"]').click();
await view.locator('#status').filter({ hasText: 'Copied Mermaid' }).waitFor({ timeout: 5000 });
const mermaid = await view.locator('body').evaluate(() => navigator.clipboard.readText());
check('Mermaid copy is a diagram of the real graph', mermaid.startsWith('graph TD') && mermaid.includes('Homepage build'), mermaid.slice(0, 80));
check('copy menu closes after choosing', await view.locator('#copymenu').isHidden());

await view.locator('#copy').click();
await view.locator('#copymenu button[data-format="markdown"]').click();
await view.locator('#status').filter({ hasText: 'Copied Markdown' }).waitFor({ timeout: 5000 });
const markdown = await view.locator('body').evaluate(() => navigator.clipboard.readText());
check(
  'Markdown copy is a checklist with dependencies',
  markdown.includes('# Site relaunch') && markdown.includes('- [x] **homepage**') && markdown.includes('waits on: homepage'),
  markdown.slice(0, 160),
);

await view.locator('#copy').click();
await view.locator('#copymenu button[data-format="json"]').click();
await view.locator('#status').filter({ hasText: 'Copied JSON' }).waitFor({ timeout: 5000 });
const json = JSON.parse(await view.locator('body').evaluate(() => navigator.clipboard.readText()));
check('JSON copy is the raw graph', json.nodes.length === 5 && json.edges.length === 4, JSON.stringify(json).slice(0, 80));

// 5. Expanding: the element fills the iframe, and the host is asked to make
// the iframe worth filling.
await view.locator('#graph').evaluate((el) => el.shadowRoot.querySelector('.fs-btn').click());
check('the element went fullscreen', await view.locator('#graph').evaluate((el) => el.hasAttribute('fullscreen')));
await page.waitForFunction(() => window.__displayModes.includes('fullscreen'), null, { timeout: 5000 });
check('the host was asked for a fullscreen card', true);

await view.locator('#graph').evaluate((el) => el.shadowRoot.querySelector('.fs-btn').click());
await page.waitForFunction(() => window.__displayModes.includes('inline'), null, { timeout: 5000 });
check('leaving fullscreen asks for the card back', await view.locator('#graph').evaluate((el) => !el.hasAttribute('fullscreen')));

check('no page errors', errors.length === 0, errors.join(' | '));

// 4. A failing tool says so on the card. An empty board reads as broken.
const failPage = await (await browser.newContext({ colorScheme: 'dark' })).newPage();
await failPage.goto(`http://127.0.0.1:${port}/?fail`);
const failView = failPage.frameLocator('#view');
await failView.locator('#status.error').filter({ hasText: 'no such table' }).waitFor({ timeout: 15000 });
check('a failed tool shows its error on the card', true);

// 5. Theming. A host that reports nothing must still follow the browser's
//    dark preference rather than rendering a white card in a dark chat.
async function bodyColors(url, colorScheme) {
  const page = await (await browser.newContext({ colorScheme })).newPage();
  await page.goto(url);
  const view = page.frameLocator('#view');
  await view.locator('#title').filter({ hasText: 'Site relaunch' }).waitFor({ timeout: 15000 });
  const colors = await view.locator('#graph').evaluate((el) => ({
    // Normalized: a browser may echo `#ffffff` back as `#fff`.
    dagBg: getComputedStyle(el).getPropertyValue('--dag-bg').trim().replace(/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i, '#$1$2$3'),
    fg: getComputedStyle(document.body).color,
    dataTheme: document.documentElement.dataset.theme ?? null,
  }));
  await page.close();
  return colors;
}

const silentDark = await bodyColors(`http://127.0.0.1:${port}/?theme=`, 'dark');
const LIGHT_BG = '#fff';
const DARK_BG = '#11151c';
check('dark browser + silent host → dark card', silentDark.dagBg === DARK_BG, JSON.stringify(silentDark));
check('a silent host never yields a light card', silentDark.dataTheme !== 'light', JSON.stringify(silentDark));

// A silent host is not proof of anything, whatever the browser reports: in
// a sandboxed iframe "light" is also the no-preference default.
const silentLight = await bodyColors(`http://127.0.0.1:${port}/?theme=`, 'light');
check('light browser + silent host → still dark', silentLight.dagBg === DARK_BG, JSON.stringify(silentLight));

const hostDark = await bodyColors(`http://127.0.0.1:${port}/?theme=dark`, 'light');
check('host saying dark beats a light browser', hostDark.dagBg === DARK_BG && hostDark.dataTheme === 'dark', JSON.stringify(hostDark));

const hostLight = await bodyColors(`http://127.0.0.1:${port}/?theme=light`, 'dark');
check('host saying light beats a dark browser', hostLight.dagBg === LIGHT_BG && hostLight.dataTheme === 'light', JSON.stringify(hostLight));

if (SHOT) {
  await page.screenshot({ path: SHOT });
  console.log(`  screenshot: ${SHOT}`);
  // The dark card is the one that regressed, so it gets a picture too.
  const darkShot = SHOT.replace(/(\.png)?$/, '-dark.png');
  const darkPage = await (await browser.newContext({ colorScheme: 'dark', viewport: { width: 760, height: 480 } })).newPage();
  await darkPage.goto(`http://127.0.0.1:${port}/?theme=`);
  await darkPage.frameLocator('#view').locator('#title').filter({ hasText: 'Site relaunch' }).waitFor({ timeout: 15000 });
  await darkPage.evaluate(() => (document.body.style.background = '#26262499'));
  await darkPage.waitForTimeout(400);
  await darkPage.screenshot({ path: darkShot });
  console.log(`  screenshot: ${darkShot}`);
}

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nboard checks passed');
