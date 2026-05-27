#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `analysis` MCP server — bridges Torque jobs to the render service's sandboxed
// analysis path (`POST /v1/analyze`). This is the "Python agent that evaluates":
// the model writes numpy/scipy/pandas analysis cells; the render service runs
// them in an ISOLATED subprocess (import allowlist, rlimits, no network),
// collects every `result(key, value)` into a provenance-tracked ResultStore,
// and — if a ReportSpec is supplied — gates + renders the report.
//
// The model NEVER computes a number itself: it decides WHAT to analyze and
// writes the code; the figures only exist because the sandbox executed it.
//
// Plain `.mjs` (no compile step — the runtime image ships only `node`).
//
// Env (injected by lib/mcp.ts buildSpecs, from process.env):
//   RENDER_SERVICE_URL  base URL of the render service
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

async function postJSON(path, body) {
  if (!SERVICE_URL) throw new Error('RENDER_SERVICE_URL is not configured');
  if (!API_KEY) throw new Error('DIGEST_API_KEY is not configured');
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`analysis service ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 1200)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: 'run_analysis',
    description:
      'Run sandboxed Python analysis over fetched data and (optionally) render a report. ' +
      'Pass `snapshots` (named JSON data the agent fetched) and `cells` (Python snippets that call ' +
      'result("key", value, fmt="{:.2f}") for each number you want). The code runs in an ISOLATED ' +
      'sandbox: numpy/scipy/pandas + the torque_stats kernels (hhi/gini/top_n_share/bootstrap_ratio_ci/' +
      'welch_ttest/...) are pre-imported; NO os/socket/network/file access. You decide WHAT to compute; ' +
      'never hand-type a figure. Returns { registered (key->formatted), store, cells, errors, and — if ' +
      '`spec` (a ReportSpec) is given — markdown, html, pdf_base64, title }. A cell that errors is reported ' +
      'but does not abort the run. If you pass a spec, every number it references must have been registered, ' +
      'or the no-hallucination gate rejects it (422).',
    inputSchema: {
      type: 'object',
      properties: {
        snapshots: {
          type: 'object',
          description: 'name -> JSON data (lists/objects/numbers) the agent fetched; bound read-only in the sandbox.',
        },
        cells: {
          type: 'array',
          description: 'Analysis cells run in order; each writes results via result(...).',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Python; calls result(key, value, fmt=..., kind=...).' },
              seed: { type: 'number', description: 'RNG seed for this cell (default 0).' },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
        spec: {
          type: 'object',
          description: 'Optional ReportSpec JSON. If provided, the result store is gated + rendered to a report.',
        },
        title: { type: 'string', description: 'Optional report title override.' },
        timeout_s: { type: 'number', description: 'Per-cell wall-clock timeout seconds (default 20).' },
      },
      required: ['cells'],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'analysis', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params ?? {};
  try {
    if (name !== 'run_analysis') {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    }
    const json = await postJSON('/v1/analyze', {
      snapshots: args.snapshots ?? {},
      cells: args.cells ?? [],
      spec: args.spec ?? null,
      title: args.title ?? null,
      timeout_s: args.timeout_s ?? 20,
      publish: false,
    });
    const slim = {
      registered: json.registered,
      errors: json.errors,
      cells: json.cells,
      title: json.title,
      markdown: json.markdown,
      // pdf_base64 / html / store intentionally omitted — too large to feed back
      // into the model context (caused provider 400s); the markdown is the deliverable.
    };
    return { content: [{ type: 'text', text: JSON.stringify(slim) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `[analysis error] ${message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[analysis-mcp] ready');
