import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteTenant, getTenant, toPublicTenant, updateTenant } from '@/lib/tenants';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

// Partial update — torque_mcp_token / torque_project_id are NOT patchable here
// (changing the boundary requires re-verification → delete + recreate).
// NOTE: `channels` REPLACES the stored channels object wholesale.
const patchBody = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    soul: z.string().min(1).optional(),
    channels: z
      .object({
        telegram: z
          .object({
            bot_token: z.string().min(1).optional(),
            webhook_secret: z.string().min(1).optional(),
            allowed_chats: z.array(z.string()).default([]),
            allow_all: z.boolean().optional(),
          })
          .optional(),
        slack: z
          .object({
            bot_token: z.string().min(1).optional(),
            signing_secret: z.string().min(1).optional(),
            allowed_channels: z.array(z.string()).default([]),
            allow_all: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    data_sources: z
      .array(z.object({ type: z.string().min(1), label: z.string().optional(), value: z.string().min(1) }))
      .nullable()
      .optional(),
    status: z.enum(['active', 'paused', 'disabled']).optional(),
  })
  .strict();

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(toPublicTenant(tenant));
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

  const patch = { ...parsed.data };

  // updateTenant REPLACES channels wholesale. The enrollment UI only sends the
  // changed list (e.g. telegram.allowed_chats), so MERGE into the stored
  // channels here — preserving the other platform's config and any per-tenant
  // bot token / signing secret that the redacted UI never sees.
  if (patch.channels) {
    const existing = await getTenant(id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const cur = existing.channels ?? {};
    patch.channels = {
      ...cur,
      ...(patch.channels.telegram
        ? { telegram: { ...cur.telegram, ...patch.channels.telegram } }
        : {}),
      ...(patch.channels.slack
        ? { slack: { ...cur.slack, ...patch.channels.slack } }
        : {}),
    };
  }

  const updated = await updateTenant(id, patch);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(toPublicTenant(updated));
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const ok = await deleteTenant(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
