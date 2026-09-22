/**
 * A 2026-07-28 MCP client, just enough of one to drive the real Worker.
 *
 * WHY THE ENVELOPE IS SPELLED OUT. On this revision there is no handshake
 * to negotiate anything: every request carries the protocol version, the
 * client and its capabilities in `_meta`, and repeats its method in the
 * `Mcp-Method` header (plus the tool name or resource URI in `Mcp-Name`).
 * Building that by hand here means the tests exercise the same path Claude
 * does, header validation included, rather than a convenient shortcut.
 */

import worker from '../src/index.ts';
import { createTestDb } from './fake-d1.ts';

export const TOKEN = 'kJ3nQ7vB9xZp2LmR8tW4yU6iO1aS5dF0gH-_cVbNxQe';
export const OTHER_TOKEN = 'zX9wQ2eR5tY7uI0oP3aS6dF8gH1jK4lZ-_cVbNmQwEr';

const HOST = 'https://taskdag.example';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'taskdag-tests', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'resource_link'; uri: string; name: string })[];
  isError?: boolean;
}

export class TestClient {
  constructor(
    readonly env: { DB: D1Database },
    readonly token: string = TOKEN,
  ) {}

  /** Same database, different capability URL: a second person. */
  as(token: string): TestClient {
    return new TestClient(this.env, token);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
    return worker.fetch(
      new Request(`${HOST}/${this.token}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          ...(name !== undefined ? { 'mcp-name': name } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
      }),
      this.env as never,
      ctx,
    );
  }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.request(method, params);
    const text = await res.text();
    const body = res.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join(''),
        )
      : JSON.parse(text);
    if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
    return body.result as Record<string, unknown>;
  }

  /** A tool call, raw: `isError` results come back rather than throwing. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await this.rpc('tools/call', { name, arguments: args })) as unknown as ToolResult;
  }

  /** A tool call that is expected to work, parsed out of its text block. */
  async json<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.tool(name, args);
    if (result.isError) throw new Error(`${name} returned an error: ${textOf(result)}`);
    return JSON.parse(textOf(result)) as T;
  }

  async readResource<T = Record<string, unknown>>(uri: string): Promise<T> {
    const result = (await this.rpc('resources/read', { uri })) as { contents: { text: string }[] };
    return JSON.parse(result.contents[0].text) as T;
  }

  async tools(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
    const result = (await this.rpc('tools/list')) as { tools: { name: string; description: string; inputSchema: unknown }[] };
    return result.tools;
  }
}

export function textOf(result: ToolResult): string {
  const block = result.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

export function linksOf(result: ToolResult): string[] {
  return result.content.filter((c) => c.type === 'resource_link').map((c) => (c as { uri: string }).uri);
}

export function client(): TestClient {
  return new TestClient({ DB: createTestDb() });
}
