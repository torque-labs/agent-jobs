import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createTemplate, listTemplates } from '@/lib/db';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const bodySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  account: z.string().optional().default(''),
  layout: z.enum(['report', 'daily']).optional().default('report'),
  recipe: z.object({ cells: z.array(z.object({ code: z.string() })).min(1), spec: z.record(z.string(), z.unknown()) }),
  fetch: z.object({ now_sql: z.string().optional(), prior_sql: z.string().optional(), signups_sql: z.string().optional() }).optional().default({}),
  prior_interval: z.string().optional().default('24 hours'),
  default_cron: z.string().nullable().optional().default(null),
  channel: z.string().optional().default('telegram'),
});

export async function GET(req: Request) {
  return withScope(async () => {
    requireScope(req, 'jobs:read');
    return NextResponse.json(await listTemplates());
  });
}

export async function POST(req: Request) {
  return withScope(async () => {
    requireScope(req, 'jobs:write');
    let raw: unknown;
    try { raw = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    const b = parsed.data;
    const id = b.id ?? `${slug(b.account) || 'tpl'}-${slug(b.name)}`;
    const tpl = await createTemplate({
      id, name: b.name, account: b.account, layout: b.layout,
      recipe: b.recipe as { cells: { code: string }[]; spec: Record<string, unknown> },
      fetch: b.fetch, prior_interval: b.prior_interval, default_cron: b.default_cron, channel: b.channel,
    });
    return NextResponse.json(tpl, { status: 201 });
  });
}
