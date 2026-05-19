import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { getJob, updateJob } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Manage a job's inbound trigger token.
 *
 * Internal (non-v1) route — gated by the proxy's Supabase session / basic
 * auth, not the API key system. Used by the trigger section in /jobs/[id].
 *
 * POST   → mint token if missing, return current { token, enabled }.
 * PATCH  → { enabled?, rotate? } — set enabled + optionally rotate the token.
 * DELETE → clear token + disable.
 */
type RouteCtx = { params: Promise<{ id: string }> };

function mintToken(): string {
  // URL-safe-ish: hex is plenty unique and the proxy doesn't care.
  return randomBytes(24).toString('hex');
}

const patchBody = z.object({
  enabled: z.boolean().optional(),
  rotate: z.boolean().optional(),
});

export async function POST(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (job.trigger_token) {
    return NextResponse.json({
      token: job.trigger_token,
      enabled: job.trigger_enabled,
    });
  }
  const token = mintToken();
  const updated = await updateJob(id, { trigger_token: token, trigger_enabled: true });
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    token: updated.trigger_token,
    enabled: updated.trigger_enabled,
  }, { status: 201 });
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

  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const patch: Parameters<typeof updateJob>[1] = {};
  if (parsed.data.rotate || (parsed.data.enabled && !job.trigger_token)) {
    patch.trigger_token = mintToken();
  }
  if (parsed.data.enabled !== undefined) {
    patch.trigger_enabled = parsed.data.enabled;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({
      token: job.trigger_token,
      enabled: job.trigger_enabled,
    });
  }
  const updated = await updateJob(id, patch);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    token: updated.trigger_token,
    enabled: updated.trigger_enabled,
  });
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const updated = await updateJob(id, { trigger_token: null, trigger_enabled: false });
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({
    token: updated.trigger_token,
    enabled: updated.trigger_enabled,
  });
}
