import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { getTemplate } from '@/lib/db';
import { createJobFromTemplate } from '@/lib/templates';
import { registerCronForJob } from '@/lib/cron';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const bodySchema = z.object({
  cron: z.string().nullable().optional(),
  channel: z.string().optional(),
  enabled: z.boolean().optional(),
  name: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withScope(async () => {
    requireScope(req, 'jobs:write');
    const { id } = await params;
    const tpl = await getTemplate(id);
    if (!tpl) return NextResponse.json({ error: 'template not found' }, { status: 404 });

    let raw: unknown = {};
    try { raw = await req.json(); } catch { /* empty body ok */ }
    const parsed = bodySchema.safeParse(raw ?? {});
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
    const opts = parsed.data;

    const cron = opts.cron ?? tpl.default_cron ?? null;
    if (cron) {
      try { CronExpressionParser.parse(cron); }
      catch (err) { return NextResponse.json({ error: `Invalid cron: ${err instanceof Error ? err.message : String(err)}` }, { status: 400 }); }
    }

    const job = await createJobFromTemplate(tpl, { cron, channel: opts.channel, enabled: opts.enabled, name: opts.name });
    if (job.enabled && job.cron) {
      try { registerCronForJob(job); } catch (err) { console.error('[templates/create-job] cron register failed:', err); }
    }
    return NextResponse.json(job, { status: 201 });
  });
}
