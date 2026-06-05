/**
 * Per-conversation memory for tenant agents. Keyed by (tenant_id,
 * conversation_id) — so each Telegram chat / Slack thread keeps its own
 * rolling history, scoped to the tenant (isolation preserved). runTenantTurn
 * loads recent turns + persists each new exchange when ctx.persist is set;
 * channel handlers opt in, while routines / UI test turns stay stateless.
 */
import { sql } from './db';

export type StoredMessage = { role: 'user' | 'assistant'; content: string };

/** How many recent messages to replay into a turn (≈ this/2 turns). */
// Rolling window of prior messages we re-inject into each turn's prompt.
// Lowered 20 → 4 (2026-06-03) after insight-style turns started failing on
// context-length errors — every prior insights reply was ~4-5KB of prose,
// and 20× of those plus the soul plus per-turn tool results pushed past
// DeepSeek V4 Pro's ~128K context limit. 4 messages = last 2 user/assistant
// exchanges, enough for conversational continuity without runaway growth.
export const MEMORY_WINDOW = 4;

let _schema: Promise<void> | null = null;

export function ensureConversationSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content         TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS conversation_messages_key_idx
        ON conversation_messages(tenant_id, conversation_id, created_at)
    `;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

/** Recent history for a conversation, oldest-first, capped at `limit`. */
export async function loadHistory(
  tenantId: string,
  conversationId: string,
  limit = MEMORY_WINDOW,
): Promise<StoredMessage[]> {
  await ensureConversationSchema();
  const rows = await sql<StoredMessage[]>`
    SELECT role, content FROM conversation_messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}

/** Append messages to a conversation (oldest-first within `msgs`). */
export async function saveMessages(
  tenantId: string,
  conversationId: string,
  msgs: StoredMessage[],
): Promise<void> {
  if (msgs.length === 0) return;
  await ensureConversationSchema();
  for (const m of msgs) {
    if (!m.content) continue;
    await sql`
      INSERT INTO conversation_messages (tenant_id, conversation_id, role, content)
      VALUES (${tenantId}, ${conversationId}, ${m.role}, ${m.content})
    `;
  }
}
