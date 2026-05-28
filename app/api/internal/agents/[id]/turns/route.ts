/**
 * GET /api/internal/agents/[id]/turns — list recent turn traces for a tenant.
 *
 * Session-gated via the proxy (Supabase OAuth @torque.so / basic-auth fallback);
 * never exposes traces to the public. Returns JSON suitable for an eval
 * dashboard or one-off offline analysis.
 *
 * Query params:
 *   limit=50         (1..500)
 *   since=ISO        return turns started_at >= since
 *   status=ok|failed|timeout
 *   rendered=render_card|render_chart|render_holder_card|none
 *     (none = picked_render_tool IS NULL — i.e. text-only replies)
 */
import { NextResponse } from 'next/server';
import { getTenant } from '@/lib/tenants';
import { listTraces, type TraceListFilters } from '@/lib/turn-traces';

export const runtime = 'nodejs';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteCtx) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 50;

  const filters: TraceListFilters = {};
  const since = url.searchParams.get('since');
  if (since) {
    const d = new Date(since);
    if (Number.isFinite(d.getTime())) filters.since = d.toISOString();
  }
  const status = url.searchParams.get('status');
  if (status === 'ok' || status === 'failed' || status === 'timeout') filters.status = status;
  const rendered = url.searchParams.get('rendered');
  if (rendered !== null) {
    filters.rendered = rendered === 'none' || rendered === '' ? null : rendered;
  }

  try {
    const traces = await listTraces(tenant.id, limit, filters);
    return NextResponse.json({
      tenant: { id: tenant.id, slug: tenant.slug },
      count: traces.length,
      filters,
      traces,
    });
  } catch (err) {
    console.error(
      `[api/internal/turns] listTraces failed for ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`,
    );
    return NextResponse.json({ error: 'failed to load traces' }, { status: 500 });
  }
}
