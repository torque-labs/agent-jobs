import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

// H3 (supply-chain): pin the EXACT version of every MCP package we spawn at the
// isolation boundary. Invoking `npx -y @torque-labs/mcp` (latest) lets whatever
// version is published at run time execute as a subprocess holding a tenant's
// scoped Torque token — an RCE/supply-chain footgun. Pinning a single exact
// version string removes the "latest" moving target.
//
// TODO (H3, blocked on `pnpm install` not being runnable in this sandbox):
// promote these to pinned `dependencies` in package.json + pnpm-lock.yaml and
// invoke the resolved LOCAL binary (e.g. require.resolve('@torque-labs/mcp')
// -> dist/index.js via `node <path>`) instead of `npx`, so the version is
// lockfile-enforced and integrity-checked rather than re-resolved from the
// registry on every spawn. Until then these exact pins are the mitigation.
export const TORQUE_MCP_VERSION = '0.4.8';
export const SUPABASE_MCP_VERSION = '0.8.1';
const TORQUE_MCP_PKG = `@torque-labs/mcp@${TORQUE_MCP_VERSION}`;
const SUPABASE_MCP_PKG = `@supabase/mcp-server-supabase@${SUPABASE_MCP_VERSION}`;

export type McpToolDef = {
  serverName: string;
  toolName: string;
  // The name we expose to the LLM — server-namespaced so two servers can't collide.
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ServerSpec = {
  name: string;
  command: string;
  args: string[];
  // Env vars to inject on top of the inherited PATH-style defaults.
  env: Record<string, string>;
  // Optional read-only tool allow-list. When set, startServer registers ONLY
  // these tools from the server (defense-in-depth on top of a read-only DB role).
  allow?: ReadonlySet<string>;
};

type Managed = {
  spec: ServerSpec;
  client: Client | null;
  transport: StdioClientTransport | null;
  tools: McpToolDef[];
  // Restart bookkeeping so we back off on a crash loop.
  consecutiveFailures: number;
  restartTimer: NodeJS.Timeout | null;
  closed: boolean;
};

// Stash registry on globalThis so the server.ts entrypoint and the Next.js
// route handlers (which may evaluate this module independently) share one
// set of MCP subprocess handles instead of spawning duplicates.
type GlobalState = {
  servers: Map<string, Managed>;
  initialized: boolean;
  initPromise: Promise<void> | null;
};
const GLOBAL_KEY = '__agentJobsMcp__';
function state(): GlobalState {
  const g = globalThis as unknown as Record<string, GlobalState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { servers: new Map(), initialized: false, initPromise: null };
  }
  return g[GLOBAL_KEY] as GlobalState;
}

// ---------------------------------------------------------------------------
// Torque READ-ONLY allow-list (isolation hardening, H1).
//
// `@torque-labs/mcp` ships mutating tools (create_project, create_api_key,
// create_recurring_incentive, create_custom_event, attach_custom_event,
// set_active_project, register_dune_event_source, create_idl,
// create_instruction, auth, reset_context, ...). A read-scoped caller — or a
// prompt-injected channel message — must NEVER be able to drive the agent into
// WRITING to a customer's Torque project. We therefore filter the toolset the
// model ever sees to an explicit server-side allow-list of read-only tool
// names, and enforce the same list again defensively before `session.call`.
// This is independent of (and not a substitute for) the soul prompt.
//
// Only tools that strictly read are listed. Anything create_/attach_/set_/
// register_/auth/reset_ is intentionally excluded. If a new read-only Torque
// tool appears it must be added here explicitly (fail-closed by default).
// `ask_torque` dropped 2026-05-28 (per memory feedback_torque_mcp_auth + live
// observation): bug-prone for numeric questions AND consistently hits the
// 120s MCP timeout. Agents wasted 4+ minutes per turn retrying it. For raw
// SQL analytics the agent uses the INGESTER MCP (`query_data` /
// `execute_raw_query`) — opt-in per tenant via `data_sources:[{type:'ingester'}]`.
export const TORQUE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  // session-scoping only (no data mutation) — needed so project-scoped reads
  // don't stall waiting for an active project. Sets session state, writes nothing.
  'set_active_project',
  'list_projects',
  'get_epoch_aggregate_stats',
  'get_epoch_leaderboard',
  'get_recurring_incentive',
  'list_recurring_incentives',
  'preview_incentive_query',
  'generate_incentive_query',
  'list_custom_events',
  'list_idls',
  'list_api_keys',
  'get_ai_context',
]);

export function isTorqueReadonlyTool(toolName: string): boolean {
  return TORQUE_READONLY_TOOLS.has(toolName);
}

// ---------------------------------------------------------------------------
// Ingester (raw on-chain indexer DB) READ-ONLY allow-list.
//
// Opt-in per tenant via a `data_sources` entry `{ type: 'ingester' }`. The
// connection string is a SHARED, global secret (env `TORQUE_INGESTER_READONLY_URL`,
// a read-only `mcp_read` DB user) — it is NOT per-project scoped, so this is
// only appropriate for data the customer is allowed to see at the row level
// (raw on-chain swaps = public blockchain data). The `mcp-postgres` server
// ships write tools (alter/create/insert/update/delete) — excluded here so the
// model's schema stays read-only even though the DB user is read-only too
// (defense in depth, fail-closed: a new tool must be added explicitly).
const MCP_POSTGRES_PKG = 'mcp-postgres@1.3.0';
export const TORQUE_INGESTER_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'query_data',
  'execute_raw_query',
  'list_tables',
  'describe_table',
  'get_schema',
  'count_rows',
  'get_table_sample',
  'table_exists',
  'column_exists',
  'get_relationships',
  'get_connection_status',
  'check_certificate_cache',
]);

export function isIngesterReadonlyTool(toolName: string): boolean {
  return TORQUE_INGESTER_READONLY_TOOLS.has(toolName);
}

// ---------------------------------------------------------------------------
// `render` MCP server — local script (mcp-servers/render/index.mjs) that bridges
// jobs to the deployed render service (https://digest.coolify.torque.so). The
// service computes every report fact deterministically and gates it, so the LLM
// never does in-head math. These tools only render/return reports (no customer
// data is mutated), so both are on the allow-list. Fail-closed: a new render
// tool must be added here explicitly.
export const RENDER_TOOLS: ReadonlySet<string> = new Set([
  'render_leaderboard',
  'render_rebate',
]);

export function isRenderTool(toolName: string): boolean {
  return RENDER_TOOLS.has(toolName);
}

// `analysis` MCP server — local script (mcp-servers/analysis/index.mjs) bridging
// jobs to the render service's sandboxed analysis path (POST /v1/analyze). The
// model writes the stats; the service runs them in an isolated sandbox and lands
// provenance-tracked results — the LLM never hand-types a figure. Read/compute
// only (no customer-data mutation), so it's on the allow-list. Fail-closed.
export const ANALYSIS_TOOLS: ReadonlySet<string> = new Set([
  'run_analysis',
]);

export function isAnalysisTool(toolName: string): boolean {
  return ANALYSIS_TOOLS.has(toolName);
}

// OpenRouter caps tool names to 64 chars and disallows certain chars.
const SAFE_NAME = /[^a-zA-Z0-9_-]/g;
function makeExposedName(serverName: string, toolName: string): string {
  const raw = `mcp_${serverName}_${toolName}`.replace(SAFE_NAME, '_');
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

function buildSpecs(): ServerSpec[] {
  const torqueKey = process.env.TORQUE_API_KEY;
  const torqueToken = process.env.TORQUE_API_TOKEN ?? torqueKey;
  const supabaseToken = process.env.SUPABASE_ACCESS_TOKEN;

  const specs: ServerSpec[] = [];

  if (torqueKey) {
    specs.push({
      name: 'torque',
      command: 'npx',
      args: ['-y', TORQUE_MCP_PKG],
      env: {
        TORQUE_API_KEY: torqueKey,
        TORQUE_API_TOKEN: torqueToken ?? torqueKey,
      },
    });
  } else {
    console.warn('[mcp] TORQUE_API_KEY not set — torque MCP will not be loaded');
  }

  if (supabaseToken) {
    specs.push({
      name: 'supabase',
      command: 'npx',
      args: ['-y', SUPABASE_MCP_PKG, `--access-token=${supabaseToken}`, '--read-only'],
      env: {},
    });
  } else {
    console.warn('[mcp] SUPABASE_ACCESS_TOKEN not set — supabase MCP will not be loaded');
  }

  // `render` — a LOCAL script we own (no npx/registry resolution at the
  // isolation boundary; H3-style supply-chain stance). It POSTs the rendered
  // reports to the deployed render service using the injected Bearer key.
  const renderUrl = process.env.RENDER_SERVICE_URL;
  const digestKey = process.env.DIGEST_API_KEY;
  if (renderUrl && digestKey) {
    // Resolve against the process cwd (repo root in dev, /app in the container)
    // so the same path works under `pnpm dev:server` and `node server.js`.
    specs.push({
      name: 'render',
      command: 'node',
      args: [resolve(process.cwd(), 'mcp-servers/render/index.mjs')],
      env: {
        RENDER_SERVICE_URL: renderUrl,
        DIGEST_API_KEY: digestKey,
      },
    });
  } else {
    console.warn('[mcp] RENDER_SERVICE_URL / DIGEST_API_KEY not set — render MCP will not be loaded');
  }

  // `analysis` — same local-script pattern as `render`; bridges to /v1/analyze.
  if (renderUrl && digestKey) {
    specs.push({
      name: 'analysis',
      command: 'node',
      args: [resolve(process.cwd(), 'mcp-servers/analysis/index.mjs')],
      env: {
        RENDER_SERVICE_URL: renderUrl,
        DIGEST_API_KEY: digestKey,
      },
    });
  }

  // `ingester` — the raw on-chain indexer DB (mcp-postgres against a SHARED,
  // read-only connection URL). Loaded for job steps when the URL is configured;
  // tools filtered to the read-only allow-list (query_data / execute_raw_query).
  // The DB role itself is read-only, so this is defense-in-depth, not the only guard.
  const ingesterUrl = process.env.TORQUE_INGESTER_READONLY_URL;
  if (ingesterUrl) {
    specs.push({
      name: 'ingester',
      command: 'npx',
      args: ['-y', MCP_POSTGRES_PKG],
      env: { DATABASE_URL: ingesterUrl },
      allow: TORQUE_INGESTER_READONLY_TOOLS,
    });
  } else {
    console.warn('[mcp] TORQUE_INGESTER_READONLY_URL not set — ingester MCP will not be loaded');
  }

  return specs;
}

// Boot-safety: never let a slow/unreachable MCP (e.g. the ingester connecting to a
// remote DB) block initMcp — which is awaited before the HTTP server listens. A
// timeout rejects -> caught by initMcp's per-spec try/catch -> scheduleRestart (non-fatal).
const MCP_START_TIMEOUT_MS = Number(process.env.MCP_START_TIMEOUT_MS ?? 20000);
// Per-call request timeouts (the SDK default of 60s is tight for ask_torque and
// for partitioned-table ingester SQL). Override via env without redeploy.
const MCP_CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? 120_000);
const MCP_INGESTER_TIMEOUT_MS = Number(process.env.MCP_INGESTER_TIMEOUT_MS ?? 180_000);
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      if (typeof t === 'object' && t && 'unref' in t) (t as { unref: () => void }).unref();
    }),
  ]);
}

async function startServer(managed: Managed): Promise<void> {
  const { spec } = managed;
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...getDefaultEnvironment(), ...spec.env },
    // Inherit stderr so npx + MCP server logs land in the container logs.
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'agent-jobs', version: '0.1.0' },
    { capabilities: {} },
  );

  // Crash detection — when the transport closes unexpectedly, schedule a restart.
  transport.onclose = () => {
    if (managed.closed) return;
    console.warn(`[mcp] ${spec.name} transport closed unexpectedly`);
    managed.client = null;
    managed.transport = null;
    managed.tools = [];
    scheduleRestart(managed);
  };
  transport.onerror = (err) => {
    console.error(`[mcp] ${spec.name} transport error:`, err);
  };

  await withTimeout(client.connect(transport), MCP_START_TIMEOUT_MS, `${spec.name} connect`);
  const listed = await withTimeout(client.listTools(), MCP_START_TIMEOUT_MS, `${spec.name} listTools`);
  const tools: McpToolDef[] = (listed.tools ?? [])
    .filter((t) => !spec.allow || spec.allow.has(t.name))
    .map((t) => ({
    serverName: spec.name,
    toolName: t.name,
    exposedName: makeExposedName(spec.name, t.name),
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }));

  managed.client = client;
  managed.transport = transport;
  managed.tools = tools;
  managed.consecutiveFailures = 0;

  console.log(`[mcp] ${spec.name} ready (${tools.length} tools)`);
}

function scheduleRestart(managed: Managed): void {
  if (managed.closed || managed.restartTimer) return;
  managed.consecutiveFailures += 1;
  // Exponential backoff capped at 60s.
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(managed.consecutiveFailures, 6));
  console.warn(`[mcp] ${managed.spec.name} restart scheduled in ${delayMs}ms (attempt ${managed.consecutiveFailures})`);
  managed.restartTimer = setTimeout(async () => {
    managed.restartTimer = null;
    try {
      await startServer(managed);
    } catch (err) {
      console.error(`[mcp] ${managed.spec.name} restart failed:`, err);
      scheduleRestart(managed);
    }
  }, delayMs);
  managed.restartTimer.unref();
}

export function initMcp(): Promise<void> {
  const s = state();
  if (s.initPromise) return s.initPromise;
  s.initPromise = (async () => {
    if (s.initialized) return;
    const specs = buildSpecs();
    for (const spec of specs) {
      const managed: Managed = {
        spec,
        client: null,
        transport: null,
        tools: [],
        consecutiveFailures: 0,
        restartTimer: null,
        closed: false,
      };
      s.servers.set(spec.name, managed);
      try {
        await startServer(managed);
      } catch (err) {
        // A boot failure shouldn't block the server — schedule retry and move on.
        console.error(`[mcp] ${spec.name} initial start failed:`, err);
        scheduleRestart(managed);
      }
    }
    s.initialized = true;
  })();
  return s.initPromise;
}

export async function shutdownMcp(): Promise<void> {
  const s = state();
  for (const m of s.servers.values()) {
    m.closed = true;
    if (m.restartTimer) {
      clearTimeout(m.restartTimer);
      m.restartTimer = null;
    }
    try {
      await m.transport?.close();
    } catch (err) {
      console.error(`[mcp] ${m.spec.name} close error:`, err);
    }
  }
  s.servers.clear();
  s.initialized = false;
  s.initPromise = null;
}

export function listAllTools(): McpToolDef[] {
  const out: McpToolDef[] = [];
  for (const m of state().servers.values()) {
    out.push(...m.tools);
  }
  return out;
}

export function findToolByExposedName(exposedName: string): McpToolDef | null {
  for (const m of state().servers.values()) {
    for (const t of m.tools) {
      if (t.exposedName === exposedName) return t;
    }
  }
  return null;
}

/**
 * Normalize an MCP callTool result (list of typed content parts) into a single
 * string the LLM can read. Surfaces isError so the model knows a tool failed
 * even when content is present.
 */
function normalizeToolResult(result: unknown): string {
  const parts: string[] = [];
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p === 'object' && 'type' in p) {
        const part = p as { type: string; text?: string; data?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text);
        } else {
          parts.push(JSON.stringify(part));
        }
      }
    }
  }
  let body = parts.join('\n');
  if ((result as { isError?: boolean }).isError) {
    body = `[tool error]\n${body}`;
  }
  if (body.length === 0) {
    body = JSON.stringify(result);
  }
  return body;
}

export async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const managed = state().servers.get(serverName);
  if (!managed) throw new Error(`MCP server "${serverName}" not registered`);
  if (!managed.client) throw new Error(`MCP server "${serverName}" not connected (restart pending)`);

  const result = await managed.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { timeout: MCP_CALL_TIMEOUT_MS },
  );
  return normalizeToolResult(result);
}

// ---------------------------------------------------------------------------
// Per-tenant (scoped) Torque MCP sessions.
//
// The global registry above runs ONE Torque MCP subprocess off a single env
// token — fine for the operator's own jobs, but the multi-tenant customer
// runtime needs PER-REQUEST isolation: every turn must talk to Torque as the
// tenant's scoped wallet-user so it can only ever see that tenant's project.
//
// `TenantTorqueSession` spawns an ephemeral `@torque-labs/mcp` subprocess with
// the tenant's scoped TORQUE_API_TOKEN injected via env (never a global), lists
// its tools, and tears the subprocess down when the turn is done. This is the
// single place the scoped credential is wired into a live MCP connection.
// ---------------------------------------------------------------------------

export type TenantTorqueSession = {
  /** Torque MCP tool defs, namespaced + filtered to the torque server only. */
  tools: McpToolDef[];
  /** Invoke a tool on this tenant's scoped Torque subprocess. */
  call: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  /** Tear down the subprocess. Always call in a finally block. */
  close: () => Promise<void>;
};

/**
 * Open a short-lived Torque MCP session authenticated as one tenant.
 *
 * @param torqueToken  The tenant's scoped Torque MCP token (JWT). This is the
 *                     isolation boundary: the subprocess can only see the
 *                     project that token's wallet-user administers.
 */
export async function openTenantTorqueSession(
  torqueToken: string,
  activeProjectId?: string,
): Promise<TenantTorqueSession> {
  if (!torqueToken) throw new Error('openTenantTorqueSession: torqueToken is required');

  const transport = new StdioClientTransport({
    command: 'npx',
    // H3: pinned exact version — never `@latest` at the isolation boundary.
    args: ['-y', TORQUE_MCP_PKG],
    env: {
      ...getDefaultEnvironment(),
      // Scoped per-tenant token — the ONLY auth this subprocess gets.
      TORQUE_API_TOKEN: torqueToken,
    },
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'agent-jobs-tenant', version: '0.1.0' },
    { capabilities: {} },
  );

  // H2: if connect/listTools throws, the subprocess is already spawned — tear
  // it down before rethrowing so a startup failure never leaks an MCP process.
  let tools: McpToolDef[];
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    // H1: only expose READ-ONLY Torque tools to the model. The mutating tools
    // the package ships are dropped here so they can never enter the schema.
    tools = (listed.tools ?? [])
      .filter((t) => isTorqueReadonlyTool(t.name))
      .map((t) => ({
        serverName: 'torque',
        toolName: t.name,
        exposedName: makeExposedName('torque', t.name),
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));
  } catch (err) {
    try {
      await transport.close();
    } catch (closeErr) {
      console.error('[mcp] tenant Torque session cleanup after startup failure:', closeErr);
    }
    throw err;
  }

  // Pin the tenant's project as active. The Torque MCP gates every data tool
  // behind an active project ("No active project set" otherwise), so a scoped
  // single-project tenant must have it set before the model runs. We do this
  // here, runtime-internal — `set_active_project` is deliberately NOT in the
  // read-only allow-list, so it never enters the model's schema and the model
  // can't switch projects. The token only administers this one project anyway.
  if (activeProjectId) {
    try {
      await client.callTool({ name: 'set_active_project', arguments: { projectId: activeProjectId } });
    } catch (pinErr) {
      // Pinning is a precondition for a correct turn, not best-effort: if it
      // fails, the session would run in an unverified active-project state.
      // Tear down and fail so runTenantTurn returns a friendly error instead.
      console.error('[mcp] failed to pin active project for tenant session:', pinErr);
      try {
        await transport.close();
      } catch (closeErr) {
        console.error('[mcp] cleanup after pin failure:', closeErr);
      }
      throw new Error('could not pin active project for tenant session');
    }
  }

  let closed = false;
  return {
    tools,
    call: async (toolName, args) => {
      if (closed) throw new Error('tenant Torque session already closed');
      // H1 (defense in depth): reject any non-allowlisted (mutating) tool
      // before it reaches the subprocess, even if it somehow bypassed the
      // schema filter. Never trust the model's choice of tool name.
      if (!isTorqueReadonlyTool(toolName)) {
        throw new Error(`tool ${toolName} is not permitted (read-only allow-list)`);
      }
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS },
      );
      return normalizeToolResult(result);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch (err) {
        console.error('[mcp] tenant Torque session close error:', err);
      }
    },
  };
}

/**
 * Open an ephemeral read-only session against the Torque INGESTER database
 * (raw on-chain indexer). Mirrors openTenantTorqueSession's lifecycle but:
 *  - spawns `mcp-postgres` with a SHARED, read-only `DATABASE_URL` (not a
 *    per-tenant credential — the ingester holds public on-chain data);
 *  - filters the toolset to the ingester read-only allow-list, enforced again
 *    in `call` (fail-closed); no write/DDL tool ever enters the schema.
 * There is no project pin: the ingester is not project-aware. Persona scoping
 * (stay on this customer's token) is enforced by the system prompt.
 */
export async function openIngesterSession(databaseUrl: string): Promise<TenantTorqueSession> {
  if (!databaseUrl) throw new Error('openIngesterSession: databaseUrl is required');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', MCP_POSTGRES_PKG],
    env: {
      ...getDefaultEnvironment(),
      DATABASE_URL: databaseUrl,
    },
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'agent-jobs-ingester', version: '0.1.0' },
    { capabilities: {} },
  );

  let tools: McpToolDef[];
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    tools = (listed.tools ?? [])
      .filter((t) => isIngesterReadonlyTool(t.name))
      .map((t) => ({
        serverName: 'ingester',
        toolName: t.name,
        exposedName: makeExposedName('ingester', t.name),
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));
  } catch (err) {
    try {
      await transport.close();
    } catch (closeErr) {
      console.error('[mcp] ingester session cleanup after startup failure:', closeErr);
    }
    throw err;
  }

  let closed = false;
  return {
    tools,
    call: async (toolName, args) => {
      if (closed) throw new Error('ingester session already closed');
      if (!isIngesterReadonlyTool(toolName)) {
        throw new Error(`tool ${toolName} is not permitted (ingester read-only allow-list)`);
      }
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: MCP_INGESTER_TIMEOUT_MS },
      );
      return normalizeToolResult(result);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch (err) {
        console.error('[mcp] ingester session close error:', err);
      }
    },
  };
}
