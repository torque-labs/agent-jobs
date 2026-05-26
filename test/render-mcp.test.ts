/**
 * Tests for the `render` MCP server (mcp-servers/render/index.mjs). No test
 * framework is wired into agent-jobs, so these use Node's built-in test runner:
 *
 *   pnpm tsx --test test/render-mcp.test.ts
 *
 * We spawn the real server via the same StdioClientTransport the orchestrator
 * uses, point RENDER_SERVICE_URL at a local stub HTTP server, and assert the
 * request construction (path, method, Bearer auth, body shape) + error handling
 * — no live render service or real DIGEST_API_KEY needed.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

type Captured = { method?: string; url?: string; auth?: string; body?: unknown };

/** A stub that records the next request and replies with `reply`. */
function stubServer(reply: { status: number; json?: unknown }) {
  const captured: Captured = {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    captured.method = req.method;
    captured.url = req.url;
    captured.auth = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        captured.body = Buffer.concat(chunks).toString('utf8');
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.json !== undefined ? JSON.stringify(reply.json) : '');
    });
  });
  return { server, captured };
}

async function withClient(
  url: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(process.cwd(), 'mcp-servers/render/index.mjs')],
    env: { ...getDefaultEnvironment(), RENDER_SERVICE_URL: url, DIGEST_API_KEY: 'test-key' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'render-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await transport.close();
  }
}

function listenOn(server: ReturnType<typeof stubServer>['server']): Promise<string> {
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      res(`http://127.0.0.1:${port}`);
    });
  });
}

test('lists exactly the two render tools with object input schemas', async () => {
  await withClient('http://127.0.0.1:1', async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['render_leaderboard', 'render_rebate']);
    for (const t of listed.tools) {
      assert.equal((t.inputSchema as { type?: string }).type, 'object');
    }
  });
});

test('render_leaderboard POSTs /v1/leaderboard with mode=results, Bearer auth, and defaults', async () => {
  const { server, captured } = stubServer({
    status: 200,
    json: { markdown: '# digest', html: '<h1>', pdf_base64: 'AA==', title: 't' },
  });
  const url = await listenOn(server);
  after(() => server.close());

  await withClient(url, async (client) => {
    const result = await client.callTool({
      name: 'render_leaderboard',
      arguments: { results: { rows: [{ wallet: 'abc', balance: 10 }] } },
    });
    assert.equal((result as { isError?: boolean }).isError, undefined);
    const text = (result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(text) as { markdown: string };
    assert.equal(parsed.markdown, '# digest');
  });

  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/v1/leaderboard');
  assert.equal(captured.auth, 'Bearer test-key');
  assert.deepEqual(captured.body, {
    mode: 'results',
    results: { rows: [{ wallet: 'abc', balance: 10 }] },
    prior_offset_days: 6,
    use_llm: true,
    publish: false,
  });
});

test('render_rebate POSTs /v1/rebate with config + data', async () => {
  const { server, captured } = stubServer({ status: 200, json: { markdown: 'r' } });
  const url = await listenOn(server);
  after(() => server.close());

  await withClient(url, async (client) => {
    await client.callTool({
      name: 'render_rebate',
      arguments: { config: 'wxrp', data: { volume: 100 }, use_llm: false },
    });
  });

  assert.equal(captured.url, '/v1/rebate');
  assert.deepEqual(captured.body, { config: 'wxrp', data: { volume: 100 }, use_llm: false });
});

test('non-200 from the service surfaces as a tool error (no fabricated digest)', async () => {
  const { server } = stubServer({ status: 401, json: { error: 'unauthorized' } });
  const url = await listenOn(server);
  after(() => server.close());

  await withClient(url, async (client) => {
    const result = await client.callTool({
      name: 'render_leaderboard',
      arguments: { results: {} },
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    const text = (result as { content: { text: string }[] }).content[0].text;
    assert.match(text, /render error/);
    assert.match(text, /401/);
  });
});
