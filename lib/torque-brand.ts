/**
 * Single source of truth for Torque brand colors used by server-rendered
 * artifacts (charts, future PDFs). Sourced from torque-landing-page's
 * tailwind.config.ts so anything we render lines up with the marketing brand.
 */
export const TORQUE_BRAND = {
  // Backgrounds
  bgDark: '#08090A',
  bgDarkSoft: '#1A1C1E',
  bgLight: '#F4FAFF',
  // Text
  textOnDark: '#F4FAFF',
  textOnDarkMuted: 'rgba(244,250,255,0.6)',
  textOnLight: '#08090A',
  // Series palette — primary first, used as accent in single-series charts.
  series: [
    '#5DFDCB', // aquamarine
    '#7CC6FE', // maya-blue
    '#0008FF', // deep blue
    '#3DDAA8', // aquamarine dark
    '#5BB0F0', // maya-blue dark
  ] as const,
  // Subtle grid / divider on dark backgrounds.
  gridOnDark: 'rgba(244,250,255,0.08)',
  gridOnLight: 'rgba(8,9,10,0.08)',
} as const;

export type TorqueBrand = typeof TORQUE_BRAND;

/**
 * Terminal-aesthetic palette for branded data cards (lib/render-card.tsx).
 * Separate token bundle so the card renderer can have its own visual
 * vocabulary (warmer accents, multiple colored highlights) without forcing
 * those choices onto the more neutral Chart.js chart renderer.
 */
export const TORQUE_TERMINAL = {
  // Backgrounds
  pageBg: '#EDF1FA',
  terminalBg: '#0E1118',
  terminalBgSoft: '#141821',
  border: 'rgba(255,255,255,0.08)',
  // Text levels
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.55)',
  textTertiary: 'rgba(255,255,255,0.32)',
  // Accents — used sparingly for highlights, dividers, callouts.
  accentBlue: '#7BC7FC',
  accentBlueDim: 'rgba(123,199,252,0.18)',
  accentOrange: '#E8A94A',
  accentYellow: '#E5C97A',
  accentYellowDim: 'rgba(229,201,122,0.18)',
  accentRed: '#E37B6B',
  accentGreen: '#5DD89B',
} as const;

/**
 * Shared palette shape. Both TORQUE_TERMINAL (dark) and TORQUE_LIGHT satisfy
 * this — the renderer takes any palette of this shape and produces a card.
 * Defined as an explicit interface (not `typeof TORQUE_TERMINAL`) so the
 * `as const` literal types on each palette don't narrow each other out of
 * compatibility.
 */
export type TorqueTerminal = {
  readonly pageBg: string;
  readonly terminalBg: string;
  readonly terminalBgSoft: string;
  readonly border: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly accentBlue: string;
  readonly accentBlueDim: string;
  readonly accentOrange: string;
  readonly accentYellow: string;
  readonly accentYellowDim: string;
  readonly accentRed: string;
  readonly accentGreen: string;
};

/**
 * Light-mode palette — anchored to the actual torque-landing-page tokens:
 *   alice-blue #F4FAFF (bg), black #08090A (text), blue #0008FF (primary),
 *   aquamarine-dark #3DDAA8 (positive), maya-blue-dark #5BB0F0 (data).
 *
 * Highlight (rank #1), section rules, and warn accents all = brand deep blue
 * #0008FF so the winner reads as the most "Torque" thing on the card. Regular
 * data bars = soft maya-blue so they support without competing. Aquamarine
 * carries the "fresh / positive / live" signal. Same shape as TORQUE_TERMINAL
 * so the renderer takes either via parameter.
 */
export const TORQUE_LIGHT = {
  pageBg: '#FFFFFF',
  terminalBg: '#FFFFFF', // pure white card body
  terminalBgSoft: '#F4FAFF', // alice-blue — chips, CTA buttons
  border: 'rgba(8,9,10,0.10)',
  textPrimary: '#08090A', // brand black
  textSecondary: 'rgba(8,9,10,0.60)',
  textTertiary: 'rgba(8,9,10,0.40)',
  accentBlue: '#5BB0F0', // maya-blue dark — non-highlight bars + sparkline
  accentBlueDim: 'rgba(91,176,240,0.22)',
  accentOrange: '#0008FF', // section rules + warn kv — brand deep blue dominates
  accentYellow: '#0008FF', // HIGHLIGHT — brand deep blue (the winner)
  accentYellowDim: 'rgba(0,8,255,0.12)',
  accentRed: '#DC2626',
  accentGreen: '#3DDAA8', // aquamarine-dark
} as const;
