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
