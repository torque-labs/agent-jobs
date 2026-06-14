/**
 * All 15 primitive section renderers + chrome helpers. Each primitive exports
 * a `render(props, palette): ReactElement` pair (palette is the active
 * TorqueTerminal/TorqueLight token bundle). Satori needs a fixed canvas
 * height up front, so per-primitive `estimate*Height` functions sum to give
 * render.tsx a number to pass in.
 *
 * Subset rules (recap from types.ts):
 *  - flexbox only (no CSS grid, no pseudo-elements)
 *  - inline styles only
 *  - we shorten the path to "<div style={{flexDirection:'row'…}}>" via small
 *    Row/Col helpers at the top.
 *
 * Theme handling — every render function takes a `palette: TorqueTerminal`
 * parameter so the same code emits both dark and light cards. Hardcoded
 * rgba tints (badge/callout backgrounds, data-row red/green dims, zebra
 * stripes) are computed via the local `tint()` helper from palette accent
 * colors, so they stay theme-correct.
 */
/** @jsxImportSource react */
import type { ReactElement, CSSProperties } from 'react';
import type { TorqueTerminal } from '../torque-brand';
import type {
  IntroBody,
  DataRows,
  DataRow,
  BigNumber,
  KvStrip,
  Comparison,
  Sparkline,
  Histogram,
  BadgeRow,
  Callout,
  MiniTable,
  CtaRow,
  _InternalNote,
} from './types';
import { CARD_LIMITS } from './types';

export const CARD_WIDTH = 720;
const PAD_X = 22;

// --- tiny layout + color helpers ---------------------------------------

const Row = ({ style, children }: { style?: CSSProperties; children?: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'row', ...style }}>{children}</div>
);

const Col = ({ style, children }: { style?: CSSProperties; children?: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>
);

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function shortAddr(s: string, max = 14): string {
  if (s.length <= max) return s;
  const keep = Math.max(3, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** Convert a #RRGGBB hex string to an rgba(...) string at the given opacity.
 *  Used to derive tinted accent backgrounds (badge bg, callout bg, zebra
 *  stripes) from the active palette so they're theme-correct. */
function tint(hex: string, opacity: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// --- chrome: status bar (with logo) + footer + section_rule --------------

export function renderStatusBar(
  symbol: string,
  label: string,
  logoDataUrl: string | null,
  P: TorqueTerminal,
): ReactElement {
  const sep = <span style={{ color: P.textTertiary, margin: '0 6px' }}>·</span>;
  return (
    <Row
      style={{
        alignItems: 'center',
        padding: '14px 22px 10px',
        fontSize: 10,
        letterSpacing: 1.2,
        color: P.textSecondary,
        textTransform: 'uppercase',
      }}
    >
      {logoDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img src={logoDataUrl} width={22} height={20} style={{ marginRight: 14 }} />
      ) : null}
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: P.accentGreen,
          marginRight: 10,
          boxShadow: `0 0 6px ${P.accentGreen}`,
        }}
      />
      <span style={{ color: P.textPrimary, fontWeight: 500 }}>live</span>
      {sep}
      <span>{symbol}</span>
      {sep}
      <span>{label}</span>
    </Row>
  );
}
export const STATUS_BAR_HEIGHT = 56;

export function renderFooter(
  updatedUtc: string | undefined,
  footerText: string | undefined,
  P: TorqueTerminal,
): ReactElement {
  return (
    <Row
      style={{
        alignItems: 'center',
        padding: '14px 22px',
        borderTop: `1px solid ${P.border}`,
        fontSize: 10,
        letterSpacing: 1.2,
        color: P.textSecondary,
        textTransform: 'uppercase',
      }}
    >
      {/* Plus sign (ASCII) substitutes for a checkmark — Geist Mono ships
          no ✓ glyph, so it renders as a tofu box. The green color carries
          the "ok / verified" semantic. */}
      <span style={{ color: P.accentGreen, marginRight: 10, fontWeight: 700 }}>+</span>
      <span>{footerText ?? 'data current'}</span>
      {updatedUtc ? (
        <>
          <span style={{ color: P.textTertiary, margin: '0 8px' }}>·</span>
          <span>{`updated ${updatedUtc}`}</span>
        </>
      ) : null}
    </Row>
  );
}
export const FOOTER_HEIGHT = 60;

function renderSectionRuleInternal(
  title: string,
  accent: 'default' | 'warn' | 'info',
  P: TorqueTerminal,
): ReactElement {
  const color = accent === 'warn' ? P.accentRed : accent === 'info' ? P.accentBlue : P.accentOrange;
  return (
    <Row
      style={{
        alignItems: 'center',
        padding: '14px 22px 10px',
        color,
        fontSize: 11,
        letterSpacing: 0.9,
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      <span style={{ marginRight: 10 }}>—</span>
      <span>{title.toLowerCase()}</span>
      <div
        style={{
          display: 'flex',
          flex: 1,
          marginLeft: 12,
          height: 0,
          borderTop: `1px dashed ${color}`,
          opacity: 0.5,
        }}
      />
    </Row>
  );
}
const SECTION_RULE_HEIGHT = 44;

// --- intro_body ---------------------------------------------------------

export function renderIntroBody(p: IntroBody, P: TorqueTerminal): ReactElement {
  const text = truncate(p.text, 280);
  const muted = p.muted ? truncate(p.muted, 120) : undefined;
  const warnBar = p.emphasis === 'warn';
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, warnBar ? 'warn' : 'default', P) : null}
      <Row
        style={{
          padding: '4px 22px 12px',
          color: P.textPrimary,
          fontSize: 13,
          lineHeight: 1.6,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'flex' }}>{text}</span>
        {muted ? (
          <span style={{ display: 'flex', color: P.textSecondary, marginLeft: 6 }}>{muted}</span>
        ) : null}
      </Row>
    </Col>
  );
}

export function estimateIntroBodyHeight(p: IntroBody): number {
  const lines = Math.ceil((p.text.length + (p.muted?.length ?? 0)) / 72);
  const body = Math.max(40, 20 + lines * 22);
  return (p.title ? SECTION_RULE_HEIGHT : 0) + body;
}

// --- data_rows ----------------------------------------------------------

const COL_NAME_W = 160;
const COL_VALUE_W = 100;

function renderDataHeader(
  cols: { name?: string; bar?: string; value?: string } | undefined,
  P: TorqueTerminal,
): ReactElement {
  const cell = (text: string, align: CSSProperties['justifyContent']): ReactElement => (
    <Row
      style={{
        justifyContent: align,
        color: P.textTertiary,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
      }}
    >
      {text}
    </Row>
  );
  return (
    <Row
      style={{
        alignItems: 'center',
        padding: '4px 0 10px',
        borderBottom: `1px dashed ${P.border}`,
        marginBottom: 6,
      }}
    >
      <Row style={{ width: COL_NAME_W }}>{cell(cols?.name ?? 'wallet', 'flex-start')}</Row>
      <Row style={{ flex: 1 }}>{cell(cols?.bar ?? 'holdings', 'flex-start')}</Row>
      <Row style={{ width: COL_VALUE_W, justifyContent: 'flex-end' }}>
        {cell(cols?.value ?? 'amount', 'flex-end')}
      </Row>
    </Row>
  );
}

function renderDataRow(
  r: DataRow,
  hasRank: boolean,
  hasBar: boolean,
  P: TorqueTerminal,
): ReactElement {
  const accentColor: Record<NonNullable<DataRow['accent']>, string> = {
    blue: P.accentBlue,
    yellow: P.accentYellow,
    red: P.accentRed,
    green: P.accentGreen,
  };
  const accentDim: Record<NonNullable<DataRow['accent']>, string> = {
    blue: P.accentBlueDim,
    yellow: P.accentYellowDim,
    red: tint(P.accentRed, 0.18),
    green: tint(P.accentGreen, 0.18),
  };
  const fg = r.highlight
    ? P.accentYellow
    : r.accent
      ? accentColor[r.accent]
      : P.accentBlue;
  const dim = r.highlight
    ? P.accentYellowDim
    : r.accent
      ? accentDim[r.accent]
      : P.accentBlueDim;
  const nameColor = r.highlight ? P.accentYellow : P.textPrimary;
  const rankStr = hasRank ? (typeof r.rank === 'number' ? String(r.rank).padStart(2, '0') : (r.rank ?? '')) : '';
  const name = shortAddr(r.name, 18);
  const pct = Math.max(0, Math.min(100, r.pct ?? 0));
  return (
    <Row
      key={`${r.rank}-${r.name}`}
      style={{ alignItems: 'center', padding: '7px 0', fontSize: 12 }}
    >
      <Row
        style={{
          width: COL_NAME_W,
          color: nameColor,
          fontWeight: r.highlight ? 500 : 400,
        }}
      >
        {hasRank ? <span style={{ color: P.textTertiary, marginRight: 10 }}>{rankStr}</span> : null}
        <span>{name}</span>
      </Row>
      <Row style={{ flex: 1, marginRight: 14 }}>
        {hasBar ? (
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
                width: `${pct}%`,
                height: '100%',
                backgroundColor: fg,
              }}
            />
          </div>
        ) : (
          <span> </span>
        )}
      </Row>
      <Row
        style={{
          width: COL_VALUE_W,
          justifyContent: 'flex-end',
          color: P.textPrimary,
          fontWeight: 500,
        }}
      >
        <span>{r.value}</span>
        {r.unit ? <span style={{ color: P.textSecondary, marginLeft: 2 }}>{r.unit}</span> : null}
      </Row>
    </Row>
  );
}

export function renderDataRows(p: DataRows, P: TorqueTerminal): ReactElement {
  const rows = p.rows.slice(0, Math.min(p.maxRows ?? 10, 20));
  const hasRank = rows.some((r) => r.rank !== undefined);
  const hasBar = rows.some((r) => r.pct !== undefined);
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '4px 22px 14px' }}>
        {renderDataHeader(p.columns, P)}
        {rows.map((r) => renderDataRow(r, hasRank, hasBar, P))}
      </Col>
    </Col>
  );
}

export function estimateDataRowsHeight(p: DataRows): number {
  const n = Math.min(p.rows.length, Math.min(p.maxRows ?? 10, 20));
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 36 + n * 34;
}

// --- big_number ---------------------------------------------------------

export function renderBigNumber(p: BigNumber, P: TorqueTerminal): ReactElement {
  const value = truncate(p.value, 14);
  const dir = p.delta?.direction;
  const deltaColor = dir === 'up' ? P.accentGreen : dir === 'down' ? P.accentRed : P.textSecondary;
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  // Shrink value font when long.
  const valueFont = value.length > 8 ? 56 : value.length > 5 ? 72 : 88;
  const capPct = p.cap ? Math.max(0, Math.min(100, p.cap.pct)) : 0;
  // Color the meter by saturation: blue well below cap, yellow approaching,
  // red at/over cap.
  const capColor =
    capPct >= 95 ? P.accentRed : capPct >= 75 ? P.accentYellow : P.accentBlue;
  const capDim =
    capPct >= 95 ? tint(P.accentRed, 0.18) : capPct >= 75 ? P.accentYellowDim : P.accentBlueDim;
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '12px 22px 18px' }}>
        <Row style={{ alignItems: 'baseline' }}>
          <span style={{ color: P.textPrimary, fontSize: valueFont, fontWeight: 700, lineHeight: 1 }}>
            {value}
          </span>
          {p.label ? (
            <span style={{ color: P.textSecondary, fontSize: 14, marginLeft: 12 }}>{p.label}</span>
          ) : null}
        </Row>
        {p.delta ? (
          <Row style={{ marginTop: 8, alignItems: 'center' }}>
            <span style={{ color: deltaColor, fontSize: 14, fontWeight: 500 }}>
              {arrow} {p.delta.value}
            </span>
          </Row>
        ) : null}
        {p.cap ? (
          <Col style={{ marginTop: 14 }}>
            <div style={{ position: 'relative', width: '100%', height: 8, display: 'flex' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  backgroundColor: capDim,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: `${capPct}%`,
                  height: '100%',
                  backgroundColor: capColor,
                }}
              />
            </div>
            {p.cap.label ? (
              <Row style={{ marginTop: 6 }}>
                <span style={{ color: P.textSecondary, fontSize: 12 }}>{truncate(p.cap.label, 80)}</span>
              </Row>
            ) : null}
          </Col>
        ) : null}
        {p.context ? (
          <Row style={{ marginTop: 6 }}>
            <span style={{ color: P.textSecondary, fontSize: 12 }}>{truncate(p.context, 120)}</span>
          </Row>
        ) : null}
      </Col>
    </Col>
  );
}

export function estimateBigNumberHeight(p: BigNumber): number {
  let h = p.title ? SECTION_RULE_HEIGHT : 0;
  h += 12 + 88; // top pad + value
  if (p.delta) h += 8 + 18;
  if (p.cap) h += 14 + 8 + (p.cap.label ? 6 + 16 : 0);
  if (p.context) h += 6 + 16;
  return h + 18;
}

// --- kv_strip -----------------------------------------------------------

function kvAccentColors(
  accent: NonNullable<KvStrip['rows'][0]['accent']>,
  P: TorqueTerminal,
): { key: string; val: string } {
  switch (accent) {
    case 'alert':
      return { key: P.accentRed, val: P.accentRed };
    case 'warn':
      return { key: P.accentOrange, val: P.accentOrange };
    case 'ok':
      return { key: P.accentGreen, val: P.accentGreen };
    default:
      return { key: P.textSecondary, val: P.textPrimary };
  }
}

export function renderKvStrip(p: KvStrip, P: TorqueTerminal): ReactElement {
  const rows = p.rows.slice(0, 6);
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '4px 22px 14px' }}>
        {rows.map((r, idx) => {
          const c = kvAccentColors(r.accent ?? 'default', P);
          return (
            <Row key={`${idx}-${r.key}`} style={{ padding: '4px 0', fontSize: 12, lineHeight: 1.6 }}>
              <Row style={{ width: 150, color: c.key }}>{r.key.toLowerCase()}</Row>
              <Row
                style={{
                  flex: 1,
                  color: c.val,
                  fontWeight: r.accent && r.accent !== 'default' ? 500 : 400,
                  flexWrap: 'wrap',
                }}
              >
                {truncate(r.val, CARD_LIMITS.KV_VAL_MAX)}
              </Row>
            </Row>
          );
        })}
      </Col>
    </Col>
  );
}

export function estimateKvStripHeight(p: KvStrip): number {
  // Per-row height grows with val length to accommodate wrap. The val column
  // is ~530px at fontSize 12 (~80 chars/line) — anything over ~75 chars wraps
  // to a second visual line, anything over ~150 to a third.
  const rowH = (val: string): number => (val.length <= 75 ? 30 : val.length <= 150 ? 52 : 74);
  const visible = p.rows.slice(0, Math.min(p.rows.length, 6));
  const sum = visible.reduce((s, r) => s + rowH(String(r.val ?? '')), 0);
  return (p.title ? SECTION_RULE_HEIGHT : 0) + sum + 18;
}

// --- comparison ---------------------------------------------------------

export function renderComparison(p: Comparison, P: TorqueTerminal): ReactElement {
  const winnerColor = (side: 'left' | 'right') =>
    p.winner === side ? P.accentGreen : P.textPrimary;
  const renderSide = (side: 'left' | 'right') => {
    const s = side === 'left' ? p.left : p.right;
    return (
      <Col style={{ flex: 1, padding: '12px 22px', alignItems: 'flex-start' }}>
        <span style={{ color: P.textSecondary, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          {s.label}
        </span>
        <Row style={{ marginTop: 8, alignItems: 'baseline' }}>
          <span style={{ color: winnerColor(side), fontSize: 40, fontWeight: 700, lineHeight: 1 }}>
            {truncate(s.value, 10)}
          </span>
          {s.unit ? (
            <span style={{ color: P.textSecondary, fontSize: 14, marginLeft: 8 }}>{s.unit}</span>
          ) : null}
        </Row>
        {s.sublabel ? (
          <span style={{ color: P.textSecondary, fontSize: 12, marginTop: 4 }}>{truncate(s.sublabel, 60)}</span>
        ) : null}
      </Col>
    );
  };
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Row style={{ alignItems: 'stretch' }}>
        {renderSide('left')}
        <Col style={{ width: 1, backgroundColor: P.border, margin: '12px 0' }} />
        {renderSide('right')}
      </Row>
      {p.delta ? (
        <Row style={{ padding: '0 22px 14px' }}>
          <span style={{ color: P.textSecondary, fontSize: 12 }}>{truncate(p.delta, 80)}</span>
        </Row>
      ) : null}
    </Col>
  );
}

export function estimateComparisonHeight(p: Comparison): number {
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 110 + (p.delta ? 24 : 0);
}

// --- sparkline (SVG line) -----------------------------------------------

function buildSparklinePath(
  series: number[],
  w: number,
  h: number,
  zero: boolean,
  refValue?: number,
): { path: string; refY: number | null } {
  if (series.length < 2) return { path: '', refY: null };
  const refIncluded = typeof refValue === 'number' && Number.isFinite(refValue);
  const min = zero
    ? 0
    : refIncluded
      ? Math.min(...series, refValue!)
      : Math.min(...series);
  const max = refIncluded ? Math.max(...series, refValue!) : Math.max(...series);
  const range = max === min ? 1 : max - min;
  const step = w / (series.length - 1);
  const path = series
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const refY = refIncluded ? h - ((refValue! - min) / range) * h : null;
  return { path, refY };
}

export function renderSparkline(p: Sparkline, P: TorqueTerminal): ReactElement {
  const series = p.series.filter((v) => Number.isFinite(v));
  const w = CARD_WIDTH - PAD_X * 2;
  const h = 76;
  const { path, refY } = buildSparklinePath(
    series,
    w,
    h,
    Boolean(p.zeroBaseline),
    p.reference?.value,
  );
  const areaPath = path ? `${path} L${w},${h} L0,${h} Z` : '';
  const dir = p.delta?.direction;
  const deltaColor = dir === 'up' ? P.accentGreen : dir === 'down' ? P.accentRed : P.textSecondary;
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  // satori doesn't support real <svg> sub-elements; embed via data URL <img>.
  // Reference line: dashed horizontal at the y-coordinate of refValue.
  const refLineSvg =
    refY !== null
      ? `<line x1="0" y1="${refY.toFixed(2)}" x2="${w}" y2="${refY.toFixed(2)}" stroke="${P.accentYellow}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`
      : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${areaPath}" fill="${P.accentBlueDim}"/><path d="${path}" stroke="${P.accentBlue}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${refLineSvg}</svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '6px 22px 12px' }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={dataUrl} width={w} height={h} />
        {p.reference?.label ? (
          <Row style={{ marginTop: 4 }}>
            <span style={{ color: P.accentYellow, fontSize: 11, letterSpacing: 0.4 }}>
              {`— — ${truncate(p.reference.label, 60)}`}
            </span>
          </Row>
        ) : null}
        <Row style={{ marginTop: 6, alignItems: 'baseline' }}>
          {p.start ? <span style={{ color: P.textTertiary, fontSize: 11 }}>{p.start}</span> : null}
          <Row style={{ flex: 1 }} />
          {p.delta ? (
            <span style={{ color: deltaColor, fontSize: 12, fontWeight: 500, marginRight: 12 }}>
              {arrow} {p.delta.value}
            </span>
          ) : null}
          {p.endValue ? (
            <span style={{ color: P.textPrimary, fontSize: 14, fontWeight: 500 }}>{p.endValue}</span>
          ) : null}
          {p.end ? <span style={{ color: P.textTertiary, fontSize: 11, marginLeft: 8 }}>{p.end}</span> : null}
        </Row>
      </Col>
    </Col>
  );
}

export function estimateSparklineHeight(p: Sparkline): number {
  return (
    (p.title ? SECTION_RULE_HEIGHT : 0) +
    6 + 76 +
    (p.reference?.label ? 4 + 16 : 0) +
    6 + 22 + 12
  );
}

// --- histogram (vertical bars) -----------------------------------------

export function renderHistogram(p: Histogram, P: TorqueTerminal): ReactElement {
  const bins = p.bins.slice(0, 16);
  const max = bins.length === 0 ? 1 : Math.max(...bins.map((b) => Math.max(0, b.value)));
  const orientation = p.orientation ?? 'vertical';

  if (orientation === 'horizontal') {
    return (
      <Col>
        {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
        <Col style={{ padding: '4px 22px 14px' }}>
          {bins.map((b, idx) => {
            const pct = max === 0 ? 0 : Math.max(0, b.value) / max * 100;
            const fg = b.highlight ? P.accentYellow : P.accentBlue;
            const dim = b.highlight ? P.accentYellowDim : P.accentBlueDim;
            return (
              <Row key={`${idx}-${b.label}`} style={{ alignItems: 'center', padding: '5px 0', fontSize: 12 }}>
                <Row style={{ width: 140, color: P.textPrimary }}>{truncate(b.label, 18)}</Row>
                <Row style={{ flex: 1, marginRight: 14 }}>
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
                        width: `${pct}%`,
                        height: '100%',
                        backgroundColor: fg,
                      }}
                    />
                  </div>
                </Row>
                <Row style={{ width: 80, justifyContent: 'flex-end', color: P.textPrimary }}>
                  <span>{b.value.toLocaleString()}</span>
                </Row>
              </Row>
            );
          })}
        </Col>
      </Col>
    );
  }

  // Vertical bars
  const chartH = 160;
  const totalW = CARD_WIDTH - PAD_X * 2;
  const barGap = 6;
  const barW = Math.max(8, (totalW - (bins.length - 1) * barGap) / Math.max(bins.length, 1));
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '6px 22px 4px' }}>
        <Row style={{ alignItems: 'flex-end', height: chartH }}>
          {bins.map((b, idx) => {
            const pct = max === 0 ? 0 : Math.max(0, b.value) / max * 100;
            const h = (pct / 100) * chartH;
            const fg = b.highlight ? P.accentYellow : P.accentBlue;
            return (
              <Col
                key={`${idx}-${b.label}`}
                style={{
                  width: barW,
                  marginRight: idx === bins.length - 1 ? 0 : barGap,
                  alignItems: 'center',
                }}
              >
                <Col style={{ flex: 1, justifyContent: 'flex-end' }}>
                  <div style={{ width: barW, height: Math.max(6, h), backgroundColor: fg, display: 'flex' }} />
                </Col>
              </Col>
            );
          })}
        </Row>
        <Row style={{ marginTop: 6 }}>
          {bins.map((b, idx) => (
            <Row
              key={`${idx}-l-${b.label}`}
              style={{
                width: barW,
                marginRight: idx === bins.length - 1 ? 0 : barGap,
                justifyContent: 'center',
                color: P.textTertiary,
                fontSize: 10,
                letterSpacing: 0.6,
              }}
            >
              {truncate(b.label, 10)}
            </Row>
          ))}
        </Row>
      </Col>
    </Col>
  );
}

export function estimateHistogramHeight(p: Histogram): number {
  if ((p.orientation ?? 'vertical') === 'horizontal') {
    return (p.title ? SECTION_RULE_HEIGHT : 0) + Math.min(p.bins.length, 16) * 28 + 18;
  }
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 6 + 160 + 24 + 4;
}

// --- badge_row ----------------------------------------------------------

function badgeToneColors(
  tone: NonNullable<BadgeRow['badges'][0]['tone']>,
  P: TorqueTerminal,
): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'ok':
      return { bg: tint(P.accentGreen, 0.15), fg: P.accentGreen, border: tint(P.accentGreen, 0.45) };
    case 'warn':
      return { bg: tint(P.accentOrange, 0.15), fg: P.accentOrange, border: tint(P.accentOrange, 0.45) };
    case 'alert':
      return { bg: tint(P.accentRed, 0.15), fg: P.accentRed, border: tint(P.accentRed, 0.45) };
    case 'info':
      return { bg: tint(P.accentBlue, 0.15), fg: P.accentBlue, border: tint(P.accentBlue, 0.45) };
    default:
      return { bg: tint(P.textPrimary, 0.05), fg: P.textSecondary, border: tint(P.textPrimary, 0.18) };
  }
}

export function renderBadgeRow(p: BadgeRow, P: TorqueTerminal): ReactElement {
  const badges = p.badges.slice(0, 4);
  return (
    <Row style={{ padding: '6px 22px 14px', flexWrap: 'wrap' }}>
      {badges.map((b, idx) => {
        const c = badgeToneColors(b.tone ?? 'neutral', P);
        return (
          <Row
            key={`${idx}-${b.label}`}
            style={{
              padding: '6px 12px',
              marginRight: 8,
              marginBottom: 6,
              backgroundColor: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 4,
              fontSize: 10,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              color: c.fg,
              alignItems: 'center',
            }}
          >
            <span style={{ fontWeight: 500 }}>{b.label}</span>
            {b.value ? (
              <>
                <span style={{ color: P.textTertiary, margin: '0 6px' }}>·</span>
                <span style={{ color: P.textPrimary }}>{b.value}</span>
              </>
            ) : null}
          </Row>
        );
      })}
    </Row>
  );
}

export function estimateBadgeRowHeight(_p: BadgeRow): number {
  return 50;
}

// --- callout ------------------------------------------------------------

function calloutToneColors(
  tone: NonNullable<Callout['tone']>,
  P: TorqueTerminal,
): { bg: string; border: string; fg: string } {
  switch (tone) {
    case 'warn':
      return { bg: tint(P.accentOrange, 0.10), border: P.accentOrange, fg: P.textPrimary };
    case 'alert':
      return { bg: tint(P.accentRed, 0.10), border: P.accentRed, fg: P.textPrimary };
    case 'ok':
      return { bg: tint(P.accentGreen, 0.10), border: P.accentGreen, fg: P.textPrimary };
    default:
      return { bg: tint(P.accentBlue, 0.10), border: P.accentBlue, fg: P.textPrimary };
  }
}

// Geist Mono doesn't ship glyphs for most unicode symbols (ⓘ, ⚠, ✓, etc.)
// — they render as missing-glyph tofu boxes. Stick to ASCII so every icon
// paints reliably. The tone color (border + tinted bg) carries the
// "info/warn/alert/ok" semantic; the glyph is just a visual anchor.
const CALLOUT_ICONS: Record<NonNullable<Callout['icon']>, string> = {
  info: 'i',
  warn: '!',
  check: '+',
  alert: '!',
};

export function renderCallout(p: Callout, P: TorqueTerminal): ReactElement {
  const c = calloutToneColors(p.tone ?? 'info', P);
  const icon = p.icon ? CALLOUT_ICONS[p.icon] : null;
  return (
    <Col style={{ padding: '6px 22px 14px' }}>
      <Row
        style={{
          padding: 14,
          backgroundColor: c.bg,
          borderLeft: `3px solid ${c.border}`,
          borderRadius: 2,
          alignItems: 'center',
          color: c.fg,
          fontSize: 13,
        }}
      >
        {icon ? <span style={{ color: c.border, marginRight: 10, fontWeight: 700 }}>{icon}</span> : null}
        <span>{truncate(p.text, 140)}</span>
      </Row>
    </Col>
  );
}

export function estimateCalloutHeight(_p: Callout): number {
  return 64;
}

// --- mini_table ---------------------------------------------------------
//
// Multi-column data grid (2-4 columns). Use when the answer is genuinely
// tabular and data_rows (single bar + value column) doesn't fit. Example:
// referral table with Referrer / Referee / Balance / Score.

export function renderMiniTable(p: MiniTable, P: TorqueTerminal): ReactElement {
  const cols = (p.columns ?? []).slice(0, 4);
  const maxRows = Math.min(p.maxRows ?? 8, 12);
  const rows = (p.rows ?? []).slice(0, maxRows);
  const totalW = CARD_WIDTH - PAD_X * 2;
  const colW = cols.length > 0 ? totalW / cols.length : totalW;
  const cellMax = 24;
  const zebra = tint(P.textPrimary, 0.015);
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, 'default', P) : null}
      <Col style={{ padding: '4px 22px 14px' }}>
        {/* Header row */}
        <Row
          style={{
            padding: '4px 0 10px',
            borderBottom: `1px dashed ${P.border}`,
            marginBottom: 6,
          }}
        >
          {cols.map((c) => (
            <Row
              key={`h-${c.key}`}
              style={{
                width: colW,
                justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
                color: P.textTertiary,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              {c.label}
            </Row>
          ))}
        </Row>
        {/* Data rows */}
        {rows.map((r, idx) => (
          <Row
            key={`r-${idx}`}
            style={{
              padding: '6px 0',
              fontSize: 12,
              // Subtle zebra striping for legibility on dense tables.
              backgroundColor: idx % 2 === 1 ? zebra : 'transparent',
            }}
          >
            {cols.map((c) => (
              <Row
                key={`${idx}-${c.key}`}
                style={{
                  width: colW,
                  justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
                  color: P.textPrimary,
                }}
              >
                {truncate(String(r[c.key] ?? '—'), cellMax)}
              </Row>
            ))}
          </Row>
        ))}
      </Col>
    </Col>
  );
}

export function estimateMiniTableHeight(p: MiniTable): number {
  const n = Math.min((p.rows ?? []).length, Math.min(p.maxRows ?? 8, 12));
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 28 + n * 30 + 18;
}

// --- cta_row ------------------------------------------------------------

export function renderCtaRow(p: CtaRow, P: TorqueTerminal): ReactElement {
  const buttons = p.buttons.slice(0, 2);
  return (
    <Row style={{ padding: '4px 22px 22px' }}>
      {buttons.map((b, idx) => {
        const primary = b.style !== 'secondary';
        const suffix = b.suffix === 'external' ? '↗' : b.suffix === 'none' ? '' : '→';
        return (
          <Row
            key={`${idx}-${b.text}`}
            style={{
              flex: 1,
              marginRight: idx === buttons.length - 1 ? 0 : 10,
              padding: 14,
              backgroundColor: primary ? P.terminalBgSoft : 'transparent',
              border: `1px solid ${primary ? tint(P.textPrimary, 0.18) : P.border}`,
              borderRadius: 4,
              alignItems: 'center',
              justifyContent: 'center',
              color: P.textPrimary,
              fontSize: 12,
              letterSpacing: 1.1,
              fontWeight: 500,
              textTransform: 'uppercase',
            }}
          >
            <span>{b.text}</span>
            {suffix ? <span style={{ color: P.textSecondary, marginLeft: 8 }}>{suffix}</span> : null}
          </Row>
        );
      })}
    </Row>
  );
}

export function estimateCtaRowHeight(_p: CtaRow): number {
  return 78;
}

// --- _internal_note (NOT agent-facing) ----------------------------------
// Internal-only marker primitive used by render.tsx's height-cap truncation
// path. Not in the tool schema, not in the validator's user-facing types.

export function renderInternalNote(p: _InternalNote, P: TorqueTerminal): ReactElement {
  return (
    <Row style={{ padding: '4px 22px 12px' }}>
      <span style={{ color: P.textTertiary, fontSize: 11, letterSpacing: 0.4 }}>
        {truncate(p.text, 200)}
      </span>
    </Row>
  );
}

export function estimateInternalNoteHeight(_p: _InternalNote): number {
  return 32;
}
