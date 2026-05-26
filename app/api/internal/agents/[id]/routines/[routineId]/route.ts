import { NextResponse } from 'next/server';
import { z } from 'zod';
import { validate as validateCron } from 'node-cron';
import { deleteRoutine, getRoutine, updateRoutine } from '@/lib/tenant-routines';
import { reloadCronForRoutine } from '@/lib/cron';

export const runtime = 'nodejs';

const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    channel: z.enum(['telegram', 'slack']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

type Ctx = { params: Promise<{ id: string; routineId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { routineId } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.cron && !validateCron(parsed.data.cron)) {
    return NextResponse.json({ error: `Invalid cron expression: ${parsed.data.cron}` }, { status: 400 });
  }
  const updated = await updateRoutine(routineId, parsed.data);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await reloadCronForRoutine(routineId); // re-register (handles enable/disable/cron change)
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { routineId } = await params;
  const existing = await getRoutine(routineId);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await deleteRoutine(routineId);
  await reloadCronForRoutine(routineId); // routine gone → unregisters the handle
  return new NextResponse(null, { status: 204 });
}
