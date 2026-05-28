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
import { recordUsage } from './tenant-usage';
import { countEntries, searchKnowledge } from './tenant-knowledge';
import { loadHistory, saveMessages } from './conversation';
import { renderChart, type ChartSpec } from './render-chart';
import { leaderboardSpec, timeseriesSpec } from './chart-presets';
import type { Tenant } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 25;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
// Per-tool-call ceiling so a hung subprocess can't stall the whole turn. Sits
// above the per-class MCP SDK request timeouts (lib/mcp.ts) so the inner one
// fires first with a cleaner error; this is the last-resort outer guard.
const TOOL_CALL_TIMEOUT_MS = 200_000;

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
  /**
   * When true, the runtime LOADS prior turns for `conversationId` from the
   * conversation store (instead of `history`) and PERSISTS this exchange after
   * the turn. Channel handlers set this; routines / UI test turns leave it off.
   */
  persist?: boolean;
};

/** Binary artifact (e.g. rendered chart PNG) attached to a tenant turn reply. */
export type TurnAttachment = {
  /** Suggested filename / caption stub. */
  name: string;
  /** PNG bytes. */
  png: Buffer;
};

export type TenantTurnResult = {
  reply: string;
  tokensIn: number;
  tokensOut: number;
  /** Torque tool names invoked this turn — handy for debugging/audit. */
  toolsUsed: string[];
  memoryNamespace: string;
  /** Optional binary artifacts (rendered charts, etc.) for the channel to send. */
  attachments?: TurnAttachment[];
};

// ---------------------------------------------------------------------------
// Built-in (non-MCP) tools — implemented in-process against the Torque server
// REST API with the tenant's scoped token. Used where the MCP tool is broken;
// currently get_leaderboard (see lib/torque-api.ts). Gated like the MCP tools:
// an explicit allow-list, checked at schema-build and at call time.
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_leaderboard',
  'search_knowledge',
  'render_chart',
  'render_leaderboard_chart',
  'render_timeseries_chart',
]);
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

// Always exposed: lets the model render a Torque-branded chart that the
// channel layer will attach to its reply (sendPhoto on Telegram, files.upload
// on Slack). The model writes a structured spec; the runtime renders + captures
// the PNG into the per-turn attachments collector. The tool returns a
// human-readable confirmation, NOT the PNG bytes (those would blow the
// context); the channel layer reads attachments from TenantTurnResult.
// PREFER the narrower presets (render_leaderboard_chart, render_timeseries_chart)
// when they fit — they encode chart-design defaults the model can't forget. Use
// render_chart only for shapes the presets don't cover.
const RENDER_CHART_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'render_chart',
  exposedName: 'render_chart',
  description:
    'Render a Torque-branded chart (PNG) that the channel will send as an ' +
    'image. PREFER render_leaderboard_chart or render_timeseries_chart when ' +
    'they fit; only use this generic tool for shapes the presets do not cover ' +
    '(e.g. multi-series comparisons). ALWAYS:\n' +
    '- pass a clear, specific title — include the project name + the metric ' +
    '(e.g. "$TRUMP unique holders — May 22–28"); NEVER leave the title empty;\n' +
    '- pass a `unit` ("wallets", "$TRUMP", "USD", "%"); the renderer uses it ' +
    'as a subtitle so the reader knows what the bars/lines represent;\n' +
    '- format date labels as "MMM D" (e.g. "May 22"), NOT raw ISO;\n' +
    '- shorten long wallet addresses to "abcd…wxyz" (first 4 + … + last 4);\n' +
    '- cap to ≤10 data points per series, ≤3 series.\n' +
    'Good example: {type:"bar", title:"$TRUMP top holders — May 28", ' +
    'labels:["7xKa…34AB","9zPa…12CD",…], series:[{label:"Holding", ' +
    'data:[1240000,870000,…]}], unit:"$TRUMP"}.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['line', 'bar'], description: 'Chart type.' },
      title: {
        type: 'string',
        description:
          'Specific chart title with project + metric + time scope. Required, ' +
          'never empty. Example: "$TRUMP daily unique holders — May 22–28".',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'X-axis labels (≤10). For dates: "May 22". For wallets: "7xKa…34AB".',
      },
      series: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Series name shown in legend (multi-series only).' },
            data: { type: 'array', items: { type: 'number' } },
          },
          required: ['label', 'data'],
        },
        description: 'One or more series; data.length must match labels.length.',
      },
      unit: {
        type: 'string',
        description: 'Unit suffix for the value axis ("wallets","$TRUMP","%","USD"). Always include.',
      },
    },
    required: ['type', 'title', 'labels', 'series', 'unit'],
  },
};

// Preset 1: top-N leaderboard. The model passes raw wallet addresses and value
// numbers; the preset truncates addresses, caps at 10, and fills in the rest.
const RENDER_LEADERBOARD_CHART_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'render_leaderboard_chart',
  exposedName: 'render_leaderboard_chart',
  description:
    'Render a Torque-branded leaderboard bar chart (top wallets / top holders / ' +
    'top earners). PREFER this over render_chart when the answer is "top N ' +
    'wallets by X" — it formats wallet addresses, caps to 10 rows, and sets ' +
    'the unit for you. Pass FULL wallet addresses; the preset shortens them.\n' +
    'Good example: rows=[{wallet:"7xKabcdef…ABCD",value:1240000}, …], ' +
    'title:"$TRUMP top holders — May 28", valueLabel:"Holding", unit:"$TRUMP".',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Specific title incl. project + metric + date. Required.',
      },
      valueLabel: { type: 'string', description: 'What the bar lengths mean (e.g. "Holding", "Score").' },
      unit: { type: 'string', description: 'Y-axis unit ("$TRUMP","USD","wallets","%").' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'Full wallet address; preset shortens it.' },
            value: { type: 'number' },
          },
          required: ['wallet', 'value'],
        },
        description: 'Rows (≤10); preset takes the first 10 in array order.',
      },
    },
    required: ['title', 'valueLabel', 'unit', 'rows'],
  },
};

// Preset 2: daily/weekly metric over time. Pass ISO dates; preset formats them.
const RENDER_TIMESERIES_CHART_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'render_timeseries_chart',
  exposedName: 'render_timeseries_chart',
  description:
    'Render a Torque-branded time-series line chart (a metric over days/weeks). ' +
    'PREFER this over render_chart when the answer is a single metric across ' +
    'consecutive dates — it formats dates as "May 22", sets the unit, and ' +
    'titles the chart properly. Pass ISO date strings ("2026-05-22").\n' +
    'Good example: points=[{date:"2026-05-22",value:347200}, …], ' +
    'title:"$TRUMP daily unique holders — May 22–28", seriesLabel:"Holders", ' +
    'unit:"wallets".',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Specific title incl. project + metric + date range. Required.',
      },
      seriesLabel: { type: 'string', description: 'What the line represents (e.g. "Holders","Swaps","Volume").' },
      unit: { type: 'string', description: 'Y-axis unit ("wallets","$TRUMP","USD","%").' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'ISO date "2026-05-22"; preset reformats.' },
            value: { type: 'number' },
          },
          required: ['date', 'value'],
        },
        description: 'Time-ordered points (≤10).',
      },
    },
    required: ['title', 'seriesLabel', 'unit', 'points'],
  },
};

// Exposed only when the tenant has knowledge-base entries (see runTenantTurn).
const SEARCH_KNOWLEDGE_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'search_knowledge',
  exposedName: 'search_knowledge',
  description:
    "Search this project's knowledge base (docs / FAQ / playbook) for relevant information. " +
    'Use this for product, how-to, onboarding, or support questions about the project that the ' +
    'Torque metrics tools do not answer. Pass a natural-language query.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look up.' } },
    required: ['query'],
  },
};

/** Run a built-in tool. Never throws — returns a string for the model.
 *  `attachments` is a per-turn collector — render_chart pushes its PNG onto it
 *  so the channel layer can pick it up from the turn result. Other builtins
 *  ignore it. */
async function runBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  tenant: Tenant,
  attachments: TurnAttachment[],
): Promise<string> {
  if (toolName === 'get_leaderboard') {
    const offerId = typeof args.recurringOfferId === 'string' ? args.recurringOfferId : '';
    if (!offerId) {
      return '[get_leaderboard requires recurringOfferId — call list_recurring_incentives first to find it]';
    }
    const limit = typeof args.limit === 'number' ? args.limit : 50;
    return fetchLeaderboard(tenant.torque_mcp_token, tenant.torque_project_id, offerId, limit);
  }
  if (toolName === 'search_knowledge') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) return '[search_knowledge requires a query]';
    return searchKnowledge(tenant.id, query);
  }
  if (
    toolName === 'render_chart' ||
    toolName === 'render_leaderboard_chart' ||
    toolName === 'render_timeseries_chart'
  ) {
    // Shared per-turn cap across all three chart tools.
    if (attachments.length >= 2) {
      return `[${toolName} limit reached for this turn — at most 2 charts per reply]`;
    }
    try {
      let spec: ChartSpec;
      if (toolName === 'render_leaderboard_chart') {
        const a = args as {
          title?: string;
          valueLabel?: string;
          unit?: string;
          rows?: Array<{ wallet: string; value: number }>;
        };
        if (!a.rows || a.rows.length === 0) return '[render_leaderboard_chart: rows is required and non-empty]';
        spec = leaderboardSpec(a.rows, {
          title: a.title ?? '',
          valueLabel: a.valueLabel ?? 'Value',
          unit: a.unit,
        });
      } else if (toolName === 'render_timeseries_chart') {
        const a = args as {
          title?: string;
          seriesLabel?: string;
          unit?: string;
          points?: Array<{ date: string; value: number }>;
        };
        if (!a.points || a.points.length === 0) return '[render_timeseries_chart: points is required and non-empty]';
        spec = timeseriesSpec(a.points, {
          title: a.title ?? '',
          seriesLabel: a.seriesLabel ?? 'Value',
          unit: a.unit,
        });
      } else {
        spec = args as unknown as ChartSpec;
      }
      const png = await renderChart(spec);
      const safeName = String(spec.title ?? 'chart').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'chart';
      attachments.push({ name: `${safeName}.png`, png });
      return `[chart rendered: "${spec.title}" — will be attached to the reply]`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'render failed';
      return `[${toolName} failed: ${msg}]`;
    }
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
  hasKnowledge: boolean,
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
  if (hasKnowledge) {
    lines.push(
      `You also have a knowledge base for ${tenant.display_name} (docs / FAQ / playbook). For ` +
        'product, how-to, onboarding, or support questions, call the `search_knowledge` tool and ' +
        'answer from what it returns.',
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
  const attachments: TurnAttachment[] = [];
  try {
    const hasKnowledge = (await countEntries(tenant.id).catch(() => 0)) > 0;
    const systemPrompt = buildSystemPrompt(tenant, ctx, Boolean(ingesterSession), hasKnowledge);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];
    // Replay scoped history. When ctx.persist is set we load it from the
    // conversation store for this (tenant, conversationId); otherwise we use
    // any history the caller passed. memory_namespace keeps it per-tenant.
    const priorHistory = ctx.persist
      ? await loadHistory(tenant.id, ctx.conversationId).catch(() => [])
      : (ctx.history ?? []);
    for (const m of priorHistory) {
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
      RENDER_CHART_TOOL,
      RENDER_LEADERBOARD_CHART_TOOL,
      RENDER_TIMESERIES_CHART_TOOL,
      ...(hasKnowledge ? [SEARCH_KNOWLEDGE_TOOL] : []),
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
                  runBuiltinTool(def.toolName, args, tenant, attachments),
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

    // Best-effort token/cost accounting — never fail the turn on a write error.
    try {
      await recordUsage(tenant.id, tenant.model, tokensIn, tokensOut);
    } catch (err) {
      console.error(
        `[agent-runtime] recordUsage failed for ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`,
      );
    }

    // Persist this exchange to conversation memory (best-effort).
    if (ctx.persist) {
      try {
        await saveMessages(tenant.id, ctx.conversationId, [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: finalText },
        ]);
      } catch (err) {
        console.error(
          `[agent-runtime] saveMessages failed for ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }

    return {
      reply: finalText.trim(),
      tokensIn,
      tokensOut,
      toolsUsed,
      memoryNamespace: tenant.memory_namespace,
      ...(attachments.length > 0 ? { attachments } : {}),
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
