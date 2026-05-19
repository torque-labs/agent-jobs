import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWebhook, listWebhooks } from '@/lib/db';
import { WEBHOOK_EVENTS } from '@/lib/events';

export const runtime = 'nodejs';

/**
 * UI mirror of /api/v1/webhooks. Gated by Supabase session / basic auth via
 * the proxy — no Bearer key needed. Used by /settings/webhooks.
 */

const VALID_EVENTS = new Set<string>(WEBHOOK_EVENTS);

const createBody = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  enabled: z.boolean().optional().default(true),
});

export async function GET() {
  try {
    const hooks = await listWebhooks();
    // Strip secret on list.
    return NextResponse.json(hooks.map(({ secret: _s, ...rest }) => rest));
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
  const bad = body.events.filter((e) => !VALID_EVENTS.has(e));
  if (bad.length > 0) {
    return NextResponse.json(
      { error: `Unknown event(s): ${bad.join(', ')}`, allowed: [...WEBHOOK_EVENTS] },
      { status: 400 },
    );
  }
  try {
    const secret = randomBytes(32).toString('hex');
    const hook = await createWebhook({
      id: randomUUID(),
      name: body.name,
      url: body.url,
      events: [...new Set(body.events)],
      secret,
      enabled: body.enabled,
    });
    return NextResponse.json(hook, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
