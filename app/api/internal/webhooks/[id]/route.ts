import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteWebhook, getWebhook, updateWebhook } from '@/lib/db';
import { WEBHOOK_EVENTS } from '@/lib/events';

export const runtime = 'nodejs';

const VALID_EVENTS = new Set<string>(WEBHOOK_EVENTS);

const patchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  enabled: z.boolean().optional(),
});

type RouteCtx = { params: Promise<{ id: string }> };

function strip<T extends { secret: string }>(h: T): Omit<T, 'secret'> {
  const { secret: _s, ...rest } = h;
  return rest;
}

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const hook = await getWebhook(id);
  if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(strip(hook));
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const patch = parsed.data;
  if (patch.events) {
    const bad = patch.events.filter((e) => !VALID_EVENTS.has(e));
    if (bad.length > 0) {
      return NextResponse.json(
        { error: `Unknown event(s): ${bad.join(', ')}`, allowed: [...WEBHOOK_EVENTS] },
        { status: 400 },
      );
    }
    patch.events = [...new Set(patch.events)];
  }
  const updated = await updateWebhook(id, patch);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(strip(updated));
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const ok = await deleteWebhook(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
