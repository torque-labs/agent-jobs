import { NextResponse } from 'next/server';
import { approveRun } from '@/lib/approval';
import { resumeJob } from '@/lib/orchestrator';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Workstream H — approve a run that is awaiting_approval.
 *
 * Body (optional): { edit?: string }  → overrides the paused step's output.
 *
 * Flow: approveRun writes any edit back to the step row + clears
 * pending_approval + flips status to 'running'. We then kick resumeJob in the
 * background — same fire-and-forget pattern as POST /api/jobs/:id/run, since
 * downstream steps can take minutes.
 */
export async function POST(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: { edit?: string } = {};
  if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // Empty body is fine; bad JSON we report.
      const text = await req.text().catch(() => '');
      if (text.trim().length > 0) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
    }
  }

  try {
    const updated = await approveRun(id, body.edit);
    if (!updated) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // Only kick the resume loop if we actually transitioned (status === 'running').
    // If the run wasn't awaiting_approval, approveRun returns the existing row
    // unchanged and we just acknowledge.
    if (updated.status === 'running') {
      void resumeJob(id).catch((err) => {
        console.error(`[api/runs/${id}/approve] resumeJob escaped:`, err);
      });
    }
    return NextResponse.json(updated, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
