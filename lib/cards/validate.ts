/**
 * Server-side spec validation. Fails closed: drops invalid sections, clamps
 * out-of-range fields, returns warnings the orchestrator can return alongside
 * the rendered PNG (the tool result the agent sees on the next turn).
 *
 * Philosophy: validation NEVER throws; the renderer always produces an image,
 * even if degraded. The agent learns from warnings on subsequent calls.
 */
import { CARD_LIMITS, type CardSpec, type Section } from './types';

export type ValidationResult = {
  spec: CardSpec;
  warnings: string[];
};

const METRIC_NAME_PATTERNS = [
  /\bhhi\b/i,
  /\bgini\b/i,
  /\bp-?value\b/i,
  /\bz-?score\b/i,
  /\br[-\s]?squared\b/i,
  /\br²/,
];

export function validateCardSpec(raw: CardSpec): ValidationResult {
  const warnings: string[] = [];
  const uniqueSeen = new Set<string>();
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];

  if (sectionsRaw.length === 0) {
    warnings.push('sections is empty; rendering minimal card.');
  }
  if (sectionsRaw.length > CARD_LIMITS.MAX_SECTIONS) {
    warnings.push(`${sectionsRaw.length} sections passed; sliced to ${CARD_LIMITS.MAX_SECTIONS}.`);
  }
  const sliced = sectionsRaw.slice(0, CARD_LIMITS.MAX_SECTIONS);

  // Per-type uniqueness — keep first, drop later.
  const UNIQUE_TYPES = new Set(['intro_body', 'big_number', 'comparison', 'sparkline', 'cta_row']);

  const out: Section[] = [];
  let sawCta = false;

  for (const s of sliced) {
    const valid = validateSection(s, warnings);
    if (!valid) continue;

    // cta_row must be last; drop sections after one.
    if (sawCta) {
      warnings.push(`section ${valid.type} dropped — must come before cta_row.`);
      continue;
    }
    if (UNIQUE_TYPES.has(valid.type)) {
      if (uniqueSeen.has(valid.type)) {
        warnings.push(`duplicate ${valid.type} dropped — only one per card.`);
        continue;
      }
      uniqueSeen.add(valid.type);
    }
    if (valid.type === 'cta_row') sawCta = true;
    out.push(valid);
  }

  // Stakeholder-voice guardrail: flag (but don't drop) any metric-name leakage
  // into kv_strip values or callouts.
  for (const s of out) {
    if (s.type === 'kv_strip') {
      for (const r of s.rows) {
        if (METRIC_NAME_PATTERNS.some((re) => re.test(r.key) || re.test(r.val))) {
          warnings.push(
            `kv_strip row "${r.key}" contains a metric name (HHI/Gini/etc); translate to plain English.`,
          );
        }
      }
    }
    if (s.type === 'callout') {
      if (METRIC_NAME_PATTERNS.some((re) => re.test(s.text))) {
        warnings.push('callout contains a metric name (HHI/Gini/etc); translate to plain English.');
      }
    }
  }

  const spec: CardSpec = {
    symbol: typeof raw.symbol === 'string' && raw.symbol.length > 0 ? raw.symbol.toLowerCase() : '$',
    label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label.toLowerCase() : 'card',
    logo: raw.logo !== false,
    updatedUtc: typeof raw.updatedUtc === 'string' ? raw.updatedUtc : undefined,
    footerText: typeof raw.footerText === 'string' ? raw.footerText : undefined,
    sections: out,
  };

  if (!raw.symbol) warnings.push('symbol missing; rendered with placeholder "$".');
  if (!raw.label) warnings.push('label missing; rendered with placeholder "card".');

  return { spec, warnings };
}

function validateSection(s: Section, warnings: string[]): Section | null {
  // Unknown type
  if (!s || typeof s !== 'object' || typeof (s as { type?: unknown }).type !== 'string') {
    warnings.push('section dropped — missing or non-string `type`.');
    return null;
  }
  switch (s.type) {
    case 'intro_body': {
      if (typeof s.text !== 'string' || s.text.length === 0) {
        warnings.push('intro_body dropped — text required.');
        return null;
      }
      return s;
    }
    case 'data_rows': {
      if (!Array.isArray(s.rows) || s.rows.length === 0) {
        warnings.push('data_rows dropped — rows required and non-empty.');
        return null;
      }
      // Clamp pct values per-row; drop rows missing name+value.
      const rows = s.rows
        .map((r) => {
          if (!r || typeof r.name !== 'string' || typeof r.value !== 'string') return null;
          let pct = r.pct;
          if (typeof pct === 'number' && Number.isFinite(pct)) {
            pct = Math.max(0, Math.min(100, pct));
          } else {
            pct = undefined;
          }
          return { ...r, pct };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length === 0) {
        warnings.push('data_rows dropped — all rows were invalid.');
        return null;
      }
      const capped = rows.slice(0, CARD_LIMITS.DATA_ROWS_HARD_MAX);
      if (rows.length > capped.length) {
        warnings.push(
          `data_rows truncated ${rows.length} -> ${capped.length} (hard cap ${CARD_LIMITS.DATA_ROWS_HARD_MAX}).`,
        );
      }
      return { ...s, rows: capped };
    }
    case 'big_number': {
      if (typeof s.value !== 'string' || s.value.length === 0) {
        warnings.push('big_number dropped — value required.');
        return null;
      }
      // Clamp/drop cap meter if malformed.
      if (s.cap) {
        if (typeof s.cap.pct !== 'number' || !Number.isFinite(s.cap.pct)) {
          warnings.push('big_number.cap dropped — pct must be a finite number.');
          const { cap: _drop, ...rest } = s;
          return rest;
        }
        const pct = Math.max(0, Math.min(100, s.cap.pct));
        return { ...s, cap: { ...s.cap, pct } };
      }
      return s;
    }
    case 'kv_strip': {
      if (!Array.isArray(s.rows) || s.rows.length === 0) {
        warnings.push('kv_strip dropped — rows required.');
        return null;
      }
      const rows = s.rows.filter((r) => r && typeof r.key === 'string' && typeof r.val === 'string');
      if (rows.length === 0) {
        warnings.push('kv_strip dropped — all rows invalid.');
        return null;
      }
      return { ...s, rows: rows.slice(0, CARD_LIMITS.KV_ROWS_SOFT_MAX) };
    }
    case 'comparison': {
      if (!s.left || !s.right || !s.left.value || !s.right.value) {
        warnings.push('comparison dropped — left.value and right.value required.');
        return null;
      }
      return s;
    }
    case 'sparkline': {
      const series = Array.isArray(s.series) ? s.series.filter((v) => Number.isFinite(v)) : [];
      if (series.length < CARD_LIMITS.SPARKLINE_MIN) {
        warnings.push('sparkline dropped — need at least 2 finite points.');
        return null;
      }
      // Drop reference line if malformed; clamp series first.
      const next = { ...s, series: series.slice(0, CARD_LIMITS.SPARKLINE_MAX) };
      if (s.reference) {
        if (typeof s.reference.value !== 'number' || !Number.isFinite(s.reference.value)) {
          warnings.push('sparkline.reference dropped — value must be a finite number.');
          const { reference: _drop, ...rest } = next;
          return rest;
        }
      }
      return next;
    }
    case 'histogram': {
      if (!Array.isArray(s.bins) || s.bins.length === 0) {
        warnings.push('histogram dropped — bins required.');
        return null;
      }
      const bins = s.bins.filter((b) => b && typeof b.label === 'string' && Number.isFinite(b.value));
      if (bins.length === 0) {
        warnings.push('histogram dropped — all bins invalid.');
        return null;
      }
      return { ...s, bins: bins.slice(0, CARD_LIMITS.HISTOGRAM_BINS_MAX) };
    }
    case 'badge_row': {
      if (!Array.isArray(s.badges) || s.badges.length === 0) {
        warnings.push('badge_row dropped — badges required.');
        return null;
      }
      return { ...s, badges: s.badges.slice(0, CARD_LIMITS.BADGES_MAX) };
    }
    case 'callout': {
      if (typeof s.text !== 'string' || s.text.length === 0) {
        warnings.push('callout dropped — text required.');
        return null;
      }
      return s;
    }
    case 'mini_table': {
      if (!Array.isArray(s.columns) || s.columns.length === 0) {
        warnings.push('mini_table dropped — columns required.');
        return null;
      }
      if (!Array.isArray(s.rows) || s.rows.length === 0) {
        warnings.push('mini_table dropped — rows required.');
        return null;
      }
      const cols = s.columns
        .filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string')
        .slice(0, CARD_LIMITS.MINI_TABLE_COLS_MAX);
      if (cols.length === 0) {
        warnings.push('mini_table dropped — no valid columns.');
        return null;
      }
      const rows = s.rows.filter(
        (r) => r && typeof r === 'object' && cols.some((c) => typeof r[c.key] === 'string'),
      );
      if (rows.length === 0) {
        warnings.push('mini_table dropped — no rows had any column key as a string.');
        return null;
      }
      const cap = Math.min(s.maxRows ?? 8, CARD_LIMITS.MINI_TABLE_ROWS_HARD_MAX);
      return { ...s, columns: cols, rows: rows.slice(0, cap) };
    }
    case 'cta_row': {
      if (!Array.isArray(s.buttons) || s.buttons.length === 0) {
        warnings.push('cta_row dropped — buttons required.');
        return null;
      }
      return { ...s, buttons: s.buttons.slice(0, CARD_LIMITS.CTA_MAX) };
    }
    default: {
      // Unknown discriminator
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      warnings.push(`section dropped — unknown type "${(s as any).type}".`);
      return null;
    }
  }
}
