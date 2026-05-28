/**
 * Chart presets — narrower tools the model can call with simpler args. Each
 * preset fills in the boilerplate (title shape, axis formatting, label
 * truncation, unit, max-row caps) that the generic `render_chart` lets the
 * model forget. The model still has `render_chart` available for arbitrary
 * shapes, but presets are strictly better for the common cases.
 *
 * Encoded "craft": one place to bake in chart-design rules instead of
 * repeating them across every system prompt.
 */
import type { ChartSpec } from './render-chart';

/** Shorten "7xKabcdef…12345AB" → "7xKa…34AB" (4 + … + 4). */
function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export type LeaderboardRow = { wallet: string; value: number };

/** Top-N leaderboard bar chart. Caps at 10 rows, shortens wallets, sets unit. */
export function leaderboardSpec(
  rows: LeaderboardRow[],
  opts: { title: string; valueLabel: string; unit?: string },
): ChartSpec {
  const top = rows.slice(0, 10);
  return {
    type: 'bar',
    title: opts.title,
    labels: top.map((r) => shortAddr(r.wallet)),
    series: [{ label: opts.valueLabel, data: top.map((r) => r.value) }],
    unit: opts.unit,
  };
}

export type TimeseriesPoint = { date: string; value: number };

/**
 * Daily/weekly time-series line chart. Pass ISO dates ("2026-05-22") and we
 * format them as "May 22" for the x-axis. Single series only — this preset is
 * for "<metric> over time".
 */
export function timeseriesSpec(
  points: TimeseriesPoint[],
  opts: { title: string; seriesLabel: string; unit?: string },
): ChartSpec {
  return {
    type: 'line',
    title: opts.title,
    labels: points.map((p) => formatDateLabel(p.date)),
    series: [{ label: opts.seriesLabel, data: points.map((p) => p.value) }],
    unit: opts.unit,
  };
}

/** "2026-05-22" or "2026-05-22T..." → "May 22". Falls back to input on parse fail. */
function formatDateLabel(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return raw;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(m[2]) - 1
  ];
  return `${month} ${Number(m[3])}`;
}
