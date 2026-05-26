import { NextResponse } from 'next/server';
import { deleteTenant, getTenant, toPublicTenant } from '@/lib/tenants';
import { requireScope, withScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  return withScope(async () => {
    requireScope(req, 'agents:read');
    const { id } = await params;
    const tenant = await getTenant(id);
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    return NextResponse.json(toPublicTenant(tenant));
  });
}

export async function DELETE(req: Request, { params }: Params) {
  return withScope(async () => {
    // C2: managing the tenant boundary (create/update/delete) is admin-gated
    // until provisioning is automated, consistent with POST /api/v1/agents.
    requireScope(req, 'admin');
    const { id } = await params;
    const ok = await deleteTenant(id);
    if (!ok) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}
