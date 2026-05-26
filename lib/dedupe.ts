/**
 * Idempotency for inbound channel events. Both Telegram and Slack re-deliver an
 * event if they don't get a fast 2xx (timeout / non-2xx). We key on the
 * platform's own delivery id (Telegram `update_id`, Slack `event_id`) and
 * record it once; a redelivery sees the row and is skipped. Combined with
 * acking BEFORE the (slow) model turn, this stops duplicate replies.
 */
import { sql } from './db';

let _schema: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS processed_events (
        event_key  TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

/**
 * Atomically claim an event key. Returns true if THIS call claimed it (proceed)
 * or false if it was already processed (skip). Fails OPEN (returns true) on a
 * store error so a transient DB blip never silently drops a real message.
 */
export async function claimEvent(key: string): Promise<boolean> {
  try {
    await ensureSchema();
    const rows = await sql`
      INSERT INTO processed_events (event_key) VALUES (${key})
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[dedupe] claimEvent failed (fail-open):', err instanceof Error ? err.name : 'error');
    return true;
  }
}
