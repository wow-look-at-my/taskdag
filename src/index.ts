/**
 * The Worker.
 *
 * ROUTES
 *   GET  /                 the landing page: static HTML that mints a token
 *                          in the BROWSER and shows the URL to bookmark.
 *   ALL  /:token/mcp       the MCP endpoint, if and only if the segment is
 *                          shaped like a real 32-byte token.
 *   GET  /health           liveness.
 *   *                      404.
 *
 * The server never mints tokens and keeps no list of them. `isOwnerToken` is
 * the whole gate, and a bare `/mcp` is a 404 because there is no graph that
 * is not somebody's.
 */

import boardHtml from '../dist/ui/board.html';
import landingHtml from '../web/landing.html';
import { handlerForToken } from './server.ts';
import { isOwnerToken } from './token.ts';

export interface Env {
  DB: D1Database;
}

const MCP_PATH = /^\/([^/]+)\/mcp$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(landingHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // The page is static and identical for everyone: the only
          // per-person thing on it is minted client-side and never sent here.
          'cache-control': 'public, max-age=300',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'taskdag' });
    }

    const match = MCP_PATH.exec(url.pathname);
    if (match) {
      const token = match[1];
      if (!isOwnerToken(token)) {
        return Response.json(
          {
            error: 'invalid_token',
            message:
              'That is not a TaskDAG connector URL. Open https://' +
              url.host +
              '/ in a browser to mint one, then use the full https://' +
              url.host +
              '/<token>/mcp URL it shows you.',
          },
          { status: 400 },
        );
      }
      const handler = handlerForToken(
        { db: env.DB, owner: token, publicUrl: `${url.origin}${url.pathname}`, boardHtml },
        url.pathname,
      );
      return handler(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
