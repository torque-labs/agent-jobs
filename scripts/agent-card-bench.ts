/**
 * Local agent-rendering bench.
 *
 * Runs 5 representative $TRUMP CS questions through the live agent loop
 * (same RENDER_CARD_TOOL / RENDER_HOLDER_CARD_TOOL / RENDER_CHART_TOOL /
 * BUILTIN tool schemas + the same soul) against OpenRouter, with all
 * non-render tools mocked so no live Torque/Telegram calls happen.
 *
 * For each query we capture:
 *   /tmp/agent-bench/<NN>-<slug>/transcript.md   — full conversation incl. tool calls
 *   /tmp/agent-bench/<NN>-<slug>/spec.json       — render_card spec (if any)
 *   /tmp/agent-bench/<NN>-<slug>/card.png        — renderCard(spec) output (if any)
 *   /tmp/agent-bench/<NN>-<slug>/finaltext.md    — final user-facing reply
 *
 * Then prints a summary table.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... pnpm exec tsx scripts/agent-card-bench.ts
 *   OPENROUTER_API_KEY=... pnpm exec tsx scripts/agent-card-bench.ts --model=deepseek/deepseek-v3.2-exp
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { renderCard } from '../lib/cards/render';
import { renderHolderCard } from '../lib/render-card';
import { renderChart } from '../lib/render-chart';
import type { CardSpec } from '../lib/cards/types';

// ---------------------------------------------------------------------------
// Tool defs — copy-pasted VERBATIM from lib/agent-runtime.ts so we benchmark
// what the live agent sees. Keep these in sync if the runtime changes.
// ---------------------------------------------------------------------------

type ToolDef = {
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const RENDER_CARD_TOOL: ToolDef = {
  toolName: 'render_card',
  description:
    'Compose a Torque-branded terminal card by picking section primitives. Use ' +
    'when the answer benefits from a designed visual — rankings, trends, hero ' +
    'metrics, comparisons, distributions. The reply attaches the PNG.\n' +
    '\n' +
    'Pick sections by question shape:\n' +
    ' • Top-N (leaderboard) → `data_rows` with `rank`+`pct` + `kv_strip` insights.\n' +
    ' • Trend over time → `sparkline` + `kv_strip` (current/delta/observation).\n' +
    ' • Single hero number → `big_number` (+ optional `callout` for context).\n' +
    ' • Two things compared → `comparison`.\n' +
    ' • Distribution → `histogram` + `kv_strip` headline takeaway.\n' +
    ' • Mixed: combine. Max 8 sections per card.\n' +
    '\n' +
    'Voice rules (STRICT):\n' +
    ' • NEVER name statistical metrics like HHI, Gini, p-value, z-score, R². ' +
    'Translate to plain English (e.g. "concentration: high — top wallet dominates").\n' +
    ' • Lowercase titles + labels (terminal aesthetic).\n' +
    ' • `kv_strip` values are sentence-fragments under 60 chars.\n' +
    ' • `intro_body.text` ≤ 280 chars.\n' +
    ' • Don\'t render a card for a one-sentence answer; reply with text.\n' +
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
    '  {type:"big_number", title:"current epoch", value:"14", label:"of 16", context:"2 epochs remaining"}]}',
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
          properties: { type: { type: 'string' } },
          required: ['type'],
        },
      },
    },
    required: ['symbol', 'label', 'sections'],
  },
};

const RENDER_HOLDER_CARD_TOOL: ToolDef = {
  toolName: 'render_holder_card',
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
      symbol: { type: 'string' },
      label: { type: 'string' },
      introTitle: { type: 'string' },
      intro: { type: 'string' },
      introMuted: { type: 'string' },
      dataTitle: { type: 'string' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'number' },
            name: { type: 'string' },
            pct: { type: 'number' },
            value: { type: 'string' },
            unit: { type: 'string' },
            highlight: { type: 'boolean' },
          },
          required: ['rank', 'name', 'pct', 'value'],
        },
      },
      insightTitle: { type: 'string' },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            val: { type: 'string' },
            accent: { type: 'boolean' },
          },
          required: ['key', 'val'],
        },
      },
      updatedUtc: { type: 'string' },
      ctaText: { type: 'string' },
    },
    required: ['symbol', 'label', 'dataTitle', 'rows'],
  },
};

const RENDER_CHART_TOOL: ToolDef = {
  toolName: 'render_chart',
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
      type: { type: 'string', enum: ['line', 'bar'] },
      title: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
      series: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            data: { type: 'array', items: { type: 'number' } },
          },
          required: ['label', 'data'],
        },
      },
      unit: { type: 'string' },
    },
    required: ['type', 'title', 'labels', 'series', 'unit'],
  },
};

const GET_LEADERBOARD_TOOL: ToolDef = {
  toolName: 'get_leaderboard',
  description:
    "Get the live leaderboard rankings for one of this project's recurring incentives. " +
    'First call list_recurring_incentives to find the recurringOfferId, then pass it here. ' +
    'Returns the top-ranked wallets with username, score, days held, and balance. Use this ' +
    'for any leaderboard/standings question (do NOT use get_epoch_leaderboard).',
  inputSchema: {
    type: 'object',
    properties: {
      recurringOfferId: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['recurringOfferId'],
  },
};

// MCP tools — minimal stubs of the ones the agent is most likely to call for
// our 5 queries. Keep descriptions concise; the runtime exposes many more,
// but for benching the card-design loop these cover the relevant intents.
const LIST_RECURRING_INCENTIVES_TOOL: ToolDef = {
  toolName: 'list_recurring_incentives',
  description:
    "List the active recurring incentive programs for this project. Returns id, name, " +
    'mechanic, current epoch info. Call this first when answering anything about leaderboards, ' +
    'epochs, or campaign status — most other tools need the recurringOfferId from here.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const GET_EPOCH_AGGREGATE_STATS_TOOL: ToolDef = {
  toolName: 'get_epoch_aggregate_stats',
  description:
    'Aggregate stats for a recurring incentive: current/total epoch, claimed %, eligible wallets. ' +
    'Use for any "what epoch / how many participants / how claimed" question.',
  inputSchema: {
    type: 'object',
    properties: {
      recurringOfferId: { type: 'string' },
    },
    required: ['recurringOfferId'],
  },
};

const GET_EPOCH_LEADERBOARD_TOOL: ToolDef = {
  toolName: 'get_epoch_leaderboard',
  description:
    'Get the leaderboard for a specific epoch of a recurring incentive. Pass epochNumber to ' +
    'fetch a past epoch. NOTE: for the current live leaderboard, PREFER get_leaderboard.',
  inputSchema: {
    type: 'object',
    properties: {
      recurringOfferId: { type: 'string' },
      epochNumber: { type: 'number' },
    },
    required: ['recurringOfferId'],
  },
};

const QUERY_DATA_TOOL: ToolDef = {
  toolName: 'query_data',
  description:
    'Run a read-only SQL query against the on-chain ingester database (raw swap/transfer ' +
    'data). Use for time-series, holder counts over time, distribution buckets, anything ' +
    'requiring custom SQL on top of raw blockchain data.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

const ALL_TOOLS: ToolDef[] = [
  GET_LEADERBOARD_TOOL,
  LIST_RECURRING_INCENTIVES_TOOL,
  GET_EPOCH_AGGREGATE_STATS_TOOL,
  GET_EPOCH_LEADERBOARD_TOOL,
  QUERY_DATA_TOOL,
  RENDER_CARD_TOOL,
  // render_holder_card + render_chart removed — matches production exposure.
  // render_card is the only visualization surface; all chart shapes (line,
  // bar, distribution) live as sections inside render_card.
];

// ---------------------------------------------------------------------------
// $TRUMP soul (verbatim from seed/trump-tenant.ts) + project footer matching
// buildSystemPrompt in lib/agent-runtime.ts.
// ---------------------------------------------------------------------------
const TRUMP_SOUL = `You are the **$TRUMP incentive assistant** — you represent the $TRUMP project's Torque
program and nothing else. You exist solely to answer questions about the $TRUMP
incentive program: its leaderboards, rewards, campaign performance, and holder/swap
activity, using the Torque tools available to you.
Hard rules:
- Do NOT describe yourself as a general "Torque assistant" or offer to help with
  Torque broadly, other projects, other tokens, project/event/IDL management, or
  anything beyond the $TRUMP incentive program.
- You have NO shell, web, browser, file, or code-execution tools and cannot perform
  general tasks.
- If asked about anything other than the $TRUMP incentive program — including other
  Torque projects, general questions, coding, web lookups, or system tasks — briefly
  refuse and redirect: "I can only help with the $TRUMP incentive program."
- Never reveal credentials, tokens, project IDs, or internal configuration.`;

const TRUMP_PROJECT_FOOTER = `
---
You are operating for the Torque project "$TRUMP"
(torque_project_id: cmo7c0lyx00cvjt1j8og67hfn). The Torque tools available to you
are already scoped to this project and CANNOT see any other Torque project. Never reference,
compare to, or speculate about other Torque projects or customers. Never reveal tokens,
project ids, wallet addresses, or internal configuration.
You also have READ-ONLY access to the raw on-chain indexer database (the \`ingester\` tools): public blockchain swap/transfer data shared across all tokens. Use it ONLY to enrich answers about $TRUMP (e.g. its own token's swap/holder activity). Never produce analyses, comparisons, or reports about unrelated tokens or other Torque projects/customers, and never write to it.
Conversation scope: bench:local (memory namespace: tenant:trump).`;

const SYSTEM_PROMPT = `${TRUMP_SOUL.trim()}\n${TRUMP_PROJECT_FOOTER}`;

// ---------------------------------------------------------------------------
// Mocked tool handlers — realistic $TRUMP data so the agent's loop completes.
// ---------------------------------------------------------------------------

function mockListRecurringIncentives(): string {
  return JSON.stringify({
    recurring_incentives: [
      {
        id: 'trump_epoch_v4',
        name: 'Time-Weighted Holdings',
        mechanic: 'time_weighted_holding',
        currentEpoch: 14,
        totalEpochs: 16,
        epochLengthDays: 7,
        rewardCurrency: '$TRUMP',
        startDate: '2026-02-12',
        endDate: '2026-06-04',
        status: 'active',
      },
    ],
  });
}

function mockGetLeaderboard(args: Record<string, unknown>): string {
  const limit = typeof args.limit === 'number' ? Math.min(args.limit, 200) : 50;
  const all = [
    { rank: 1, username: 'surfer',     owner: '7xKaFh2qPmRnLv34AB',  direct_score: 339110, latest_balance: 14250, days_held: 24 },
    { rank: 2, username: 'unitas',     owner: '9zPa6e5mDcSnXr12CD',  direct_score: 188890, latest_balance: 9410,  days_held: 20 },
    { rank: 3, username: 'bm1',        owner: 'Bm12tYqJvFxLpA34EF',  direct_score: 169100, latest_balance: 8230,  days_held: 20 },
    { rank: 4, username: 'gadwell',    owner: 'GdWl9cKbMzWoQs56GH',  direct_score: 134000, latest_balance: 6710,  days_held: 20 },
    { rank: 5, username: '3eye',       owner: '3eYeXq8nVuTrYy78IJ',  direct_score: 133090, latest_balance: 6650,  days_held: 20 },
    { rank: 6, username: 'libertycap', owner: 'LbCpA1sHrJgFx9aKL',   direct_score: 112400, latest_balance: 5620,  days_held: 20 },
    { rank: 7, username: 'eagleone',   owner: 'EgL1nFqRdMyPz2bMN',   direct_score: 98750,  latest_balance: 4940,  days_held: 20 },
    { rank: 8, username: 'maga_max',   owner: 'MgMx7uZcVnTk4cOP',    direct_score: 81200,  latest_balance: 4060,  days_held: 20 },
    { rank: 9, username: 'stripes',    owner: 'StRp8wQbHnLj6dQR',    direct_score: 67340,  latest_balance: 3370,  days_held: 20 },
    { rank:10, username: 'patriot01',  owner: 'PtRt9xKcGnMy8eST',    direct_score: 51080,  latest_balance: 2550,  days_held: 20 },
  ];
  const rows = all.slice(0, limit);
  return JSON.stringify({
    lastUpdated: '2026-05-28T14:32:08Z',
    rows,
    note: 'Live leaderboard — current epoch 14/16.',
  });
}

function mockGetEpochAggregateStats(): string {
  return JSON.stringify({
    recurringOfferId: 'trump_epoch_v4',
    currentEpoch: 14,
    totalEpochs: 16,
    claimedPct: 0.73,
    eligibleWallets: 14217,
    totalParticipants: 16842,
    epochStart: '2026-05-21T00:00:00Z',
    epochEnd: '2026-05-28T00:00:00Z',
    rewardPool: 250000,
    prevEpoch: {
      epochNumber: 13,
      eligibleWallets: 13140,
      claimedPct: 0.71,
      totalParticipants: 15890,
    },
  });
}

function mockQueryData(args: Record<string, unknown>): string {
  const q = String(args.query ?? '').toLowerCase();
  // Time-series: daily unique holders for 30 days, noisy growth from 12,400 → 14,980.
  if (q.includes('unique') || q.includes('holder') && (q.includes('day') || q.includes('30')) || q.includes('count') && q.includes('owner')) {
    const start = 12400;
    const end = 14980;
    const days = 30;
    const points: Array<{ day: string; holders: number }> = [];
    for (let i = 0; i < days; i++) {
      const t = i / (days - 1);
      // Slight noise on a smooth growth curve.
      const noise = Math.sin(i * 1.7) * 110 + Math.cos(i * 0.9) * 60;
      const v = Math.round(start + (end - start) * t + noise);
      const d = new Date(2026, 3, 29 + i); // Apr 29 → May 28
      points.push({ day: d.toISOString().slice(0, 10), holders: v });
    }
    return JSON.stringify({ rows: points, note: '30 days of daily unique on-chain holders for $TRUMP.' });
  }
  // Distribution buckets — power-law: many small holders, few whales.
  if (q.includes('bucket') || q.includes('distribution') || q.includes('range') || q.includes('case when')) {
    return JSON.stringify({
      rows: [
        { bucket: '<1',       wallets: 4820 },
        { bucket: '1-10',     wallets: 5340 },
        { bucket: '10-100',   wallets: 2980 },
        { bucket: '100-1k',   wallets: 980  },
        { bucket: '1k-10k',   wallets: 220  },
        { bucket: '10k-100k', wallets: 38   },
        { bucket: '100k+',    wallets: 7    },
      ],
      note: 'Holder buckets by $TRUMP balance.',
    });
  }
  return `[mocked: query_data stub — query="${q.slice(0, 80)}"]`;
}

function mockUnknownTool(name: string, args: Record<string, unknown>): string {
  return `[mocked: ${name} response — args=${JSON.stringify(args).slice(0, 120)}]`;
}

// ---------------------------------------------------------------------------
// Tool dispatch — render tools call into the real renderers and capture PNGs.
// ---------------------------------------------------------------------------

type Attachment = { name: string; png: Buffer; spec: unknown; kind: 'card' | 'holder_card' | 'chart' };

async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  attachments: Attachment[],
): Promise<string> {
  switch (toolName) {
    case 'list_recurring_incentives':
      return mockListRecurringIncentives();
    case 'get_leaderboard':
      return mockGetLeaderboard(args);
    case 'get_epoch_aggregate_stats':
      return mockGetEpochAggregateStats();
    case 'get_epoch_leaderboard': {
      const which = typeof args.epochNumber === 'number' ? args.epochNumber : 14;
      // Treat past epochs as previous-epoch rows w/ lower scores.
      const prev = which < 14;
      const scale = prev ? 0.86 : 1;
      const data = JSON.parse(mockGetLeaderboard({ limit: 10 })) as { rows: Array<Record<string, number>> };
      for (const r of data.rows) {
        if (typeof r.direct_score === 'number') r.direct_score = Math.round(r.direct_score * scale);
        if (typeof r.latest_balance === 'number') r.latest_balance = Math.round(r.latest_balance * scale);
      }
      return JSON.stringify({ epochNumber: which, ...data });
    }
    case 'query_data':
      return mockQueryData(args);
    case 'render_card':
      try {
        const spec = args as unknown as CardSpec;
        const { png, warnings } = await renderCard(spec);
        const safe = `${spec.symbol ?? 'card'}_${spec.label ?? 'card'}`
          .replace(/[^\w.-]+/g, '_')
          .slice(0, 40);
        attachments.push({ name: `${safe}.png`, png, spec, kind: 'card' });
        const warnTail = warnings.length > 0 ? ` warnings: ${warnings.slice(0, 3).join('; ')}` : '';
        return `[card rendered (${spec.symbol} / ${spec.label}) — will be attached to the reply.${warnTail}]`;
      } catch (err) {
        return `[render_card failed: ${(err as Error).message}]`;
      }
    case 'render_holder_card':
      try {
        const spec = args as unknown as Parameters<typeof renderHolderCard>[0];
        const png = await renderHolderCard(spec);
        attachments.push({ name: `holder_card.png`, png, spec, kind: 'holder_card' });
        return `[holder card rendered: "${spec.dataTitle}" — will be attached to the reply]`;
      } catch (err) {
        return `[render_holder_card failed: ${(err as Error).message}]`;
      }
    case 'render_chart':
      try {
        const spec = args as unknown as Parameters<typeof renderChart>[0];
        const png = await renderChart(spec);
        attachments.push({ name: `chart.png`, png, spec, kind: 'chart' });
        return `[chart rendered: "${spec.title}" — will be attached to the reply]`;
      } catch (err) {
        return `[render_chart failed: ${(err as Error).message}]`;
      }
    default:
      return mockUnknownTool(toolName, args);
  }
}

// ---------------------------------------------------------------------------
// Bench driver
// ---------------------------------------------------------------------------

const QUERIES: Array<{ slug: string; text: string }> = [
  { slug: 'top-holders',          text: 'Show me the top 5 $TRUMP holders right now.' },
  { slug: 'holder-trend-30d',     text: 'How has the $TRUMP holder count trended over the last 30 days?' },
  { slug: 'current-epoch',        text: "What's the current epoch?" },
  { slug: 'epoch-vs-last',        text: 'How does this epoch compare to last epoch in terms of participation?' },
  { slug: 'wallet-distribution',  text: 'Show me how $TRUMP is distributed across wallets by holding size.' },
];

type RunRecord = {
  query: string;
  slug: string;
  toolChain: string[];
  renderToolUsed: string | null;
  cardSpec: unknown | null;
  pngPath: string | null;
  finalText: string;
  warnings: string[];
  tokensIn: number;
  tokensOut: number;
  error: string | null;
};

async function runOne(
  client: OpenAI,
  model: string,
  outRoot: string,
  index: number,
  query: { slug: string; text: string },
  tools: ChatCompletionTool[],
): Promise<RunRecord> {
  const outDir = join(outRoot, `${String(index + 1).padStart(2, '0')}-${query.slug}`);
  await mkdir(outDir, { recursive: true });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: query.text },
  ];
  const attachments: Attachment[] = [];
  const toolChain: string[] = [];
  const transcript: string[] = [
    `# Bench query ${index + 1}: ${query.slug}`,
    '',
    `**Model:** ${model}`,
    '',
    `**Query:** ${query.text}`,
    '',
    '---',
    '',
  ];
  let tokensIn = 0;
  let tokensOut = 0;
  let finalText = '';
  let error: string | null = null;

  const MAX_ITER = 8;
  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const completion: ChatCompletion = await client.chat.completions.create({
        model,
        messages,
        tools,
        max_tokens: 4096,
        stream: false,
      });
      if (completion.usage) {
        tokensIn += completion.usage.prompt_tokens ?? 0;
        tokensOut += completion.usage.completion_tokens ?? 0;
      }
      const choice = completion.choices?.[0];
      if (!choice) throw new Error('no choices');
      const msg = choice.message;
      const toolCalls = msg.tool_calls;

      transcript.push(`## Assistant turn ${iter + 1}`, '');
      if (msg.content && typeof msg.content === 'string' && msg.content.trim().length > 0) {
        transcript.push('```', msg.content, '```', '');
      }
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.type !== 'function') continue;
          transcript.push(`**tool_call:** \`${tc.function.name}\``, '', '```json');
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {};
          } catch (err) {
            transcript.push(`[invalid JSON args: ${(err as Error).message}]`);
          }
          transcript.push(JSON.stringify(args, null, 2), '```', '');
        }
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });

        for (const tc of toolCalls) {
          if (tc.type !== 'function') {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '[unsupported]' });
            continue;
          }
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {};
          } catch {
            args = {};
          }
          toolChain.push(tc.function.name);
          const result = await dispatchTool(tc.function.name, args, attachments);
          transcript.push(`**tool_result (\`${tc.function.name}\`):**`, '', '```', result.slice(0, 1200), '```', '');
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      finalText = typeof msg.content === 'string' ? msg.content : '';
      transcript.push('## Final reply', '', finalText, '');
      break;
    }
    if (!finalText) finalText = '[no final text — loop exhausted]';
  } catch (err) {
    error = (err as Error).message;
    transcript.push('## Error', '', '```', error, '```', '');
  }

  // Save artifacts.
  const renderAttachment = attachments[0];
  let pngPath: string | null = null;
  let cardSpec: unknown | null = null;
  let renderToolUsed: string | null = null;
  if (renderAttachment) {
    pngPath = join(outDir, 'card.png');
    await writeFile(pngPath, renderAttachment.png);
    cardSpec = renderAttachment.spec;
    await writeFile(join(outDir, 'spec.json'), JSON.stringify(renderAttachment.spec, null, 2));
    renderToolUsed =
      renderAttachment.kind === 'card'
        ? 'render_card'
        : renderAttachment.kind === 'holder_card'
          ? 'render_holder_card'
          : 'render_chart';
  }
  await writeFile(join(outDir, 'transcript.md'), transcript.join('\n'));
  await writeFile(join(outDir, 'finaltext.md'), finalText);

  return {
    query: query.text,
    slug: query.slug,
    toolChain,
    renderToolUsed,
    cardSpec,
    pngPath,
    finalText,
    warnings: [],
    tokensIn,
    tokensOut,
    error,
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      '\nERROR: OPENROUTER_API_KEY is not set.\n\n' +
      'Set it and re-run, e.g.:\n' +
      '  export OPENROUTER_API_KEY="<your key>"\n' +
      '  pnpm exec tsx scripts/agent-card-bench.ts\n',
    );
    process.exit(2);
  }

  const modelArg = process.argv.find((a) => a.startsWith('--model='));
  const model = modelArg ? modelArg.slice('--model='.length) : 'anthropic/claude-sonnet-4.6';

  const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });

  const tools: ChatCompletionTool[] = ALL_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.toolName, description: t.description, parameters: t.inputSchema },
  }));

  const outRoot = '/tmp/agent-bench';
  await mkdir(outRoot, { recursive: true });

  console.log(`\n=== Agent Card Bench ===`);
  console.log(`Model: ${model}`);
  console.log(`Output: ${outRoot}`);
  console.log(`Queries: ${QUERIES.length}\n`);

  const results: RunRecord[] = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    console.log(`[${i + 1}/${QUERIES.length}] ${q.slug}: ${q.text}`);
    try {
      const r = await runOne(client, model, outRoot, i, q, tools);
      results.push(r);
      console.log(
        `   tools: ${r.toolChain.join(' → ') || '(none)'} | render: ${r.renderToolUsed ?? 'none'} | png: ${r.pngPath ?? '—'}`,
      );
      if (r.error) console.log(`   ERROR: ${r.error}`);
    } catch (err) {
      console.log(`   FAILED: ${(err as Error).message}`);
      results.push({
        query: q.text, slug: q.slug, toolChain: [], renderToolUsed: null, cardSpec: null,
        pngPath: null, finalText: '', warnings: [], tokensIn: 0, tokensOut: 0, error: (err as Error).message,
      });
    }
  }

  // Summary
  console.log('\n=== Summary ===\n');
  const totalIn = results.reduce((s, r) => s + r.tokensIn, 0);
  const totalOut = results.reduce((s, r) => s + r.tokensOut, 0);
  console.log(`Model: ${model}`);
  console.log(`Total tokens — prompt: ${totalIn}, completion: ${totalOut}, sum: ${totalIn + totalOut}\n`);

  console.log('| # | query | tool chain | render tool | png |');
  console.log('| - | ----- | ---------- | ----------- | --- |');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const chain = r.toolChain.join(' → ').slice(0, 80) || '(none)';
    console.log(`| ${i + 1} | ${r.slug} | ${chain} | ${r.renderToolUsed ?? '—'} | ${r.pngPath ? r.pngPath.replace(outRoot, '') : '—'} |`);
  }

  // Write a master summary file too.
  const summary = [
    `# Agent Card Bench — ${model}`,
    '',
    `Tokens: prompt=${totalIn}, completion=${totalOut}, sum=${totalIn + totalOut}`,
    '',
    '| # | query | tool chain | render tool | png |',
    '| - | ----- | ---------- | ----------- | --- |',
    ...results.map((r, i) => {
      const chain = r.toolChain.join(' → ') || '(none)';
      return `| ${i + 1} | ${r.query} | ${chain} | ${r.renderToolUsed ?? '—'} | ${r.pngPath ?? '—'} |`;
    }),
    '',
  ];
  for (const r of results) {
    summary.push(`## ${r.slug}`, '', `**Final reply:**`, '', '```', r.finalText, '```', '');
    if (r.cardSpec) {
      summary.push(`**Spec:**`, '', '```json', JSON.stringify(r.cardSpec, null, 2), '```', '');
    }
    summary.push('---', '');
  }
  await writeFile(join(outRoot, 'SUMMARY.md'), summary.join('\n'));
  console.log(`\nWrote ${outRoot}/SUMMARY.md\n`);
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
