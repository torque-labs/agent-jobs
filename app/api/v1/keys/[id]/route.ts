import { NextResponse } from 'next/server';
import { revokeApiKey } from '@/lib/api-keys';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'keys:admin');
    const { id } = await ctx.params;
    const ok = await revokeApiKey(id);
    if (!ok) return NextResponse.json({ error: 'Not found or already revoked' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  });
}
