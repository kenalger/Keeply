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
  // A white canvas with grey islands — the reverse of the grouped-list
  // convention, by product decision. The step between the two IS the
  // separation: a card gets no outline and no shadow, so if these were close
  // the grouping would disappear. `surfaceAlt` (inputs, wells) sits a further
  // step down so it still reads as recessed when it lands ON an island.
  bg: '#FFFFFF',
  bgElevated: '#FFFFFF',
  bgSunken: '#E6E6E6',
  surface: '#F1F1F1',
  // The fills below were tuned against WHITE islands and sat four to six
  // shades off a grey one — a "Paused" chip with no visible pill. Each is one
  // step darker than it was; every text pair on them is still measured ≥ 4.5:1
  // (`tests/theme-contrast.test.ts`), and each fill now clears the island.
  surfaceAlt: '#E8E8E8',
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
  successBg: '#E4E4E4',
  warning: '#2E2E2E',
  warningBg: '#DEDEDE',
  danger: '#000000',
  dangerBg: '#D4D4D4',
  info: '#2E2E2E',
  infoBg: '#E1E1E1',
  // A pressed row on an island and a pressed input on `surfaceAlt` both have
  // to read: this clears the island by 19 and the input by 10.
  pressed: '#DEDEDE',
  scrim: 'rgba(0, 0, 0, 0.45)',
  skeleton: '#E2E2E2',
  skeletonHighlight: '#EFEFEF',
};

export const lightStatus: ThemeStatus = {
  overdue: { fg: '#FFFFFF', bg: '#171717', label: 'Overdue' },
  expired: { fg: '#FFFFFF', bg: '#171717', label: 'Expired' },
  dueToday: { fg: '#101010', bg: '#B0B0B0', label: 'Due today' },
  dueSoon: { fg: '#1F1F1F', bg: '#E4E4E4', border: '#575757', label: 'Due soon' },
  expiringSoon: { fg: '#1F1F1F', bg: '#E4E4E4', border: '#575757', label: 'Expiring soon' },
  upcoming: { fg: '#2E2E2E', bg: '#DCDCDC', label: 'Upcoming' },
  paid: { fg: '#4A4A4A', bg: 'transparent', border: '#878787', label: 'Paid' },
  valid: { fg: '#4A4A4A', bg: 'transparent', border: '#878787', label: 'Valid' },
  // 4.53:1 — the tightest pair in the palette, and the faintest fill that still
  // reads as a fill on a `#F1F1F1` island. Darker text would stop it being the
  // tertiary ink, which is the point of `inactive`.
  inactive: { fg: '#676767', bg: '#E6E6E6', label: 'Inactive' },
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
  // Was `#1E1E1E`: 1.03:1 against the `#1B1B1B` island, i.e. no visible pill —
  // the same defect the light theme grew when its islands went grey, caught by
  // the same test. 4.62:1 for the label.
  inactive: { fg: '#8E8E8E', bg: '#262626', label: 'Inactive' },
};
