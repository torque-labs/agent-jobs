import { NextResponse } from 'next/server';
import { revokeApiKey } from '@/lib/api-keys';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    const ok = await revokeApiKey(id);
    if (!ok) return NextResponse.json({ error: 'Not found or already revoked' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
