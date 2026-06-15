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
    theme: raw.theme === 'dark' ? 'dark' : 'light',
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
      // Auto-coerce numeric values to strings. LLMs frequently pass `42`
      // instead of `"42"` for big_number.value, and the strict-string check
      // silently dropped the whole section. Accepting either is harmless
      // since we always render it as text.
      const rawValue = (s as { value?: unknown }).value;
      let value: string;
      if (typeof rawValue === 'string') {
        value = rawValue;
      } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        value = String(rawValue);
      } else {
        warnings.push('big_number dropped — value required (string or finite number).');
        return null;
      }
      if (value.length === 0) {
        warnings.push('big_number dropped — value must be non-empty.');
        return null;
      }
      const coerced = { ...s, value };
      // Clamp/drop cap meter if malformed.
      if (coerced.cap) {
        if (typeof coerced.cap.pct !== 'number' || !Number.isFinite(coerced.cap.pct)) {
          warnings.push('big_number.cap dropped — pct must be a finite number.');
          const { cap: _drop, ...rest } = coerced;
          return rest;
        }
        const pct = Math.max(0, Math.min(100, coerced.cap.pct));
        return { ...coerced, cap: { ...coerced.cap, pct } };
      }
      return coerced;
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
    case 'grouped_bars': {
      // Coerce (don't filter) labels so label<->value index alignment is
      // preserved — dropping a middle label would shift every later series
      // value under the wrong category.
      const labels = (Array.isArray(s.labels) ? s.labels : [])
        .map((l) => (typeof l === 'string' ? l : l == null ? '' : String(l)))
        .slice(0, CARD_LIMITS.GROUPED_BARS_CATS_MAX);
      if (labels.length === 0) {
        warnings.push('grouped_bars dropped — labels required.');
        return null;
      }
      const series = (Array.isArray(s.series) ? s.series : [])
        .filter(
          (ser) =>
            ser &&
            typeof ser.name === 'string' &&
            Array.isArray(ser.values) &&
            // A finite value must fall inside the visible label window, or the
            // section renders as all-zero bars.
            ser.values.slice(0, labels.length).some((v) => Number.isFinite(v)),
        )
        .slice(0, CARD_LIMITS.GROUPED_BARS_SERIES_MAX);
      if (series.length === 0) {
        warnings.push('grouped_bars dropped — need a series with a finite value in the label window.');
        return null;
      }
      let marker = s.marker;
      if (marker) {
        if (typeof marker.at !== 'number' || !Number.isFinite(marker.at)) {
          warnings.push('grouped_bars.marker dropped — at must be a finite number.');
          marker = undefined;
        } else {
          marker = { at: marker.at, label: typeof marker.label === 'string' ? marker.label : undefined };
        }
      }
      return { ...s, labels, series, marker };
    }
    case 'range_bars': {
      const rows = (Array.isArray(s.rows) ? s.rows : [])
        .filter(
          (r) =>
            r &&
            typeof r.label === 'string' &&
            [r.lo, r.mid, r.hi].every((v) => typeof v === 'number' && Number.isFinite(v)),
        )
        // Normalize so lo <= hi and mid sits within [lo, hi] — guards against
        // inverted whiskers, out-of-range dots, and bogus axes.
        .map((r) => {
          const lo = Math.min(r.lo, r.hi);
          const hi = Math.max(r.lo, r.hi);
          const mid = Math.max(lo, Math.min(hi, r.mid));
          return { ...r, lo, mid, hi };
        })
        .slice(0, CARD_LIMITS.RANGE_BARS_ROWS_MAX);
      if (rows.length === 0) {
        warnings.push('range_bars dropped — need rows with label + finite lo/mid/hi.');
        return null;
      }
      return { ...s, rows };
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
