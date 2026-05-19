import { NextResponse } from 'next/server';
import { getRun } from '@/lib/db';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'runs:read');
    const { id } = await ctx.params;
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(run);
  });
}
