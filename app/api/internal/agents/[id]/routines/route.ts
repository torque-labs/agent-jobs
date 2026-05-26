import { NextResponse } from 'next/server';
import { z } from 'zod';
import { validate as validateCron } from 'node-cron';
import { getTenant } from '@/lib/tenants';
import { createRoutine, listRoutinesForTenant } from '@/lib/tenant-routines';
import { reloadCronForRoutine } from '@/lib/cron';

export const runtime = 'nodejs';

const createBody = z.object({
  name: z.string().min(1).max(120),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  channel: z.enum(['telegram', 'slack']),
  enabled: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const routines = await listRoutinesForTenant(id);
  return NextResponse.json(routines);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  }
  if (!validateCron(parsed.data.cron)) {
    return NextResponse.json({ error: `Invalid cron expression: ${parsed.data.cron}` }, { status: 400 });
  }

  const routine = await createRoutine({ tenant_id: id, ...parsed.data });
  await reloadCronForRoutine(routine.id); // register the schedule now
  return NextResponse.json(routine, { status: 201 });
}
