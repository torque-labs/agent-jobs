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
import { TORQUE_TERMINAL, TORQUE_LIGHT, type TorqueTerminal } from '../torque-brand';
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
  renderGroupedBars,
  estimateGroupedBarsHeight,
  renderRangeBars,
  estimateRangeBarsHeight,
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

function pickPalette(theme: 'dark' | 'light' | undefined): TorqueTerminal {
  // Light is the default brand look; dark only when explicitly requested.
  return theme === 'dark' ? TORQUE_TERMINAL : TORQUE_LIGHT;
}

// Dispatch tables — adding a new primitive: add an entry here.
function dispatchSection(s: Section, P: TorqueTerminal): ReactElement {
  switch (s.type) {
    case 'intro_body':
      return renderIntroBody(s, P);
    case 'data_rows':
      return renderDataRows(s, P);
    case 'big_number':
      return renderBigNumber(s, P);
    case 'kv_strip':
      return renderKvStrip(s, P);
    case 'comparison':
      return renderComparison(s, P);
    case 'sparkline':
      return renderSparkline(s, P);
    case 'histogram':
      return renderHistogram(s, P);
    case 'grouped_bars':
      return renderGroupedBars(s, P);
    case 'range_bars':
      return renderRangeBars(s, P);
    case 'badge_row':
      return renderBadgeRow(s, P);
    case 'callout':
      return renderCallout(s, P);
    case 'mini_table':
      return renderMiniTable(s, P);
    case 'cta_row':
      return renderCtaRow(s, P);
    case '_internal_note':
      return renderInternalNote(s, P);
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
    case 'grouped_bars':
      return estimateGroupedBarsHeight(s);
    case 'range_bars':
      return estimateRangeBarsHeight(s);
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

  // Load the Torque hexagon SVG once; recolor per-spec to the active palette's
  // textPrimary (the native fill is #010101) so it contrasts in both themes.
  const logoPath = path.join(cwd, 'public/logos/torque-symbol.svg');
  let rawLogoSvg: string | null = null;
  try {
    rawLogoSvg = await fs.readFile(logoPath, 'utf-8');
  } catch (err) {
    console.warn('[render-card] torque-symbol.svg not found; rendering without logo:', err);
  }

  return async (spec: CardSpec): Promise<Buffer> => {
    const P = pickPalette(spec.theme);
    const totalHeight =
      STATUS_BAR_HEIGHT +
      spec.sections.reduce((sum, s) => sum + estimateSectionHeight(s), 0) +
      FOOTER_HEIGHT +
      20;
    const showLogo = spec.logo !== false && rawLogoSvg !== null;
    const logoDataUrl =
      showLogo && rawLogoSvg
        ? `data:image/svg+xml;base64,${Buffer.from(rawLogoSvg.replace(/#010101/gi, P.textPrimary)).toString('base64')}`
        : null;
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
        {renderStatusBar(spec.symbol, spec.label, logoDataUrl, P)}
        {spec.sections.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
            {dispatchSection(s, P)}
          </div>
        ))}
        {renderFooter(spec.updatedUtc, spec.footerText, P)}
      </div>
    );
    const svg = await satori(tree, { width: CARD_WIDTH, height: totalHeight, fonts });
    // Render at 2× pixel density so the card stays crisp on retina/HDPI
    // displays — twice as wide in pixels, same physical size, sharp text/bars.
    const resvg = new Resvg(svg, {
      background: P.terminalBg,
      font: { defaultFontFamily: 'Geist Mono' },
      fitTo: { mode: 'width', value: CARD_WIDTH * 2 },
    });
    return resvg.render().asPng();
  };
}
