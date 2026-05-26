import type { StepDefinition } from '../lib/types';

/**
 * TRUMP daily leaderboard digest job seed.
 *
 * Deterministic-render flow (Phase 3): the LLM no longer computes any number.
 *  - fetch-current: get the CURRENT leaderboard snapshot via the `torque` MCP.
 *  - render: call `mcp_render_leaderboard` (the `render` MCP, which bridges to
 *    the deployed render service). The service computes every fact — 24h deltas,
 *    concentration, rank boundary, engagement — DETERMINISTICALLY from the raw
 *    rows (deriving the prior snapshot itself from prior_offset_days) and renders
 *    the markdown digest. This replaces the old in-head-math `compose` step and
 *    the hallucination risk it carried. Operator approval still gates publish.
 *  - publish: pure text — emits an OUTLINE_REQUEST manifest the orchestrator's
 *    downstream consumer POSTs to Outline, using the render step's `markdown`
 *    verbatim. The MCP layer doesn't expose a terminal/curl tool, so this step
 *    stays LLM-only.
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
      name: 'fetch-current',
      model: 'anthropic/claude-sonnet-4.6',
      system_prompt: `You are a Torque leaderboard data fetcher. Your ONLY job: call mcp_torque_set_active_project, then mcp_torque_get_recurring_incentive, then mcp_torque_preview_incentive_query with the given endDate. Return the raw query result as JSON. Do NOT interpret. Do NOT compute anything. Do NOT call ask_torque (it confabulates). FORBIDDEN: any mcp_torque_create_*, mcp_torque_attach_*, mcp_torque_update_*, mcp_torque_register_*, mcp_torque_delete_* tools.`,
      user_template: `Project: TRUMP (projectId cmo7c0lyx00cvjt1j8og67hfn). Offer cmovk8qf900gdk01h71tpsx0y. Fetch the CURRENT leaderboard snapshot at endDate=2026-05-18T23:59:59Z (end of yesterday UTC). Use mcp_torque_preview_incentive_query. Paginate to get ALL rows (typically ~185). Return the full raw result as JSON.`,
      tools_allowed: ['torque'],
      retries: 1,
      timeout_seconds: 600,
    },
    {
      name: 'render',
      model: 'anthropic/claude-sonnet-4.6',
      system_prompt: `You are the TRUMP digest renderer. You do NOT compute or interpret any number yourself — the render service does that deterministically.

Call mcp_render_leaderboard EXACTLY ONCE with:
  - results: the full raw leaderboard snapshot JSON from the fetch-current step (pass it through verbatim as the results object).
  - prior_offset_days: 6
  - use_llm: true

The tool returns a JSON object { markdown, html, pdf_base64, title }. Return ONLY the value of the "markdown" field, verbatim — no preamble, no code fences, no commentary. If the tool returns an error, return the error text so the operator can see it. Never fabricate a digest if the tool fails.`,
      user_template: `Current leaderboard snapshot (pass as the results object to mcp_render_leaderboard):
{{steps.fetch-current.output}}`,
      tools_allowed: ['render'],
      retries: 1,
      timeout_seconds: 900,
      // Workstream G — feed prior digests' feedback into the render prompt so
      // the model learns from corrections (e.g. pass-through framing) across runs.
      use_feedback: true,
      // Workstream H — operator must approve the rendered digest before publish.
      approval_required: true,
    },
    {
      name: 'publish',
      model: 'anthropic/claude-sonnet-4.6',
      system_prompt: `You are the Outline publisher. The actual POST happens outside this step — your job is to emit a publish manifest the downstream job consumer will read. Return ONLY a fenced \`\`\`json block matching this shape (no commentary, no markdown around it):

{
  "title": "<UTC date>_<HHMM>_TRUMP",
  "collectionId": "55efc62e-d91f-4fcc-ac6b-cd3c2c3f4e6a",
  "publish": true,
  "text": "<the full markdown digest>"
}

Use the render step output verbatim as the text — it is already the finished markdown digest. Title format: YYYY-MM-DD_HHMM_TRUMP using the current UTC time.`,
      user_template: `Render step output (the finished markdown digest):
{{steps.render.output}}`,
      tools_allowed: [],
      retries: 1,
      timeout_seconds: 120,
    },
  ] as StepDefinition[],
};
