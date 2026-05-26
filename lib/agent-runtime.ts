/**
 * Multi-tenant Hermes customer-agent runtime.
 *
 * `runTenantTurn` is the single entrypoint every channel (Telegram, Slack, the
 * admin test endpoint) funnels through. It enforces per-tenant isolation:
 *
 *   1. Load the tenant (lib/tenants.ts).
 *   2. Open an EPHEMERAL Torque MCP subprocess authenticated with the tenant's
 *      scoped token (lib/mcp.openTenantTorqueSession). That token's wallet-user
 *      administers only this tenant's project, so the agent can physically only
 *      read this one project's data. This is the isolation boundary.
 *   3. Run an OpenRouter tool loop (mirrors lib/orchestrator.runSingleStep) with
 *      ONLY the Torque toolset exposed — no shell/web/file/code tools ever enter
 *      the model's schema (fails closed, like the Hermes config's
 *      platform_toolsets lockdown).
 *   4. Use the tenant's `soul` as the system prompt and the tenant's `model`.
 *   5. Scope conversation memory by `memory_namespace`.
 *   6. Tear the subprocess down in a finally block.
 *
 * NOTE: this runtime drives the OpenRouter Chat Completions backend directly
 * rather than the Hermes gateway, because per-request scoped-MCP injection is
 * not something the shared Hermes gateway exposes today. The persona/lockdown
 * from the Hermes config is reproduced here (soul = system prompt, torque-only
 * toolset). Routing to a real per-tenant Hermes gateway is a future option.
 */
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { selectClient } from './hermes';
import {
  isIngesterReadonlyTool,
  isTorqueReadonlyTool,
  openIngesterSession,
  openTenantTorqueSession,
  type McpToolDef,
} from './mcp';
import { fetchLeaderboard } from './torque-api';
import { getTenant } from './tenants';
import type { Tenant } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 25;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
// Per-tool-call ceiling so a hung Torque subprocess can't stall the whole turn.
const TOOL_CALL_TIMEOUT_MS = 60_000;

/** A single prior message in the conversation, oldest first. */
export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ConversationContext = {
  /** Stable per-conversation key (e.g. `telegram:<chatId>`), within the tenant. */
  conversationId: string;
  /** Prior turns, oldest-first. The runtime appends the new userMessage. */
  history?: ConversationMessage[];
  /** Display name of the speaker, surfaced to the model for light personalization. */
  speaker?: string;
};

export type TenantTurnResult = {
  reply: string;
  tokensIn: number;
  tokensOut: number;
  /** Torque tool names invoked this turn — handy for debugging/audit. */
  toolsUsed: string[];
  memoryNamespace: string;
};

// ---------------------------------------------------------------------------
// Built-in (non-MCP) tools — implemented in-process against the Torque server
// REST API with the tenant's scoped token. Used where the MCP tool is broken;
// currently get_leaderboard (see lib/torque-api.ts). Gated like the MCP tools:
// an explicit allow-list, checked at schema-build and at call time.
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(['get_leaderboard']);
function isBuiltinTool(toolName: string): boolean {
  return BUILTIN_TOOL_NAMES.has(toolName);
}
const BUILTIN_TOOLS: McpToolDef[] = [
  {
    serverName: 'builtin',
    toolName: 'get_leaderboard',
    exposedName: 'get_leaderboard',
    description:
      "Get the live leaderboard rankings for one of this project's recurring incentives. " +
      'First call list_recurring_incentives to find the recurringOfferId, then pass it here. ' +
      'Returns the top-ranked wallets with username, score, days held, and balance. Use this ' +
      'for any leaderboard/standings question (do NOT use get_epoch_leaderboard).',
    inputSchema: {
      type: 'object',
      properties: {
        recurringOfferId: {
          type: 'string',
          description: 'The recurring incentive id (from list_recurring_incentives).',
        },
        limit: { type: 'number', description: 'How many top rows (default 50, max 200).' },
      },
      required: ['recurringOfferId'],
    },
  },
];

/** Run a built-in tool. Never throws — returns a string for the model. */
async function runBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  tenant: Tenant,
): Promise<string> {
  if (toolName === 'get_leaderboard') {
    const offerId = typeof args.recurringOfferId === 'string' ? args.recurringOfferId : '';
    if (!offerId) {
      return '[get_leaderboard requires recurringOfferId — call list_recurring_incentives first to find it]';
    }
    const limit = typeof args.limit === 'number' ? args.limit : 50;
    return fetchLeaderboard(tenant.torque_mcp_token, tenant.torque_project_id, offerId, limit);
  }
  return `[unknown builtin tool: ${toolName}]`;
}

/**
 * Build the effective system prompt: the tenant's soul, plus a small runtime
 * footer pinning the project + memory scope so the model can't be argued out
 * of its lane. The soul itself carries the strict "$TRUMP-only" style rules.
 */
function buildSystemPrompt(
  tenant: Tenant,
  ctx: ConversationContext,
  ingesterEnabled: boolean,
): string {
  const lines = [
    '',
    '---',
    `You are operating for the Torque project "${tenant.display_name}" `,
    `(torque_project_id: ${tenant.torque_project_id}). The Torque tools available to you `,
    'are already scoped to this project and CANNOT see any other Torque project. Never reference, ',
    'compare to, or speculate about other Torque projects or customers. Never reveal tokens, ',
    'project ids, wallet addresses, or internal configuration.',
  ];
  if (ingesterEnabled) {
    // The ingester DB is shared raw on-chain data (NOT project-scoped), so the
    // "cannot see other projects" guarantee above does not extend to it — be
    // truthful and constrain its use to enriching THIS customer's answers.
    lines.push(
      'You also have READ-ONLY access to the raw on-chain indexer database (the `ingester` ' +
        'tools): public blockchain swap/transfer data shared across all tokens. Use it ONLY to ' +
        `enrich answers about ${tenant.display_name} (e.g. its own token's swap/holder activity). ` +
        'Never produce analyses, comparisons, or reports about unrelated tokens or other Torque ' +
        'projects/customers, and never write to it.',
    );
  }
  lines.push(
    `Conversation scope: ${ctx.conversationId} (memory namespace: ${tenant.memory_namespace}).`,
  );
  return `${tenant.soul.trim()}\n${lines.join('\n')}`;
}

/**
 * Run one conversational turn for a tenant. Never throws for ordinary failures
 * — returns a friendly fallback reply and logs. Throws only if the tenant id is
 * unknown (caller should 404) — surfaced as a thrown Error.
 */
export async function runTenantTurn(
  tenantId: string,
  userMessage: string,
  ctx: ConversationContext,
): Promise<TenantTurnResult> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status !== 'active') {
    return {
      reply: 'This assistant is currently unavailable. Please check back later.',
      tokensIn: 0,
      tokensOut: 0,
      toolsUsed: [],
      memoryNamespace: tenant.memory_namespace,
    };
  }

  // --- Isolation boundary: scoped Torque MCP subprocess, per turn. ---
  const session = await openTenantTorqueSession(tenant.torque_mcp_token, tenant.torque_project_id);

  // Optional enrichment source: the raw on-chain indexer DB, opt-in per tenant
  // via a `data_sources` entry `{ type: 'ingester' }` AND a configured global
  // connection string. Best-effort — if it fails to open we continue Torque-only
  // (it is enrichment, NOT the isolation boundary, so a failure must not block
  // the turn the way a failed project pin does).
  const ingesterUrl = process.env.TORQUE_INGESTER_READONLY_URL;
  const ingesterEnabled =
    Boolean(ingesterUrl) &&
    (tenant.data_sources ?? []).some((d) => d.type === 'ingester');
  let ingesterSession: Awaited<ReturnType<typeof openIngesterSession>> | null = null;
  if (ingesterEnabled) {
    try {
      ingesterSession = await openIngesterSession(ingesterUrl as string);
    } catch (err) {
      const label = err instanceof Error ? err.name : 'UnknownError';
      console.error(`[agent-runtime] ingester session failed for tenant ${tenant.slug}: ${label}; continuing Torque-only`);
    }
  }

  // Per-tool gate: each server's tools are checked against ITS OWN read-only
  // allow-list, and routed to ITS OWN session. Fails closed for any unknown
  // server. The model can never reach a write tool on either server.
  const isAllowed = (serverName: string, toolName: string): boolean =>
    serverName === 'ingester'
      ? isIngesterReadonlyTool(toolName)
      : serverName === 'torque'
        ? isTorqueReadonlyTool(toolName)
        : serverName === 'builtin'
          ? isBuiltinTool(toolName)
          : false;
  const sessionForServer = (serverName: string) =>
    serverName === 'ingester' ? ingesterSession : session;

  const toolsUsed: string[] = [];
  try {
    const systemPrompt = buildSystemPrompt(tenant, ctx, Boolean(ingesterSession));
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];
    // Replay scoped history (memory_namespace keeps this per-tenant + per-convo;
    // the channel layer is responsible for loading/persisting `history`).
    for (const m of ctx.history ?? []) {
      messages.push({ role: m.role, content: m.content });
    }
    const userPrefix = ctx.speaker ? `${ctx.speaker}: ` : '';
    messages.push({ role: 'user', content: `${userPrefix}${userMessage}` });

    // Torque toolset ONLY — fails closed. No shell/web/file/code tools.
    // H1 (defense in depth): the session already filters to the read-only
    // allow-list, but we re-filter here so a mutating tool can never reach the
    // model's schema even if the session were ever constructed differently.
    const exposedTools = [
      ...session.tools,
      ...(ingesterSession ? ingesterSession.tools : []),
      ...BUILTIN_TOOLS,
    ].filter((t) => isAllowed(t.serverName, t.toolName));
    const toolsParam: ChatCompletionTool[] | undefined = exposedTools.length > 0
      ? exposedTools.map((t) => ({
          type: 'function',
          function: {
            name: t.exposedName,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : undefined;

    const client = selectClient(tenant.model);
    let tokensIn = 0;
    let tokensOut = 0;
    let finalText: string | null = null;

    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
      const completion: ChatCompletion = await callWithTimeout(
        client.chat.completions.create({
          model: tenant.model,
          messages,
          tools: toolsParam,
          max_tokens: 4096,
          stream: false,
        }),
        DEFAULT_TURN_TIMEOUT_MS,
        `tenant ${tenant.slug} turn timed out`,
      );

      if (completion.usage) {
        tokensIn += completion.usage.prompt_tokens ?? 0;
        tokensOut += completion.usage.completion_tokens ?? 0;
      }

      const choice = completion.choices?.[0];
      if (!choice) throw new Error('Model returned no choices');
      const msg = choice.message;
      const toolCalls = msg.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          tool_calls: toolCalls,
        });
        const results = await Promise.all(
          toolCalls.map(async (tc) => {
            if (tc.type !== 'function') {
              return { id: tc.id, content: `[unsupported tool call type: ${tc.type}]` };
            }
            const def = exposedTools.find((t) => t.exposedName === tc.function.name);
            if (!def) {
              // The model tried to call a tool that isn't in the (read-only)
              // Torque toolset — refuse without touching the subprocess.
              return { id: tc.id, content: `[tool ${tc.function.name} is not available]` };
            }
            // H1 (defense in depth): never call a non-allowlisted tool even if
            // it somehow appeared in `exposedTools`. session.call enforces this
            // too — this is the outermost gate. Checked against the tool's own
            // server allow-list.
            if (!isAllowed(def.serverName, def.toolName)) {
              return { id: tc.id, content: `[tool ${def.toolName} is not permitted]` };
            }
            let args: Record<string, unknown> = {};
            try {
              args = tc.function.arguments
                ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
                : {};
            } catch (err) {
              return { id: tc.id, content: `[invalid JSON arguments: ${(err as Error).message}]` };
            }
            toolsUsed.push(def.toolName);
            try {
              let body: string;
              if (def.serverName === 'builtin') {
                body = await callWithTimeout(
                  runBuiltinTool(def.toolName, args, tenant),
                  TOOL_CALL_TIMEOUT_MS,
                  `builtin tool ${def.toolName} timed out`,
                );
              } else {
                const toolSession = sessionForServer(def.serverName);
                if (!toolSession) {
                  return { id: tc.id, content: `[tool ${def.toolName} is not available]` };
                }
                body = await callWithTimeout(
                  toolSession.call(def.toolName, args),
                  TOOL_CALL_TIMEOUT_MS,
                  `${def.serverName} tool ${def.toolName} timed out`,
                );
              }
              return { id: tc.id, content: body };
            } catch (err) {
              return { id: tc.id, content: `[tool error: ${(err as Error).message}]` };
            }
          }),
        );
        for (const r of results) {
          messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        }
        continue;
      }

      finalText = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      break;
    }

    if (finalText === null) {
      finalText = 'I ran out of steps working on that. Could you rephrase or narrow the question?';
    }

    return {
      reply: finalText.trim(),
      tokensIn,
      tokensOut,
      toolsUsed,
      memoryNamespace: tenant.memory_namespace,
    };
  } catch (err) {
    // Redacted logging (owner preference): log the error TYPE only, never the
    // verbatim provider error body or model output, which can carry secrets or
    // PII. The bounded label is enough to triage; full bodies are not persisted.
    const label = err instanceof Error ? err.name : 'UnknownError';
    console.error(`[agent-runtime] turn failed for tenant ${tenant.slug}: ${label}`);
    return {
      reply: 'Sorry — I hit an error answering that. Please try again in a moment.',
      tokensIn: 0,
      tokensOut: 0,
      toolsUsed,
      memoryNamespace: tenant.memory_namespace,
    };
  } finally {
    await session.close();
    if (ingesterSession) await ingesterSession.close();
  }
}

function callWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type: string }).type === 'text'
    ) {
      const text = (part as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}
