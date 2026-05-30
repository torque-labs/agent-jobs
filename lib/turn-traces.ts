/**
 * Turn-level trace store for post-hoc evaluation. Captures each turn's full
 * tool sequence, timings, model + tokens, status, and a render-tool tag so
 * we can quantify behavior like "what fraction of trend questions actually
 * produced a card?" without trawling stdout logs.
 *
 * All writes are best-effort; a DB outage must not fail the live turn.
 * Inserts go through saveTrace at completion time (or finalizeTraceError on
 * failure) so we keep the live runtime hot path lean.
 */
import { sql } from './db';

export type ToolCallTrace = {
  /** Tool name as the model emitted it. */
  tool: string;
  /** Duration in ms (start → result / error). */
  dur_ms: number;
  /** True if the call returned without throwing; false on error/timeout. */
  ok: boolean;
  /** Scalar-only argument summary (capped 80 chars). Never raw SQL / wallets / PII. */
  args_summary?: string;
  /** Full SQL query (capped 2000 chars). Populated ONLY for indexer SQL tools
   *  (execute_raw_query / query_data) so we can debug the agent's query strategy
   *  without surfacing args for unrelated tools (which may carry wallet lists). */
  args_full?: string;
  /** Compact result summary (e.g. "rows=42 time=120ms"). Populated for SQL tools. */
  result_summary?: string;
  /** Error name (e.g. "TimeoutError") when ok=false. */
  err_name?: string;
};

export type TurnTraceStatus = 'ok' | 'failed' | 'timeout';

export type TurnTraceInput = {
  tenant_id: string;
  conversation_id: string;
  model: string;
  user_message: string;
  /** Channel that originated this turn (telegram/slack/ui-test/routine). */
  source?: string;
  started_at: Date;
  completed_at: Date;
  status: TurnTraceStatus;
  /** Short error label when status != 'ok'. */
  err_label?: string;
  /** Final reply text, truncated by the caller. */
  final_reply?: string;
  tokens_in: number;
  tokens_out: number;
  tool_calls: ToolCallTrace[];
  /** "render_card" / "render_chart" / null if no visual tool fired. */
  picked_render_tool: string | null;
  attachments_count: number;
};

export type StoredTurnTrace = TurnTraceInput & {
  id: number;
  duration_ms: number;
};

let _schema: Promise<void> | null = null;

export function ensureTurnTracesSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS turn_traces (
        id                  BIGSERIAL PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        conversation_id     TEXT NOT NULL,
        model               TEXT NOT NULL,
        source              TEXT,
        user_message        TEXT NOT NULL,
        started_at          TIMESTAMPTZ NOT NULL,
        completed_at        TIMESTAMPTZ NOT NULL,
        duration_ms         INTEGER NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('ok','failed','timeout')),
        err_label           TEXT,
        final_reply         TEXT,
        tokens_in           INTEGER NOT NULL DEFAULT 0,
        tokens_out          INTEGER NOT NULL DEFAULT 0,
        tool_calls          JSONB NOT NULL DEFAULT '[]'::jsonb,
        picked_render_tool  TEXT,
        attachments_count   INTEGER NOT NULL DEFAULT 0
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS turn_traces_tenant_started_idx
        ON turn_traces(tenant_id, started_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS turn_traces_render_tool_idx
        ON turn_traces(tenant_id, picked_render_tool)
    `;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

/** Persist a completed turn trace. Best-effort: caller wraps in try/catch. */
export async function saveTrace(input: TurnTraceInput): Promise<void> {
  await ensureTurnTracesSchema();
  const duration_ms = Math.max(0, input.completed_at.getTime() - input.started_at.getTime());
  await sql`
    INSERT INTO turn_traces (
      tenant_id, conversation_id, model, source, user_message,
      started_at, completed_at, duration_ms, status, err_label,
      final_reply, tokens_in, tokens_out, tool_calls,
      picked_render_tool, attachments_count
    ) VALUES (
      ${input.tenant_id}, ${input.conversation_id}, ${input.model},
      ${input.source ?? null}, ${input.user_message},
      ${input.started_at}, ${input.completed_at}, ${duration_ms},
      ${input.status}, ${input.err_label ?? null},
      ${input.final_reply ?? null}, ${input.tokens_in}, ${input.tokens_out},
      ${sql.json(input.tool_calls)},
      ${input.picked_render_tool}, ${input.attachments_count}
    )
  `;
}

export type TraceListFilters = {
  /** ISO from-time inclusive */
  since?: string;
  /** Only return turns where status=this. */
  status?: TurnTraceStatus;
  /** Only return turns where picked_render_tool=this. */
  rendered?: string | null;
};

export async function listTraces(
  tenantId: string,
  limit = 50,
  filters: TraceListFilters = {},
): Promise<StoredTurnTrace[]> {
  await ensureTurnTracesSchema();
  const lim = Math.max(1, Math.min(500, limit));
  const sinceDate = filters.since ? new Date(filters.since) : null;
  const rows = await sql<StoredTurnTrace[]>`
    SELECT
      id, tenant_id, conversation_id, model, source, user_message,
      started_at, completed_at, duration_ms, status, err_label,
      final_reply, tokens_in, tokens_out, tool_calls,
      picked_render_tool, attachments_count
    FROM turn_traces
    WHERE tenant_id = ${tenantId}
      AND (${sinceDate}::timestamptz IS NULL OR started_at >= ${sinceDate})
      AND (${filters.status ?? null}::text IS NULL OR status = ${filters.status ?? null})
      AND (
        ${filters.rendered === undefined ? null : 'set'}::text IS NULL
        OR picked_render_tool IS NOT DISTINCT FROM ${filters.rendered ?? null}
      )
    ORDER BY started_at DESC
    LIMIT ${lim}
  `;
  return rows;
}
