import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createTenant, listTenants, toPublicTenant } from '@/lib/tenants';
import { verifyTorqueTokenScope } from '@/lib/torque-verify';

export const runtime = 'nodejs';

/**
 * UI mirror of /api/v1/agents. Gated by Supabase session / basic auth via the
 * proxy — no Bearer key needed. Used by /settings/agents. Always returns the
 * redacted PublicTenant (toPublicTenant) — the scoped Torque token + channel
 * secrets are NEVER sent to the browser.
 */

const dataSourceSchema = z.object({
  type: z.string().min(1),
  label: z.string().optional(),
  value: z.string().min(1),
});

const createBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric/hyphen'),
  display_name: z.string().min(1).max(120),
  torque_project_id: z.string().min(1),
  torque_wallet_pubkey: z.string().min(1).optional(),
  torque_mcp_token: z.string().min(1),
  model: z.string().min(1).optional(),
  soul: z.string().min(1),
  data_sources: z.array(dataSourceSchema).nullable().optional(),
});

/** Best-effort extract the Torque userId from an MCP JWT (informational only). */
function jwtUserId(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json) as { userId?: string };
    return typeof obj.userId === 'string' ? obj.userId : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const tenants = await listTenants();
    return NextResponse.json(tenants.map(toPublicTenant));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Same isolation gate as /api/v1/agents: the caller-supplied token must be
  // scoped to EXACTLY this project before we persist it.
  const scope = await verifyTorqueTokenScope(body.torque_mcp_token, body.torque_project_id);
  if (!scope.ok) {
    return NextResponse.json(
      { error: `torque_mcp_token scope check failed: ${scope.reason}` },
      { status: 400 },
    );
  }

  try {
    const tenant = await createTenant({
      slug: body.slug,
      display_name: body.display_name,
      torque_project_id: body.torque_project_id,
      torque_wallet_pubkey:
        body.torque_wallet_pubkey?.trim() || jwtUserId(body.torque_mcp_token) || body.slug,
      torque_mcp_token: body.torque_mcp_token,
      model: body.model,
      soul: body.soul,
      data_sources: body.data_sources ?? null,
    });
    return NextResponse.json(toPublicTenant(tenant), { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
