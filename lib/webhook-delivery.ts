import { createHmac } from 'node:crypto';
import { sql } from './db';

/**
 * Workstream D — outbound webhook delivery sweeper.
 *
 * Every 30s the cron tick calls `sweepWebhookDeliveries()`. It:
 *   1. Selects up to 50 deliveries with `next_attempt_at <= now()` that
 *      haven't been delivered or dead-lettered, using FOR UPDATE SKIP LOCKED
 *      so concurrent sweepers (across restarts, or future multi-pod) don't
 *      double-fire any single row.
 *   2. For each row: HMAC-signs the payload with the webhook's secret, POSTs
 *      to the URL with the signature header, and updates the row based on the
 *      response.
 *   3. 2xx → delivered_at=now(), next_attempt_at=NULL.
 *      non-2xx or exception → increment attempt; if >= MAX_ATTEMPTS dead-letter,
 *      else schedule a retry from RETRY_BACKOFF_MS by attempt index.
 */

// 4 attempts total: original + 3 retries. After attempt 4 fails the row is
// dead-lettered.
const MAX_ATTEMPTS = 4;

// Indexed by the NEXT attempt count. attempt=1 means the first attempt just
// failed; we schedule it 30s out, etc. attempt>=4 → dead-letter (no scheduling).
const RETRY_BACKOFF_MS: number[] = [
  30 * 1000,         // 30s
  5 * 60 * 1000,     // 5min
  30 * 60 * 1000,    // 30min
  3 * 60 * 60 * 1000, // 3h (only used if we ever raise MAX_ATTEMPTS)
];

const BATCH_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 15_000;

type DueRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  attempt: number;
  url: string;
  secret: string;
  enabled: boolean;
};

/**
 * One sweep pass. Idempotent and safe to call concurrently. Returns the
 * number of deliveries processed (attempted or skipped due to disabled hook).
 */
export async function sweepWebhookDeliveries(): Promise<number> {
  let rows: DueRow[];
  try {
    // Lock candidate rows so two concurrent sweeps can't pick the same one.
    // We join to webhooks to grab url+secret+enabled inline.
    rows = await sql<DueRow[]>`
      WITH due AS (
        SELECT d.id
        FROM webhook_deliveries d
        WHERE d.next_attempt_at IS NOT NULL
          AND d.next_attempt_at <= now()
          AND d.delivered_at IS NULL
          AND d.dead_lettered_at IS NULL
        ORDER BY d.next_attempt_at
        LIMIT ${BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      SELECT d.id, d.webhook_id, d.event, d.payload, d.attempt,
             w.url, w.secret, w.enabled
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id IN (SELECT id FROM due)
    `;
  } catch (err) {
    console.error('[webhook-delivery] sweep select failed:', err);
    return 0;
  }

  if (rows.length === 0) return 0;

  let processed = 0;
  for (const row of rows) {
    processed++;
    // Skip disabled hooks: just clear next_attempt_at and leave delivered_at
    // null — operator can re-enable + manually requeue if they want.
    if (!row.enabled) {
      try {
        await sql`
          UPDATE webhook_deliveries
          SET next_attempt_at = NULL,
              last_error = 'webhook disabled'
          WHERE id = ${row.id}
        `;
      } catch (err) {
        console.error(`[webhook-delivery] failed to skip disabled hook for ${row.id}:`, err);
      }
      continue;
    }

    await deliverOne(row);
  }

  return processed;
}

async function deliverOne(row: DueRow): Promise<void> {
  const nextAttempt = row.attempt + 1;
  const payloadString = JSON.stringify(row.payload);
  const signature = createHmac('sha256', row.secret).update(payloadString).digest('hex');

  let status = 0;
  let errorMsg: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentJobs-Event': row.event,
        'X-AgentJobs-Signature': `sha256=${signature}`,
        'X-AgentJobs-Delivery': row.id,
      },
      body: payloadString,
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      errorMsg = `HTTP ${status}: ${body.slice(0, 500)}`;
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  // 2xx → delivered.
  if (status >= 200 && status < 300) {
    try {
      await sql`
        UPDATE webhook_deliveries
        SET attempt = ${nextAttempt},
            delivered_at = now(),
            next_attempt_at = NULL,
            last_status = ${status},
            last_error = NULL
        WHERE id = ${row.id}
      `;
    } catch (err) {
      console.error(`[webhook-delivery] failed to mark delivered ${row.id}:`, err);
    }
    return;
  }

  // Failure path.
  if (nextAttempt >= MAX_ATTEMPTS) {
    try {
      await sql`
        UPDATE webhook_deliveries
        SET attempt = ${nextAttempt},
            dead_lettered_at = now(),
            next_attempt_at = NULL,
            last_status = ${status || null},
            last_error = ${errorMsg}
        WHERE id = ${row.id}
      `;
    } catch (err) {
      console.error(`[webhook-delivery] failed to dead-letter ${row.id}:`, err);
    }
    return;
  }

  // Schedule retry. nextAttempt is 1-indexed here (we just incremented),
  // RETRY_BACKOFF_MS is 0-indexed by the count of past failures.
  const backoffMs = RETRY_BACKOFF_MS[nextAttempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  try {
    await sql`
      UPDATE webhook_deliveries
      SET attempt = ${nextAttempt},
          next_attempt_at = now() + (${backoffMs}::bigint || ' milliseconds')::interval,
          last_status = ${status || null},
          last_error = ${errorMsg}
      WHERE id = ${row.id}
    `;
  } catch (err) {
    console.error(`[webhook-delivery] failed to schedule retry for ${row.id}:`, err);
  }
}
