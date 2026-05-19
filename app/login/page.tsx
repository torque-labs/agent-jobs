import { signInWithGoogle } from './actions';
import { isSupabaseConfigured } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';

type SearchParams = Promise<{ error?: string; next?: string }>;

const ERROR_COPY: Record<string, string> = {
  domain: 'Only @torque.so Google accounts are allowed.',
  oauth: 'Sign-in failed. Try again.',
  not_configured:
    'Google sign-in is not configured yet. Use basic auth or ask Sheldon to wire the Supabase env vars.',
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const configured = isSupabaseConfigured();

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
            AJ
          </div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Agent Jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your @torque.so Google account.
          </p>
        </div>

        {sp.error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {ERROR_COPY[sp.error] ?? 'Something went wrong.'}
          </div>
        )}

        <form action={signInWithGoogle}>
          <input type="hidden" name="next" value={sp.next ?? '/'} />
          <Button type="submit" className="w-full" disabled={!configured}>
            {configured ? 'Continue with Google' : 'Google sign-in not configured'}
          </Button>
        </form>

        {!configured && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Falling back to basic auth — the browser will prompt for credentials on protected pages.
          </p>
        )}
      </div>
    </div>
  );
}
