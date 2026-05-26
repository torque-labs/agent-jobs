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

// A Torque project id is a cuid (`c` + lowercased alphanumerics, ~25 chars).
// Used to pull ids out of the markdown table the MCP now renders.
const PROJECT_ID_RE = /(?<![A-Za-z0-9])c[a-z0-9]{20,32}(?![A-Za-z0-9])/g;

/**
 * Extract Torque project ids from whatever `list_projects` returned. The MCP
 * does NOT guarantee a stable shape: older builds returned JSON, current ones
 * (@torque-labs/mcp >=0.4.8) return a human-readable markdown table as text
 * (e.g. `| **$TRUMP** | \`cmo7...\` |`). We must handle both, and we must fail
 * CLOSED — under-counting a multi-project token to one id would silently break
 * isolation, so we collect ids from BOTH a JSON walk and a raw-text id scan and
 * union them (over-counting only makes the scope check stricter / safer).
 */
function extractProjectIds(body: string): string[] {
  const ids = new Set<string>();

  // Path 1: structured JSON (forward/back compat with array or {projects:[…]}).
  try {
    const parsed: unknown = JSON.parse(body);
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        for (const key of ['id', 'projectId', 'project_id']) {
          const v = obj[key];
          if (typeof v === 'string' && v.length > 0) ids.add(v);
        }
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') visit(v);
        }
      }
    };
    visit(parsed);
  } catch {
    // Not JSON — fall through to the text scan below.
  }

  // Path 2: raw text / markdown — the table renders each project's id verbatim.
  // The preamble and headers contain no cuid-shaped tokens, so this matches
  // exactly the project ids (one per row).
  for (const m of body.matchAll(PROJECT_ID_RE)) ids.add(m[0]);

  return [...ids];
}

/**
 * Independent upper-bound on how many projects `list_projects` describes, used
 * to fail CLOSED even if the id scan under-counts (e.g. a row truncated or
 * rendered in an unexpected charset). We do NOT trust the id count alone: a
 * multi-project token whose extra rows the regex missed would otherwise pass.
 * Returns the max of two signals (0 if neither is present):
 *  - the count the MCP itself declares, e.g. "**Your Projects** (3)";
 *  - the number of distinct text lines that carry a project-id-shaped token.
 * A correctly-scoped token must yield exactly one project, so the caller
 * rejects anything > 1.
 */
function countProjectsDescribed(body: string): number {
  let declared = 0;
  const m = body.match(/projects?\**\s*\((\d+)\)/i);
  if (m) declared = Number(m[1]);
  let idRows = 0;
  const rowRe = /(?<![A-Za-z0-9])c[a-z0-9]{20,32}(?![A-Za-z0-9])/;
  for (const line of body.split('\n')) if (rowRe.test(line)) idRows += 1;
  return Math.max(declared, idRows);
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
    // Fail closed against id-scan under-counting: if the response independently
    // describes more than one project (declared count or multiple id-bearing
    // rows), reject even though only one id was extracted.
    const described = countProjectsDescribed(body);
    if (described > 1) {
      return {
        ok: false,
        reason: `list_projects describes ${described} projects; token must be scoped to exactly one`,
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
