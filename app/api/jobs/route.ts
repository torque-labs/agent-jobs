import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { createJob, listJobs } from '@/lib/db';
import { registerCronForJob } from '@/lib/cron';

// postgres + node-cron are Node-only — pin this route to the Node runtime.
export const runtime = 'nodejs';

const stepSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  system_prompt: z.string(),
  user_template: z.string(),
  tools_allowed: z.array(z.string()).nullable(),
  retries: z.number().int().nonnegative().default(1),
  timeout_seconds: z.number().int().positive().default(600),
});

const createJobBodySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  cron: z.string().nullable().optional().default(null),
  enabled: z.boolean().optional().default(true),
  steps: z.array(stepSchema).min(1),
});

export async function GET() {
  try {
    const jobs = await listJobs();
    return NextResponse.json(jobs);
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

  const parsed = createJobBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // Validate cron expression if provided.
  if (body.cron) {
    try {
      CronExpressionParser.parse(body.cron);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Invalid cron expression: ${msg}` },
        { status: 400 },
      );
    }
  }

  // Enforce unique step names within the job.
  const stepNames = new Set<string>();
  for (const step of body.steps) {
    if (stepNames.has(step.name)) {
      return NextResponse.json(
        { error: `Duplicate step name "${step.name}" — step names must be unique within a job` },
        { status: 400 },
      );
    }
    stepNames.add(step.name);
  }

  try {
    const job = await createJob({
      id: body.id ?? randomUUID(),
      name: body.name,
      description: body.description,
      cron: body.cron,
      enabled: body.enabled,
      steps: body.steps,
    });

    // Register cron if the job is enabled and has a schedule. Failures are
    // logged but don't block job creation — the user can edit + re-register.
    if (job.enabled && job.cron) {
      try {
        registerCronForJob(job);
      } catch (err) {
        console.error(`[api/jobs] failed to register cron for ${job.id}:`, err);
      }
    }

    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
