import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifyApiKey } from '@/lib/api-keys';

/**
 * Request gate. Next 16 calls this "proxy" (formerly `middleware.ts`). Runs in
 * the Node.js runtime — `lib/api-keys.ts` uses the postgres client and
 * `node:crypto`, both of which need Node.
 *
 * Three layers, tried in order:
 *   1. `/api/v1/*` — Bearer API key. We only verify the key + forward scopes
 *      via the `x-api-scopes` header; each route enforces the specific scope
 *      it requires via `lib/require-scope.ts`. No session fallback.
 *   2. Supabase session (Google @torque.so OAuth). For browser routes + the
 *      internal `/api/*` (non-v1) routes.
 *   3. Basic auth fallback when `ALLOW_BASIC_AUTH=true` — keeps the existing
 *      curl/browser flows working while Supabase is being wired up.
 *
 * Skipped: PUBLIC_PATHS, PUBLIC_PREFIXES.
 */

const ALLOWED_DOMAIN = 'torque.so';
const PUBLIC_PATHS = new Set<string>(['/login']);
const PUBLIC_PREFIXES = [
  '/auth/',
  '/api/healthcheck',
  // Workstream E — inbound job triggers: the path token IS the credential.
  '/api/v1/triggers/',
];

function jsonError(message: string, status: number): NextResponse {
  return new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function tryBasicAuth(req: NextRequest): boolean {
  if (process.env.ALLOW_BASIC_AUTH !== 'true') return false;
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = atob(header.slice('Basic '.length).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  const provided = idx >= 0 ? decoded.slice(idx + 1) : decoded;
  return timingSafeEqual(provided, expected);
}

function basicAuthChallenge(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="agent-jobs", charset="UTF-8"' },
  });
}

function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

async function trySupabaseSession(
  req: NextRequest,
): Promise<{ ok: true; response: NextResponse } | { ok: false; signOut?: boolean }> {
  if (!isSupabaseConfigured()) return { ok: false };
  let response = NextResponse.next({ request: req });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          response = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false };
  if (!user.email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`)) {
    await supabase.auth.signOut();
    return { ok: false, signOut: true };
  }
  return { ok: true, response };
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always-open routes (healthcheck, login, oauth callback).
  if (isPublic(pathname)) return NextResponse.next();

  // ---- 1. Bearer API key for /api/v1/* ----
  if (pathname.startsWith('/api/v1/')) {
    const header = req.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      return jsonError('Missing Bearer API key', 401);
    }
    const token = header.slice('Bearer '.length).trim();
    let verified: { id: string; scopes: string[] } | null = null;
    try {
      verified = await verifyApiKey(token);
    } catch (err) {
      console.error('[proxy] verifyApiKey failed:', err);
      return jsonError('Internal auth error', 500);
    }
    if (!verified) return jsonError('Invalid or revoked API key', 401);

    // Forward scopes + key id so route handlers can enforce the per-route
    // scope via lib/require-scope.ts.
    const headers = new Headers(req.headers);
    headers.set('x-api-scopes', verified.scopes.join(','));
    headers.set('x-api-key-id', verified.id);
    return NextResponse.next({ request: { headers } });
  }

  // ---- 2. Supabase session (browser + non-v1 API) ----
  const sessionResult = await trySupabaseSession(req);
  if (sessionResult.ok) return sessionResult.response;

  // ---- 3. Basic auth fallback ----
  if (tryBasicAuth(req)) return NextResponse.next();

  // No auth — branch on browser vs API.
  if (pathname.startsWith('/api/')) {
    if (!isSupabaseConfigured() && process.env.ALLOW_BASIC_AUTH === 'true') {
      return basicAuthChallenge();
    }
    return jsonError('Unauthorized', 401);
  }
  if (isSupabaseConfigured()) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (process.env.ALLOW_BASIC_AUTH === 'true') {
    return basicAuthChallenge();
  }
  return jsonError('Unauthorized', 401);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
