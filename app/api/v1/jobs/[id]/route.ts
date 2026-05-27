import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { deleteJob, getJob, updateJob } from '@/lib/db';
import { reloadCronForJob, unregisterCron } from '@/lib/cron';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const stepSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  system_prompt: z.string(),
  user_template: z.string(),
  tools_allowed: z.array(z.string()).nullable(),
  retries: z.number().int().nonnegative(),
  timeout_seconds: z.number().int().positive(),
  approval_required: z.boolean().optional(),
  use_feedback: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  cron: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).optional(),
});

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'jobs:read');
    const { id } = await ctx.params;
    const job = await getJob(id);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(job);
  });
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'jobs:write');
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const patch = parsed.data;

    if (patch.cron) {
      try {
        CronExpressionParser.parse(patch.cron);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { error: `Invalid cron expression: ${msg}` },
          { status: 400 },
        );
      }
    }

    if (patch.steps) {
      const seen = new Set<string>();
      for (const step of patch.steps) {
        if (seen.has(step.name)) {
          return NextResponse.json(
            { error: `Duplicate step name "${step.name}"` },
            { status: 400 },
          );
        }
        seen.add(step.name);
      }
    }

    const updated = await updateJob(id, patch);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    try {
      await reloadCronForJob(id);
    } catch (err) {
      console.error(`[api/v1/jobs/${id}] failed to reload cron:`, err);
    }

    return NextResponse.json(updated);
  });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'jobs:write');
    const { id } = await ctx.params;
    try {
      unregisterCron(id);
    } catch (err) {
      console.error(`[api/v1/jobs/${id}] failed to unregister cron:`, err);
    }
    const removed = await deleteJob(id);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  });
}
