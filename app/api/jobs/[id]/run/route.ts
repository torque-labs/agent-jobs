import { NextResponse } from 'next/server';
import { executeJob } from '@/lib/orchestrator';
import { getJob } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Manual job-trigger endpoint.
 *
 * Design tension: the orchestrator's `executeJob` creates the Run row
 * internally and only resolves after all steps complete. We don't want to
 * block the HTTP response for the full run duration, AND we don't have a
 * public signature that hands back the runId before the work completes.
 *
 * v1 approach (documented): fire-and-forget. We do a fast existence check on
 * the job (so callers get a 404 immediately if the id is bad), then kick off
 * `executeJob` via `void` with a `.catch` to swallow any escaped error, and
 * return `{ ok: true }` immediately. The UI then polls `/api/runs?jobId=...`
 * to discover the newly-created run row (the orchestrator persists 'running'
 * before doing any model work, so it appears within milliseconds).
 *
 * Follow-up: ask Agent A to add an `executeJobByRunId(jobId, runId, triggeredBy)`
 * variant so this route can mint a UUID, return it synchronously, and
 * background the work.
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

  // Fire and forget. executeJob never throws (it catches internally), but we
  // belt-and-suspenders this with a .catch so an unexpected rejection can't
  // become an unhandled rejection and tear down the process.
  void executeJob(id, 'manual').catch((err) => {
    console.error(`[api/jobs/${id}/run] executeJob escaped:`, err);
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
