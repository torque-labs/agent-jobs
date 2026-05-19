import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiKey, listApiKeys } from '@/lib/api-keys';
import { ALL_SCOPES, isValidScope } from '@/lib/scopes';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * UI-only mirror of /api/v1/keys. Gated by Supabase session OR basic auth
 * (whichever the request used to reach the proxy — middleware lets it through).
 * We tag `created_by` with the Supabase user email when available, otherwise
 * 'basic-auth'.
 */

const createBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).min(1),
});

async function getActor(): Promise<string> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return 'basic-auth';
  const { data: { user } } = await supabase.auth.getUser();
  return user?.email ?? 'basic-auth';
}

export async function GET() {
  try {
    const keys = await listApiKeys();
    return NextResponse.json(keys);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
      { error: `Unknown scope(s): ${bad.join(', ')}`, allowed: ALL_SCOPES },
      { status: 400 },
    );
  }
  try {
    const actor = await getActor();
    const created = await createApiKey(parsed.data.name, parsed.data.scopes, actor);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
