import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteTenant, getTenant, toPublicTenant, updateTenant } from '@/lib/tenants';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  return withScope(async () => {
    requireScope(req, 'agents:read');
    const { id } = await params;
    const tenant = await getTenant(id);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    return NextResponse.json(toPublicTenant(tenant));
  });
}

export async function DELETE(req: Request, { params }: Params) {
  return withScope(async () => {
    // C2: managing the tenant boundary (create/update/delete) is admin-gated
    // until provisioning is automated, consistent with POST /api/v1/agents.
    requireScope(req, 'admin');
    const { id } = await params;
    const ok = await deleteTenant(id);
    if (!ok) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}


// Partial update — admin only, same as create/delete (C2: managing the tenant
// boundary). Used to ENROLL a customer's Telegram chat id (shared-bot mode) and
// to tweak model/soul/status/data_sources without recreating the tenant. The
// torque_mcp_token / torque_project_id (the isolation boundary) are NOT
// patchable here — changing them requires re-verification, so delete+recreate.
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

export async function PATCH(req: Request, { params }: Params) {
  return withScope(async () => {
    requireScope(req, 'admin');
    const { id } = await params;
    const existing = await getTenant(id);
    if (!existing) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

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

    const updated = await updateTenant(id, parsed.data);
    if (!updated) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    return NextResponse.json(toPublicTenant(updated));
  });
}
