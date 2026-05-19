import { NextResponse, type NextRequest } from 'next/server';

/**
 * Simple basic-auth gate on the whole app. Configured by APP_PASSWORD env.
 * If the env var is unset we bypass entirely (local dev). Healthcheck is
 * always exempt so liveness probes don't need credentials.
 *
 * Username portion is ignored — the password is the only secret. Any value
 * for username is accepted (browsers will prompt for one).
 */
const PUBLIC_PATHS = new Set<string>([
  '/api/healthcheck',
]);

export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    // No password configured — open access (local dev default).
    return NextResponse.next();
  }

  const pathname = req.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const header = req.headers.get('authorization');
  if (header && header.startsWith('Basic ')) {
    const encoded = header.slice('Basic '.length).trim();
    let decoded = '';
    try {
      decoded = atob(encoded);
    } catch {
      decoded = '';
    }
    const idx = decoded.indexOf(':');
    const providedPassword = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    if (timingSafeEqual(providedPassword, password)) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="agent-jobs", charset="UTF-8"',
    },
  });
}

/**
 * Constant-time string compare. The Edge runtime doesn't have node:crypto,
 * so we hand-roll it. Returns false immediately on length mismatch (length
 * itself is not a secret here — we're guarding against per-character timing
 * leaks on the password value).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export const config = {
  // Run on everything except Next internals and static assets. We still need
  // the middleware to run on /api/* so API endpoints are gated too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
