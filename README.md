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
- **One token, as many graphs as you like.** Each graph has a server-minted handle (`g_…`) that
  every result carries and every tool accepts; omit it and you get the most recent one. `graphs`
  lists them. Two chats pointed at the same URL can work on the same graph or on different ones —
  the handle decides, not the connection. `reset` empties one graph and leaves the handle standing.
- Tool results, resources and the App **never contain the token**. `taskdag://me` returns
  `{ owner: "capability-url", token_tail: "…" }` and nothing more.
- The trade versus OAuth: the host you paste it into (Anthropic, for claude.ai) stores the
  connector URL, so it stores the token.

### There is no session to identify you by

A remote MCP server has exactly one other place it could look for "who is this, and which working
set": the transport. On protocol revision `2026-07-28` there is nothing there. The changelog's first
entry is

> Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport.
> [...] Servers that need cross-call state use explicit, server-minted handles passed as ordinary
> tool arguments ([SEP-2567](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567)).

and the Statelessness chapter closes the workarounds: a server **MUST NOT** rely on prior requests
over the same connection to establish context *including client identity*, an open connection
*"is not a conversation or session"*, and state spanning requests **MUST** be referenced by an
explicit identifier the client passes every time. There is no conversation or thread id anywhere in
`_meta` either — the reserved `io.modelcontextprotocol/*` keys are the protocol version, the
client's info and capabilities, a log level, a subscription id, the server's info, and task/skill
plumbing. The closest thing to a name in any of them is `clientInfo`, which is the product
(`"ClaudeAI"` from claude.ai, `"claude-code"` from the CLI) and its version — not a person.

So the two sanctioned answers are OAuth for *who* and a server-minted handle passed on every call
for *which working set*. TaskDAG implements the second one literally: `graph` is minted by the
server, returned in every result, and accepted as an ordinary argument on every tool — SEP-2567 as
written. The path token answers the *other* question, and answers it as a capability rather than as
identity: it is read fresh from every request, which is the property the statelessness rule is
about, but it is **not** authentication of a person — see the trade above.

The two never blur together. A handle is an address inside one token's partition and is safe to
show the model; the token is the credential and never appears in a result. `resolveGraph` is the
single place they meet, and it binds the owner alongside the handle — so another token's handle
reads as "no graph with that handle", exactly like one that was never minted.

What the server does with the machinery that was removed, all pinned by `test/transport.test.ts`:

| | |
|---|---|
| `Mcp-Session-Id` on a request | Ignored, never echoed. The spec's word is *"ignore it, and do not mint or echo session IDs"*. |
| `GET` or `DELETE` on `/<token>/mcp` | `405`. Those were the standalone SSE stream and session termination. |
| Response to any call | Carries no session id, on the modern revision and on the `2025-11-25` fallback alike. |

That last row is why the tests exist: statelessness here is inherited from the SDK, not written in
this repo, and an SDK upgrade that started minting session ids would quietly put a second, weaker
handle on every graph — one a host could cache, log, or hand to a different chat.

Worth knowing when reading logs: Claude Code still implements the *client* half of `2025-11-25`
sessions (it stores an `mcp-session-id` from an initialize response, replays it, and on
`404`/`"No valid session ID"` logs *"MCP session expired [...] triggering reconnection"* and
re-initializes into a brand-new one). A session id is disposable connection state to the client
that holds it, which is the practical reason it could never have been anyone's identity.

## Setup

### 1. Clone, with the submodule

The graph element (`<dag-view>`) is vendored as a pinned submodule from the **private**
`wow-look-at-my/js-snippets` repository, and compiled into the App bundle at build time. The build
machine needs GitHub access to that repo; Cloudflare does not.

```bash
git clone --recurse-submodules https://github.com/wow-look-at-my/taskdag.git
cd taskdag
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
npx wrangler d1 create taskdag-db       # only for a new deployment; see below
npm run migrate:remote                  # or: npm run migrate:local
```

D1 is on the Workers Paid plan. `wrangler.jsonc` already carries the `database_id` for this
deployment's database — it is an identifier, not a credential, and it has to be committed because
a Cloudflare Workers Build reads the binding straight out of the file. Deploying to a *different*
account means creating your own database and replacing that id.

**A fresh database needs no migration step, and neither did the handles.** The Worker applies the
migration files themselves — imported as text, not a second copy of the DDL — on its first database
call. So a deploy pointed at an empty D1 works immediately instead of answering *no such table:
graphs* until somebody remembers `wrangler d1 migrations apply`, and an existing deployment picked
up `0002_graph_handles.sql` on its next request with its graphs intact.

That is possible because **every statement in `migrations/` is idempotent**: `CREATE ... IF NOT
EXISTS`, or a backfill whose `WHERE NOT EXISTS` makes a second run do nothing. `0002` adds tables
beside `0001`'s and copies the rows across rather than rebuilding them, which is what makes it safe
to re-run on every cold start. A test enforces the rule, because it is the only thing standing
between a bootstrap and a duplicated graph.

A migration that **alters or drops** an existing table is a different animal and still goes through
`npm run migrate:remote` by hand, deliberately: a schema change that runs itself on the first
request is how you lose data at 3am. `0003_drop_legacy_tables.sql` drops 0001's now-unused
`graphs`/`tasks`/`edges`, and is **deliberately absent from `src/schema.ts`'s migration list** so
the bootstrap can never run it; a test fails if it is added, or if any statement on the bootstrap
path is a `DROP`/`ALTER`. Run it by hand once you are satisfied the copy landed — those three
tables are still the only copy of the pre-handle rows, since 0002 copied rather than moved them,
and the file carries the query to check that with. Running `migrations apply` on a
bootstrapped database is a harmless no-op.

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
| `plan` | Create/update tasks **and** edges in one call. **Merges — never deletes.** `new_graph: true` starts a separate plan. Renders the board. | no |
| `link` / `unlink` | Add / remove dependency edges. | `unlink`: edges only |
| `ready` | Tasks that can start now: `todo` with every dependency `done`. Renders the board. | no |
| `update_task` | Change one task's status, title, detail, priority or tags. | no |
| `get_task` | One task in full, with dependencies, dependents and what is blocking it. | no |
| `show` | Draw the board, return the summary. | no |
| `mermaid` | The graph as a diagram — selectable, and capped. See below. | no |
| `graphs` | Every **non-empty** graph on this connector: handle, title, task count. | no |
| `delete_graph` | **Removes a graph entirely**, handle included. Requires `{ "confirm": "DELETE" }` and an explicit handle. | **yes** |
| `reset` | **Empties one graph.** Requires `{ "confirm": "RESET" }`. The handle survives. | **yes** |

`delete_graph` is the one tool with **no default handle**: every other tool falls back to your most
recent graph, and a default that empties the wrong one is recoverable where a default that deletes
it is not. An emptied graph drops out of `graphs` — a list filling up with the husks of `reset`
calls is a list nobody can read — but its handle keeps working, and writing to it puts it back.
Resolution is deliberately not filtered the same way: clear a graph and add to it without naming
it, and you land back in the one you just cleared rather than silently in an older one.


`reset` is a separate tool rather than a `mode` on `plan` on purpose: hosts grant permission per
tool *name*, so this is what lets you auto-approve `plan` while `reset` still stops and asks.
`plan` has no replace or wipe flag at all.

Resources: `taskdag://graph/<handle>` (every node and edge — the payload the tools leave out),
`taskdag://me` (identity, never the token) and `ui://taskdag/board` (the MCP App).

### What a result costs

A tool result is not free and it is not paid once: it lands in the conversation and is re-sent with
every turn that follows. So a result here is a **receipt** — which graph, how big, what is startable
— and never the graph itself:

```json
{"graph":"g_9f1c…","title":"Platform migration","tasks":40,"edges":39,
 "counts":{"todo":40},"ready":[{"key":"T1","title":"Task number 1"}]}
```

alongside a `resource_link` to `taskdag://graph/<handle>`. The App reads that resource directly, so
the board draws the whole graph without the model paying for it, and the model reads it only when
the shape of the graph is genuinely the question. A 40-task `plan` answers in ~420 characters
instead of ~9,500. `test/budget.test.ts` holds that line: it fails if a result starts carrying the
graph again.

### `mermaid`: selectable, capped, and uncapped on purpose

The diagram is the one result meant to be read as text, which makes it the one place a big graph can
quietly cost thousands of tokens. So:

- **Select instead of dumping.** `keys` (+ `depth`, `direction`) draws a neighbourhood; `status`
  filters. Seeds always survive their own filter, and keys that match nothing select *nothing* —
  never, quietly, everything.
- **The output is capped** at 4,000 characters (8,000 if you ask). Over that, you get the
  measurements rather than half a diagram, because truncated Mermaid is a syntax error, not a
  smaller picture.
- **The cap lifts only after it bites.** An overflow mints a single-use `override_token`, and that
  token is the only way past the cap — for that graph, once. Asking for `max_chars: 500000` up
  front is refused by the schema.

**Graph rules.** Cycles are rejected by `link` and `plan`, with the cycle reported as task keys and
nothing written. Self-edges are illegal, duplicate edges are idempotent. A cancelled dependency does
not count as satisfied. Reopening a done task does not reopen its dependents. Keys auto-assign
`T1`, `T2`, … (next free number, gaps are never reused). Every batch is one transaction.

## What the logs do not keep

Cloudflare's automatic per-request invocation log records the full request URL — and here the URL
path *is* the credential. Left on, anyone who can read the account's logs, or any Logpush
destination downstream of them, would have permanent read/write on every graph that had been
touched. So `wrangler.jsonc` sets `observability.logs.invocation_logs: false` and
`redact_query_string: true`. Explicit `console.log` still works; this Worker writes none that carry
a token, and no tool result, resource or App payload contains one either.

Worth knowing about what *does* reach the Worker: requests arrive from Anthropic's cloud, so the
client IP, ASN and geo in `request.cf` are Anthropic's shared egress rather than the end user's,
and nothing in a request identifies a conversation.

## The App

`ui://taskdag/board`, MIME `text/html;profile=mcp-app`, linked from `plan`, `ready` and `show` via
`_meta.ui.resourceUri`. It is one self-contained HTML file: `<dag-view>`, its stylesheet and the
App bridge are all bundled in, and the resource declares **empty** CSP domain lists — the iframe
makes no network requests at all, and never talks to `/mcp` or D1. Every write goes
View → host `tools/call` → Worker, which is also why the host's permission prompts still mean
something.

`_meta.ui.domain` is set, for Claude, to `sha256(<the public token URL>).hex[:32] +
".claudemcpcontent.com"` — per-graph, and not a way back to the token.

**The card is dark unless the host proves otherwise.** Inside a sandboxed iframe,
`prefers-color-scheme: light` is also what a browser reports when nobody has expressed a
preference, and `getDocumentTheme()` reads an attribute rather than the media query and falls back
to light — so neither can distinguish a light user from a silent host. Only `hostContext.theme`
can, and anything short of it saying `"light"` leaves the card dark.

**Getting things out of it.** The graph is painted on a canvas, so there is no text to select —
**Copy** offers three shapes instead: *Markdown* (a checklist, with each task's prerequisites under
it), *Mermaid* (a diagram) and *JSON* (the raw graph). The Mermaid comes from `src/graph.ts`'s own
renderer, compiled into the bundle: `graph.ts` is pure, so the Worker and the App share one
implementation rather than drifting apart as two. `navigator.clipboard` needs a permission the
host's sandbox may withhold, so there is an `execCommand` fallback and, if both fail, the card says
so rather than silently doing nothing.

**Making it bigger.** `<dag-view>` brings its own fit, zoom and orientation buttons, and its
fullscreen button is now enabled — it fills the iframe. Because the iframe is only as big as the
host made the card, toggling it also asks the host for the matching display mode
(`ui/request-display-mode`). A host that offers no fullscreen mode, or declines, still gets the
in-iframe fill: the request never blocks the toggle.

Hosts that ignore MCP Apps lose nothing important: every tool still returns compact JSON, and
`mermaid` renders the same diagram on demand.

## Tests

```bash
npm test          # graph rules + merge semantics against real SQL
npm run typecheck
npm run check:board   # drives the compiled App in Chromium against a stand-in host
```

`test/transport.test.ts` drives the real Worker entry point against that same fake, and asserts the
session rules above — no minted session id, an incoming one ignored, `405` on GET and DELETE, and a
preflight that allows the `Mcp-Method` / `Mcp-Name` headers every modern request now has to carry.
`test/handles.test.ts` covers the handle itself (minting, defaulting, cross-token refusal, the
resource behind it), `test/mermaid.test.ts` the selection and the cap, `test/budget.test.ts` what
all of it costs a conversation, and `test/migration.test.ts` starts from a genuine pre-handle
database — 0001's tables with rows in them — to prove the backfill gives an existing graph a handle
without losing or duplicating it, however many times a cold start replays it. `test/fake-d1.ts` runs the real migration and the real statements on `node:sqlite`, so the merge
tests exercise the actual SQL rather than a second implementation of it. `scripts/check-board.mjs`
loads the compiled bundle in a browser, completes the MCP Apps handshake, and asserts that the
graph draws, that selection fetches detail through the host, that **Done** leaves as a
`tools/call`, that each **Copy** format lands in a real clipboard, and that fullscreen negotiates a
display mode with the host. On a machine whose Chromium lives outside `node_modules`, point it at one:
`CHROME_PATH=/path/to/chromium npm run check:board`.

## Manual check list

1. MCP Inspector against a minted `/<token>/mcp`: `tools/list` shows eleven tools, `resources/list`

   shows `ui://taskdag/board` with MIME `text/html;profile=mcp-app`, and reading
   `taskdag://graph/<handle>` from a `plan` result returns that graph whole.
2. Claude.ai (or the Cloudflare AI Playground): after `plan`, the board renders inline.
3. Clicking **Done** on the board changes D1 — ask *"what's ready?"* afterwards and the queue has
   moved.

## Layout

```
src/graph.ts    pure rules: cycles, ready set, keys, selection, mermaid (unit tested)
src/db.ts       D1, owned by token and addressed by handle; merge, patch, reset (unit tested)
src/tools.ts    the MCP tools and resources
src/server.ts   one McpServer per request, closed over the token
src/index.ts    routing: /, /:token/mcp, /health
src/token.ts    what counts as an owner token
web/landing.html        the static page that mints tokens in the browser
web/widgets/board.*     the MCP App: shell + wrapper around <dag-view>
third_party/js-snippets pinned submodule: the viewer itself
migrations/             D1 schema
```
