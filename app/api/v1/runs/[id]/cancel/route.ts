import { NextResponse } from 'next/server';
import { cancelRun, getRun } from '@/lib/db';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Cooperative cancel. Flips status='cancelled' if the run is in 'queued' or
 * 'running'; the orchestrator notices at the next step boundary and stops.
 * Already-terminal runs return their current row unchanged with 200.
 */
export async function POST(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'runs:cancel');
    const { id } = await ctx.params;
    const existing = await getRun(id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const updated = await cancelRun(id);
    return NextResponse.json(updated ?? existing);
  });
}
