/**
 * createJobFromTemplate — turn a stored ReportTemplate into a runnable Job.
 *
 * The "select + schedule" half of the reporting product: a template (authored by
 * the author-report-recipe skill, uploaded via /api/v1/templates) becomes a
 * three-step job — fetch (ingester) -> analyze (run_analysis, approval-gated) ->
 * deliver (channel manifest). The recipe {cells, spec} is gate-validated at author
 * time; the sandbox recomputes every number each run.
 */
import { randomUUID } from 'node:crypto';
import type { ReportTemplate } from './db';
import type { StepDefinition, Job } from './types';
import { createJob } from './db';

const RUN_MODEL = process.env.REPORT_RUN_MODEL || 'anthropic/claude-sonnet-4.6';

export type CreateJobFromTemplateOpts = {
  cron?: string | null;
  channel?: string;
  enabled?: boolean;
  id?: string;
  name?: string;
};

function fetchStep(t: ReportTemplate): StepDefinition {
  const f = t.fetch || {};
  const blocks: string[] = [];
  if (f.now_sql) blocks.push('BOARD_NOW (execute_raw_query, query = this):\n```sql\n' + f.now_sql + '\n```');
  if (f.prior_sql) blocks.push('BOARD_PRIOR (execute_raw_query, query = this):\n```sql\n' + f.prior_sql + '\n```');
  if (f.signups_sql) blocks.push('SIGNUPS (execute_raw_query, query = this):\n```sql\n' + f.signups_sql + '\n```');
  return {
    name: 'fetch',
    model: RUN_MODEL,
    system_prompt:
      'You are a data fetcher. Call mcp_ingester_execute_raw_query once per SQL block below, ' +
      'passing each block as the `query` argument VERBATIM (self-contained; do not edit). Return ONLY a JSON ' +
      'object {"now_rows":[...],"prior_rows":[...],"signups":{...}} from the respective query `rows`. Do NOT ' +
      'interpret, compute, or drop rows. The ingester is read-only; never attempt INSERT/UPDATE/DELETE/DDL.',
    user_template: blocks.join('\n\n'),
    tools_allowed: ['ingester'],
    retries: 1,
    timeout_seconds: 600,
  };
}

function analyzeStep(t: ReportTemplate): StepDefinition {
  return {
    name: 'analyze',
    model: RUN_MODEL,
    system_prompt:
      'You are the report renderer. Call mcp_run_analysis EXACTLY ONCE. You do NOT compute any number — the ' +
      'sandbox does. Build `snapshots` from the fetch output by passing arrays through VERBATIM (transpose ' +
      'row objects into the column arrays the cells reference; pass scalar counts as-is). Pass `cells` and ' +
      '`spec` EXACTLY as the literals below. Return ONLY the returned `markdown` field, verbatim. If ' +
      'run_analysis errors, return the error text.\n\ncells = ' + JSON.stringify(t.recipe.cells) +
      '\n\nspec = ' + JSON.stringify(t.recipe.spec),
    user_template: 'Fetch output:\n{{steps.fetch.output}}',
    tools_allowed: ['analysis'],
    retries: 1,
    timeout_seconds: 900,
    use_feedback: true,
    approval_required: true,
  };
}

function deliverStep(t: ReportTemplate, channel: string): StepDefinition {
  return {
    name: 'deliver',
    model: RUN_MODEL,
    system_prompt:
      'You are the channel publisher. The post happens downstream — emit ONLY a fenced ```json block ' +
      `(no commentary) of shape {"channels":["${channel}"],"${channel}":"<message>","markdown":"<approved markdown verbatim>"}. ` +
      'House rules: NO emojis. Lead with the deltas (signed numbers carry direction). Use a fenced code block ' +
      'for any leaderboard table so columns align in chat. Keep it ~1 screen. End with a "Reply for the full ' +
      'breakdown" line. Use ONLY figures present in the approved markdown — invent nothing.',
    user_template: 'Approved report markdown:\n{{steps.analyze.output}}',
    tools_allowed: [],
    retries: 1,
    timeout_seconds: 180,
  };
}

export function buildJobInputFromTemplate(t: ReportTemplate, opts: CreateJobFromTemplateOpts = {}) {
  const channel = opts.channel || t.channel || 'telegram';
  return {
    id: opts.id ?? randomUUID(),
    name: opts.name ?? `${t.name} (${channel})`,
    description: `Scheduled report from template "${t.name}" [${t.account}] — fetch → analyze → approve → deliver(${channel}).`,
    cron: opts.cron ?? t.default_cron ?? null,
    enabled: opts.enabled ?? true,
    steps: [fetchStep(t), analyzeStep(t), deliverStep(t, channel)] as StepDefinition[],
  };
}

export async function createJobFromTemplate(t: ReportTemplate, opts: CreateJobFromTemplateOpts = {}): Promise<Job> {
  return createJob(buildJobInputFromTemplate(t, opts));
}
