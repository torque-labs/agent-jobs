import { NextResponse } from 'next/server';
import { rejectRun } from '@/lib/approval';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Workstream H — reject a paused run. Terminal: the run is marked failed
 * with the supplied reason. No way to un-reject in v1 (operator can re-run
 * the job to start a fresh attempt).
 *
 * Body: { reason: string }  // required, non-empty
 */
export async function POST(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: { reason?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const reason = (body.reason ?? '').trim();
  if (!reason) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }

  try {
    const updated = await rejectRun(id, reason);
    if (!updated) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
