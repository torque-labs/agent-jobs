/**
 * Server-side data-card renderer — produces Torque-branded PNGs the agent
 * attaches to a reply. Replaces the older Chart.js renderer (lib/render-chart)
 * for the shapes we have a designed mock for. Currently:
 *   - renderHolderCard: terminal-aesthetic leaderboard + insight card.
 *
 * Stack: satori (JSX -> SVG, flexbox subset) + @resvg/resvg-js (SVG -> PNG,
 * pure Rust, ships musl Alpine prebuilds — no Cairo, no Chromium). Lazy-
 * loaded so cold-start cost is only paid on first render.
 *
 * Stakeholder-voice note (per memory): never name statistical metrics
 * (HHI/Gini/etc) in user-facing insight rows. Compute them upstream if needed,
 * pass plain-English summaries here ("concentration: high — top wallet
 * dominates").
 */
/** @jsxImportSource react */
import type { ReactElement, CSSProperties } from 'react';
import { TORQUE_TERMINAL } from './torque-brand';

const P = TORQUE_TERMINAL;
const WIDTH = 720;

export type HolderRow = {
  rank: number;
  /** Wallet display name (already truncated by caller if needed) */
  name: string;
  /** 0..100 — controls the bar fill width */
  pct: number;
  /** Numeric portion of the value, e.g. "2.84" */
  value: string;
  /** Unit suffix shown muted next to value, e.g. "M", "K". Optional. */
  unit?: string;
  /** Top-1 typically true — swaps to yellow accent */
  highlight?: boolean;
};

export type Insight = {
  key: string;
  val: string;
  /** Red accent for the headline insight (e.g. concentration callout) */
  accent?: boolean;
};

export type HolderCardSpec = {
  /** Status-bar token, e.g. "$trump". Lowercased in the design. */
  symbol: string;
  /** Status-bar section, e.g. "leaderboard". Lowercased. */
  label: string;
  /** Optional intro paragraph above the data block */
  intro?: string;
  /** Optional muted text after intro, e.g. "Window closes in 34d 09h 18m." */
  introMuted?: string;
  /** Section title above intro (only if intro is set), e.g. "how this leaderboard works" */
  introTitle?: string;
  /** Section title above data rows, e.g. "top holders — current epoch" */
  dataTitle: string;
  /** Section title above insights, e.g. "intelligence — concentration" */
  insightTitle?: string;
  rows: HolderRow[];
  insights?: Insight[];
  /** Footer right-side text e.g. "14:32:08 utc" — caller pre-formats. */
  updatedUtc?: string;
  /** Optional CTA button at the bottom */
  ctaText?: string;
};

let cachedRenderer: ((spec: HolderCardSpec) => Promise<Buffer>) | null = null;

/** Render a HolderCard spec to PNG. Throws on font / render failure. */
export async function renderHolderCard(spec: HolderCardSpec): Promise<Buffer> {
  if (!cachedRenderer) cachedRenderer = await buildRenderer();
  return cachedRenderer(spec);
}

async function buildRenderer(): Promise<(spec: HolderCardSpec) => Promise<Buffer>> {
  const satoriMod = await import('satori');
  // satori is published as both ESM and CJS — the default export shape can
  // differ; this normalization handles both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const satori = (satoriMod.default ?? (satoriMod as any)) as unknown as (
    el: ReactElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => Promise<string>;
  const { Resvg } = await import('@resvg/resvg-js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Brand font: Geist Mono (the terminal aesthetic is mono throughout). Geist
  // ships TTFs via the `geist` npm package — node_modules/geist/dist/fonts.
  const cwd = process.cwd();
  const geistMonoDir = path.join(cwd, 'node_modules/geist/dist/fonts/geist-mono');
  const [regular, bold] = await Promise.all([
    fs.readFile(path.join(geistMonoDir, 'GeistMono-Regular.ttf')).catch(() => null),
    fs.readFile(path.join(geistMonoDir, 'GeistMono-Bold.ttf')).catch(() => null),
  ]);
  if (!regular || !bold) {
    throw new Error(
      'renderHolderCard: Geist Mono TTFs not found at ' +
        geistMonoDir +
        ' — install the `geist` package (pnpm add geist).',
    );
  }
  const fonts = [
    { name: 'Geist Mono', data: regular, weight: 400 as const, style: 'normal' as const },
    { name: 'Geist Mono', data: bold, weight: 700 as const, style: 'normal' as const },
  ];

  return async (spec: HolderCardSpec): Promise<Buffer> => {
    const el = buildCardTree(spec);
    const height = estimateHeight(spec);
    const svg = await satori(el, { width: WIDTH, height, fonts });
    const resvg = new Resvg(svg, {
      background: P.terminalBg,
      font: { defaultFontFamily: 'Geist Mono' },
    });
    return resvg.render().asPng();
  };
}

/**
 * Pre-compute card height from the spec. Satori needs a fixed canvas height
 * up front (no auto-shrink). We pad generously so a slightly-overshooting
 * estimate just leaves dark space rather than clipping content.
 */
function estimateHeight(spec: HolderCardSpec): number {
  let h = 56; // status bar
  if (spec.intro || spec.introTitle) {
    h += 44; // intro section rule
    h += 92; // intro body
  }
  h += 44; // data section rule
  h += 36; // data header row
  h += spec.rows.length * 34;
  if (spec.insights && spec.insights.length > 0) {
    h += 44; // insight section rule
    h += spec.insights.length * 30 + 12;
  }
  h += 60; // footer
  if (spec.ctaText) h += 80;
  return Math.max(360, h + 24);
}

// ---------------------------------------------------------------------------
// JSX tree — Satori subset (flexbox only, inline styles). No CSS grid, no
// pseudo-elements; we replace grid with `display: flex` + fixed widths, and
// replace ::before/::after bar trick with two stacked absolute-positioned
// divs (dim background + bright foreground sized by pct).
// ---------------------------------------------------------------------------

function buildCardTree(spec: HolderCardSpec): ReactElement {
  const showIntro = Boolean(spec.intro || spec.introTitle);
  const sections: ReactElement[] = [];
  sections.push(statusBar(spec.symbol, spec.label));
  if (showIntro) {
    sections.push(sectionRule(spec.introTitle ?? 'context'));
    sections.push(introBody(spec.intro ?? '', spec.introMuted));
  }
  sections.push(sectionRule(spec.dataTitle));
  sections.push(dataBlock(spec.rows));
  if (spec.insights && spec.insights.length > 0) {
    sections.push(sectionRule(spec.insightTitle ?? 'intelligence'));
    sections.push(insightBlock(spec.insights));
  }
  sections.push(actionFooter(spec.updatedUtc));
  if (spec.ctaText) sections.push(cta(spec.ctaText));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: WIDTH,
        backgroundColor: P.terminalBg,
        color: P.textPrimary,
        fontFamily: 'Geist Mono',
        fontSize: 13,
      }}
    >
      {sections.map((s, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
          {s}
        </div>
      ))}
    </div>
  );
}

// ---- Section components --------------------------------------------------

function statusBar(symbol: string, label: string): ReactElement {
  const sep = (
    <span style={{ color: P.textTertiary, margin: '0 6px' }}>·</span>
  );
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '16px 22px 10px',
        fontSize: 10,
        letterSpacing: 1.2,
        color: P.textSecondary,
        textTransform: 'uppercase',
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: P.accentGreen,
          marginRight: 10,
          // Soft glow approximation (no box-shadow in satori) via border + alpha:
          boxShadow: `0 0 6px ${P.accentGreen}`,
        }}
      />
      <span style={{ color: P.textPrimary, fontWeight: 500 }}>live</span>
      {sep}
      <span>{symbol}</span>
      {sep}
      <span>{label}</span>
    </div>
  );
}

function sectionRule(title: string): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '14px 22px 10px',
        color: P.accentOrange,
        fontSize: 11,
        letterSpacing: 0.9,
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      <span style={{ marginRight: 10 }}>—</span>
      <span>{title}</span>
      <div
        style={{
          flex: 1,
          marginLeft: 12,
          height: 0,
          // Dashed border emulation: satori supports border styles. Real dashed
          // requires a borderTop on a 1px-tall div.
          borderTop: `1px dashed ${P.accentOrange}`,
          opacity: 0.5,
        }}
      />
    </div>
  );
}

function introBody(text: string, muted?: string): ReactElement {
  return (
    <div
      style={{
        padding: '4px 22px 12px',
        color: P.textPrimary,
        fontSize: 13,
        lineHeight: 1.6,
        display: 'flex',
      }}
    >
      <span style={{ display: 'flex' }}>
        {text}
        {muted ? <span style={{ color: P.textSecondary }}>{` ${muted}`}</span> : null}
      </span>
    </div>
  );
}

function dataBlock(rows: HolderRow[]): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 22px 14px' }}>
      {dataHeader()}
      {rows.map((r) => dataRow(r))}
    </div>
  );
}

const COL_NAME_W = 130;
const COL_VALUE_W = 100;

function dataHeader(): ReactElement {
  const cell = (text: string, align: CSSProperties['justifyContent']): ReactElement => (
    <div
      style={{
        display: 'flex',
        justifyContent: align,
        color: P.textTertiary,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
      }}
    >
      {text}
    </div>
  );
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '4px 0 10px',
        borderBottom: `1px dashed ${P.border}`,
        marginBottom: 6,
      }}
    >
      <div style={{ display: 'flex', width: COL_NAME_W }}>{cell('wallet', 'flex-start')}</div>
      <div style={{ display: 'flex', flex: 1 }}>{cell('holdings', 'flex-start')}</div>
      <div style={{ display: 'flex', width: COL_VALUE_W, justifyContent: 'flex-end' }}>
        {cell('amount', 'flex-end')}
      </div>
    </div>
  );
}

function dataRow(r: HolderRow): ReactElement {
  const fg = r.highlight ? P.accentYellow : P.accentBlue;
  const dim = r.highlight ? P.accentYellowDim : P.accentBlueDim;
  const nameColor = r.highlight ? P.accentYellow : P.textPrimary;
  const rank = String(r.rank).padStart(2, '0');
  return (
    <div
      key={`${r.rank}-${r.name}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '7px 0',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: COL_NAME_W,
          color: nameColor,
          fontWeight: r.highlight ? 500 : 400,
        }}
      >
        <span style={{ color: P.textTertiary, marginRight: 10 }}>{rank}</span>
        <span>{r.name}</span>
      </div>
      <div style={{ display: 'flex', flex: 1, marginRight: 14 }}>
        {/* Bar: dim background + bright fill (no pseudo-elements in satori) */}
        <div style={{ position: 'relative', width: '100%', height: 14, display: 'flex' }}>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: dim,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: `${Math.max(0, Math.min(100, r.pct))}%`,
              height: '100%',
              backgroundColor: fg,
            }}
          />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          width: COL_VALUE_W,
          justifyContent: 'flex-end',
          color: P.textPrimary,
          fontWeight: 500,
        }}
      >
        <span>{r.value}</span>
        {r.unit ? <span style={{ color: P.textSecondary, marginLeft: 2 }}>{r.unit}</span> : null}
      </div>
    </div>
  );
}

function insightBlock(insights: Insight[]): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 22px 14px' }}>
      {insights.map((i, idx) => insightRow(i, idx))}
    </div>
  );
}

function insightRow(i: Insight, idx: number): ReactElement {
  const keyColor = i.accent ? P.accentRed : P.textSecondary;
  const valColor = i.accent ? P.accentRed : P.textPrimary;
  return (
    <div
      key={`${idx}-${i.key}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        padding: '4px 0',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div style={{ display: 'flex', width: 150, color: keyColor }}>{i.key}</div>
      <div style={{ display: 'flex', flex: 1, color: valColor, fontWeight: i.accent ? 500 : 400 }}>
        {i.val}
      </div>
    </div>
  );
}

function actionFooter(updatedUtc?: string): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '14px 22px',
        borderTop: `1px solid ${P.border}`,
        fontSize: 10,
        letterSpacing: 1.2,
        color: P.textSecondary,
        textTransform: 'uppercase',
      }}
    >
      <span style={{ color: P.accentGreen, marginRight: 10 }}>✓</span>
      <span>data current</span>
      {updatedUtc ? (
        <>
          <span style={{ color: P.textTertiary, margin: '0 8px' }}>·</span>
          <span>{`updated ${updatedUtc}`}</span>
        </>
      ) : null}
    </div>
  );
}

function cta(text: string): ReactElement {
  return (
    <div style={{ display: 'flex', padding: '0 22px 22px' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          padding: 16,
          backgroundColor: P.terminalBgSoft,
          border: `1px solid rgba(255,255,255,0.18)`,
          borderRadius: 4,
          color: P.textPrimary,
          fontSize: 12,
          letterSpacing: 1.2,
          fontWeight: 500,
          textTransform: 'uppercase',
        }}
      >
        <span>{text}</span>
        <span style={{ color: P.textSecondary, marginLeft: 8 }}>↗</span>
      </div>
    </div>
  );
}
