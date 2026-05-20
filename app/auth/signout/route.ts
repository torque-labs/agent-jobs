import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  const protocol =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('0.0.0.0') ? 'http' : 'https');
  return NextResponse.redirect(`${protocol}://${host}/login`, { status: 303 });
}

export async function GET(request: Request) {
  // Convenience for nav links — same behaviour.
  return POST(request);
}
