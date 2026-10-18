// Mirror of tokens.css for SVG widgets that need colors as values. Prefer
// `var(--token)` in markup; use these only where a CSS variable can't reach.

export type Theme = 'day' | 'night';

export const TOKENS = {
  day: {
    bg: '#EEF2F3',
    panel: '#FFFFFF',
    line: '#D3DBDE',
    ink: '#0E1A22',
    sub: '#4F5F69',
    accent: '#0D5A85',
    accentTint: '#E1EBF1',
    accentInk: '#0B4A6E',
    good: '#1F7A5A',
    warn: '#9A5300',
    warnTint: '#FBF0DF',
    alarm: '#B42318',
    alarmTint: '#FBE9E7',
    alarmBannerBg: '#B42318',
    alarmBannerInk: '#FFFFFF',
    stale: '#6F7B82',
    port: '#C0362C',
    stbd: '#1F7A5A',
    navBg: '#0E1A22',
    navActive: '#1E3240',
  },
  night: {
    bg: '#000000',
    panel: '#0B0302',
    line: '#33100D',
    ink: '#E0392D',
    sub: '#A8322A',
    accent: '#E0392D',
    accentTint: '#1A0605',
    accentInk: '#E0392D',
    good: '#A8322A',
    warn: '#FF5A4E',
    warnTint: '#1A0605',
    alarm: '#FF4A3D',
    alarmTint: '#1A0605',
    alarmBannerBg: '#FF4A3D',
    alarmBannerInk: '#000000',
    stale: '#5C1A15',
    port: '#A8322A',
    stbd: '#E0392D',
    navBg: '#000000',
    navActive: '#1A0605',
  },
} as const satisfies Record<Theme, Record<string, string>>;

export type TokenName = keyof (typeof TOKENS)['day'];
