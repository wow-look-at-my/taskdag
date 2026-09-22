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

const INSTRUCTIONS = [
  'TaskDAG holds ONE working graph of tasks and dependencies for this connection.',
  'An edge { from, to } reads "from depends on to": to must be done before from can start.',
  'plan merges — it never deletes, so a new plan never needs a wipe first.',
  'reset is the only tool that clears the graph and it needs { "confirm": "RESET" }.',
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
    corsOptions: { origin: '*', methods: 'GET,POST,OPTIONS', headers: 'Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id' },
  });
}
