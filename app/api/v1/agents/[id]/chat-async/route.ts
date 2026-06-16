import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  runTenantTurn,
  type ConversationMessage,
  type TenantTurnResult,
} from '@/lib/agent-runtime';
import { getTenant } from '@/lib/tenants';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

/**
 * Async variant of the chat endpoint, for heavy turns that exceed the proxy's
 * ~60s sync timeout (full-leaderboard sums, multi-tool research, card renders).
 *
 *   POST /api/v1/agents/[id]/chat-async        -> { turn_id }  (returns immediately)
 *   GET  /api/v1/agents/[id]/chat-async?turn_id=...  -> { status, ...result }
 *
 * The turn runs in the background on the long-lived custom Node server (not a
 * serverless function), so the fire-and-forget promise completes in-process —
 * the same way the Slack/Telegram channel routes run turns without blocking the
 * HTTP response. Every HTTP call here is sub-second, so the gateway never times
 * out. Behind agents:read.
 *
 * State is an in-memory map keyed by turn_id (lost on restart, pruned after an
 * hour) — operator/test use, not a durable job queue.
 */

type StoredTurn =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; startedAt: number; finishedAt: number; result: TenantTurnResult }
  | { status: 'error'; startedAt: number; finishedAt: number; error: string };

// Stash on globalThis so route re-evaluation / multiple handler modules share
// one map instead of resetting it.
const g = globalThis as unknown as { __asyncTurns?: Map<string, StoredTurn> };
if (!g.__asyncTurns) g.__asyncTurns = new Map();
const store = g.__asyncTurns;

const ONE_HOUR_MS = 60 * 60 * 1000;
function prune(): void {
  const now = Date.now();
  for (const [id, t] of store) {
    const ts = t.status === 'running' ? t.startedAt : t.finishedAt;
    if (now - ts > ONE_HOUR_MS) store.delete(id);
  }
}

const body = z.object({
  message: z.string().min(1),
  conversation_id: z.string().min(1).optional(),
  speaker: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withScope(async () => {
    requireScope(req, 'agents:read');
    const { id } = await params;

    const tenant = await getTenant(id);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    prune();
    const turnId = randomUUID();
    const startedAt = Date.now();
    store.set(turnId, { status: 'running', startedAt });

    // Fire-and-forget — the turn runs to completion in-process and stashes its
    // result for polling. NOT awaited, so the HTTP response returns instantly.
    void runTenantTurn(id, parsed.data.message, {
      conversationId: parsed.data.conversation_id ?? `async:${id}:${turnId}`,
      speaker: parsed.data.speaker,
      history: (parsed.data.history ?? []) as ConversationMessage[],
    })
      .then((result) => store.set(turnId, { status: 'done', startedAt, finishedAt: Date.now(), result }))
      .catch((err) =>
        store.set(turnId, {
          status: 'error',
          startedAt,
          finishedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    return NextResponse.json(
      { turn_id: turnId, status: 'running', poll: `/api/v1/agents/${id}/chat-async?turn_id=${turnId}` },
      { status: 202 },
    );
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withScope(async () => {
    requireScope(req, 'agents:read');
    await params; // turn_id is globally unique; id not needed for lookup

    const turnId = new URL(req.url).searchParams.get('turn_id');
    if (!turnId) {
      return NextResponse.json({ error: 'turn_id query param required' }, { status: 400 });
    }
    const t = store.get(turnId);
    if (!t) {
      return NextResponse.json({ error: 'turn_id not found (expired or invalid)' }, { status: 404 });
    }
    if (t.status === 'running') {
      return NextResponse.json({ status: 'running', elapsed_ms: Date.now() - t.startedAt });
    }
    if (t.status === 'error') {
      return NextResponse.json({ status: 'error', error: t.error, elapsed_ms: t.finishedAt - t.startedAt });
    }
    return NextResponse.json({ status: 'done', elapsed_ms: t.finishedAt - t.startedAt, ...t.result });
  });
}
