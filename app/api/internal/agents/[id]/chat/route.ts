import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runTenantTurn } from '@/lib/agent-runtime';
import { getTenant } from '@/lib/tenants';

export const runtime = 'nodejs';

const body = z.object({ message: z.string().min(1) });

/** Session-gated UI test turn (mirrors /api/v1/agents/[id]/chat). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const result = await runTenantTurn(id, parsed.data.message, {
    conversationId: `ui-test:${id}`,
    history: [],
  });
  return NextResponse.json({ reply: result.reply, toolsUsed: result.toolsUsed });
}
