/**
 * Server-side chart renderer — produces Torque-branded PNGs the agent can
 * attach to a message. Channel-agnostic: returns a PNG Buffer; lib/channels.ts
 * decides whether to send it as Telegram sendPhoto or Slack files.upload.
 *
 * Uses @napi-rs/canvas (pure-Rust Skia, ships musl Alpine prebuilds — no
 * toolchain, no Cairo) + Chart.js. Lazy-loaded so the dep cost is only paid
 * when a turn actually calls render_chart.
 */
import { TORQUE_BRAND } from './torque-brand';

export type ChartSpec = {
  type: 'line' | 'bar';
  title: string;
  /** X-axis labels (one per data point). Strings — for date axes, pass ISO dates as strings. */
  labels: string[];
  /** One or more series; each must have data.length === labels.length. */
  series: Array<{ label: string; data: number[] }>;
  /** Optional unit suffix on tooltips/axis (e.g. "$", "%", "wallets"). */
  unit?: string;
};

const WIDTH = 1080;
const HEIGHT = 720;

let cachedRenderer: ((spec: ChartSpec) => Promise<Buffer>) | null = null;

/** Render `spec` to a PNG Buffer. Throws on bad input or render failure. */
export async function renderChart(spec: ChartSpec): Promise<Buffer> {
  if (!cachedRenderer) {
    cachedRenderer = await buildRenderer();
  }
  return cachedRenderer(spec);
}

async function buildRenderer(): Promise<(spec: ChartSpec) => Promise<Buffer>> {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  const { Chart, registerables } = await import('chart.js');
  Chart.register(...registerables);

  // Chart.js clears the canvas during render() — so a pre-render fillRect gets
  // wiped, leaving a transparent (i.e. Telegram-white) background that hides
  // every Torque-dark-mode text color we set. This plugin paints the dark bg
  // INSIDE Chart.js's draw lifecycle via globalCompositeOperation, so the
  // brand palette stays legible. Registered once at builder-init time.
  Chart.register({
    id: 'torqueBgPlugin',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeDraw(chart: any) {
      const c = chart?.canvas?.getContext?.('2d');
      if (!c) return;
      c.save();
      c.globalCompositeOperation = 'destination-over';
      c.fillStyle = TORQUE_BRAND.bgDark;
      c.fillRect(0, 0, chart.width, chart.height);
      c.restore();
    },
  });

  // System sans-serif is fine for Alpine; @napi-rs/canvas ships with a default.
  // If we ever ship a brand font (e.g. Instrument Sans), drop the .ttf into the
  // image and register it here.
  void GlobalFonts;

  return async (spec: ChartSpec): Promise<Buffer> => {
    if (spec.series.length === 0) throw new Error('renderChart: at least one series required');
    for (const s of spec.series) {
      if (s.data.length !== spec.labels.length) {
        throw new Error(`renderChart: series "${s.label}" data length mismatches labels`);
      }
    }
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    // Belt + braces: also paint the dark bg directly on the canvas so even if
    // the plugin ever doesn't fire (Chart.js version skew, plugin filtered),
    // we still get a Torque-dark base instead of transparent.
    ctx.fillStyle = TORQUE_BRAND.bgDark;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const palette = TORQUE_BRAND.series;
    const datasets = spec.series.map((s, i) => {
      const color = palette[i % palette.length];
      return {
        label: s.label,
        data: s.data,
        borderColor: color,
        backgroundColor: spec.type === 'bar' ? color : hexAlpha(color, 0.15),
        borderWidth: 2,
        pointRadius: spec.type === 'line' ? 3 : 0,
        pointBackgroundColor: color,
        fill: spec.type === 'line',
        tension: 0.25,
      };
    });

    // Truncate long X-axis labels (e.g. raw wallet addresses) so they fit and
    // don't overlap. The agent is told to do this client-side via the soul +
    // tool description, but defend against lapses here.
    const xLabels = spec.labels.map((l) => (l.length > 14 ? `${l.slice(0, 4)}…${l.slice(-4)}` : l));
    const title = spec.title?.trim() || `${spec.series[0].label} — ${spec.type}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = new Chart(ctx as any, {
      type: spec.type,
      data: { labels: xLabels, datasets },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: 2,
        layout: { padding: { top: 8, right: 24, bottom: 8, left: 8 } },
        plugins: {
          title: {
            display: true,
            text: title,
            color: TORQUE_BRAND.textOnDark,
            font: { size: 26, weight: 'bold' },
            padding: { top: 20, bottom: 24 },
          },
          subtitle: spec.unit
            ? {
                display: true,
                text: `(${spec.unit})`,
                color: TORQUE_BRAND.textOnDarkMuted,
                font: { size: 14 },
                padding: { bottom: 12 },
              }
            : undefined,
          legend: {
            display: spec.series.length > 1,
            labels: { color: TORQUE_BRAND.textOnDark, font: { size: 14 } },
          },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            ticks: {
              color: TORQUE_BRAND.textOnDarkMuted,
              font: { size: 13 },
              // Rotate long-label runs so they don't overlap.
              maxRotation: xLabels.length > 6 ? 35 : 0,
              minRotation: xLabels.length > 6 ? 35 : 0,
              autoSkip: false,
            },
            grid: { color: TORQUE_BRAND.gridOnDark },
            border: { color: TORQUE_BRAND.gridOnDark },
          },
          y: {
            ticks: {
              color: TORQUE_BRAND.textOnDarkMuted,
              font: { size: 13 },
              callback: (v: number | string) => formatNum(Number(v)),
            },
            grid: { color: TORQUE_BRAND.gridOnDark },
            border: { color: TORQUE_BRAND.gridOnDark },
            beginAtZero: true,
          },
        },
      },
    });

    chart.render();
    const png = canvas.toBuffer('image/png');
    chart.destroy();
    return png;
  };
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(2);
}

/** Convert a #RRGGBB hex to rgba with the given alpha. */
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`;
}
