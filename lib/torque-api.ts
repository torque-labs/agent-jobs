/**
 * Direct (non-MCP) reads against the Torque server REST API, authenticated with
 * a tenant's scoped Torque token. Used for data the @torque-labs/mcp tools
 * can't return correctly — currently the epoch leaderboard, whose MCP tool
 * (get_epoch_leaderboard, preview mode) calls the wrong API variant
 * (latest-eval-results?limit=50&offset=0 → empty wallets + a response the
 * tool's own zod rejects: "lastUpdated: Expected date, received string").
 *
 * The CORRECT request is `...latest-eval-results?limit=N&fullQueryResults=true`,
 * which returns populated rows in data.results[].row. We call it directly with
 * the tenant's scoped Bearer token — isolation is preserved because the URL is
 * built from the tenant's OWN projectId and the token only authorizes that
 * project, so a stray recurringOfferId can't reach another customer's data.
 */
const TORQUE_SERVER_BASE = 'https://server.torque.so';

type LeaderboardRow = {
  owner?: string;
  username?: string;
  days_held?: number;
  balance_days?: number;
  latest_balance?: number;
  direct_score?: number;
  score?: number;
  metricValue?: number;
};

function shortAddr(a?: string): string {
  if (!a || a.length < 12) return a || '—';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
function fmtNum(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Fetch + format the live leaderboard for one recurring incentive. Returns a
 * compact text block for the model to re-present. Never throws — returns a
 * friendly string on any failure.
 */
export async function fetchLeaderboard(
  token: string,
  projectId: string,
  recurringOfferId: string,
  limit = 50,
): Promise<string> {
  const n = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const url =
    `${TORQUE_SERVER_BASE}/project/${encodeURIComponent(projectId)}` +
    `/recurring-offer/${encodeURIComponent(recurringOfferId)}` +
    `/latest-eval-results?limit=${n}&fullQueryResults=true`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    return 'The leaderboard service is unreachable right now. Please try again shortly.';
  }
  if (!res.ok) {
    return `Could not fetch the leaderboard (HTTP ${res.status}). Make sure the recurringOfferId belongs to this project.`;
  }

  const json = (await res.json().catch(() => null)) as
    | { status?: string; data?: { results?: Array<{ row?: LeaderboardRow } & LeaderboardRow>; lastUpdated?: string } }
    | null;
  if (!json || json.status !== 'SUCCESS' || !json.data) {
    return 'The leaderboard is not available right now.';
  }

  const raw = Array.isArray(json.data.results) ? json.data.results : [];
  const rows = raw
    .map((r) => (r.row ?? r) as LeaderboardRow)
    .filter((r) => r && (r.owner || r.username))
    .slice(0, n);
  if (rows.length === 0) {
    return 'No leaderboard entries yet for this campaign (the current epoch may not have results yet).';
  }

  const lines = rows.map((r, i) => {
    const who = r.username ? `${r.username} (${shortAddr(r.owner)})` : shortAddr(r.owner);
    const score = r.direct_score ?? r.score ?? r.metricValue;
    const parts = [`score ${fmtNum(score)}`];
    if (r.days_held != null) parts.push(`${fmtNum(r.days_held)}d held`);
    if (r.latest_balance != null) parts.push(`bal ${fmtNum(r.latest_balance)}`);
    return `${i + 1}. ${who} — ${parts.join(', ')}`;
  });
  const updated = json.data.lastUpdated ? ` (updated ${json.data.lastUpdated})` : '';
  return `Leaderboard — top ${rows.length}${updated}:\n${lines.join('\n')}`;
}
