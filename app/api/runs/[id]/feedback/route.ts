import { NextResponse } from 'next/server';
import { getRun } from '@/lib/db';
import {
  createFeedback,
  listFeedbackForRun,
} from '@/lib/feedback';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

const VALID_RATINGS = new Set(['good', 'bad', 'neutral']);

/**
 * Workstream G — per-run human feedback.
 *
 * POST body: { rating: 'good'|'bad'|'neutral', comment?: string }
 * GET response: RunFeedback[] for this run.
 *
 * Auth: covered by the global middleware basic-auth. We don't gate on a
 * scope here since feedback is operator-driven and the UI uses the same
 * basic-auth cookie. Public-API agents wanting feedback can build a v1 route.
 */

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  try {
    const items = await listFeedbackForRun(id);
    return NextResponse.json(items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: { rating?: string; comment?: string; createdBy?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.rating || !VALID_RATINGS.has(body.rating)) {
    return NextResponse.json(
      { error: `rating must be one of: ${[...VALID_RATINGS].join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    const fb = await createFeedback({
      runId: id,
      jobId: run.job_id,
      rating: body.rating as 'good' | 'bad' | 'neutral',
      comment: body.comment ?? '',
      createdBy: body.createdBy ?? null,
    });
    return NextResponse.json(fb, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
