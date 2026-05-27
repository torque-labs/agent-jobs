import postgres from 'postgres';
import type {
  Job,
  PendingApproval,
  Run,
  RunFeedback,
  StepDefinition,
  StepRun,
  Webhook,
  WebhookDelivery,
} from './types';

// Lazy client so `next build` page-data collection doesn't crash when
// DATABASE_URL is absent at build time. The URL is only required when
// a query actually runs (boot, request handling, cron tick).
let _sql: ReturnType<typeof postgres> | null = null;

function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL env var is required at runtime');
  }
  _sql = postgres(url, { max: 10, idle_timeout: 30, prepare: false });
  return _sql;
}

const sqlProxyTarget = function () {} as unknown as ReturnType<typeof postgres>;

export const sql: ReturnType<typeof postgres> = new Proxy(sqlProxyTarget, {
  get(_t, prop) {
    const client = getSql() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
  apply(_t, _this, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
  },
}) as ReturnType<typeof postgres>;

let schemaInitPromise: Promise<void> | null = null;

/**
 * Idempotent schema bootstrap. Safe to call repeatedly; only runs once per
 * process. Other helpers in this module do NOT auto-call it — callers (API
 * routes, cron, orchestrator entrypoints) should call `await initSchema()`
 * during startup.
 */
export function initSchema(): Promise<void> {
  if (schemaInitPromise) return schemaInitPromise;
  schemaInitPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cron        TEXT,
        steps       JSONB NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status        TEXT NOT NULL,
        triggered_by  TEXT NOT NULL,
        started_at    TIMESTAMPTZ,
        ended_at      TIMESTAMPTZ,
        step_runs     JSONB NOT NULL DEFAULT '[]'::jsonb,
        final_output  TEXT,
        error         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status)`;
    await sql`CREATE INDEX IF NOT EXISTS runs_job_id_created_idx ON runs(job_id, created_at DESC)`;

    // Webhooks: outbound HTTP delivery configuration.
    await sql`
      CREATE TABLE IF NOT EXISTS webhooks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL,
        events      JSONB NOT NULL,
        secret      TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id              TEXT PRIMARY KEY,
        webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event           TEXT NOT NULL,
        payload         JSONB NOT NULL,
        attempt         INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        delivered_at    TIMESTAMPTZ,
        dead_lettered_at TIMESTAMPTZ,
        last_status     INT,
        last_error      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
        ON webhook_deliveries(next_attempt_at)
        WHERE next_attempt_at IS NOT NULL
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_id_created_idx
        ON webhook_deliveries(webhook_id, created_at DESC)
    `;

    // Triggers: per-job inbound webhook tokens.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS trigger_token TEXT UNIQUE`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS trigger_enabled BOOLEAN NOT NULL DEFAULT false`;
    await sql`
      CREATE INDEX IF NOT EXISTS jobs_trigger_token_idx
        ON jobs(trigger_token) WHERE trigger_token IS NOT NULL
    `;

    // Workstream H — approval gate state for runs paused mid-execution.
    // Shape: { step_name, output, requested_at }. NULL = no approval pending.
    await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS pending_approval JSONB`;

    // Workstream G — per-run human feedback. Denormalized job_id so we can
    // list feedback by job without joining through runs (the orchestrator
    // queries this on every step that opts into use_feedback).
    await sql`
      CREATE TABLE IF NOT EXISTS run_feedback (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        job_id      TEXT NOT NULL,
        rating      TEXT NOT NULL CHECK (rating IN ('good','bad','neutral')),
        comment     TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by  TEXT
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS run_feedback_job_id_idx
        ON run_feedback(job_id, created_at DESC)
    `;

    // Report templates — a markdown brief compiled (by the author-report-recipe
    // skill) into a recipe {cells, spec}. Uploaded here, then selected + scheduled
    // as a job via createJobFromTemplate. `recipe` is the gate-validated unit;
    // `fetch` carries the data-binding SQL (now/prior/signups).
    await sql`
      CREATE TABLE IF NOT EXISTS report_templates (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        account        TEXT NOT NULL DEFAULT '',
        layout         TEXT NOT NULL DEFAULT 'report',
        recipe         JSONB NOT NULL,
        fetch          JSONB NOT NULL DEFAULT '{}'::jsonb,
        prior_interval TEXT NOT NULL DEFAULT '24 hours',
        default_cron   TEXT,
        channel        TEXT NOT NULL DEFAULT 'telegram',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS run_feedback_run_id_idx
        ON run_feedback(run_id, created_at DESC)
    `;
  })().catch((err) => {
    // Reset so the next caller can retry (e.g. transient DB outage on boot).
    schemaInitPromise = null;
    throw err;
  });
  return schemaInitPromise;
}

// ---------- Row mappers ----------

type JobRow = {
  id: string;
  name: string;
  description: string;
  cron: string | null;
  steps: StepDefinition[];
  enabled: boolean;
  trigger_token: string | null;
  trigger_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type RunRow = {
  id: string;
  job_id: string;
  status: Run['status'];
  triggered_by: Run['triggered_by'];
  started_at: Date | null;
  ended_at: Date | null;
  step_runs: StepRun[];
  final_output: string | null;
  error: string | null;
  pending_approval: PendingApproval | null;
  created_at: Date;
};

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    cron: row.cron,
    steps: row.steps ?? [],
    enabled: row.enabled,
    trigger_token: row.trigger_token ?? null,
    trigger_enabled: row.trigger_enabled ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    job_id: row.job_id,
    status: row.status,
    triggered_by: row.triggered_by,
    started_at: row.started_at,
    ended_at: row.ended_at,
    step_runs: row.step_runs ?? [],
    final_output: row.final_output,
    error: row.error,
    pending_approval: row.pending_approval ?? null,
    created_at: row.created_at,
  };
}

// ---------- Run approval state ----------

/**
 * Workstream H — write the `pending_approval` JSONB + bump status atomically.
 * The orchestrator calls this from `lib/approval.requestApproval` after a step
 * that has `approval_required: true` completes; the API approve route then
 * clears it via `clearPendingApproval`.
 */
export async function setPendingApproval(
  runId: string,
  pending: PendingApproval,
): Promise<Run | null> {
  const rows = await sql<RunRow[]>`
    UPDATE runs
    SET pending_approval = ${sql.json(pending)},
        status = 'awaiting_approval'
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Clear the pending_approval JSONB and (optionally) flip the run back to
 * 'running'. Returning to 'running' is the resume path; leaving status alone
 * is used for the reject path which will then call setRunError + flip to
 * 'failed' separately.
 */
export async function clearPendingApproval(
  runId: string,
  opts: { resumeRunning?: boolean } = {},
): Promise<Run | null> {
  if (opts.resumeRunning) {
    const rows = await sql<RunRow[]>`
      UPDATE runs
      SET pending_approval = NULL, status = 'running'
      WHERE id = ${runId}
      RETURNING *
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }
  const rows = await sql<RunRow[]>`
    UPDATE runs
    SET pending_approval = NULL
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

// ---------- Run feedback CRUD ----------

type RunFeedbackRow = {
  id: string;
  run_id: string;
  job_id: string;
  rating: 'good' | 'bad' | 'neutral';
  comment: string;
  created_at: Date;
  created_by: string | null;
};

function mapFeedback(row: RunFeedbackRow): RunFeedback {
  return {
    id: row.id,
    run_id: row.run_id,
    job_id: row.job_id,
    rating: row.rating,
    comment: row.comment ?? '',
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

export type CreateFeedbackInput = {
  id: string;
  run_id: string;
  job_id: string;
  rating: 'good' | 'bad' | 'neutral';
  comment?: string;
  created_by?: string | null;
};

export async function insertRunFeedback(
  input: CreateFeedbackInput,
): Promise<RunFeedback> {
  const rows = await sql<RunFeedbackRow[]>`
    INSERT INTO run_feedback (id, run_id, job_id, rating, comment, created_by)
    VALUES (
      ${input.id},
      ${input.run_id},
      ${input.job_id},
      ${input.rating},
      ${input.comment ?? ''},
      ${input.created_by ?? null}
    )
    RETURNING *
  `;
  return mapFeedback(rows[0]);
}

export async function getRunFeedbackByJob(
  jobId: string,
  limit = 20,
): Promise<RunFeedback[]> {
  const rows = await sql<RunFeedbackRow[]>`
    SELECT * FROM run_feedback
    WHERE job_id = ${jobId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapFeedback);
}

export async function getRunFeedbackByRun(runId: string): Promise<RunFeedback[]> {
  const rows = await sql<RunFeedbackRow[]>`
    SELECT * FROM run_feedback
    WHERE run_id = ${runId}
    ORDER BY created_at DESC
  `;
  return rows.map(mapFeedback);
}

// ---------- Job CRUD ----------

export type CreateJobInput = {
  id: string;
  name: string;
  description?: string;
  cron?: string | null;
  steps: StepDefinition[];
  enabled?: boolean;
};

export async function createJob(input: CreateJobInput): Promise<Job> {
  const rows = await sql<JobRow[]>`
    INSERT INTO jobs (id, name, description, cron, steps, enabled)
    VALUES (
      ${input.id},
      ${input.name},
      ${input.description ?? ''},
      ${input.cron ?? null},
      ${sql.json(input.steps)},
      ${input.enabled ?? true}
    )
    RETURNING *
  `;
  return mapJob(rows[0]);
}

export async function getJob(id: string): Promise<Job | null> {
  const rows = await sql<JobRow[]>`SELECT * FROM jobs WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function listJobs(): Promise<Job[]> {
  const rows = await sql<JobRow[]>`SELECT * FROM jobs ORDER BY created_at DESC`;
  return rows.map(mapJob);
}

// ---------------------------------------------------------------------------
// Report templates
// ---------------------------------------------------------------------------
export type ReportTemplate = {
  id: string;
  name: string;
  account: string;
  layout: string;
  recipe: { cells: { code: string }[]; spec: Record<string, unknown> };
  fetch: { now_sql?: string; prior_sql?: string; signups_sql?: string };
  prior_interval: string;
  default_cron: string | null;
  channel: string;
  created_at: Date;
};
type ReportTemplateRow = Omit<ReportTemplate, 'default_cron'> & { default_cron: string | null };

function mapTemplate(r: ReportTemplateRow): ReportTemplate {
  return {
    id: r.id, name: r.name, account: r.account, layout: r.layout,
    recipe: r.recipe, fetch: r.fetch ?? {}, prior_interval: r.prior_interval,
    default_cron: r.default_cron ?? null, channel: r.channel, created_at: r.created_at,
  };
}

export type CreateTemplateInput = Omit<ReportTemplate, 'created_at'>;

export async function createTemplate(input: CreateTemplateInput): Promise<ReportTemplate> {
  const rows = await sql<ReportTemplateRow[]>`
    INSERT INTO report_templates (id, name, account, layout, recipe, fetch, prior_interval, default_cron, channel)
    VALUES (
      ${input.id}, ${input.name}, ${input.account}, ${input.layout},
      ${sql.json(input.recipe as unknown as Parameters<typeof sql.json>[0])}, ${sql.json(input.fetch as unknown as Parameters<typeof sql.json>[0])},
      ${input.prior_interval}, ${input.default_cron ?? null}, ${input.channel}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, account = EXCLUDED.account, layout = EXCLUDED.layout,
      recipe = EXCLUDED.recipe, fetch = EXCLUDED.fetch,
      prior_interval = EXCLUDED.prior_interval, default_cron = EXCLUDED.default_cron,
      channel = EXCLUDED.channel
    RETURNING *
  `;
  return mapTemplate(rows[0]);
}

export async function getTemplate(id: string): Promise<ReportTemplate | null> {
  const rows = await sql<ReportTemplateRow[]>`SELECT * FROM report_templates WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapTemplate(rows[0]) : null;
}

export async function listTemplates(): Promise<ReportTemplate[]> {
  const rows = await sql<ReportTemplateRow[]>`SELECT * FROM report_templates ORDER BY created_at DESC`;
  return rows.map(mapTemplate);
}

export type UpdateJobInput = Partial<{
  name: string;
  description: string;
  cron: string | null;
  steps: StepDefinition[];
  enabled: boolean;
  trigger_token: string | null;
  trigger_enabled: boolean;
}>;

export async function updateJob(id: string, patch: UpdateJobInput): Promise<Job | null> {
  // Build a partial update via the row-update helper. Only keys present on
  // `patch` are written; updated_at is always bumped.
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.cron !== undefined) updates.cron = patch.cron;
  if (patch.steps !== undefined) updates.steps = sql.json(patch.steps);
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  if (patch.trigger_token !== undefined) updates.trigger_token = patch.trigger_token;
  if (patch.trigger_enabled !== undefined) updates.trigger_enabled = patch.trigger_enabled;
  updates.updated_at = new Date();

  const keys = Object.keys(updates);
  if (keys.length === 1) {
    // Only updated_at — nothing meaningful changed; return current row.
    return getJob(id);
  }

  const rows = await sql<JobRow[]>`
    UPDATE jobs SET ${sql(updates, ...keys)}
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function deleteJob(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM jobs WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------- Run CRUD ----------

export type CreateRunInput = {
  id: string;
  job_id: string;
  status: Run['status'];
  triggered_by: Run['triggered_by'];
  started_at?: Date | null;
  step_runs?: StepRun[];
};

export async function createRun(input: CreateRunInput): Promise<Run> {
  const rows = await sql<RunRow[]>`
    INSERT INTO runs (id, job_id, status, triggered_by, started_at, step_runs)
    VALUES (
      ${input.id},
      ${input.job_id},
      ${input.status},
      ${input.triggered_by},
      ${input.started_at ?? null},
      ${sql.json(input.step_runs ?? [])}
    )
    RETURNING *
  `;
  return mapRun(rows[0]);
}

export async function getRun(id: string): Promise<Run | null> {
  const rows = await sql<RunRow[]>`SELECT * FROM runs WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapRun(rows[0]) : null;
}

export type ListRunsFilter = {
  status?: Run['status'];
  jobId?: string;
  limit?: number;
};

export async function listRuns(filter: ListRunsFilter = {}): Promise<Run[]> {
  const limit = filter.limit ?? 100;
  let rows: RunRow[];
  if (filter.status && filter.jobId) {
    rows = await sql<RunRow[]>`
      SELECT * FROM runs
      WHERE status = ${filter.status} AND job_id = ${filter.jobId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (filter.status) {
    rows = await sql<RunRow[]>`
      SELECT * FROM runs WHERE status = ${filter.status}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (filter.jobId) {
    rows = await sql<RunRow[]>`
      SELECT * FROM runs WHERE job_id = ${filter.jobId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql<RunRow[]>`
      SELECT * FROM runs ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return rows.map(mapRun);
}

export async function updateRunStatus(
  id: string,
  status: Run['status'],
  opts: { started_at?: Date | null; ended_at?: Date | null } = {},
): Promise<Run | null> {
  const updates: Record<string, unknown> = { status };
  if (opts.started_at !== undefined) updates.started_at = opts.started_at;
  if (opts.ended_at !== undefined) updates.ended_at = opts.ended_at;
  const keys = Object.keys(updates);
  const rows = await sql<RunRow[]>`
    UPDATE runs SET ${sql(updates, ...keys)}
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Atomic-ish patch to a single step_run inside the JSONB step_runs array.
 * Reads the current row, mutates the matching step, writes it back. Callers
 * should serialize their updates per run (the orchestrator already runs steps
 * sequentially so there's no contention).
 */
export async function updateStepRun(
  runId: string,
  stepName: string,
  updates: Partial<StepRun>,
): Promise<Run | null> {
  const current = await getRun(runId);
  if (!current) return null;
  const next: StepRun[] = current.step_runs.map((sr) =>
    sr.step_name === stepName ? { ...sr, ...updates } : sr,
  );
  // If the step wasn't in the array yet, append it.
  if (!current.step_runs.some((sr) => sr.step_name === stepName)) {
    next.push({
      step_name: stepName,
      status: 'pending',
      output: null,
      tokens: null,
      cost_usd: null,
      started_at: null,
      ended_at: null,
      error: null,
      ...updates,
    });
  }
  const rows = await sql<RunRow[]>`
    UPDATE runs SET step_runs = ${sql.json(next)}
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function setRunFinalOutput(runId: string, output: string): Promise<Run | null> {
  const rows = await sql<RunRow[]>`
    UPDATE runs SET final_output = ${output}
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function setRunError(runId: string, error: string): Promise<Run | null> {
  const rows = await sql<RunRow[]>`
    UPDATE runs SET error = ${error}
    WHERE id = ${runId}
    RETURNING *
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Cancel a run: set status='cancelled' and ended_at=now() iff the run is
 * currently 'queued' or 'running'. Already-terminal runs (done/failed/cancelled)
 * are left alone and the function returns the existing row.
 *
 * The orchestrator checks for status='cancelled' at each step boundary and
 * bails out if it sees one, so this gives a cooperative-cancel semantic
 * without needing to kill any in-flight model call.
 */
export async function cancelRun(runId: string): Promise<Run | null> {
  const rows = await sql<RunRow[]>`
    UPDATE runs
    SET status = 'cancelled', ended_at = now()
    WHERE id = ${runId} AND status IN ('queued', 'running')
    RETURNING *
  `;
  if (rows[0]) return mapRun(rows[0]);
  // Not in a cancellable state — return whatever we have.
  return getRun(runId);
}

// ---------- Webhook CRUD (Workstream D) ----------

type WebhookRow = {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  created_at: Date;
};

function mapWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: Array.isArray(row.events) ? row.events : [],
    secret: row.secret,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

export type CreateWebhookInput = {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  enabled?: boolean;
};

export async function createWebhook(input: CreateWebhookInput): Promise<Webhook> {
  const rows = await sql<WebhookRow[]>`
    INSERT INTO webhooks (id, name, url, events, secret, enabled)
    VALUES (
      ${input.id},
      ${input.name},
      ${input.url},
      ${sql.json(input.events)},
      ${input.secret},
      ${input.enabled ?? true}
    )
    RETURNING *
  `;
  return mapWebhook(rows[0]);
}

export async function listWebhooks(): Promise<Webhook[]> {
  const rows = await sql<WebhookRow[]>`SELECT * FROM webhooks ORDER BY created_at DESC`;
  return rows.map(mapWebhook);
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  const rows = await sql<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapWebhook(rows[0]) : null;
}

export type UpdateWebhookInput = Partial<{
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
}>;

export async function updateWebhook(
  id: string,
  patch: UpdateWebhookInput,
): Promise<Webhook | null> {
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.url !== undefined) updates.url = patch.url;
  if (patch.events !== undefined) updates.events = sql.json(patch.events);
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  const keys = Object.keys(updates);
  if (keys.length === 0) return getWebhook(id);
  const rows = await sql<WebhookRow[]>`
    UPDATE webhooks SET ${sql(updates, ...keys)}
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? mapWebhook(rows[0]) : null;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM webhooks WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/**
 * Enabled webhooks subscribed to a given event. The `events` JSONB column is
 * an array of strings; `?` (jsonb-contains-key) matches array elements at the
 * top level.
 */
export async function listWebhooksForEvent(event: string): Promise<Webhook[]> {
  const rows = await sql<WebhookRow[]>`
    SELECT * FROM webhooks
    WHERE enabled = true AND events ? ${event}
    ORDER BY created_at DESC
  `;
  return rows.map(mapWebhook);
}

// ---------- Webhook deliveries (Workstream D) ----------

type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  attempt: number;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  dead_lettered_at: Date | null;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
};

function mapWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhook_id: row.webhook_id,
    event: row.event,
    payload: row.payload,
    attempt: row.attempt,
    next_attempt_at: row.next_attempt_at,
    delivered_at: row.delivered_at,
    dead_lettered_at: row.dead_lettered_at,
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

export async function listWebhookDeliveries(
  webhookId: string,
  limit = 50,
): Promise<WebhookDelivery[]> {
  const rows = await sql<WebhookDeliveryRow[]>`
    SELECT * FROM webhook_deliveries
    WHERE webhook_id = ${webhookId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapWebhookDelivery);
}

// ---------- Trigger token lookup (Workstream E) ----------

export async function getJobByTriggerToken(token: string): Promise<Job | null> {
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs WHERE trigger_token = ${token} LIMIT 1
  `;
  return rows[0] ? mapJob(rows[0]) : null;
}
