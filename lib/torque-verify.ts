/**
 * Server-side verification that a caller-supplied Torque MCP token is scoped to
 * EXACTLY one project — the one the tenant claims (C2).
 *
 * The `torque_mcp_token` is the entire isolation boundary for a tenant: it is
 * the only credential the per-turn Torque subprocess gets, so whatever projects
 * that token's wallet-user administers are exactly what the agent can read. If
 * a caller hands us a broadly-scoped token (one that can see other customers'
 * projects, or more than one project), storing it would silently break tenant
 * isolation. So before we persist it we open a scoped session and confirm
 * `list_projects` returns exactly one project, equal to `torque_project_id`.
 *
 * We reuse `openTenantTorqueSession` (the same code path the runtime uses) so
 * the verification credential and the live credential are wired identically.
 */
import { openTenantTorqueSession } from './mcp';

export type ScopeCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Extract Torque project ids from whatever `list_projects` returned. The MCP
 * normalizes tool output to a string; the body is JSON in practice but its
 * exact shape (array of objects, `{ projects: [...] }`, etc.) is not contract,
 * so we walk the parsed value and collect every plausible project id.
 */
function extractProjectIds(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      // A project object exposes its id as `id` or `projectId`.
      for (const key of ['id', 'projectId', 'project_id']) {
        const v = obj[key];
        if (typeof v === 'string' && v.length > 0) ids.add(v);
      }
      // Recurse into common containers (projects, data, result, etc.).
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') visit(v);
      }
    }
  };
  visit(parsed);
  return [...ids];
}

/**
 * Verify `token` is scoped to exactly `expectedProjectId`. Opens an ephemeral
 * scoped Torque session (always torn down) and inspects `list_projects`.
 */
export async function verifyTorqueTokenScope(
  token: string,
  expectedProjectId: string,
): Promise<ScopeCheckResult> {
  let session: Awaited<ReturnType<typeof openTenantTorqueSession>>;
  try {
    session = await openTenantTorqueSession(token);
  } catch {
    // Redacted (owner preference): don't surface the provider error body.
    return { ok: false, reason: 'could not open a scoped Torque session with the supplied token' };
  }
  try {
    if (!session.tools.some((t) => t.toolName === 'list_projects')) {
      return { ok: false, reason: 'token cannot list projects (list_projects unavailable)' };
    }
    const body = await session.call('list_projects', {});
    const ids = extractProjectIds(body);
    if (ids.length === 0) {
      return { ok: false, reason: 'token administers no projects' };
    }
    if (ids.length > 1) {
      return {
        ok: false,
        reason: `token is scoped to ${ids.length} projects; it must be scoped to exactly one`,
      };
    }
    if (ids[0] !== expectedProjectId) {
      return {
        ok: false,
        reason: 'token is scoped to a different project than torque_project_id',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'list_projects call failed for the supplied token' };
  } finally {
    await session.close();
  }
}
