import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiKey, listApiKeys } from '@/lib/api-keys';
import { ALL_SCOPES, isValidScope } from '@/lib/scopes';
import { withScope, requireScope } from '@/lib/require-scope';

export const runtime = 'nodejs';

const createBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).min(1),
});

export async function GET(req: Request) {
  return withScope(async () => {
    requireScope(req, 'keys:admin');
    const keys = await listApiKeys();
    return NextResponse.json(keys);
  });
}

export async function POST(req: Request) {
  return withScope(async () => {
    requireScope(req, 'keys:admin');
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = createBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const bad = parsed.data.scopes.filter((s) => !isValidScope(s));
    if (bad.length > 0) {
      return NextResponse.json(
        {
          error: `Unknown scope(s): ${bad.join(', ')}`,
          allowed: ALL_SCOPES,
        },
        { status: 400 },
      );
    }
    const creator = req.headers.get('x-api-key-id') ?? 'api';
    const created = await createApiKey(parsed.data.name, parsed.data.scopes, creator);
    // First-and-only-time the plain key is returned.
    return NextResponse.json(created, { status: 201 });
  });
}
