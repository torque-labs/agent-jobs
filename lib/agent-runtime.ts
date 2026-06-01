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
import { renderHolderCard, type HolderCardSpec } from './render-card';
import { renderCard } from './cards/render';
import type { CardSpec } from './cards/types';
import { saveTrace, type ToolCallTrace } from './turn-traces';
import type { Tenant } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 25;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
// Per-tool-call ceiling so a hung subprocess can't stall the whole turn. Sits
// above the per-class MCP SDK request timeouts (lib/mcp.ts) so the inner one
// fires first with a cleaner error; this is the last-resort outer guard.
const TOOL_CALL_TIMEOUT_MS = 200_000;
// Whole-turn budget. Each iteration's LLM call + tool calls are bounded
// individually, but multi-iteration turns can still exceed any reasonable
// wall-clock; this is the hard cap so the user gets a clean "try narrowing
// it" message instead of waiting indefinitely.
const TURN_BUDGET_MS = 10 * 60_000;

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
  'render_card',
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
// PRIMARY visual tool — composable Torque-branded data card. The agent
// designs the card per-question by passing an ordered array of typed
// `sections` (intro_body, data_rows, big_number, kv_strip, comparison,
// sparkline, histogram, callout, badge_row, mini_table, cta_row, …). The
// renderer wraps it with status_bar (top, with Torque logo) + footer (bottom)
// and emits a single PNG attached to the reply.
const RENDER_CARD_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'render_card',
  exposedName: 'render_card',
  description:
    'PRIMARY visualization tool. Compose a Torque-branded terminal card by ' +
    'picking section primitives (intro_body, data_rows, big_number, kv_strip, ' +
    'comparison, sparkline, histogram, mini_table, badge_row, callout, cta_row). ' +
    'Use whenever the answer involves NUMBERS — rankings, trends, hero metrics, ' +
    'comparisons, distributions, multi-column tables, status. The reply attaches ' +
    'the PNG. There is NO other render/chart tool — this is the only visual surface.\n' +
    '\n' +
    'WHEN TO RENDER:\n' +
    ' • ANY numeric answer (top N, trends, single metrics, comparisons, ' +
    'distributions, status questions like "current epoch?", "claim rate?") — ' +
    'render the card. Don\'t reply with a one-line number as text when a ' +
    '`big_number` card would make it land.\n' +
    ' • Conversational greetings, refusals, single-sentence yes/no answers — ' +
    'skip the card, reply with text.\n' +
    '\n' +
    'PICK SECTIONS BY QUESTION SHAPE:\n' +
    ' • Top-N / leaderboard → `data_rows` with `rank`+`pct` + `kv_strip` insights.\n' +
    ' • Trend over time → `sparkline` + `kv_strip` (current/delta/observation). ' +
    'When the question is "vs baseline/target" (e.g. "volume vs baseline", ' +
    '"signups vs goal"), add `sparkline.reference:{value,label}` — draws a ' +
    'dashed line at that value so the comparison is visual.\n' +
    ' • Single hero number ("current epoch", "claim rate", "total participants") ' +
    '→ `big_number` (+ optional `callout`/`kv_strip` for context). When the ' +
    'metric has a cap, budget, or goal (e.g. "$3,210 of $5,000 daily cap", ' +
    '"$1.2M of $5M budget"), add `big_number.cap:{pct,label}` — renders a ' +
    'progress meter beneath (blue<75%, yellow 75-94%, red≥95%).\n' +
    ' • Two things compared → `comparison`.\n' +
    ' • Distribution / breakdown by bucket / by category → `histogram` + ' +
    '`kv_strip` takeaway. (NOT a separate chart tool — use render_card with a ' +
    '`histogram` section.)\n' +
    ' • Multi-column tabular data (referrers/referees + multiple value columns, ' +
    'wallet + balance + score + days, schedule tables) → `mini_table` with 2-4 ' +
    'columns. NEVER write a Markdown table (`| col | col |`) in the reply — ' +
    'Telegram flattens it. mini_table is your ONLY way to display multi-column ' +
    'rows; use it whenever you would have written a Markdown table.\n' +
    ' • Mixed: combine. Max 8 sections per card.\n' +
    ' • AT MOST ONE render_card call per turn — your second call will be ' +
    'rejected. Get the spec right the first time. If you need to show ' +
    "multiple shapes (e.g. ranked list AND insights), put them as separate " +
    'SECTIONS inside a single render_card call, not multiple cards.\n' +
    '\n' +
    'VOICE RULES (STRICT):\n' +
    ' • NEVER name statistical metrics like HHI, Gini, p-value, z-score, R². ' +
    'Translate to plain English (e.g. "concentration: high — top wallet dominates").\n' +
    ' • Lowercase titles + labels (terminal aesthetic).\n' +
    ' • `kv_strip` values are sentence-fragments under 60 chars.\n' +
    ' • `intro_body.text` ≤ 280 chars.\n' +
    ' • Don\'t pass two big_numbers (use comparison). Don\'t pass two sparklines. ' +
    'cta_row must be the last section.\n' +
    '\n' +
    'Example — leaderboard:\n' +
    '{ symbol:"$trump", label:"leaderboard", updatedUtc:"14:32:08 utc", sections:[\n' +
    '  {type:"intro_body", title:"how this leaderboard works", text:"Time-weighted holdings rank by amount × duration."},\n' +
    '  {type:"data_rows", title:"top holders — current epoch", rows:[\n' +
    '    {rank:1, name:"patriot_01", pct:100, value:"2.84", unit:"M", highlight:true},\n' +
    '    {rank:2, name:"eagle_dao", pct:55, value:"1.56", unit:"M"}]},\n' +
    '  {type:"kv_strip", title:"intelligence — concentration", rows:[\n' +
    '    {key:"top 1 share", val:"37.5% → single wallet dominates"},\n' +
    '    {key:"concentration", val:"high — top wallet dominates", accent:"alert"}]}]}\n' +
    '\n' +
    'Example — trend: { symbol:"$trump", label:"trend · 30d", sections:[\n' +
    '  {type:"sparkline", title:"holders — 30d", series:[12400,12510,…,14980], start:"apr 28", end:"may 28", endValue:"14,980", delta:{value:"+18%", direction:"up"}},\n' +
    '  {type:"kv_strip", rows:[{key:"30d change", val:"+2,580 holders", accent:"ok"}]}]}\n' +
    '\n' +
    'Example — hero number: { symbol:"$trump", label:"epoch status", sections:[\n' +
    '  {type:"big_number", title:"current epoch", value:"14", label:"of 16", context:"2 epochs remaining"}]}\n' +
    '\n' +
    'Example — cap / utilization: { symbol:"xrp", label:"pilot · day 2 of 5", sections:[\n' +
    '  {type:"big_number", title:"rebate pool", value:"$3,210", label:"paid today", cap:{pct:64.2, label:"$3,210 / $5,000 daily cap"}}]}\n' +
    '\n' +
    'Example — trend vs baseline: { symbol:"xrp", label:"volume · 7d", sections:[\n' +
    '  {type:"sparkline", title:"daily volume", series:[38000,41500,52000,39400,44200,870000,1780000], reference:{value:44000, label:"pre-pilot baseline ($44k median)"}, start:"may 22", end:"may 28", endValue:"$1.78M", delta:{value:"40× baseline", direction:"up"}}]}',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Lowercase token, e.g. "$trump".' },
      label: { type: 'string', description: 'Lowercase card label, e.g. "leaderboard", "trend".' },
      logo: { type: 'boolean', description: 'Default true; pass false to hide the Torque hex glyph.' },
      updatedUtc: { type: 'string', description: 'Pre-formatted timestamp, e.g. "14:32:08 utc".' },
      footerText: { type: 'string', description: 'Override the footer left text (default "data current").' },
      sections: {
        type: 'array',
        description: 'Ordered body sections (max 8). Each item is a typed primitive — see schema variants.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
          },
          required: ['type'],
        },
      },
    },
    required: ['symbol', 'label', 'sections'],
  },
};

// Back-compat: the leaderboard-specific tool. Still callable but new code
// should use `render_card`. Kept for one release; remove once telemetry shows
// no callers.
const RENDER_HOLDER_CARD_TOOL: McpToolDef = {
  serverName: 'builtin',
  toolName: 'render_holder_card',
  exposedName: 'render_holder_card',
  description:
    "Render the Torque-branded 'top holders' data card (PNG) that the channel " +
    'sends as an image. Use this for any leaderboard / top-N wallets / top-N ' +
    'holders question — it includes the chart, the wallet rows, intro context, ' +
    'and a few summary insight rows in one branded image.\n' +
    'Rules:\n' +
    "- `rows` is required, max 10, sorted by descending value. Pass `pct` as 0-100 " +
    'where 100 = the longest bar (typically the rank-1 wallet at 100%, others ' +
    'scaled proportionally).\n' +
    '- Mark the top wallet `highlight: true` for the yellow accent treatment.\n' +
    '- `insights` should be 2-5 plain-English summary rows. NEVER name statistical ' +
    'metrics (no "gini", "HHI", "p-value"); compute them yourself if useful, ' +
    'translate to plain English (e.g. "concentration: high — top wallet dominates").\n' +
    '- Set one insight `accent: true` for the headline (red callout).\n' +
    '- `symbol` and `label` go in the live status bar; lowercase, e.g. "$trump" / "leaderboard".\n' +
    '- `dataTitle` follows pattern "top holders — <epoch label>".\n' +
    '- `updatedUtc` is pre-formatted "HH:MM:SS utc".\n' +
    'After the card renders, your text reply should call out the headline number ' +
    "or trend the card shows — don't just send the picture silently.",
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Project token, lowercase. e.g. "$trump"' },
      label: { type: 'string', description: 'Section name, lowercase. e.g. "leaderboard"' },
      introTitle: {
        type: 'string',
        description: 'Optional intro section title, e.g. "how this leaderboard works".',
      },
      intro: {
        type: 'string',
        description: 'Optional 1-2 sentence intro / mechanic explanation above the data block.',
      },
      introMuted: {
        type: 'string',
        description: 'Optional muted suffix after intro, e.g. "Window closes in 34d 09h 18m."',
      },
      dataTitle: {
        type: 'string',
        description: 'Section title above the rows, e.g. "top holders — current epoch".',
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'number' },
            name: { type: 'string', description: 'Wallet display name (already truncated by you).' },
            pct: { type: 'number', description: '0-100; the longest bar (typically rank 1) is 100.' },
            value: { type: 'string', description: 'Numeric portion, e.g. "2.84".' },
            unit: { type: 'string', description: 'Optional unit, e.g. "M", "K".' },
            highlight: { type: 'boolean', description: 'True on the rank-1 row for yellow accent.' },
          },
          required: ['rank', 'name', 'pct', 'value'],
        },
        description: 'Max 10 rows; sorted by descending value.',
      },
      insightTitle: {
        type: 'string',
        description: 'Section title above the insights block, e.g. "intelligence — concentration".',
      },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Plain-English label, lowercase preferred.' },
            val: { type: 'string', description: 'Plain-English value (may include arrow + commentary).' },
            accent: { type: 'boolean', description: 'True on the headline insight (red callout).' },
          },
          required: ['key', 'val'],
        },
        description: '2-5 plain-English summary rows. Never name statistical metrics.',
      },
      updatedUtc: { type: 'string', description: 'Pre-formatted timestamp e.g. "14:32:08 utc".' },
      ctaText: {
        type: 'string',
        description: 'Optional CTA label for the bottom button, e.g. "view full leaderboard".',
      },
    },
    required: ['symbol', 'label', 'dataTitle', 'rows'],
  },
};

// Generic Chart.js fallback. Use only when render_holder_card doesn't fit
// (e.g. time-series, multi-series comparisons, distributions). The card tools
// produce the polished branded image; this is the functional fallback for the
// long tail.
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
  if (toolName === 'render_card') {
    // ONE card per turn — second call returns a hard rejection telling the
    // model to work with what it already rendered. Multiple cards per reply
    // cluttered chat threads in production.
    if (attachments.length >= 1) {
      return (
        '[render_card already called this turn — only ONE card per reply. ' +
        'The card you already rendered is what the user will see. ' +
        'Write your text reply around it; do NOT call render_card again.]'
      );
    }
    try {
      const spec = args as unknown as CardSpec;
      const { png, warnings } = await renderCard(spec);
      const safeName = `${spec.symbol ?? 'card'}_${spec.label ?? 'card'}`
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40);
      attachments.push({ name: `${safeName}.png`, png });
      const warnTail = warnings.length > 0 ? ` warnings: ${warnings.slice(0, 3).join('; ')}` : '';
      return `[card rendered (${spec.symbol} / ${spec.label}) — will be attached to the reply.${warnTail}]`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'render failed';
      return `[render_card failed: ${msg}]`;
    }
  }
  if (toolName === 'render_holder_card') {
    if (attachments.length >= 2) {
      return '[render_holder_card limit reached for this turn — at most 2 attachments per reply]';
    }
    try {
      const spec = args as unknown as HolderCardSpec;
      if (!spec.rows || spec.rows.length === 0) {
        return '[render_holder_card: rows is required and non-empty]';
      }
      const png = await renderHolderCard(spec);
      const safeName = `${spec.symbol ?? 'holders'}_card`.replace(/[^\w.-]+/g, '_').slice(0, 40);
      attachments.push({ name: `${safeName}.png`, png });
      return `[holder card rendered: "${spec.dataTitle}" — will be attached to the reply]`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'render failed';
      return `[render_holder_card failed: ${msg}]`;
    }
  }
  if (toolName === 'render_chart') {
    if (attachments.length >= 2) {
      return '[render_chart limit reached for this turn — at most 2 attachments per reply]';
    }
    try {
      const spec = args as unknown as ChartSpec;
      const png = await renderChart(spec);
      const safeName = String(spec.title ?? 'chart').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'chart';
      attachments.push({ name: `${safeName}.png`, png });
      return `[chart rendered: "${spec.title}" — will be attached to the reply]`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'render failed';
      return `[render_chart failed: ${msg}]`;
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
  const toolTraces: ToolCallTrace[] = [];
  const turnT0 = Date.now();
  const turnStartedAt = new Date();
  console.log(
    `[turn] tenant=${tenant.slug} conv=${ctx.conversationId} model=${tenant.model} started`,
  );
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
      RENDER_CARD_TOOL,
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

    const turnDeadline = turnT0 + TURN_BUDGET_MS;
    let budgetExceeded = false;
    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
      if (Date.now() > turnDeadline) {
        budgetExceeded = true;
        finalText =
          'Sorry — that query is taking longer than I can spend on it. ' +
          'Try narrowing it (smaller date range, fewer wallets, or a more specific metric) and I\'ll re-run.';
        break;
      }
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
            const t0 = Date.now();
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
              const dur = Date.now() - t0;
              // Structured tool-call trace — single line, greppable in Coolify
              // logs. Args summary is the first scalar value only, capped, so
              // we don't leak full SQL queries or wallet lists.
              console.log(
                `[turn] tenant=${tenant.slug} tool=${def.toolName} dur=${dur}ms ok ${argSummary(args)}`,
              );
              const sqlExtras = captureSqlDebug(def.toolName, args, body);
              toolTraces.push({
                tool: def.toolName,
                dur_ms: dur,
                ok: true,
                args_summary: argSummary(args) || undefined,
                ...sqlExtras,
              });
              return { id: tc.id, content: capToolResponse(body) };
            } catch (err) {
              const dur = Date.now() - t0;
              const errName = (err as Error).name;
              console.log(
                `[turn] tenant=${tenant.slug} tool=${def.toolName} dur=${dur}ms FAIL ${errName}`,
              );
              const sqlExtras = captureSqlDebug(def.toolName, args, null);
              toolTraces.push({
                tool: def.toolName,
                dur_ms: dur,
                ok: false,
                err_name: errName,
                args_summary: argSummary(args) || undefined,
                ...sqlExtras,
              });
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

    // Defensive post-process: strip Markdown tables the model might have
    // written in the final reply despite the soul rule. Telegram + Slack both
    // flatten `|---|---|` into unreadable lines. Detected by a separator row
    // `|---|---|` surrounded by a header row above and data rows below.
    //
    // Conditional: ONLY strip when a card was actually rendered, since the card
    // is the replacement. When NO card exists, the raw table is degraded but at
    // least informative — replacing it with "(table omitted)" leaves the user
    // with neither view of the data, which is worse than the flattened table.
    if (attachments.length > 0) {
      const stripResult = stripMarkdownTables(finalText);
      if (stripResult.stripped) {
        console.log(
          `[turn] tenant=${tenant.slug} stripped Markdown table from reply (card already rendered)`,
        );
        finalText = stripResult.text;
      }
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

    console.log(
      `[turn] tenant=${tenant.slug} completed dur=${Date.now() - turnT0}ms tokens=in:${tokensIn} out:${tokensOut} tools=${toolsUsed.length} attachments=${attachments.length}`,
    );

    // Best-effort eval trace — never fail the turn on DB error.
    try {
      await saveTrace({
        tenant_id: tenant.id,
        conversation_id: ctx.conversationId,
        model: tenant.model,
        source: ctx.conversationId.split(':')[0] || undefined,
        user_message: userMessage.slice(0, 1000),
        started_at: turnStartedAt,
        completed_at: new Date(),
        status: budgetExceeded ? 'timeout' : 'ok',
        err_label: budgetExceeded ? 'TurnBudgetExceeded' : undefined,
        final_reply: finalText.trim().slice(0, 4000),
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        tool_calls: toolTraces,
        picked_render_tool: pickRenderTool(toolTraces),
        attachments_count: attachments.length,
      });
    } catch (err) {
      console.error(
        `[agent-runtime] saveTrace failed for ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`,
      );
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
    const label = err instanceof Error ? err.name : 'UnknownError';
    console.log(
      `[turn] tenant=${tenant.slug} FAILED dur=${Date.now() - turnT0}ms tools=${toolsUsed.length} err=${label}`,
    );
    // Persist the failed trace too — that's the most important eval signal.
    try {
      await saveTrace({
        tenant_id: tenant.id,
        conversation_id: ctx.conversationId,
        model: tenant.model,
        source: ctx.conversationId.split(':')[0] || undefined,
        user_message: userMessage.slice(0, 1000),
        started_at: turnStartedAt,
        completed_at: new Date(),
        status: label === 'TimeoutError' || /timed out/.test(label) ? 'timeout' : 'failed',
        err_label: label,
        tokens_in: 0,
        tokens_out: 0,
        tool_calls: toolTraces,
        picked_render_tool: pickRenderTool(toolTraces),
        attachments_count: attachments.length,
      });
    } catch (saveErr) {
      console.error(
        `[agent-runtime] saveTrace (failed turn) failed for ${tenant.slug}: ${saveErr instanceof Error ? saveErr.name : 'error'}`,
      );
    }
    // Redacted logging (owner preference): log the error TYPE only, never the
    // verbatim provider error body or model output, which can carry secrets or
    // PII. The bounded label is enough to triage; full bodies are not persisted.
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

/**
 * Strip Markdown tables from a model's reply (defensive backstop for the soul
 * "HARD STOP" rule that models intermittently ignore). Detected pattern:
 *  - a separator row that's all `|`, `-`, `:`, and whitespace (e.g. `|---|---|`)
 *  - the line above is treated as the header (removed)
 *  - consecutive lines below matching `| ... |` are treated as data rows (removed)
 * Replaces the whole block with a one-line placeholder pointing at render_card.
 * Returns `{ text, stripped }` so the caller can log telemetry.
 */
function stripMarkdownTables(input: string): { text: string; stripped: boolean } {
  const lines = input.split('\n');
  const out: string[] = [];
  let stripped = false;
  let i = 0;
  const separatorRe = /^\s*\|[\-:\s|]+\|\s*$/;
  const tableRowRe = /^\s*\|.*\|\s*$/;
  while (i < lines.length) {
    if (separatorRe.test(lines[i])) {
      // Drop trailing header row above the separator (if it looks like a table row).
      if (out.length > 0 && tableRowRe.test(out[out.length - 1])) {
        out.pop();
      }
      // Skip the separator.
      i += 1;
      // Skip consecutive data rows.
      while (i < lines.length && tableRowRe.test(lines[i])) i += 1;
      out.push('(table omitted — ask for a card view if you want the breakdown.)');
      stripped = true;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return { text: out.join('\n'), stripped };
}

/**
 * One-line argument summary for tool-call logs. Pulls the first 2 scalar
 * fields the LLM passed (string/number/boolean) and caps the whole line at
 * 80 chars. Used by tool-call traces in the runtime — full args may carry
 * SQL queries, wallet lists, or PII, which we never want in logs.
 */
function argSummary(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (parts.length >= 2) break;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v);
      parts.push(`${k}=${s.length > 30 ? s.slice(0, 27) + '…' : s}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=array[${v.length}]`);
    }
  }
  const line = parts.join(' ');
  return line.length > 80 ? line.slice(0, 77) + '…' : line;
}

const RENDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_card',
  'render_chart',
  'render_holder_card',
]);

// Cap on the tool-result payload re-injected into the model's context. Big
// query results (1000+ rows, 100KB+ JSON blobs) get carried into every
// subsequent model call in the tool loop — context compounds geometrically.
// Cap at 4KB per tool response; the agent sees a clear truncation marker and
// can refine with COUNT/GROUP BY/LIMIT if it needs more.
const TOOL_RESPONSE_CAP = 4000;
function capToolResponse(body: string): string {
  if (body.length <= TOOL_RESPONSE_CAP) return body;
  const head = body.slice(0, TOOL_RESPONSE_CAP);
  return `${head}\n\n[…tool response truncated from ${body.length} chars to ${TOOL_RESPONSE_CAP}. If you need a summary of the full result, refine the query with COUNT, GROUP BY, or a tighter WHERE filter.]`;
}

// Indexer SQL tools — for these we capture the full query + row count in the
// trace so we can audit the agent's query strategy. Limited to SQL tools so we
// don't accidentally surface arg payloads for tools that carry wallet lists or
// PII (e.g. get_leaderboard args, which may include a recurringOfferId only,
// but other Torque tools could carry richer data).
const SQL_DEBUG_TOOLS: ReadonlySet<string> = new Set(['execute_raw_query', 'query_data']);

function captureSqlDebug(
  toolName: string,
  args: Record<string, unknown>,
  body: string | null,
): { args_full?: string; result_summary?: string } {
  if (!SQL_DEBUG_TOOLS.has(toolName)) return {};
  const out: { args_full?: string; result_summary?: string } = {};
  const q = typeof args.query === 'string' ? args.query : '';
  if (q) out.args_full = q.length > 2000 ? q.slice(0, 2000) + '…' : q;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { rowCount?: number; execution_time_ms?: number };
      if (typeof parsed.rowCount === 'number') {
        out.result_summary =
          `rows=${parsed.rowCount}` +
          (typeof parsed.execution_time_ms === 'number'
            ? ` time=${parsed.execution_time_ms}ms`
            : '');
      }
    } catch {
      // body wasn't JSON — skip; row count unavailable
    }
  }
  return out;
}

/** First successful render-tool call wins. null if none fired (or all failed). */
function pickRenderTool(traces: ToolCallTrace[]): string | null {
  for (const t of traces) {
    if (t.ok && RENDER_TOOL_NAMES.has(t.tool)) return t.tool;
  }
  return null;
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
