import type { StepDefinition } from '../lib/types';

/**
 * TRUMP daily leaderboard digest job seed.
 *
 * All steps run through the Hermes Agent gateway (`hermes-agent`) because
 * they need MCP access:
 *  - fetch-baseline / fetch-compare: Torque MCP for leaderboard snapshots.
 *  - compose: Python execute_code for delta math + writing /tmp/digest.md.
 *  - publish: terminal/curl to POST the markdown to the Outline Agents
 *    collection (sandboxed execute_code lacks the OUTLINE_API_KEY env var).
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
      model: 'hermes-agent',
      system_prompt: `You are a Torque leaderboard data fetcher. Your ONLY job: call mcp_torque_set_active_project, then mcp_torque_get_recurring_incentive, then mcp_torque_preview_incentive_query with the given endDate. Return the raw query result as JSON. Do NOT interpret. Do NOT call ask_torque (it confabulates). FORBIDDEN: any mcp_torque_create_*, mcp_torque_attach_*, mcp_torque_update_*, mcp_torque_register_*, mcp_torque_delete_* tools.`,
      user_template: `Project: TRUMP (projectId cmo7c0lyx00cvjt1j8og67hfn). Offer cmovk8qf900gdk01h71tpsx0y. Fetch the leaderboard snapshot at endDate=2026-05-17T23:59:59Z (end of yesterday-minus-one UTC = the BASELINE timestamp). Use mcp_torque_preview_incentive_query. Paginate to get ALL rows (typically ~185). Return the full raw result.`,
      tools_allowed: null,
      retries: 1,
      timeout_seconds: 600,
    },
    {
      name: 'fetch-compare',
      model: 'hermes-agent',
      system_prompt: `Same role as fetch-baseline.`,
      user_template: `Same project/offer as fetch-baseline. Fetch the leaderboard snapshot at endDate=2026-05-18T23:59:59Z (end of yesterday UTC = the COMPARE timestamp). Same tool, same pagination, same raw output.`,
      tools_allowed: null,
      retries: 1,
      timeout_seconds: 600,
    },
    {
      name: 'compose',
      model: 'hermes-agent',
      system_prompt: `You are the TRUMP digest composer. Given two leaderboard snapshots (baseline + compare), use execute_code (Python) to compute exact deltas. Then write a markdown digest to /tmp/digest.md following this exact structure:

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

Rules: every number traces back to your Python output. NEVER guess. NEVER reference HHI/Gini by name. TRUMP campaign rules: no points/raffles/buy-vs-transfer. Target ≤60 lines markdown. DO NOT include a "Constraints honored" line.

Return only: \`DIGEST_WRITTEN: /tmp/digest.md\``,
      user_template: `Baseline snapshot:
{{steps.fetch-baseline.output}}

Compare snapshot:
{{steps.fetch-compare.output}}

Day N: compute as (compare-date - 2026-05-12).days + 1, where 2026-05-12 is epoch start. M = 50. Report date = compare-date. Compose now.`,
      tools_allowed: null,
      retries: 1,
      timeout_seconds: 900,
    },
    {
      name: 'publish',
      model: 'hermes-agent',
      system_prompt: `You are the Outline publisher. Use the terminal tool (NOT execute_code — sandbox lacks env vars). Build payload + POST via curl:

\`\`\`bash
TITLE="$(date -u +%Y-%m-%d_%H%M)_TRUMP"
python3 -c "
import json
payload = {
    'title': '$TITLE',
    'text': open('/tmp/digest.md').read(),
    'collectionId': '55efc62e-d91f-4fcc-ac6b-cd3c2c3f4e6a',
    'publish': True,
}
open('/tmp/outline-body.json','w').write(json.dumps(payload))
"
curl -sS -X POST "https://outline.coolify.torque.so/api/documents.create" \\
  -H "Authorization: Bearer $OUTLINE_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data @/tmp/outline-body.json
\`\`\`

Parse the response. On "ok":true, return: \`✅ <title> → https://outline.coolify.torque.so<data.url>\`. On 401/403 surface auth error (no retry). On 400 surface validation. On 5xx retry ONCE.`,
      user_template: `Publish the digest at /tmp/digest.md (just composed). Compose step output: {{steps.compose.output}}`,
      tools_allowed: null,
      retries: 1,
      timeout_seconds: 120,
    },
  ] as StepDefinition[],
};
