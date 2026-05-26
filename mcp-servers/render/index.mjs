#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `render` MCP server — bridges Torque jobs to the deployed render service so
// the LLM NEVER computes report numbers itself.
//
// The render service (https://digest.coolify.torque.so) computes every fact
// deterministically (concentration, deltas, rank boundary, engagement) from
// the raw eval rows and renders the digest. The model's only job is to pass
// the snapshot through and use the returned `markdown` verbatim — eliminating
// the in-head-math hallucination risk.
//
// Plain `.mjs` on purpose: the production runtime image ships only `node` (no
// tsx) and copies this file verbatim — no compile step. `@modelcontextprotocol/sdk`
// is a production dependency, so the import resolves in the container.
//
// Env (injected by lib/mcp.ts buildSpecs, sourced from process.env):
//   RENDER_SERVICE_URL  base URL of the render service (e.g. https://digest.coolify.torque.so)
//   DIGEST_API_KEY      Bearer token for the render service
// ---------------------------------------------------------------------------
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVICE_URL = (process.env.RENDER_SERVICE_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.DIGEST_API_KEY ?? '';

/**
 * POST a JSON body to a render-service endpoint and return the parsed JSON.
 * Throws an Error with a clear, model-readable message on any non-2xx.
 */
async function postRender(path, body) {
  if (!SERVICE_URL) throw new Error('RENDER_SERVICE_URL is not configured');
  if (!API_KEY) throw new Error('DIGEST_API_KEY is not configured');

  const res = await fetch(`${SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`render service ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: 'render_leaderboard',
    description:
      'Compute leaderboard facts (concentration, 24h deltas, rank boundary, engagement) from raw eval rows AND render the digest, all deterministically server-side. Pass the current leaderboard snapshot as `results`; the service derives the prior snapshot itself from `prior_offset_days`. Returns { markdown, html, pdf_base64, title }. Use the returned `markdown` VERBATIM — never recompute any number.',
    inputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'object',
          description: 'The current leaderboard eval result JSON (rows + metadata) as returned by the Torque incentive query.',
        },
        prior_offset_days: {
          type: 'number',
          description: 'How many days back the service should compute the prior/baseline snapshot for delta math. Default 6.',
        },
        use_llm: {
          type: 'boolean',
          description: 'Whether the service may use an LLM to phrase the narrative insights. Default true.',
        },
      },
      required: ['results'],
      additionalProperties: false,
    },
  },
  {
    name: 'render_rebate',
    description:
      'Render a rebate-program report for a configured slug from a DataContract payload. Numbers are computed/validated server-side. Returns { markdown, html, pdf_base64, title }. Use the returned `markdown` verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          type: 'string',
          description: 'The rebate config slug registered on the render service.',
        },
        data: {
          type: 'object',
          description: 'The DataContract payload for the rebate report.',
        },
        use_llm: {
          type: 'boolean',
          description: 'Whether the service may use an LLM to phrase the narrative. Default true.',
        },
      },
      required: ['config', 'data'],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'render', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Hand-roll the list/call handlers against the low-level Server so we don't
// depend on the higher-level McpServer helper API surface (which wants Zod raw
// shapes); these tools expose plain JSON Schema, matching what lib/mcp.ts reads.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const { name, arguments: args = {} } = request.params ?? {};
    try {
      let json;
      if (name === 'render_leaderboard') {
        json = await postRender('/v1/leaderboard', {
          mode: 'results',
          results: args.results,
          prior_offset_days: args.prior_offset_days ?? 6,
          use_llm: args.use_llm ?? true,
          publish: false,
        });
      } else if (name === 'render_rebate') {
        json = await postRender('/v1/rebate', {
          config: args.config,
          data: args.data,
          use_llm: args.use_llm ?? true,
        });
      } else {
        return {
          isError: true,
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(json) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: `[render error] ${message}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[render-mcp] ready');
