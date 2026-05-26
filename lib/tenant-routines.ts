/**
 * Per-agent scheduled "routines" — a tenant agent runs a prompt on a cron
 * cadence (UTC) and posts the reply to its Telegram/Slack channel (e.g. a
 * daily digest). Scheduling is via the same in-process node-cron used by jobs
 * (lib/cron.ts); execution goes through runTenantTurn (lib/routine-runner.ts)
 * so it's scoped to the tenant's Torque token + soul + tools.
 */
import { randomBytes } from 'node:crypto';
import { sql } from './db';

export type RoutineChannel = 'telegram' | 'slack';

export type Routine = {
  id: string;
  tenant_id: string;
  name: string;
  cron: string; // interpreted in UTC
  prompt: string;
  channel: RoutineChannel;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
  created_at: Date;
  updated_at: Date;
};

let _schema: Promise<void> | null = null;

export function ensureRoutineSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS tenant_routines (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        name        TEXT NOT NULL,
        cron        TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        channel     TEXT NOT NULL CHECK (channel IN ('telegram','slack')),
        enabled     BOOLEAN NOT NULL DEFAULT true,
        last_run_at TIMESTAMPTZ,
        last_status TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS tenant_routines_tenant_idx ON tenant_routines(tenant_id)`;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

type Row = Routine;

function newId(): string {
  return `routine_${randomBytes(6).toString('hex')}`;
}

export type CreateRoutineInput = {
  tenant_id: string;
  name: string;
  cron: string;
  prompt: string;
  channel: RoutineChannel;
  enabled?: boolean;
};

export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  await ensureRoutineSchema();
  const id = newId();
  const rows = await sql<Row[]>`
    INSERT INTO tenant_routines (id, tenant_id, name, cron, prompt, channel, enabled)
    VALUES (${id}, ${input.tenant_id}, ${input.name}, ${input.cron}, ${input.prompt},
            ${input.channel}, ${input.enabled ?? true})
    RETURNING *
  `;
  return rows[0];
}

export async function listRoutinesForTenant(tenantId: string): Promise<Routine[]> {
  await ensureRoutineSchema();
  return sql<Row[]>`SELECT * FROM tenant_routines WHERE tenant_id = ${tenantId} ORDER BY created_at`;
}

/** Every enabled routine across all tenants — used by cron boot registration. */
export async function listEnabledRoutines(): Promise<Routine[]> {
  await ensureRoutineSchema();
  return sql<Row[]>`SELECT * FROM tenant_routines WHERE enabled = true`;
}

export async function getRoutine(id: string): Promise<Routine | null> {
  await ensureRoutineSchema();
  const rows = await sql<Row[]>`SELECT * FROM tenant_routines WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export type UpdateRoutineInput = Partial<{
  name: string;
  cron: string;
  prompt: string;
  channel: RoutineChannel;
  enabled: boolean;
}>;

export async function updateRoutine(id: string, patch: UpdateRoutineInput): Promise<Routine | null> {
  await ensureRoutineSchema();
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.cron !== undefined) updates.cron = patch.cron;
  if (patch.prompt !== undefined) updates.prompt = patch.prompt;
  if (patch.channel !== undefined) updates.channel = patch.channel;
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  updates.updated_at = new Date();
  const keys = Object.keys(updates);
  if (keys.length === 1) return getRoutine(id);
  const rows = await sql<Row[]>`
    UPDATE tenant_routines SET ${sql(updates, ...keys)} WHERE id = ${id} RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  await ensureRoutineSchema();
  const rows = await sql`DELETE FROM tenant_routines WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function markRoutineRun(id: string, status: string): Promise<void> {
  await ensureRoutineSchema();
  await sql`UPDATE tenant_routines SET last_run_at = now(), last_status = ${status} WHERE id = ${id}`;
}
