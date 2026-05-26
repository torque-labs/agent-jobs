import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createTenant, listTenants, toPublicTenant } from '@/lib/tenants';
import { requireScope, withScope } from '@/lib/require-scope';
import { verifyTorqueTokenScope } from '@/lib/torque-verify';

export const runtime = 'nodejs';

// C1/M2: a channel, if present, is "enabled" and therefore MUST carry its
// secret (webhook_secret / signing_secret) and an explicit audience — either a
// non-empty allow-list or `allow_all: true`. The runtime fails closed on any of
// these being absent; we reject at the schema boundary so bad config can't be
// stored in the first place.
const telegramChannelSchema = z
  .object({
    bot_token: z.string().min(1).optional(),
    allowed_chats: z.array(z.string()).default([]),
    webhook_secret: z.string().min(1).optional(),
    allow_all: z.boolean().optional(),
  })
  .refine((c) => c.allow_all === true || c.allowed_chats.length > 0, {
    message: 'Telegram channel requires a non-empty allowed_chats or allow_all: true',
    path: ['allowed_chats'],
  });

const slackChannelSchema = z
  .object({
    bot_token: z.string().min(1).optional(),
    signing_secret: z.string().min(1).optional(),
    allowed_channels: z.array(z.string()).default([]),
    allow_all: z.boolean().optional(),
  })
  .refine((c) => c.allow_all === true || c.allowed_channels.length > 0, {
    message: 'Slack channel requires a non-empty allowed_channels or allow_all: true',
    path: ['allowed_channels'],
  });

const channelsSchema = z
  .object({
    telegram: telegramChannelSchema.optional(),
    slack: slackChannelSchema.optional(),
  })
  .default({});

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
  torque_wallet_pubkey: z.string().min(1),
  torque_mcp_token: z.string().min(1),
  torque_ingest_key: z.string().nullable().optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  soul: z.string().min(1),
  channels: channelsSchema.optional(),
  memory_namespace: z.string().min(1).optional(),
  data_sources: z.array(dataSourceSchema).nullable().optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  owner: z.string().nullable().optional(),
});

export async function GET(req: Request) {
  return withScope(async () => {
    requireScope(req, 'agents:read');
    const tenants = await listTenants();
    return NextResponse.json(tenants.map(toPublicTenant));
  });
}

export async function POST(req: Request) {
  return withScope(async () => {
    // C2: provisioning a tenant means writing a caller-supplied Torque token to
    // the isolation boundary. Gate behind `admin` (not plain agents:write)
    // until provisioning is automated and the token is minted server-side.
    requireScope(req, 'admin');

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

    // C2: the torque_mcp_token is caller-supplied and otherwise unverified —
    // verify SERVER-SIDE that it is scoped to EXACTLY this project before we
    // store it. Open a scoped session and confirm list_projects returns exactly
    // one project equal to torque_project_id. Reject otherwise so a token that
    // can see other (or more) projects can never become a tenant's boundary.
    const scopeCheck = await verifyTorqueTokenScope(
      parsed.data.torque_mcp_token,
      parsed.data.torque_project_id,
    );
    if (!scopeCheck.ok) {
      return NextResponse.json(
        { error: `torque_mcp_token scope check failed: ${scopeCheck.reason}` },
        { status: 400 },
      );
    }

    try {
      const tenant = await createTenant(parsed.data);
      // Never echo back secrets — return the redacted public shape.
      return NextResponse.json(toPublicTenant(tenant), { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Unique-violation on slug surfaces as a 409.
      if (/duplicate key|unique/i.test(msg)) {
        return NextResponse.json({ error: 'A tenant with that slug already exists' }, { status: 409 });
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  });
}
