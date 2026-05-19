import postgres from 'postgres';
import type { Job, Run, StepDefinition, StepRun } from './types';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL env var is required for lib/db.ts');
}

// Single shared postgres client. porsager/postgres handles pooling internally.
// Disable automatic snake_case<->camelCase transforms; we do explicit row mapping.
export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  prepare: false,
});

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
    created_at: row.created_at,
  };
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

export type UpdateJobInput = Partial<{
  name: string;
  description: string;
  cron: string | null;
  steps: StepDefinition[];
  enabled: boolean;
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
