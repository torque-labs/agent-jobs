import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/db';
import type { Run } from '@/lib/types';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const VALID_STATUSES: ReadonlySet<Run['status']> = new Set([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

/**
 * GET /api/v1/runs?status=&job_id=&since=&limit=
 *
 * `since` (ISO timestamp) filters to runs with created_at > since. Implemented
 * post-query against listRuns so we don't have to widen the db helper API.
 * Acceptable since the DB query is already bounded by limit (default 100).
 */
export async function GET(req: Request) {
  return withScope(async () => {
    requireScope(req, 'runs:read');
    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status') ?? undefined;
    const jobIdParam = url.searchParams.get('job_id') ?? url.searchParams.get('jobId') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const sinceParam = url.searchParams.get('since');

    if (statusParam && !VALID_STATUSES.has(statusParam as Run['status'])) {
      return NextResponse.json(
        { error: `Invalid status "${statusParam}". Allowed: ${[...VALID_STATUSES].join(', ')}` },
        { status: 400 },
      );
    }

    let limit: number | undefined;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        return NextResponse.json(
          { error: 'limit must be a positive integer <= 1000' },
          { status: 400 },
        );
      }
      limit = Math.floor(n);
    }

    let sinceDate: Date | null = null;
    if (sinceParam) {
      const d = new Date(sinceParam);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json(
          { error: 'since must be an ISO 8601 timestamp' },
          { status: 400 },
        );
      }
      sinceDate = d;
    }

    let runs = await listRuns({
      status: statusParam as Run['status'] | undefined,
      jobId: jobIdParam,
      limit,
    });
    if (sinceDate) {
      const sinceMs = sinceDate.getTime();
      runs = runs.filter((r) => new Date(r.created_at).getTime() > sinceMs);
    }
    return NextResponse.json(runs);
  });
}
