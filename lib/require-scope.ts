/**
 * Middleware (lib/api-keys.ts owner) is responsible for translating
 * `Authorization: Bearer ak_live_...` into a comma-separated `x-api-scopes`
 * request header before the request reaches a /api/v1/* route handler.
 *
 * Route handlers call `requireScope(req, 'jobs:read')` (etc.) at the top of
 * each method. The helper throws a `Response` (NOT a plain Error) when the
 * caller lacks the scope — handlers wrap their body in try/catch and re-emit
 * any thrown Response. We use `throw new Response(...)` instead of returning
 * to keep call sites a one-liner.
 *
 * Special scope: `admin` implicitly satisfies any required scope.
 */
export function requireScope(req: Request, scope: string): void {
  const header = req.headers.get('x-api-scopes') ?? '';
  const scopes = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.includes('admin') || scopes.includes(scope)) {
    return;
  }
  throw new Response(`Forbidden: requires scope ${scope}`, { status: 403 });
}

/**
 * Wrap a route handler body so a thrown `Response` (from requireScope) is
 * returned as-is. Any other throw becomes a 500 JSON response.
 */
export async function withScope(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
