/**
 * Keeply — the raw colour values, and nothing else.
 *
 * ── WHY THESE LEFT `tokens.ts` ─────────────────────────────────────────────
 * `tokens.ts` imports `react-native` (for `Platform.select`, which decides the
 * hairline width, the mono font and the shadow shapes), so nothing in it can
 * be loaded by `node --test`. The palettes are pure data and the ONE thing in
 * the theme with a property worth asserting — contrast — so they live here,
 * where `tests/theme-contrast.test.ts` can reach them.
 *
 * The design system claimed "measured contrast in both themes" for several
 * phases with nothing measuring it. Now something does.
 *
 * ── THE ACCENT IS THE ONLY COLOUR IN THE APP ───────────────────────────────
 * Everything else is greyscale, deliberately. The accent means exactly one
 * thing — **this is interactive, or this is selected** — and it is spent on
 * the primary button, a chosen chip, the active tab, a focused field and the
 * text cursor. That is the whole budget.
 *
 * It is NOT used for status. An overdue bill, an expiring document and a
 * successful save stay in greyscale (`ThemeStatus` below), because the moment
 * colour also means "bad" it stops reliably meaning "tap this", and a screen
 * with four hues is a screen where none of them carries information.
 *
 * One hue, two values — a darker one for light mode and a lighter one for dark
 * — both measured against the surfaces they sit on. Changing the brand colour
 * is changing `accent`, `accentMuted` and `onAccent` here, and nowhere else:
 * every consumer reads the token.
 */
import type { ThemeColor, ThemeStatus } from './tokens';

export const lightColor: ThemeColor = {
  // The canvas sits a clear step below `surface`, because the step IS the
  // separation: a card gets no outline and no shadow, so if these two were
  // close the grouping would disappear.
  bg: '#F1F1F1',
  bgElevated: '#FFFFFF',
  bgSunken: '#E6E6E6',
  surface: '#FFFFFF',
  surfaceAlt: '#EBEBEB',
  border: '#DCDCDC',
  borderStrong: '#878787',
  text: '#171717',
  textSecondary: '#545454',
  textTertiary: '#676767',
  textInverse: '#FFFFFF',
  // Not a brand colour: the ink. A primary button is black with white on it.
  // The one hue in the app. 5.99:1 against white — comfortably AA for the
  // white label on a primary button, and above the 3:1 a focus ring or an
  // active tab needs as a non-text UI element.
  accent: '#175CD3',
  // The same hue at a tint, for a focus ring and a tinted icon button. It is a
  // BACKGROUND only; nothing legible is ever drawn in it.
  accentMuted: '#E4ECFB',
  onAccent: '#FFFFFF',
  // The four "semantic" inks are neutral now, and only `danger` is set apart —
  // it is pure black, one step past `accent`, so a destructive control and an
  // error message outrank everything else on the screen by value alone.
  success: '#2E2E2E',
  successBg: '#EDEDED',
  warning: '#2E2E2E',
  warningBg: '#E6E6E6',
  danger: '#000000',
  dangerBg: '#DCDCDC',
  info: '#2E2E2E',
  infoBg: '#EAEAEA',
  pressed: '#E4E4E4',
  scrim: 'rgba(0, 0, 0, 0.45)',
  skeleton: '#E2E2E2',
  skeletonHighlight: '#EFEFEF',
};

export const lightStatus: ThemeStatus = {
  overdue: { fg: '#FFFFFF', bg: '#171717', label: 'Overdue' },
  expired: { fg: '#FFFFFF', bg: '#171717', label: 'Expired' },
  dueToday: { fg: '#101010', bg: '#B0B0B0', label: 'Due today' },
  dueSoon: { fg: '#1F1F1F', bg: '#EDEDED', border: '#575757', label: 'Due soon' },
  expiringSoon: { fg: '#1F1F1F', bg: '#EDEDED', border: '#575757', label: 'Expiring soon' },
  upcoming: { fg: '#2E2E2E', bg: '#DCDCDC', label: 'Upcoming' },
  paid: { fg: '#4A4A4A', bg: 'transparent', border: '#878787', label: 'Paid' },
  valid: { fg: '#4A4A4A', bg: 'transparent', border: '#878787', label: 'Valid' },
  inactive: { fg: '#676767', bg: '#EDEDED', label: 'Inactive' },
};

export const darkColor: ThemeColor = {
  // Same reasoning as light, inverted: the canvas drops nearly to black so the
  // surfaces above it read as raised without an outline to say so.
  bg: '#0A0A0A',
  bgElevated: '#232323',
  bgSunken: '#000000',
  surface: '#1B1B1B',
  surfaceAlt: '#262626',
  border: '#333333',
  borderStrong: '#727272',
  text: '#F2F2F2',
  textSecondary: '#ABABAB',
  textTertiary: '#909090',
  textInverse: '#0E0E0E',
  // The same hue lifted for a dark canvas — a dark-mode accent has to be
  // lighter than its light-mode twin or it disappears into the surface.
  // 9.39:1 on the canvas, 8.17:1 on a card, 9.16:1 for the dark label on top.
  accent: '#8AB4F8',
  accentMuted: '#1B2740',
  onAccent: '#0E0E0E',
  success: '#DCDCDC',
  successBg: '#1E1E1E',
  warning: '#DCDCDC',
  warningBg: '#242424',
  danger: '#FFFFFF',
  dangerBg: '#333333',
  info: '#DCDCDC',
  infoBg: '#202020',
  pressed: '#2C2C2C',
  scrim: 'rgba(0, 0, 0, 0.6)',
  skeleton: '#262626',
  skeletonHighlight: '#333333',
};

export const darkStatus: ThemeStatus = {
  overdue: { fg: '#101010', bg: '#F2F2F2', label: 'Overdue' },
  expired: { fg: '#101010', bg: '#F2F2F2', label: 'Expired' },
  dueToday: { fg: '#0E0E0E', bg: '#949494', label: 'Due today' },
  dueSoon: { fg: '#F2F2F2', bg: '#1F1F1F', border: '#A0A0A0', label: 'Due soon' },
  expiringSoon: { fg: '#F2F2F2', bg: '#1F1F1F', border: '#A0A0A0', label: 'Expiring soon' },
  upcoming: { fg: '#E0E0E0', bg: '#3A3A3A', label: 'Upcoming' },
  paid: { fg: '#A8A8A8', bg: 'transparent', border: '#727272', label: 'Paid' },
  valid: { fg: '#A8A8A8', bg: 'transparent', border: '#727272', label: 'Valid' },
  inactive: { fg: '#8E8E8E', bg: '#1E1E1E', label: 'Inactive' },
};
