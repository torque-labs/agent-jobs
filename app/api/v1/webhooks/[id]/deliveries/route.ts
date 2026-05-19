import { NextResponse } from 'next/server';
import { getWebhook, listWebhookDeliveries } from '@/lib/db';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'webhooks:admin');
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    let limit = 50;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        return NextResponse.json(
          { error: 'limit must be a positive integer <= 500' },
          { status: 400 },
        );
      }
      limit = Math.floor(n);
    }
    const hook = await getWebhook(id);
    if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const rows = await listWebhookDeliveries(id, limit);
    return NextResponse.json(rows);
  });
}
