import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/db';
import type { Run } from '@/lib/types';

export const runtime = 'nodejs';

const VALID_STATUSES: ReadonlySet<Run['status']> = new Set([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const jobIdParam = url.searchParams.get('jobId') ?? undefined;
  const limitParam = url.searchParams.get('limit');

  if (statusParam && !VALID_STATUSES.has(statusParam as Run['status'])) {
    return NextResponse.json(
      {
        error: `Invalid status "${statusParam}". Allowed: ${[...VALID_STATUSES].join(', ')}`,
      },
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

  try {
    const runs = await listRuns({
      status: statusParam as Run['status'] | undefined,
      jobId: jobIdParam,
      limit,
    });
    return NextResponse.json(runs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
