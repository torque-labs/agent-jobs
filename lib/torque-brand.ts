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

export type TorqueTerminal = typeof TORQUE_TERMINAL;
