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
  /** Visual theme. "dark" = terminal aesthetic on near-black bg (default).
   *  "light" = Torque brand light palette on white bg. */
  theme?: 'dark' | 'light';
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
  | GroupedBars
  | RangeBars
  | BadgeRow
  | Callout
  | MiniTable
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
  /**
   * Optional cap/utilization meter rendered beneath the value. `pct` is the
   * fill percentage 0-100. `label` is the pre-formatted "used / cap" string
   * (e.g. "$3,200 / $5,000 daily cap"). Use for cap utilization, budget burn,
   * goal progress.
   */
  cap?: { pct: number; label?: string };
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
  /**
   * Optional horizontal reference line drawn at `value` (same units as
   * series). Use for baseline, target, or threshold comparison
   * (e.g. "volume vs $44k baseline"). The reference value is included in the
   * y-axis range so the line is always visible.
   */
  reference?: { value: number; label?: string };
};

export type HistogramBin = { label: string; value: number; highlight?: boolean };

export type Histogram = {
  type: 'histogram';
  title?: string;
  bins: HistogramBin[];
  orientation?: 'vertical' | 'horizontal';
};

export type GroupedBarSeries = {
  /** Legend name for this series. */
  name: string;
  /** One bar value per category label; short arrays zero-pad, long truncate. */
  values: number[];
  /** Palette-mapped bar color. Defaults cycle green -> blue -> yellow. */
  color?: 'green' | 'blue' | 'red' | 'yellow' | 'slate';
};

export type GroupedBars = {
  type: 'grouped_bars';
  title?: string;
  /** Category labels along the x-axis (e.g. time slots). Max 12. */
  labels: string[];
  /** 1-3 series drawn side-by-side within each category. */
  series: GroupedBarSeries[];
  /** Optional dashed vertical divider drawn before category index `at`
   *  (an event boundary, e.g. a launch). `label` shows as a caption. */
  marker?: { at: number; label?: string };
  /** When false, hides the legend (default: shown when >1 series). */
  legend?: boolean;
};

export type RangeRow = {
  /** Row label, e.g. "Gross (DiD)". */
  label: string;
  /** Low / point-estimate / high of the range. Drawn as a whisker with a
   *  dot at `mid`, all rows sharing one axis for visual comparability. */
  lo: number;
  mid: number;
  hi: number;
  /** Palette-mapped color. Defaults cycle green -> blue -> yellow. */
  color?: 'green' | 'blue' | 'red' | 'yellow' | 'slate';
};

export type RangeBars = {
  type: 'range_bars';
  title?: string;
  /** 1-5 whisker rows on a shared horizontal axis. */
  rows: RangeRow[];
  /** Value prefix, e.g. "$". */
  prefix?: string;
  /** Value suffix, e.g. "M" or "%". */
  suffix?: string;
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

export type MiniTableColumn = {
  /** Object key the column reads from each row. */
  key: string;
  /** Human-readable header text (uppercased + muted by the renderer). */
  label: string;
  /** Column alignment; defaults to "left". */
  align?: 'left' | 'right';
};

export type MiniTable = {
  type: 'mini_table';
  title?: string;
  /** 2-4 columns. Excess sliced. */
  columns: MiniTableColumn[];
  /** Each row is a flat string map keyed by column.key. */
  rows: Array<Record<string, string>>;
  /** Default 8, hard cap 12. */
  maxRows?: number;
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
  KV_VAL_MAX: 140,
  CALLOUT_TEXT_MAX: 140,
  NAME_TEXT_MAX: 18,
  BIG_NUMBER_MAX_CHARS: 12,
  SPARKLINE_MIN: 2,
  SPARKLINE_MAX: 60,
  HISTOGRAM_BINS_MAX: 16,
  GROUPED_BARS_CATS_MAX: 12,
  GROUPED_BARS_SERIES_MAX: 3,
  RANGE_BARS_ROWS_MAX: 5,
  MINI_TABLE_COLS_MAX: 4,
  MINI_TABLE_ROWS_HARD_MAX: 12,
  MINI_TABLE_CELL_MAX: 24,
  CTA_MAX: 2,
} as const;
