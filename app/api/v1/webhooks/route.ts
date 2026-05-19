import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWebhook, listWebhooks } from '@/lib/db';
import { WEBHOOK_EVENTS } from '@/lib/events';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const VALID_EVENTS = new Set<string>(WEBHOOK_EVENTS);

const createBody = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  enabled: z.boolean().optional().default(true),
});

export async function GET(req: Request) {
  return withScope(async () => {
    requireScope(req, 'webhooks:admin');
    const hooks = await listWebhooks();
    // Strip the secret on list — secret is only ever returned once at create.
    return NextResponse.json(hooks.map(({ secret: _s, ...rest }) => rest));
  });
}

export async function POST(req: Request) {
  return withScope(async () => {
    requireScope(req, 'webhooks:admin');

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

    const badEvents = body.events.filter((e) => !VALID_EVENTS.has(e));
    if (badEvents.length > 0) {
      return NextResponse.json(
        {
          error: `Unknown event(s): ${badEvents.join(', ')}`,
          allowed: [...WEBHOOK_EVENTS],
        },
        { status: 400 },
      );
    }

    // Dedup events while preserving order.
    const events = [...new Set(body.events)];

    // 32 bytes (256 bits) of secret material, hex-encoded.
    const secret = randomBytes(32).toString('hex');

    const hook = await createWebhook({
      id: randomUUID(),
      name: body.name,
      url: body.url,
      events,
      secret,
      enabled: body.enabled,
    });

    // Show the secret exactly once. Subsequent GETs strip it.
    return NextResponse.json(hook, { status: 201 });
  });
}
