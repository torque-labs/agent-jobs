/**
 * Visual smoke test for the two new optional fields:
 *   - big_number.cap (utilization meter)
 *   - sparkline.reference (baseline/target line)
 *
 * Also confirms the XRP pilot can be expressed using the existing 11
 * primitives composed correctly — no new primitive types needed.
 *
 * Usage: pnpm exec tsx scripts/render-xrp-pilot-tests.tsx
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCard } from '../lib/cards/render';
import type { CardSpec } from '../lib/cards/types';

const OUT_DIR = '/tmp/xrp-pilot-tests';

// Scene 1 — Cap utilization on the global $5k/day rebate pool.
// Tests: big_number.cap (color shifts: blue < 75%, yellow < 95%, red ≥ 95%).
const CAP_UTILIZATION: CardSpec = {
  symbol: 'xrp',
  label: 'pilot · day 2 of 5',
  sections: [
    {
      type: 'big_number',
      title: 'global rebate pool',
      value: '$3,210',
      label: 'paid today',
      delta: { value: '$1,890 vs yesterday', direction: 'up' },
      cap: { pct: 64.2, label: '$3,210 / $5,000 daily cap' },
      context: 'Top wallet earned $920 / $1,200 cap (77%).',
    },
    {
      type: 'kv_strip',
      title: 'pilot scoreboard',
      rows: [
        { key: 'epoch', val: '2 of 5 · 14h 12m remaining' },
        { key: 'volume routed', val: '$1.78M', accent: 'ok' },
        { key: 'eligible wallets', val: '23 of 47 invited' },
        { key: 'wallets at cap', val: '0', accent: 'ok' },
      ],
    },
  ],
  updatedUtc: '16:48:02 utc',
};

// Scene 2 — Volume trend with the $44k median baseline drawn as reference.
// Tests: sparkline.reference (dashed line at the y-coordinate of refValue).
const VOLUME_VS_BASELINE: CardSpec = {
  symbol: 'xrp',
  label: 'volume · 7-day trend',
  sections: [
    {
      type: 'intro_body',
      title: 'context',
      text: 'XRP routing volume on Solana since the pilot opened. Dashed line shows the pre-pilot median ($44k/day) — the bar to clear.',
    },
    {
      type: 'sparkline',
      title: 'daily volume routed',
      // Pre-pilot 5 days (well under baseline some days) + pilot days (lifted).
      series: [38_000, 41_500, 52_000, 39_400, 44_200, 870_000, 1_780_000],
      reference: { value: 44_000, label: 'pre-pilot baseline ($44k median)' },
      start: 'may 22',
      end: 'may 28',
      endValue: '$1.78M',
      delta: { value: '40× baseline', direction: 'up' },
    },
    {
      type: 'comparison',
      title: 'pilot vs baseline',
      left: { label: 'pre-pilot median', value: '$44k', sublabel: 'daily volume' },
      right: { label: 'day 2 of pilot', value: '$1.78M', sublabel: '40× lift', unit: '' },
      winner: 'right',
      delta: '+$1.74M absolute · 3,945% increase',
    },
  ],
  updatedUtc: '16:48:02 utc',
};

// Scene 3 — Full daily digest composed entirely from existing primitives.
// Tests: leaderboard via mini_table, tier composition via histogram,
// epoch progress via badge_row, risk flags via mini_table.
const FULL_DAILY_DIGEST: CardSpec = {
  symbol: 'xrp',
  label: 'pilot · daily digest',
  sections: [
    {
      type: 'badge_row',
      badges: [
        { label: 'day 1', tone: 'ok', value: '✓' },
        { label: 'day 2', tone: 'info', value: 'live' },
        { label: 'day 3', tone: 'neutral' },
        { label: 'day 4', tone: 'neutral' },
      ],
    },
    {
      type: 'big_number',
      title: 'rebates paid today',
      value: '$3,210',
      label: 'usdc',
      cap: { pct: 64.2, label: '$3,210 / $5,000 daily cap' },
    },
    {
      type: 'mini_table',
      title: 'top earners — day 2',
      columns: [
        { key: 'rank', label: '#' },
        { key: 'wallet', label: 'wallet' },
        { key: 'vol', label: 'volume', align: 'right' },
        { key: 'rebate', label: 'rebate', align: 'right' },
      ],
      rows: [
        { rank: '🥇', wallet: '7gAk…sWx7', vol: '$512k', rebate: '$920' },
        { rank: '🥈', wallet: 'EWvS…w8Bj', vol: '$338k', rebate: '$608' },
        { rank: '🥉', wallet: 'Hn4P…m2qK', vol: '$214k', rebate: '$385' },
        { rank: '04', wallet: 'BvR8…tg7L', vol: '$148k', rebate: '$266' },
        { rank: '05', wallet: 'C3xZ…pNk9', vol: '$76k',  rebate: '$133' },
      ],
    },
    {
      type: 'histogram',
      title: 'wallets by tier',
      bins: [
        { label: '$0-2k', value: 18 },
        { label: '$2k-10k', value: 12 },
        { label: '$10k+', value: 5, highlight: true },
      ],
      orientation: 'horizontal',
    },
    {
      type: 'mini_table',
      title: 'wallets on watch',
      columns: [
        { key: 'wallet', label: 'wallet' },
        { key: 'cadence', label: 'cadence' },
        { key: 'symmetry', label: 'buy/sell' },
        { key: 'partners', label: 'partners' },
      ],
      rows: [
        { wallet: 'Hn4P…m2qK', cadence: 'OK',    symmetry: 'WATCH', partners: 'OK' },
        { wallet: 'BvR8…tg7L', cadence: 'WATCH', symmetry: 'OK',    partners: 'FLAG' },
      ],
    },
  ],
  updatedUtc: '16:48:02 utc',
  footerText: 'daily digest',
};

// Scene 4 — At-cap edge case to verify cap-meter color shifts.
// Tests: big_number.cap renders red ≥ 95%.
const AT_CAP: CardSpec = {
  symbol: 'xrp',
  label: 'pilot · day 4 of 5',
  sections: [
    {
      type: 'big_number',
      title: 'global rebate pool',
      value: '$4,950',
      label: 'paid today',
      cap: { pct: 99.0, label: '$4,950 / $5,000 daily cap — 99% saturated' },
      context: 'Cap will be hit in ~28 minutes at current pace.',
    },
    {
      type: 'callout',
      tone: 'warn',
      icon: 'warn',
      text: 'Global cap effectively reached; trailing wallets earn 0 from here. Consider raising the cap or signalling close to whitelisted traders.',
    },
  ],
  updatedUtc: '16:48:02 utc',
};

// --- run -----------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const scenes: Array<[string, CardSpec]> = [
    ['01-cap-utilization.png', CAP_UTILIZATION],
    ['02-volume-vs-baseline.png', VOLUME_VS_BASELINE],
    ['03-full-daily-digest.png', FULL_DAILY_DIGEST],
    ['04-at-cap.png', AT_CAP],
  ];
  for (const [name, spec] of scenes) {
    const { png, warnings } = await renderCard(spec);
    const path = join(OUT_DIR, name);
    await writeFile(path, png);
    console.log(`✓ ${name} (${(png.length / 1024).toFixed(1)}KB)`);
    if (warnings.length > 0) {
      for (const w of warnings) console.log(`  · ${w}`);
    }
  }
  console.log(`\nWrote ${scenes.length} scenes to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
