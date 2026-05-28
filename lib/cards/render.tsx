/**
 * Top-level card renderer. Takes a CardSpec, runs validation, sums per-
 * primitive height estimates, hands off to satori + resvg.
 *
 * Architecture:
 *   renderCard(rawSpec) -> validateCardSpec -> dispatchSection per type ->
 *                          satori(...) -> resvg.render() -> PNG buffer
 *
 * Per-primitive render functions live in cards/primitives.tsx. Dispatch table
 * here keeps the orchestrator dumb — new primitives are wired in two places
 * (types.ts + the dispatchSection switch below).
 */
/** @jsxImportSource react */
import type { ReactElement } from 'react';
import { TORQUE_TERMINAL } from '../torque-brand';
import type { CardRenderResult, CardSpec, Section } from './types';
import { CARD_LIMITS } from './types';
import { validateCardSpec } from './validate';
import {
  CARD_WIDTH,
  STATUS_BAR_HEIGHT,
  FOOTER_HEIGHT,
  renderStatusBar,
  renderFooter,
  renderIntroBody,
  estimateIntroBodyHeight,
  renderDataRows,
  estimateDataRowsHeight,
  renderBigNumber,
  estimateBigNumberHeight,
  renderKvStrip,
  estimateKvStripHeight,
  renderComparison,
  estimateComparisonHeight,
  renderSparkline,
  estimateSparklineHeight,
  renderHistogram,
  estimateHistogramHeight,
  renderBadgeRow,
  estimateBadgeRowHeight,
  renderCallout,
  estimateCalloutHeight,
  renderMiniTable,
  estimateMiniTableHeight,
  renderCtaRow,
  estimateCtaRowHeight,
  renderInternalNote,
  estimateInternalNoteHeight,
} from './primitives';

const P = TORQUE_TERMINAL;

// Dispatch tables — adding a new primitive: add an entry here.
function dispatchSection(s: Section): ReactElement {
  switch (s.type) {
    case 'intro_body':
      return renderIntroBody(s);
    case 'data_rows':
      return renderDataRows(s);
    case 'big_number':
      return renderBigNumber(s);
    case 'kv_strip':
      return renderKvStrip(s);
    case 'comparison':
      return renderComparison(s);
    case 'sparkline':
      return renderSparkline(s);
    case 'histogram':
      return renderHistogram(s);
    case 'badge_row':
      return renderBadgeRow(s);
    case 'callout':
      return renderCallout(s);
    case 'mini_table':
      return renderMiniTable(s);
    case 'cta_row':
      return renderCtaRow(s);
    case '_internal_note':
      return renderInternalNote(s);
  }
}

function estimateSectionHeight(s: Section): number {
  switch (s.type) {
    case 'intro_body':
      return estimateIntroBodyHeight(s);
    case 'data_rows':
      return estimateDataRowsHeight(s);
    case 'big_number':
      return estimateBigNumberHeight(s);
    case 'kv_strip':
      return estimateKvStripHeight(s);
    case 'comparison':
      return estimateComparisonHeight(s);
    case 'sparkline':
      return estimateSparklineHeight(s);
    case 'histogram':
      return estimateHistogramHeight(s);
    case 'badge_row':
      return estimateBadgeRowHeight(s);
    case 'callout':
      return estimateCalloutHeight(s);
    case 'mini_table':
      return estimateMiniTableHeight(s);
    case 'cta_row':
      return estimateCtaRowHeight(s);
    case '_internal_note':
      return estimateInternalNoteHeight(s);
  }
}

let cachedRenderer: ((spec: CardSpec) => Promise<Buffer>) | null = null;

/** Render `rawSpec` to a PNG buffer + warnings. Validation may strip/clamp. */
export async function renderCard(rawSpec: CardSpec): Promise<CardRenderResult> {
  const { spec, warnings } = validateCardSpec(rawSpec);

  // Enforce overall height ceiling — drop trailing sections + add a note.
  const sectionsWithHeights = spec.sections.map((s) => ({ s, h: estimateSectionHeight(s) }));
  let runningHeight = STATUS_BAR_HEIGHT + FOOTER_HEIGHT;
  const kept: Section[] = [];
  let truncated = 0;
  for (const { s, h } of sectionsWithHeights) {
    if (runningHeight + h > CARD_LIMITS.MAX_HEIGHT - 40) {
      truncated += 1;
      continue;
    }
    runningHeight += h;
    kept.push(s);
  }
  if (truncated > 0) {
    warnings.push(`card trimmed — ${truncated} trailing section(s) exceeded ${CARD_LIMITS.MAX_HEIGHT}px height cap.`);
    kept.push({ type: '_internal_note', text: `(card trimmed — ${truncated} section${truncated === 1 ? '' : 's'} omitted)` });
    runningHeight += estimateInternalNoteHeight({ type: '_internal_note', text: '' });
  }
  const finalSpec: CardSpec = { ...spec, sections: kept };

  if (!cachedRenderer) cachedRenderer = await buildRenderer();
  const png = await cachedRenderer(finalSpec);
  return { png, warnings };
}

async function buildRenderer(): Promise<(spec: CardSpec) => Promise<Buffer>> {
  const satoriMod = await import('satori');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const satori = (satoriMod.default ?? (satoriMod as any)) as unknown as (
    el: ReactElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => Promise<string>;
  const { Resvg } = await import('@resvg/resvg-js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const cwd = process.cwd();
  const geistMonoDir = path.join(cwd, 'node_modules/geist/dist/fonts/geist-mono');
  const [regular, bold] = await Promise.all([
    fs.readFile(path.join(geistMonoDir, 'GeistMono-Regular.ttf')).catch(() => null),
    fs.readFile(path.join(geistMonoDir, 'GeistMono-Bold.ttf')).catch(() => null),
  ]);
  if (!regular || !bold) {
    throw new Error(
      'renderCard: Geist Mono TTFs not found at ' + geistMonoDir + ' — install the `geist` package.',
    );
  }
  const fonts = [
    { name: 'Geist Mono', data: regular, weight: 400 as const, style: 'normal' as const },
    { name: 'Geist Mono', data: bold, weight: 700 as const, style: 'normal' as const },
  ];

  // Load + recolor the Torque hexagon for the status bar logo. Best-effort.
  const logoPath = path.join(cwd, 'public/logos/torque-symbol.svg');
  let logoDataUrl: string | null = null;
  try {
    const raw = await fs.readFile(logoPath, 'utf-8');
    const recolored = raw.replace(/#010101/gi, P.textPrimary);
    logoDataUrl = `data:image/svg+xml;base64,${Buffer.from(recolored).toString('base64')}`;
  } catch (err) {
    console.warn('[render-card] torque-symbol.svg not found; rendering without logo:', err);
  }

  return async (spec: CardSpec): Promise<Buffer> => {
    const totalHeight =
      STATUS_BAR_HEIGHT +
      spec.sections.reduce((sum, s) => sum + estimateSectionHeight(s), 0) +
      FOOTER_HEIGHT +
      20;
    const showLogo = spec.logo !== false && logoDataUrl !== null;
    const tree = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: CARD_WIDTH,
          backgroundColor: P.terminalBg,
          color: P.textPrimary,
          fontFamily: 'Geist Mono',
          fontSize: 13,
        }}
      >
        {renderStatusBar(spec.symbol, spec.label, showLogo ? logoDataUrl : null)}
        {spec.sections.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
            {dispatchSection(s)}
          </div>
        ))}
        {renderFooter(spec.updatedUtc, spec.footerText)}
      </div>
    );
    const svg = await satori(tree, { width: CARD_WIDTH, height: totalHeight, fonts });
    const resvg = new Resvg(svg, {
      background: P.terminalBg,
      font: { defaultFontFamily: 'Geist Mono' },
    });
    return resvg.render().asPng();
  };
}
