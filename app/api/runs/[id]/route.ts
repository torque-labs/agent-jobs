import { NextResponse } from 'next/server';
import { getRun } from '@/lib/db';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
