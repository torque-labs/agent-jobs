import { NextResponse } from 'next/server';
import { cancelRun, getRun } from '@/lib/db';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Internal cancel endpoint used by the UI (no scope check — the basic-auth
 * middleware already gates access). Mirrors /api/v1/runs/:id/cancel so
 * server-rendered run pages don't have to mint API keys to drive the action.
 */
export async function POST(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    const existing = await getRun(id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const updated = await cancelRun(id);
    return NextResponse.json(updated ?? existing);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
