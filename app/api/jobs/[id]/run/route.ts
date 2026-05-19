import { NextResponse } from 'next/server';
import { startJobRun } from '@/lib/orchestrator';
import { getJob } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Manual job-trigger endpoint. Mints a runId synchronously (via
 * orchestrator.startJobRun) so the UI can redirect to /runs/:id immediately
 * without polling /api/runs?jobId=… to discover the row.
 */
type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;

  try {
    const job = await getJob(id);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const runId = startJobRun(id, 'manual');
  return NextResponse.json({ ok: true, runId }, { status: 202 });
}
