import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteEntry, updateEntry } from '@/lib/tenant-knowledge';

export const runtime = 'nodejs';

const patchBody = z
  .object({ title: z.string().min(1).max(200).optional(), content: z.string().min(1).optional() })
  .strict();

type Ctx = { params: Promise<{ id: string; entryId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { entryId } = await params;
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
  const updated = await updateEntry(entryId, parsed.data);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { entryId } = await params;
  const ok = await deleteEntry(entryId);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
