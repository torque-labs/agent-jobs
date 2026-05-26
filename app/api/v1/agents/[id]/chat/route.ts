import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runTenantTurn, type ConversationMessage } from '@/lib/agent-runtime';
import { getTenant } from '@/lib/tenants';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

/**
 * Operator/test endpoint: drive a single tenant turn directly, without a real
 * channel. Used to verify the $TRUMP tenant end-to-end (scoped Torque MCP +
 * soul + model) before any Telegram/Slack wiring. Behind agents:read.
 */
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

    const result = await runTenantTurn(id, parsed.data.message, {
      conversationId: parsed.data.conversation_id ?? `test:${id}`,
      speaker: parsed.data.speaker,
      history: (parsed.data.history ?? []) as ConversationMessage[],
    });
    return NextResponse.json(result);
  });
}
