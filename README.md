# TaskDAG

A remote MCP server on Cloudflare Workers that lets Claude build and walk a **DAG of tasks**, and
draws the graph as an **MCP App** inline in the conversation.

Ask for a plan, get a dependency graph. Ask what's ready, get the tasks whose prerequisites are
all done. Click **Done** on the board and D1 changes.

```
[ Site relaunch                          Ready: brand, cms ]
[  Brand refresh ──▶ Homepage build ──▶ Staging ──▶ Prod    ]
[  CMS migration ───────────────────────┘                   ]
[ homepage  Homepage build  (done)                          ]
[ [Start] [Done]                               [Refresh]    ]
```

---

## How identity works: the URL *is* the login

There is no OAuth and no sign-in. `GET /` is a static page whose JavaScript generates 32 bytes with
`crypto.getRandomValues` **in your browser** and shows you a URL:

```
https://taskdag.<subdomain>.workers.dev/<token>/mcp
```

That URL is the connector URL, and it is also the password.

- **The server never mints tokens** and keeps no list of them. It only checks that a path segment
  looks like real entropy (43 base64url characters, ≥16 distinct) — `test`, `foobar` and UUIDs are
  rejected with a 400, and a bare `/mcp` is a 404.
- **Anyone who has the URL has full read/write on that graph.** Bookmark it; don't post it.
- **One working graph per token URL.** Two chats pointed at the same URL share one graph. Reload
  `/` to mint a new, empty one — the old graph keeps living at its own URL. `reset` wipes only the
  graph belonging to the token it was called on.
- Tool results, resources and the App **never contain the token**. `taskdag://me` returns
  `{ owner: "capability-url", token_tail: "…" }` and nothing more.
- The trade versus OAuth: the host you paste it into (Anthropic, for claude.ai) stores the
  connector URL, so it stores the token.

## Setup

### 1. Clone, with the submodule

The graph element (`<dag-view>`) is vendored as a pinned submodule from the **private**
`wow-look-at-my/js-snippets` repository, and compiled into the App bundle at build time. The build
machine needs GitHub access to that repo; Cloudflare does not.

```bash
git clone --recurse-submodules https://github.com/wow-look-at-my/dag-mcp.git
cd dag-mcp
# or, in an existing clone:
git submodule update --init
npm install
```

Fixes to the viewer itself belong in `js-snippets` (commit there, then bump the submodule SHA
here). `web/widgets/board.ts` is only a wrapper: it mounts the element, maps tool results onto its
node/edge shape, follows selection, and calls MCP tools through the host.

### 2. Cloudflare

```bash
npx wrangler login
npx wrangler d1 create taskdag-db       # paste the id into wrangler.jsonc
npm run migrate:remote                  # or: npm run migrate:local
```

D1 is on the Workers Paid plan. Put the printed `database_id` into `wrangler.jsonc` where it says
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 3. Run it

```bash
npm run dev        # builds the App bundle, then wrangler dev
npm run deploy     # builds, then wrangler deploy
```

### Deploying from the Cloudflare Git integration

Deploys come from the **Cloudflare Git integration** — there is deliberately no GitHub Actions
deploy workflow here. Two things make that work with no dashboard configuration beyond the deploy
command:

- **The compiled App bundle is committed** (`dist/ui/board.html`). `js-snippets` is private, and a
  Cloudflare build has no credentials for it, so it cannot check out the submodule to rebuild the
  widget. Run `npm run build:ui` and commit the result whenever the widget or the submodule SHA
  changes.
- **`wrangler.jsonc` installs its own dependencies.** A Workers Build runs the deploy command
  (`npx wrangler versions upload`) against a bare clone with no `node_modules`; wrangler's
  `build.command` hook (`scripts/ensure-deps.mjs`) installs the runtime dependencies first, and
  no-ops when they are already present, so it costs nothing locally.

**Point the integration at a branch that actually has the code.** A build against a branch without
`wrangler.jsonc` fails with *"Missing entry-point to Worker script"* — that error means the wrong
branch, not a broken config.

### 4. Mint a URL and connect

Open `https://taskdag.<subdomain>.workers.dev/`, copy the URL it shows you, and bookmark it.

**Claude.ai** — Settings → Connectors → *Add custom connector* → paste the URL →
authentication **no sign-in**. Tools on a custom connector are ask-each-time until you allowlist
them; `reset` is worth leaving on ask.

**Claude Code**

```bash
claude mcp add --transport http taskdag https://taskdag.<subdomain>.workers.dev/<token>/mcp
```

## Example prompts

- *Plan a DAG for a site relaunch: brand, homepage, cms, staging, prod. homepage depends on brand;
  staging depends on homepage and cms; prod depends on staging. Show the board.*
- *What's ready?*
- *Mark T2 done.*
- *I want to start over. Reset the graph (confirm RESET) and then plan a weekend trip.*

## Tools

An edge `{ from, to }` reads **"`from` depends on `to`"**: `to` must be done before `from` can
start. Mermaid output and the board both draw it the other way round — prerequisite first — because
that is the direction work flows.

| Tool | What it does | Destructive |
|---|---|---|
| `plan` | Create/update tasks **and** edges in one call. **Merges — never deletes.** Renders the board. | no |
| `add_tasks` | Append tasks, no edges. Merges by key. | no |
| `link` / `unlink` | Add / remove dependency edges. | `unlink`: edges only |
| `ready` | Tasks that can start now: `todo` with every dependency `done`. Renders the board. | no |
| `update_task` | Change one task's status, title, detail, priority or tags. | no |
| `get_task` | One task in full, with dependencies, dependents and what is blocking it. | no |
| `show` | `summary` \| `mermaid` \| `json`. Renders the board. | no |
| `reset` | **Wipes the whole graph.** Requires `{ "confirm": "RESET" }`. | **yes** |

`reset` is a separate tool rather than a `mode` on `plan` on purpose: hosts grant permission per
tool *name*, so this is what lets you auto-approve `plan` while `reset` still stops and asks.
`plan` has no replace or wipe flag at all.

Resources: `taskdag://me` (identity, never the token) and `ui://taskdag/board` (the MCP App).

**Graph rules.** Cycles are rejected by `link` and `plan`, with the cycle reported as task keys and
nothing written. Self-edges are illegal, duplicate edges are idempotent. A cancelled dependency does
not count as satisfied. Reopening a done task does not reopen its dependents. Keys auto-assign
`T1`, `T2`, … (next free number, gaps are never reused). Every batch is one transaction.

## The App

`ui://taskdag/board`, MIME `text/html;profile=mcp-app`, linked from `plan`, `ready` and `show` via
`_meta.ui.resourceUri`. It is one self-contained HTML file: `<dag-view>`, its stylesheet and the
App bridge are all bundled in, and the resource declares **empty** CSP domain lists — the iframe
makes no network requests at all, and never talks to `/mcp` or D1. Every write goes
View → host `tools/call` → Worker, which is also why the host's permission prompts still mean
something.

`_meta.ui.domain` is set, for Claude, to `sha256(<the public token URL>).hex[:32] +
".claudemcpcontent.com"` — per-graph, and not a way back to the token.

Hosts that ignore MCP Apps lose nothing important: every tool still returns compact JSON, and
Mermaid text for graphs up to 60 nodes.

## Tests

```bash
npm test          # graph rules + merge semantics against real SQL
npm run typecheck
npm run check:board   # drives the compiled App in Chromium against a stand-in host
```

`test/fake-d1.ts` runs the real migration and the real statements on `node:sqlite`, so the merge
tests exercise the actual SQL rather than a second implementation of it. `scripts/check-board.mjs`
loads the compiled bundle in a browser, completes the MCP Apps handshake, and asserts that the
graph draws, that selection fetches detail through the host, and that **Done** leaves as a
`tools/call`. On a machine whose Chromium lives outside `node_modules`, point it at one:
`CHROME_PATH=/path/to/chromium npm run check:board`.

## Manual check list

1. MCP Inspector against a minted `/<token>/mcp`: `tools/list` shows nine tools, `resources/list`
   shows `ui://taskdag/board` with MIME `text/html;profile=mcp-app`.
2. Claude.ai (or the Cloudflare AI Playground): after `plan`, the board renders inline.
3. Clicking **Done** on the board changes D1 — ask *"what's ready?"* afterwards and the queue has
   moved.

## Layout

```
src/graph.ts    pure rules: cycles, ready set, keys, mermaid   (unit tested)
src/db.ts       D1, partitioned by token; merge, patch, reset  (unit tested)
src/tools.ts    the MCP tools and resources
src/server.ts   one McpServer per request, closed over the token
src/index.ts    routing: /, /:token/mcp, /health
src/token.ts    what counts as an owner token
web/landing.html        the static page that mints tokens in the browser
web/widgets/board.*     the MCP App: shell + wrapper around <dag-view>
third_party/js-snippets pinned submodule: the viewer itself
migrations/             D1 schema
```
