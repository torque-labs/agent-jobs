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
export const TORQUE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'ask_torque',
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

  return specs;
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

  await client.connect(transport);
  const listed = await client.listTools();
  const tools: McpToolDef[] = (listed.tools ?? []).map((t) => ({
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

  const result = await managed.client.callTool({ name: toolName, arguments: args });
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
      const result = await client.callTool({ name: toolName, arguments: args });
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
