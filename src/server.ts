/**
 * One MCP server per request, closed over the request's token.
 *
 * `createMcpHandler` takes a factory rather than a server, which is what
 * makes the capability URL work: the token is baked into the tools' closure
 * at construction, so no tool can be called with an owner other than the one
 * in the path it arrived on.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

import { registerTaskDag } from './tools.ts';
import type { ToolContext } from './tools.ts';

const SERVER_INFO = { name: 'taskdag', version: '0.1.0' } as const;

/**
 * Sent once per conversation, so it buys clarity cheaply — and it is the
 * only place that can teach the handle convention before the first call.
 */
const INSTRUCTIONS = [
  'TaskDAG stores graphs of tasks and dependencies.',
  'Every result carries a `graph` handle: pass it back on later calls, or omit it for the most recent one.',
  'Results are summaries; the nodes and edges live at taskdag://graph/<handle>, and `mermaid` draws them.',
  'An edge { from, to } reads "from depends on to": to must be done before from can start.',
  'plan merges — it never deletes, so a new plan never needs a wipe first.',
  'reset is the only tool that clears a graph and it needs { "confirm": "RESET" }.',
].join(' ');

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: {
      // Advertising the Apps extension is what tells a host it can render
      // the ui:// resources these tools link to.
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
      },
    },
  });
  registerTaskDag(server, ctx);
  return server;
}

/**
 * An MCP HTTP handler bound to one token's path. Built per request: the
 * route itself carries the token, so it cannot be shared between owners.
 */
export function handlerForToken(ctx: ToolContext, route: string) {
  return createMcpHandler(() => createServer(ctx), {
    route,
    // Claude reaches the Worker from Anthropic's cloud, and the App iframe
    // never talks to /mcp directly, so no browser Origin needs allowing
    // beyond the defaults.
    //
    // The header list is what a browser-side client would be allowed to
    // send, and on 2026-07-28 that has to include `Mcp-Method` and
    // `Mcp-Name`: with the handshake gone, every request restates its
    // method in a header and `tools/call` restates the tool name, and a
    // preflight that withheld them would fail every modern call. Only POST
    // is listed because GET and DELETE are 405 on this revision -- the GET
    // SSE stream and DELETE session termination are 2025-11-25 mechanisms.
    // `MCP-Session-Id` stays allowed rather than supported: an older client
    // may send one, and the server ignores it (see test/transport.test.ts).
    corsOptions: {
      origin: '*',
      methods: 'POST,OPTIONS',
      headers: 'Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Method, MCP-Name, MCP-Session-Id',
    },
  });
}
