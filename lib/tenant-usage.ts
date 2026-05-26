/**
 * Per-turn token usage + estimated cost for tenant agents. Written by
 * runTenantTurn (lib/agent-runtime.ts) on every turn — channel turns and UI
 * test turns alike. Cost is the ESTIMATE from lib/models.ts pricing, computed
 * and frozen at write time. Surfaced read-only in /settings/agents.
 */
import { sql } from './db';
import { estimateCostUsd } from './models';

let _schema: Promise<void> | null = null;

export function ensureUsageSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS tenant_usage (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        model       TEXT NOT NULL,
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        cost_usd    NUMERIC(14, 8) NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS tenant_usage_tenant_idx ON tenant_usage(tenant_id)`;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

/** Record one turn's usage. Best-effort — callers should not let this throw. */
export async function recordUsage(
  tenantId: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  if (tokensIn <= 0 && tokensOut <= 0) return;
  await ensureUsageSchema();
  const cost = estimateCostUsd(model, tokensIn, tokensOut);
  await sql`
    INSERT INTO tenant_usage (tenant_id, model, tokens_in, tokens_out, cost_usd)
    VALUES (${tenantId}, ${model}, ${tokensIn}, ${tokensOut}, ${cost})
  `;
}

export type UsageSummary = {
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

const EMPTY: UsageSummary = { turns: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };

type SummaryRow = {
  tenant_id: string;
  turns: string;
  tokens_in: string | null;
  tokens_out: string | null;
  cost_usd: string | null;
};

function rowToSummary(r: SummaryRow): UsageSummary {
  return {
    turns: Number(r.turns),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
  };
}

/** All-time usage for one tenant. */
export async function getUsageSummary(tenantId: string): Promise<UsageSummary> {
  await ensureUsageSchema();
  const rows = await sql<SummaryRow[]>`
    SELECT ${tenantId} AS tenant_id,
           count(*) AS turns,
           sum(tokens_in) AS tokens_in,
           sum(tokens_out) AS tokens_out,
           sum(cost_usd) AS cost_usd
    FROM tenant_usage WHERE tenant_id = ${tenantId}
  `;
  return rows[0] ? rowToSummary(rows[0]) : { ...EMPTY };
}

/** All-time usage for every tenant, keyed by tenant_id (for the list page). */
export async function getUsageSummaries(): Promise<Record<string, UsageSummary>> {
  await ensureUsageSchema();
  const rows = await sql<SummaryRow[]>`
    SELECT tenant_id,
           count(*) AS turns,
           sum(tokens_in) AS tokens_in,
           sum(tokens_out) AS tokens_out,
           sum(cost_usd) AS cost_usd
    FROM tenant_usage GROUP BY tenant_id
  `;
  const out: Record<string, UsageSummary> = {};
  for (const r of rows) out[r.tenant_id] = rowToSummary(r);
  return out;
}
