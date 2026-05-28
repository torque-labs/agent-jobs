/**
 * Schema for the composable data-card system. The agent calls a single tool
 * `render_card({symbol, label, sections:[...], ...})` where `sections` is an
 * ordered array of typed primitives. The renderer iterates and draws each.
 *
 * Adding a new primitive: (1) add the type below; (2) export a render +
 * estimateHeight pair in cards/primitives.tsx; (3) add it to the dispatch table
 * in cards/render.tsx; (4) add a row in cards/validate.ts. The tool description
 * (in lib/agent-runtime.ts) is the authoritative behavioral guidance for the
 * agent — keep it in sync.
 */

// ---------------------------------------------------------------------------
// Card envelope — card-level props rendered as chrome around the sections.
// ---------------------------------------------------------------------------

export type CardSpec = {
  /** Status-bar token, lowercased, e.g. "$trump". */
  symbol: string;
  /** Status-bar section, lowercased, e.g. "leaderboard", "trend", "comparison". */
  label: string;
  /** When false, hide the Torque hex glyph (default: shown). */
  logo?: boolean;
  /** Optional pre-formatted footer timestamp, e.g. "14:32:08 utc". */
  updatedUtc?: string;
  /** Optional overrides for the footer left-side text (default: "data current"). */
  footerText?: string;
  /** Body sections in render order. Max 8 enforced server-side. */
  sections: Section[];
};

// ---------------------------------------------------------------------------
// Primitive section types — discriminated by `type`.
// ---------------------------------------------------------------------------

export type Section =
  | IntroBody
  | DataRows
  | BigNumber
  | KvStrip
  | Comparison
  | Sparkline
  | Histogram
  | BadgeRow
  | Callout
  | CtaRow
  // _InternalNote is used by render.tsx for the height-cap truncation marker
  // only. It is never exposed in the agent's tool schema or documented.
  | _InternalNote;

export type IntroBody = {
  type: 'intro_body';
  title?: string;
  text: string;
  muted?: string;
  emphasis?: 'default' | 'warn';
};

export type DataRow = {
  rank?: number | string;
  name: string;
  pct?: number;
  value: string;
  unit?: string;
  highlight?: boolean;
  accent?: 'blue' | 'yellow' | 'red' | 'green';
};

export type DataRows = {
  type: 'data_rows';
  title?: string;
  columns?: { name?: string; bar?: string; value?: string };
  rows: DataRow[];
  maxRows?: number;
};

export type BigNumber = {
  type: 'big_number';
  title?: string;
  value: string;
  label?: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  context?: string;
};

export type KvRow = {
  key: string;
  val: string;
  accent?: 'default' | 'warn' | 'alert' | 'ok';
};

export type KvStrip = {
  type: 'kv_strip';
  title?: string;
  rows: KvRow[];
};

export type Comparison = {
  type: 'comparison';
  title?: string;
  left: { label: string; value: string; unit?: string; sublabel?: string };
  right: { label: string; value: string; unit?: string; sublabel?: string };
  winner?: 'left' | 'right' | 'tie';
  delta?: string;
};

export type Sparkline = {
  type: 'sparkline';
  title?: string;
  series: number[];
  label?: string;
  start?: string;
  end?: string;
  endValue?: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  zeroBaseline?: boolean;
};

export type HistogramBin = { label: string; value: number; highlight?: boolean };

export type Histogram = {
  type: 'histogram';
  title?: string;
  bins: HistogramBin[];
  orientation?: 'vertical' | 'horizontal';
};

export type Badge = {
  label: string;
  value?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'alert' | 'info';
};

export type BadgeRow = {
  type: 'badge_row';
  badges: Badge[];
};

export type Callout = {
  type: 'callout';
  text: string;
  tone?: 'info' | 'warn' | 'alert' | 'ok';
  icon?: 'info' | 'warn' | 'check' | 'alert';
};

export type CtaButton = {
  text: string;
  style?: 'primary' | 'secondary';
  suffix?: 'arrow' | 'external' | 'none';
};

export type CtaRow = {
  type: 'cta_row';
  buttons: CtaButton[];
};

/** Internal-only — used by render.tsx for height-cap truncation marker. */
export type _InternalNote = {
  type: '_internal_note';
  text: string;
};

// ---------------------------------------------------------------------------
// Result envelope — validation produces warnings the orchestrator can log.
// ---------------------------------------------------------------------------

export type CardRenderResult = {
  png: Buffer;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Server-side limits (also reproduced in tool description / validation).
// ---------------------------------------------------------------------------

export const CARD_LIMITS = {
  MAX_SECTIONS: 8,
  MAX_HEIGHT: 1400,
  DATA_ROWS_HARD_MAX: 20,
  KV_ROWS_SOFT_MAX: 6,
  BADGES_MAX: 4,
  INTRO_TEXT_MAX: 280,
  KV_VAL_MAX: 60,
  CALLOUT_TEXT_MAX: 140,
  NAME_TEXT_MAX: 18,
  BIG_NUMBER_MAX_CHARS: 12,
  SPARKLINE_MIN: 2,
  SPARKLINE_MAX: 60,
  HISTOGRAM_BINS_MAX: 16,
  CTA_MAX: 2,
} as const;
