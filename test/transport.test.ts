/**
 * The transport's half of identity: what the server must NOT do with a
 * session.
 *
 * MCP `2026-07-28` deleted protocol-level sessions outright. The changelog
 * entry is "Remove protocol-level sessions and the `Mcp-Session-Id` header
 * from the Streamable HTTP transport [...] Servers that need cross-call
 * state use explicit, server-minted handles passed as ordinary tool
 * arguments", and the transport chapter tells a server on this revision to
 * answer GET and DELETE with 405 and, on an incoming `Mcp-Session-Id`, to
 * "ignore it, and do not mint or echo session IDs".
 *
 * That is not a footnote for TaskDAG: the capability URL is the whole
 * identity model, and it is only sound while the connection carries no
 * identity of its own. A session id minted by a future SDK upgrade would be
 * a second, weaker handle on the same graph -- one the host could cache,
 * log, or hand to a different chat. These tests fail if that ever starts
 * happening, which is the point: they pin behaviour the server gets from a
 * dependency rather than from its own code.
 *
 * They drive the real Worker entry point (`src/index.ts`) against the same
 * SQLite-backed D1 fake the db tests use, so routing, the token gate, the
 * SDK's HTTP layer and the tools are all in the path.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.ts';
import { createTestDb } from './fake-d1.ts';

const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';
const OTHER_TOKEN = 'zX9wQ2eR5tY7uI0oP3aS6dF8gH1jK4lZ-_cVbNmQwEr';

const HOST = 'https://taskdag.example';

/** No-op ExecutionContext: nothing under test defers work. */
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function env(): { DB: D1Database } {
  return { DB: createTestDb() };
}

/**
 * The `2026-07-28` per-request envelope. With sessions gone there is no
 * handshake left to carry this: every request states the protocol version,
 * the client and its capabilities in `_meta`, and repeats the method in the
 * `Mcp-Method` header. A server that rejected these would be failing the
 * revision, so sending them exactly is part of what the test asserts.
 */
function modernBody(id: number, method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'transport-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function fetchWorker(e: { DB: D1Database }, request: Request): Promise<Response> {
  return worker.fetch(request, e as never, ctx);
}

/** One modern JSON-RPC call, optionally with extra (hostile) headers. */
function call(
  e: { DB: D1Database },
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  token: string = TOKEN,
): Promise<Response> {
  return fetchWorker(
    e,
    new Request(`${HOST}/${token}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        // `tools/call` must repeat the tool name in a header too; the
        // revision requires header and body to agree.
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(modernBody(1, method, params)),
    }),
  );
}

/** A JSON-RPC result, whether it arrives as JSON or as a one-event stream. */
async function result(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(
        text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join(''),
      )
    : JSON.parse(text);
  expect(json.error, JSON.stringify(json.error)).toBeUndefined();
  return json.result as Record<string, unknown>;
}

/** Tool names from a `tools/list` result, sorted so order is not asserted. */
function toolNames(listResult: Record<string, unknown>): string[] {
  return (listResult.tools as { name: string }[]).map((t) => t.name).sort();
}

/** The graph `show` reports, parsed out of its text content. */
async function graphKeys(e: { DB: D1Database }, token: string = TOKEN): Promise<string[]> {
  const res = await call(e, 'tools/call', { name: 'show', arguments: { format: 'json' } }, {}, token);
  const shown = await result(res);
  const text = (shown.content as { type: string; text: string }[]).find((c) => c.type === 'text');
  const graph = JSON.parse(text!.text) as { graph: { nodes: { key: string }[] } };
  return graph.graph.nodes.map((n) => n.key).sort();
}

describe('sessions are not part of this transport', () => {
  it('mints no session id on an ordinary call', async () => {
    const res = await call(env(), 'tools/list');

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(toolNames(await result(res))).toContain('plan');
  });

  it('ignores an Mcp-Session-Id it is handed, and does not echo it', async () => {
    // A 2025-11-25-era client, or an attacker guessing that the session id
    // is the identity, sends one. Neither may change the answer.
    const res = await call(env(), 'tools/list', {}, { 'mcp-session-id': 'attacker-supplied-session' });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(toolNames(await result(res))).toEqual(toolNames(await result(await call(env(), 'tools/list'))));
  });

  it('answers GET and DELETE on the MCP endpoint with 405', async () => {
    const e = env();

    // GET was the standalone SSE stream and DELETE was session termination;
    // this revision has neither, and 405 is what tells an older client so.
    const get = await fetchWorker(e, new Request(`${HOST}/${TOKEN}/mcp`));
    const del = await fetchWorker(e, new Request(`${HOST}/${TOKEN}/mcp`, { method: 'DELETE' }));

    expect(get.status).toBe(405);
    expect(del.status).toBe(405);
  });

  it('preflights the headers a modern request cannot do without', async () => {
    // With the handshake gone, `Mcp-Method` (and `Mcp-Name` on a
    // `tools/call`) are required on every request. A browser-side client
    // whose preflight did not allow them could not make one call.
    const res = await fetchWorker(
      env(),
      new Request(`${HOST}/${TOKEN}/mcp`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.invalid',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, mcp-protocol-version, mcp-method, mcp-name',
        },
      }),
    );
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();

    expect(allowed).toContain('mcp-method');
    expect(allowed).toContain('mcp-name');
    expect(allowed).toContain('mcp-protocol-version');
  });

  it('still mints nothing for a legacy client that opens with initialize', async () => {
    // 2025-11-25 allows a session and Claude Code still implements the
    // client half of it, so the fallback path has to stay stateless too:
    // it is the same graph either way, reached by the same URL.
    const res = await fetchWorker(
      env(),
      new Request(`${HOST}/${TOKEN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect((await result(res)).protocolVersion).toBe('2025-11-25');
  });
});

describe('the URL is the identity', () => {
  it('shows one graph to unrelated requests carrying the same token', async () => {
    const e = env();

    await call(e, 'tools/call', {
      name: 'plan',
      arguments: { title: 'Site relaunch', tasks: [{ key: 'brand', title: 'Brand refresh' }], edges: [] },
    });

    // Nothing links these two requests: no session, no cookie, no stream.
    // The path is the only thing they share, and it is enough.
    expect(await graphKeys(e)).toEqual(['brand']);
  });

  it('shows a different token an empty graph', async () => {
    const e = env();

    await call(e, 'tools/call', {
      name: 'plan',
      arguments: { title: 'Site relaunch', tasks: [{ key: 'brand', title: 'Brand refresh' }], edges: [] },
    });

    expect(await graphKeys(e, OTHER_TOKEN)).toEqual([]);
  });

  it('refuses a path segment that is not a real token, and a bare /mcp', async () => {
    const e = env();

    const guessed = await fetchWorker(
      e,
      new Request(`${HOST}/test/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(modernBody(1, 'tools/list')),
      }),
    );
    const bare = await fetchWorker(e, new Request(`${HOST}/mcp`, { method: 'POST' }));

    expect(guessed.status).toBe(400);
    expect(bare.status).toBe(404);
  });
});
