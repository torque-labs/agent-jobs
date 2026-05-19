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
  const host = h.get('host') ?? 'localhost:3000';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
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
