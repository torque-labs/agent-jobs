import { NextResponse } from 'next/server';
import { getJob } from '@/lib/db';
import { startJobRun } from '@/lib/orchestrator';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Public manual-trigger endpoint. Returns the runId synchronously so the
 * caller can poll /api/v1/runs/:id; the orchestrator runs in the background.
 */
export async function POST(req: Request, ctx: RouteCtx) {
  return withScope(async () => {
    requireScope(req, 'runs:trigger');
    const { id } = await ctx.params;
    const job = await getJob(id);
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const runId = startJobRun(id, 'manual');
    return NextResponse.json({ ok: true, runId }, { status: 202 });
  });
}
