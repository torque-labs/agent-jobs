import { NextResponse } from 'next/server';
import { getJobByTriggerToken } from '@/lib/db';
import { startJobRun } from '@/lib/orchestrator';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ token: string }> };

/**
 * Workstream E — inbound trigger endpoint.
 *
 * The path token IS the auth credential (proxy.ts skips Bearer for this
 * prefix). We look up the job by token, 404 if not found or trigger is
 * disabled, read the request body, and kick off `executeJob` in the
 * background with the body + headers threaded into the templating context.
 *
 * Returns `{ ok: true, run_id }` immediately with HTTP 202 so callers don't
 * block on the full run duration.
 */
export async function POST(req: Request, ctx: RouteCtx) {
  const { token } = await ctx.params;
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  let job;
  try {
    job = await getJobByTriggerToken(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[triggers] getJobByTriggerToken failed:', msg);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!job || !job.trigger_enabled) {
    // Same 404 in both cases — don't leak whether the token exists but the
    // trigger is just disabled.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Read body as text first; try to parse JSON when the Content-Type says so
  // (or when parsing happens to succeed).
  const rawBody = await req.text().catch(() => '');
  let body: unknown = null;
  const contentType = req.headers.get('content-type') ?? '';
  if (rawBody.length > 0) {
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Leave body as null but keep rawBody for {{trigger.body}} access.
        body = null;
      }
    } else {
      // Best-effort JSON parse even without the header.
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }
  }

  // Lowercase header keys so `{{trigger.headers.x-custom}}` is consistent.
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const runId = startJobRun(job.id, 'trigger', {
    triggerBody: body,
    triggerRawBody: rawBody,
    triggerHeaders: headers,
  });

  return NextResponse.json({ ok: true, run_id: runId }, { status: 202 });
}
