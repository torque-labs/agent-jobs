/**
 * Visual-review battery for renderHolderCard.
 *
 * Generates ~14 PNG variants exercising the design surface (row count,
 * intro/insights presence, accent overload, long names, highlight position,
 * CTA, footer toggle, density edge). Writes to /tmp/card-tests/ and prints a
 * one-line description table.
 *
 * Usage: pnpm exec tsx scripts/render-card-tests.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHolderCard, type HolderCardSpec, type HolderRow, type Insight } from '../lib/render-card';

const OUT_DIR = '/tmp/card-tests';

// --- Base $TRUMP-style fixture --------------------------------------------
// Modeled after the shipped screenshot: rank 1 Surfer (highlighted yellow)
// then descending K-value balances down to ~133K.
const BASE_ROWS: HolderRow[] = [
  { rank: 1, name: 'surfer',  pct: 100,  value: '339.11', unit: 'K', highlight: true },
  { rank: 2, name: 'unitas',  pct: 55.7, value: '188.89', unit: 'K' },
  { rank: 3, name: 'bm1',     pct: 49.9, value: '169.10', unit: 'K' },
  { rank: 4, name: 'gadwell', pct: 39.5, value: '134.00', unit: 'K' },
  { rank: 5, name: '3eye',    pct: 39.3, value: '133.09', unit: 'K' },
];

const BASE_INTRO =
  'Time-weighted holding leaderboard for $TRUMP. Top wallets accrue weight every minute they hold.';
const BASE_INTRO_MUTED = 'Window closes in 34d 09h 18m.';

const BASE_INSIGHTS: Insight[] = [
  { key: 'concentration', val: 'high — top wallet dominates the field', accent: true },
  { key: 'gap to #2',     val: '150.22K (44.3% headroom over rank 2)' },
  { key: 'movement',      val: 'rank 3 closed 12.8K on rank 2 in 24h' },
];

const BASE: HolderCardSpec = {
  symbol: '$trump',
  label: 'leaderboard',
  introTitle: 'how this leaderboard works',
  intro: BASE_INTRO,
  introMuted: BASE_INTRO_MUTED,
  dataTitle: 'top holders — current epoch',
  insightTitle: 'intelligence — concentration',
  rows: BASE_ROWS,
  insights: BASE_INSIGHTS,
  updatedUtc: '14:32:08 utc',
};

// --- Variant builders ------------------------------------------------------

function tenRows(): HolderRow[] {
  // Extend the base shape down to rank 10 with plausible descending K values.
  return [
    ...BASE_ROWS,
    { rank: 6,  name: 'pepehands',  pct: 36.1, value: '122.40', unit: 'K' },
    { rank: 7,  name: 'maga_whale', pct: 32.8, value: '111.20', unit: 'K' },
    { rank: 8,  name: 'eaglevault', pct: 29.4, value: '99.70',  unit: 'K' },
    { rank: 9,  name: 'forty7',     pct: 26.9, value: '91.20',  unit: 'K' },
    { rank: 10, name: 'rallybag',   pct: 24.1, value: '81.70',  unit: 'K' },
  ];
}

function longNameRows(): HolderRow[] {
  return [
    { rank: 1, name: 'patriot_supremacy_2024',  pct: 100,  value: '339.11', unit: 'K', highlight: true },
    { rank: 2, name: 'freedom_warriors_dao',    pct: 55.7, value: '188.89', unit: 'K' },
    { rank: 3, name: 'liberty_eagle_vault_001', pct: 49.9, value: '169.10', unit: 'K' },
    { rank: 4, name: 'gadwell_capital_partners', pct: 39.5, value: '134.00', unit: 'K' },
    { rank: 5, name: 'three_eye_research_grp',  pct: 39.3, value: '133.09', unit: 'K' },
  ];
}

function highlightRank3Rows(): HolderRow[] {
  return BASE_ROWS.map((r) => ({ ...r, highlight: r.rank === 3 }));
}

function allAccentInsights(): Insight[] {
  return [
    { key: 'concentration', val: 'critical — top wallet > 50% of holdings', accent: true },
    { key: 'velocity',      val: 'critical — 30% turnover in last 24h',     accent: true },
    { key: 'gap to #2',     val: 'critical — 44.3% headroom is unprecedented', accent: true },
    { key: 'risk',          val: 'critical — single-actor manipulation likely',  accent: true },
  ];
}

function fiveInsights(): Insight[] {
  return [
    { key: 'concentration', val: 'high — top wallet dominates', accent: true },
    { key: 'gap to #2',     val: '150.22K (44.3% headroom)' },
    { key: 'movement',      val: 'rank 3 closed 12.8K in 24h' },
    { key: 'velocity',      val: 'moderate — 8.2% turnover in 24h' },
    { key: 'wallets in',    val: '+12 new entrants past 6h' },
  ];
}

// --- Variant catalog -------------------------------------------------------

type Variant = {
  name: string;
  description: string;
  spec: HolderCardSpec;
};

const VARIANTS: Variant[] = [
  {
    name: 'baseline-5row',
    description: 'Baseline 5-row leaderboard (logo top-left + full intro + insights).',
    spec: { ...BASE },
  },
  {
    name: '3row-tight',
    description: 'Same shape but 3 rows only — checks tight-card padding.',
    spec: { ...BASE, rows: BASE_ROWS.slice(0, 3) },
  },
  {
    name: '10row-dense',
    description: '10 rows of data — full data-block density check.',
    spec: { ...BASE, rows: tenRows() },
  },
  {
    name: 'no-insights',
    description: 'No insights — verify insight section is fully omitted.',
    spec: { ...BASE, insights: undefined, insightTitle: undefined },
  },
  {
    name: 'no-intro',
    description: 'No intro / introTitle — verify intro section is omitted.',
    spec: { ...BASE, intro: undefined, introTitle: undefined, introMuted: undefined },
  },
  {
    name: 'insights-no-accent',
    description: 'Insights present but none accent: true — no red callout.',
    spec: {
      ...BASE,
      insights: BASE_INSIGHTS.map((i) => ({ ...i, accent: false })),
    },
  },
  {
    name: 'all-accent-stress',
    description: 'Every insight accent: true — red overload stress test.',
    spec: { ...BASE, insights: allAccentInsights() },
  },
  {
    name: 'long-names',
    description: 'Long wallet names (22+ chars) — overflow / truncation behavior.',
    spec: { ...BASE, rows: longNameRows() },
  },
  {
    name: 'highlight-rank3',
    description: 'Yellow highlight on rank 3 instead of rank 1 — accent not position-locked.',
    spec: { ...BASE, rows: highlightRank3Rows() },
  },
  {
    name: 'with-cta',
    description: 'CTA "view full leaderboard" rendered at bottom.',
    spec: { ...BASE, ctaText: 'view full leaderboard' },
  },
  {
    name: 'no-updated-footer',
    description: 'Footer without updatedUtc — check "data current" alone.',
    spec: { ...BASE, updatedUtc: undefined },
  },
  {
    name: 'updated-only-minimal',
    description: 'Only dataTitle + rows + updatedUtc (no intro, no insights, no CTA).',
    spec: {
      symbol: '$trump',
      label: 'leaderboard',
      dataTitle: 'top holders — current epoch',
      rows: BASE_ROWS,
      updatedUtc: '14:32:08 utc',
    },
  },
  {
    name: 'edge-everything',
    description: '10 rows + intro + 5 insights + CTA — height-estimate edge.',
    spec: {
      ...BASE,
      rows: tenRows(),
      insights: fiveInsights(),
      ctaText: 'view full leaderboard',
    },
  },
  {
    name: 'intro-no-muted',
    description: 'Intro present but no introMuted — check trailing space behavior.',
    spec: { ...BASE, introMuted: undefined },
  },
];

// --- Runner ---------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const results: { n: string; name: string; description: string; status: string }[] = [];

  for (let i = 0; i < VARIANTS.length; i++) {
    const v = VARIANTS[i];
    const n = String(i + 1).padStart(2, '0');
    const file = join(OUT_DIR, `${n}-${v.name}.png`);
    const t0 = Date.now();
    try {
      const png = await renderHolderCard(v.spec);
      await writeFile(file, png);
      const dt = Date.now() - t0;
      results.push({ n, name: v.name, description: v.description, status: `ok ${dt}ms` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ n, name: v.name, description: v.description, status: `ERROR: ${msg}` });
      // continue with next variant
    }
  }

  // --- Stdout table -------------------------------------------------------
  console.log('');
  console.log('Generated cards (' + OUT_DIR + '):');
  console.log('NN | name                    | status      | description');
  console.log('---+-------------------------+-------------+----------------------------------------');
  for (const r of results) {
    const namePad = r.name.padEnd(23);
    const statusPad = r.status.padEnd(11);
    console.log(`${r.n} | ${namePad} | ${statusPad} | ${r.description}`);
  }
  console.log('');
  const errs = results.filter((r) => r.status.startsWith('ERROR'));
  if (errs.length > 0) {
    console.log(`${errs.length} variant(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${results.length} variants rendered.`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
