'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = String(formData.get('next') ?? '/');
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    // Supabase not configured yet — bounce back to /login with an explanatory
    // banner. The basic-auth fallback is the only path until env vars land.
    redirect('/login?error=not_configured');
  }

  const h = await headers();
  // Traefik proxies the request; the bare `host` header is the internal
  // container hostname (0.0.0.0:3000). The public host comes through
  // `x-forwarded-host`.
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const protocol =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('0.0.0.0') ? 'http' : 'https');
  const origin = `${protocol}://${host}`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      // Hint Google's account picker to the torque.so workspace.
      queryParams: { hd: 'torque.so', prompt: 'select_account' },
    },
  });

  if (error) throw error;
  if (data?.url) redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  redirect('/login');
}
