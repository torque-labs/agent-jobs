import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

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
      args: ['-y', '@torque-labs/mcp'],
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
      args: ['-y', '@supabase/mcp-server-supabase@latest', `--access-token=${supabaseToken}`, '--read-only'],
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

export async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const managed = state().servers.get(serverName);
  if (!managed) throw new Error(`MCP server "${serverName}" not registered`);
  if (!managed.client) throw new Error(`MCP server "${serverName}" not connected (restart pending)`);

  const result = await managed.client.callTool({ name: toolName, arguments: args });

  // Normalize the MCP result content (list of typed parts) into a string the LLM can read.
  // We surface isError so the model knows the tool failed even if content is present.
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
