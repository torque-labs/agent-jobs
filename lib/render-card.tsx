/**
 * BACK-COMPAT SHIM. The old `renderHolderCard` API is preserved by translating
 * its single-card spec into the new generic CardSpec and delegating to
 * lib/cards/render.tsx. New callers should use `renderCard` directly.
 *
 * Plan: keep this shim for one release; after telemetry shows no callers,
 * delete this file and the `render_holder_card` tool from agent-runtime.
 */
import type { CardSpec, Section } from './cards/types';
import { renderCard } from './cards/render';

// Re-export legacy types for callers that still import from here. These map
// 1:1 onto the new CardSpec sections.
export type HolderRow = {
  rank: number;
  name: string;
  pct: number;
  value: string;
  unit?: string;
  highlight?: boolean;
};

export type Insight = {
  key: string;
  val: string;
  accent?: boolean;
};

export type HolderCardSpec = {
  symbol: string;
  label: string;
  intro?: string;
  introMuted?: string;
  introTitle?: string;
  dataTitle: string;
  insightTitle?: string;
  rows: HolderRow[];
  insights?: Insight[];
  updatedUtc?: string;
  ctaText?: string;
};

export async function renderHolderCard(spec: HolderCardSpec): Promise<Buffer> {
  const sections: Section[] = [];

  // intro_body
  if (spec.intro || spec.introTitle) {
    sections.push({
      type: 'intro_body',
      title: spec.introTitle,
      text: spec.intro ?? '',
      muted: spec.introMuted,
    });
  }

  // data_rows
  sections.push({
    type: 'data_rows',
    title: spec.dataTitle,
    rows: spec.rows.map((r) => ({
      rank: r.rank,
      name: r.name,
      pct: r.pct,
      value: r.value,
      unit: r.unit,
      highlight: r.highlight,
    })),
  });

  // kv_strip
  if (spec.insights && spec.insights.length > 0) {
    sections.push({
      type: 'kv_strip',
      title: spec.insightTitle,
      rows: spec.insights.map((i) => ({
        key: i.key,
        val: i.val,
        accent: i.accent ? 'alert' : undefined,
      })),
    });
  }

  // cta_row
  if (spec.ctaText) {
    sections.push({ type: 'cta_row', buttons: [{ text: spec.ctaText, suffix: 'external' }] });
  }

  const card: CardSpec = {
    symbol: spec.symbol,
    label: spec.label,
    updatedUtc: spec.updatedUtc,
    sections,
  };

  const { png } = await renderCard(card);
  return png;
}
