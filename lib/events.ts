import { randomUUID } from 'node:crypto';
import { listWebhooksForEvent, sql } from './db';

/**
 * The set of orchestrator-emitted webhook events. Keep this in sync with
 * `lib/orchestrator.ts` (the only place that calls `emit`) and with the UI
 * checkbox set in `app/settings/webhooks/create-webhook-dialog.tsx`.
 */
export type WebhookEvent =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'step.completed';

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  'run.started',
  'run.completed',
  'run.failed',
  'step.completed',
] as const;

/**
 * Enqueue a webhook delivery for every webhook subscribed to `event`.
 *
 * The sweeper in `lib/webhook-delivery.ts` consumes due rows on a 30s cron
 * tick and posts them. We deliberately insert with `next_attempt_at = now()`
 * (NOT NULL) so the row is immediately eligible for the next sweeper pass —
 * once delivered, `next_attempt_at` is cleared.
 *
 * Never throws — failure to enqueue a webhook must NOT cause the orchestrator
 * step or run that triggered it to fail.
 */
export async function emit(event: WebhookEvent, payload: unknown): Promise<void> {
  let hooks;
  try {
    hooks = await listWebhooksForEvent(event);
  } catch (err) {
    console.error(`[events] listWebhooksForEvent(${event}) failed:`, err);
    return;
  }
  if (hooks.length === 0) return;

  const payloadJson = JSON.stringify(payload);
  for (const h of hooks) {
    try {
      await sql`
        INSERT INTO webhook_deliveries
          (id, webhook_id, event, payload, next_attempt_at)
        VALUES (
          ${randomUUID()},
          ${h.id},
          ${event},
          ${payloadJson}::jsonb,
          now()
        )
      `;
    } catch (err) {
      console.error(
        `[events] failed to enqueue delivery for webhook ${h.id} event ${event}:`,
        err,
      );
    }
  }
}
