import type { StepDefinition } from '../lib/types';

/**
 * TRUMP daily leaderboard digest job seed.
 *
 * Tool steps drive MCP via in-process subprocesses (see lib/mcp.ts):
 *  - fetch-baseline / fetch-compare: get `torque` MCP tools for leaderboard snapshots.
 *  - compose: pure text — receives both snapshots in the prompt and emits markdown.
 *  - publish: pure text — emits an OUTLINE_REQUEST manifest the orchestrator's
 *    downstream consumer can POST to Outline. The MCP layer doesn't currently
 *    expose a terminal/curl tool, so we keep this step LLM-only.
 */
export const TRUMP_DIGEST_JOB = {
  id: 'trump-daily-digest',
  name: 'TRUMP Daily Leaderboard Digest',
  description:
    'Daily summary of the TRUMP Time Weighted Holding Leaderboard, posted to Outline Agents collection.',
  cron: '0 2 * * *', // 02:00 UTC daily
  enabled: true,
  steps: [
    {
      name: 'fetch-baseline',
      model: 'anthropic/claude-sonnet-4-6',
      system_prompt: `You are a Torque leaderboard data fetcher. Your ONLY job: call mcp_torque_set_active_project, then mcp_torque_get_recurring_incentive, then mcp_torque_preview_incentive_query with the given endDate. Return the raw query result as JSON. Do NOT interpret. Do NOT call ask_torque (it confabulates). FORBIDDEN: any mcp_torque_create_*, mcp_torque_attach_*, mcp_torque_update_*, mcp_torque_register_*, mcp_torque_delete_* tools.`,
      user_template: `Project: TRUMP (projectId cmo7c0lyx00cvjt1j8og67hfn). Offer cmovk8qf900gdk01h71tpsx0y. Fetch the leaderboard snapshot at endDate=2026-05-17T23:59:59Z (end of yesterday-minus-one UTC = the BASELINE timestamp). Use mcp_torque_preview_incentive_query. Paginate to get ALL rows (typically ~185). Return the full raw result.`,
      tools_allowed: ['torque'],
      retries: 1,
      timeout_seconds: 600,
    },
    {
      name: 'fetch-compare',
      model: 'anthropic/claude-sonnet-4-6',
      system_prompt: `Same role as fetch-baseline.`,
      user_template: `Same project/offer as fetch-baseline. Fetch the leaderboard snapshot at endDate=2026-05-18T23:59:59Z (end of yesterday UTC = the COMPARE timestamp). Same tool, same pagination, same raw output.`,
      tools_allowed: ['torque'],
      retries: 1,
      timeout_seconds: 600,
    },
    {
      name: 'compose',
      model: 'anthropic/claude-sonnet-4-6',
      system_prompt: `You are the TRUMP digest composer. Given two leaderboard snapshots (baseline + compare), compute exact deltas in your head and emit a markdown digest following this exact structure (return ONLY the markdown, no preamble):

# TRUMP · Time Weighted Holding Leaderboard
**Day N of M** · Report covers <baseline-end-date> UTC

## Key Metrics
| | Today | Δ vs yesterday |
|---|---:|---:|
| Active participants | <n> | <±n> |
| Total TRUMP held | <sum> | <±delta (±%)> |
| Median balance | <median> | <±delta (±%)> |
| Top-19 share of total | <%> | <±pp> |
| Bottom-50% share of total | <%> | <±pp> |

## Movers (last 24h)
| Tier | ↑ Increased | ↓ Decreased | Flat |
|---|---:|---:|---:|
| Top 19 | <n> | <n> | <n> |
| Ranks 20-100 | <n> | <n> | <n> |
| Ranks 101+ | <n> | <n> | <n> |

### Top 5 Increasers
[table: rank, wallet (truncated), username, baseline_balance, compare_balance, Δ, %Δ]

### Top 5 Decreasers
[same shape]

## Top Insights
**1 · <plain-language concentration headline>** — use specific %s. NEVER mention HHI/Gini.
**2 · <plain-language rank-19 cutoff headline>** — rank-19 threshold, rank-20 gap, contested or locked.
**3 · <plain-language single biggest movement>** — name the wallet (truncated + username), Δ in TRUMP + %, projected consequence.

## Recommendation
### Option A — Scoring improvement: <name>
**What/Why/Estimated impact** (3 short lines)
### Option B — New incentive: <Leaderboard | Rebate | Gift>: <name>
**What/Why/Estimated impact**

Rules: every number traces back to the snapshots provided. NEVER guess. NEVER reference HHI/Gini by name. TRUMP campaign rules: no points/raffles/buy-vs-transfer. Target ≤60 lines markdown. DO NOT include a "Constraints honored" line.`,
      user_template: `Baseline snapshot:
{{steps.fetch-baseline.output}}

Compare snapshot:
{{steps.fetch-compare.output}}

Day N: compute as (compare-date - 2026-05-12).days + 1, where 2026-05-12 is epoch start. M = 50. Report date = compare-date. Compose now.`,
      tools_allowed: [],
      retries: 1,
      timeout_seconds: 900,
    },
    {
      name: 'publish',
      model: 'anthropic/claude-sonnet-4-6',
      system_prompt: `You are the Outline publisher. The actual POST happens outside this step — your job is to emit a publish manifest the downstream job consumer will read. Return ONLY a fenced \`\`\`json block matching this shape (no commentary, no markdown around it):

{
  "title": "<UTC date>_<HHMM>_TRUMP",
  "collectionId": "55efc62e-d91f-4fcc-ac6b-cd3c2c3f4e6a",
  "publish": true,
  "text": "<the full markdown digest>"
}

Use the compose step output verbatim as the text. Title format: YYYY-MM-DD_HHMM_TRUMP using the current UTC time.`,
      user_template: `Compose step output:
{{steps.compose.output}}`,
      tools_allowed: [],
      retries: 1,
      timeout_seconds: 120,
    },
  ] as StepDefinition[],
};
