import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_DOMAIN = 'torque.so';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  // Build the PUBLIC origin from x-forwarded-* headers; `request.url`'s
  // origin is the internal container address (0.0.0.0:3000) behind Traefik.
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  const protocol =
    request.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('0.0.0.0') ? 'http' : 'https');
  const origin = `${protocol}://${host}`;

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/login?error=not_configured`);
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  if (!data.user.email?.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  const safeNext = next.startsWith('/') ? next : '/';
  return NextResponse.redirect(`${origin}${safeNext}`);
}
