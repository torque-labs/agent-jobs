import { NextResponse } from 'next/server';
import { getTemplate } from '@/lib/db';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withScope(async () => {
    requireScope(req, 'jobs:read');
    const { id } = await params;
    const tpl = await getTemplate(id);
    if (!tpl) return NextResponse.json({ error: 'template not found' }, { status: 404 });
    return NextResponse.json(tpl);
  });
}
