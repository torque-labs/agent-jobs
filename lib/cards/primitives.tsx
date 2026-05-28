/**
 * All 15 primitive section renderers + chrome helpers. Each primitive exports
 * a `render(props): ReactElement` and an `estimateHeight(props): number` pair.
 * Satori needs a fixed canvas height up front, so per-primitive height
 * estimates summed in the orchestrator (cards/render.tsx) is how we pick it.
 *
 * Subset rules (recap from cards/types.ts):
 *  - flexbox only (no CSS grid, no pseudo-elements)
 *  - inline styles only
 *  - we shorten the path to "<div style={{flexDirection:'row'…}}>" by using a
 *    small Row/Col helper at the top.
 */
/** @jsxImportSource react */
import type { ReactElement, CSSProperties } from 'react';
import { TORQUE_TERMINAL } from '../torque-brand';
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
  CtaRow,
} from './types';

const P = TORQUE_TERMINAL;
export const CARD_WIDTH = 720;
const PAD_X = 22;

// --- tiny layout helpers -------------------------------------------------

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

// --- chrome: status bar (with logo) + footer + section_rule --------------

export function renderStatusBar(
  symbol: string,
  label: string,
  logoDataUrl: string | null,
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

export function renderFooter(updatedUtc?: string, footerText?: string): ReactElement {
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
      <span style={{ color: P.accentGreen, marginRight: 10 }}>✓</span>
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
  accent: 'default' | 'warn' | 'info' = 'default',
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

export function renderIntroBody(p: IntroBody): ReactElement {
  const text = truncate(p.text, 280);
  const muted = p.muted ? truncate(p.muted, 120) : undefined;
  const warnBar = p.emphasis === 'warn';
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title, warnBar ? 'warn' : 'default') : null}
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

function renderDataHeader(cols?: { name?: string; bar?: string; value?: string }): ReactElement {
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

function renderDataRow(r: DataRow, hasRank: boolean, hasBar: boolean): ReactElement {
  const accentColor: Record<NonNullable<DataRow['accent']>, string> = {
    blue: P.accentBlue,
    yellow: P.accentYellow,
    red: P.accentRed,
    green: P.accentGreen,
  };
  const accentDim: Record<NonNullable<DataRow['accent']>, string> = {
    blue: P.accentBlueDim,
    yellow: P.accentYellowDim,
    red: 'rgba(227,123,107,0.18)',
    green: 'rgba(93,216,155,0.18)',
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

export function renderDataRows(p: DataRows): ReactElement {
  const rows = p.rows.slice(0, Math.min(p.maxRows ?? 10, 20));
  const hasRank = rows.some((r) => r.rank !== undefined);
  const hasBar = rows.some((r) => r.pct !== undefined);
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title) : null}
      <Col style={{ padding: '4px 22px 14px' }}>
        {renderDataHeader(p.columns)}
        {rows.map((r) => renderDataRow(r, hasRank, hasBar))}
      </Col>
    </Col>
  );
}

export function estimateDataRowsHeight(p: DataRows): number {
  const n = Math.min(p.rows.length, Math.min(p.maxRows ?? 10, 20));
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 36 + n * 34;
}

// --- big_number ---------------------------------------------------------

export function renderBigNumber(p: BigNumber): ReactElement {
  const value = truncate(p.value, 14);
  const dir = p.delta?.direction;
  const deltaColor = dir === 'up' ? P.accentGreen : dir === 'down' ? P.accentRed : P.textSecondary;
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  // Shrink value font when long.
  const valueFont = value.length > 8 ? 56 : value.length > 5 ? 72 : 88;
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title) : null}
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
  if (p.context) h += 6 + 16;
  return h + 18;
}

// --- kv_strip -----------------------------------------------------------

function kvAccentColors(accent: NonNullable<KvStrip['rows'][0]['accent']>): { key: string; val: string } {
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

export function renderKvStrip(p: KvStrip): ReactElement {
  const rows = p.rows.slice(0, 6);
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title) : null}
      <Col style={{ padding: '4px 22px 14px' }}>
        {rows.map((r, idx) => {
          const c = kvAccentColors(r.accent ?? 'default');
          return (
            <Row key={`${idx}-${r.key}`} style={{ padding: '4px 0', fontSize: 12, lineHeight: 1.6 }}>
              <Row style={{ width: 150, color: c.key }}>{r.key.toLowerCase()}</Row>
              <Row style={{ flex: 1, color: c.val, fontWeight: r.accent && r.accent !== 'default' ? 500 : 400 }}>
                {truncate(r.val, 60)}
              </Row>
            </Row>
          );
        })}
      </Col>
    </Col>
  );
}

export function estimateKvStripHeight(p: KvStrip): number {
  return (p.title ? SECTION_RULE_HEIGHT : 0) + Math.min(p.rows.length, 6) * 30 + 18;
}

// --- comparison ---------------------------------------------------------

export function renderComparison(p: Comparison): ReactElement {
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
      {p.title ? renderSectionRuleInternal(p.title) : null}
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

function buildSparklinePath(series: number[], w: number, h: number, zero: boolean): string {
  if (series.length < 2) return '';
  const min = zero ? 0 : Math.min(...series);
  const max = Math.max(...series);
  const range = max === min ? 1 : max - min;
  const step = w / (series.length - 1);
  return series
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function renderSparkline(p: Sparkline): ReactElement {
  const series = p.series.filter((v) => Number.isFinite(v));
  const w = CARD_WIDTH - PAD_X * 2;
  const h = 76;
  const path = buildSparklinePath(series, w, h, Boolean(p.zeroBaseline));
  const areaPath = path ? `${path} L${w},${h} L0,${h} Z` : '';
  const dir = p.delta?.direction;
  const deltaColor = dir === 'up' ? P.accentGreen : dir === 'down' ? P.accentRed : P.textSecondary;
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  // satori doesn't support real <svg> sub-elements; embed via data URL <img>.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${areaPath}" fill="${P.accentBlueDim}"/><path d="${path}" stroke="${P.accentBlue}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return (
    <Col>
      {p.title ? renderSectionRuleInternal(p.title) : null}
      <Col style={{ padding: '6px 22px 12px' }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={dataUrl} width={w} height={h} />
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
  return (p.title ? SECTION_RULE_HEIGHT : 0) + 6 + 76 + 6 + 22 + 12;
}

// --- histogram (vertical bars) -----------------------------------------

export function renderHistogram(p: Histogram): ReactElement {
  const bins = p.bins.slice(0, 16);
  const max = bins.length === 0 ? 1 : Math.max(...bins.map((b) => Math.max(0, b.value)));
  const orientation = p.orientation ?? 'vertical';

  if (orientation === 'horizontal') {
    return (
      <Col>
        {p.title ? renderSectionRuleInternal(p.title) : null}
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
      {p.title ? renderSectionRuleInternal(p.title) : null}
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

// --- ascii_chart --------------------------------------------------------

// --- badge_row ----------------------------------------------------------

function badgeToneColors(tone: NonNullable<BadgeRow['badges'][0]['tone']>): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'ok':
      return { bg: 'rgba(93,216,155,0.15)', fg: P.accentGreen, border: 'rgba(93,216,155,0.45)' };
    case 'warn':
      return { bg: 'rgba(232,169,74,0.15)', fg: P.accentOrange, border: 'rgba(232,169,74,0.45)' };
    case 'alert':
      return { bg: 'rgba(227,123,107,0.15)', fg: P.accentRed, border: 'rgba(227,123,107,0.45)' };
    case 'info':
      return { bg: 'rgba(123,199,252,0.15)', fg: P.accentBlue, border: 'rgba(123,199,252,0.45)' };
    default:
      return { bg: 'rgba(255,255,255,0.05)', fg: P.textSecondary, border: 'rgba(255,255,255,0.18)' };
  }
}

export function renderBadgeRow(p: BadgeRow): ReactElement {
  const badges = p.badges.slice(0, 4);
  return (
    <Row style={{ padding: '6px 22px 14px', flexWrap: 'wrap' }}>
      {badges.map((b, idx) => {
        const c = badgeToneColors(b.tone ?? 'neutral');
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

function calloutToneColors(tone: NonNullable<Callout['tone']>): { bg: string; border: string; fg: string } {
  switch (tone) {
    case 'warn':
      return { bg: 'rgba(232,169,74,0.10)', border: P.accentOrange, fg: P.textPrimary };
    case 'alert':
      return { bg: 'rgba(227,123,107,0.10)', border: P.accentRed, fg: P.textPrimary };
    case 'ok':
      return { bg: 'rgba(93,216,155,0.10)', border: P.accentGreen, fg: P.textPrimary };
    default:
      return { bg: 'rgba(123,199,252,0.10)', border: P.accentBlue, fg: P.textPrimary };
  }
}

// Geist Mono doesn't ship glyphs for unicode symbols like ⓘ / ⚠ — they render
// as missing-glyph boxes. Stick to ASCII so every icon paints reliably.
const CALLOUT_ICONS: Record<NonNullable<Callout['icon']>, string> = {
  info: 'i',
  warn: '!',
  check: '✓',
  alert: '!',
};

export function renderCallout(p: Callout): ReactElement {
  const c = calloutToneColors(p.tone ?? 'info');
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

// --- mini_table (REMOVED) — data_rows covers the same shapes. ----------

// --- cta_row ------------------------------------------------------------

export function renderCtaRow(p: CtaRow): ReactElement {
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
              border: `1px solid ${primary ? 'rgba(255,255,255,0.18)' : P.border}`,
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

// --- spacer (REMOVED) — primitives carry their own padding. ------------

// --- _internal_note (NOT agent-facing) ----------------------------------
// Internal-only marker primitive used by render.tsx's height-cap truncation
// path. Not in the tool schema, not in the validator's user-facing types.

import type { _InternalNote } from './types';

export function renderInternalNote(p: _InternalNote): ReactElement {
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
