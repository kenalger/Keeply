/**
 * Keeply design tokens.
 *
 * Every colour, space, radius, type ramp and shadow the app is allowed to use
 * lives here. Feature code must never reach for a raw hex value — it either
 * reads a semantic colour (`theme.color.*`) or, for anything that communicates
 * the state of a record, a status token (`theme.status[key]`).
 *
 * ── THE PALETTE IS MONOCHROME ──────────────────────────────────────────────
 * There is no hue anywhere in this file. Light is near-black on off-white,
 * dark is off-white on near-black, and everything between the two is a neutral
 * grey (R = G = B, without exception). `accent` is not a brand colour: it is
 * the ink itself, so a primary button INVERTS rather than tints.
 *
 * That removes the app's easiest signal, so the vocabulary that remains has to
 * do the work deliberately — and it is a better vocabulary anyway, because it
 * survives colour blindness, a greyscale screenshot, direct sunlight and a
 * printed page, none of which hue survives:
 *
 *   FILL WEIGHT   how dark the chip is — a six-step ladder from solid ink to
 *                 barely-there. This is the primary carrier of urgency.
 *   OUTLINE       a bordered chip reads as "settled / nothing to do"; a filled
 *                 one reads as "this is a state you are in".
 *   TYPE WEIGHT   `bodyStrong` versus `body` on selection and emphasis.
 *   ICON          every status has a symbol, and `StatusPill` draws it.
 *
 * The rule that matters: **no status is ever distinguishable by tone alone.**
 * Each of the nine carries its own label and its own symbol as well as its own
 * treatment. Where two share a treatment (`overdue`/`expired`,
 * `dueSoon`/`expiringSoon`, `paid`/`valid`) they are from disjoint domains —
 * payments versus documents — and never appear in the same list, and they
 * still differ by icon and by label.
 *
 * ── PURE BLACK ON PURE WHITE IS NOT USED ───────────────────────────────────
 * `#000` on `#FFF` at 16pt vibrates: the 21:1 edge is beyond what the eye
 * wants for continuous reading, and on OLED it smears on scroll. Body text is
 * `#171717` on a `#F5F5F5` canvas (16.4:1) and `#F2F2F2` on `#0E0E0E` (17.2:1)
 * — still far past AAA, without the glare. Pure black and pure white are held
 * back for the two places an absolute IS wanted: `danger`, which must outrank
 * every other ink on the screen, and the white a solid `overdue` chip prints
 * on.
 *
 * ── CONTRAST ───────────────────────────────────────────────────────────────
 * Every pair below is measured against WCAG 2.1 — 4.5:1 for text, 3:1 for
 * non-text UI boundaries — in BOTH themes. Measured values are in the PR
 * description. One documented exception, unchanged from the coloured palette:
 * `border`, the hairline between list rows and around cards, is ~1.3:1. It is
 * decorative separation between two surfaces that are themselves adjacent in
 * value; the boundary of anything INTERACTIVE uses `borderStrong`, which
 * clears 3:1 on every surface it is drawn on.
 */
import { Platform, type TextStyle, type ViewStyle } from 'react-native';
// The raw colour values live in their own module so `node --test` can measure
// their contrast; this file cannot be loaded outside a bundler.
import { darkColor, darkStatus, lightColor, lightStatus } from './palette';
import type { Insets } from 'react-native';

/* ------------------------------------------------------------------ *
 * Primitive types
 * ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark';

/** The semantic states a Keeply record can be in. */
export type StatusKey =
  | 'overdue'
  | 'dueToday'
  | 'dueSoon'
  | 'upcoming'
  | 'paid'
  | 'expired'
  | 'expiringSoon'
  | 'valid'
  | 'inactive';

export interface ThemeColor {
  /** App canvas. */
  bg: string;
  /** Raised canvas (sheets, popovers). */
  bgElevated: string;
  /** Recessed canvas (grouped-list backdrop, wells). */
  bgSunken: string;
  /** Default card / row surface. */
  surface: string;
  /** Secondary surface: nested wells, inputs, skeleton base. */
  surfaceAlt: string;
  /** Hairline separators. Decorative — not held to 3:1. */
  border: string;
  /** Boundaries of interactive controls. Held to 3:1. */
  borderStrong: string;
  /** Primary text. */
  text: string;
  /** Supporting text — still held to 4.5:1. */
  textSecondary: string;
  /** Least emphasis text — still held to 4.5:1. */
  textTertiary: string;
  /** Text drawn on top of `text` (e.g. tooltips). */
  textInverse: string;
  /** Brand / primary action. */
  accent: string;
  /** Tinted accent backdrop. */
  accentMuted: string;
  /** Text/icons drawn on `accent`. */
  onAccent: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  info: string;
  infoBg: string;
  /** Solid surface colour used while a row/card is pressed. */
  pressed: string;
  /** Modal backdrop. */
  scrim: string;
  /** Skeleton base + sweep. */
  skeleton: string;
  skeletonHighlight: string;
}

export type ColorKey = keyof ThemeColor;

export interface StatusToken {
  /** Foreground: label text and icon. */
  fg: string;
  /** Pill / chip background. */
  bg: string;
  /**
   * Outline colour, when this state is drawn as an OUTLINED chip rather than a
   * filled one. Absent means "filled" — which is itself the signal, so this is
   * additive rather than decorative: without hue, fill-versus-outline is half
   * of what separates "overdue" from "paid".
   *
   * Optional, so every existing reader of `{ fg, bg, label }` is unaffected.
   */
  border?: string;
  /** Human-readable default label. */
  label: string;
}

export type ThemeStatus = Record<StatusKey, StatusToken>;

export interface ThemeSpace {
  xs: 4;
  sm: 8;
  md: 12;
  lg: 16;
  xl: 24;
  xxl: 32;
  xxxl: 48;
}

export interface ThemeRadius {
  sm: number;
  md: number;
  lg: number;
  xl: number;
  pill: number;
}

/**
 * ── THE LAYOUT RULES ───────────────────────────────────────────────────────
 * `space` is a scale; this is a set of DECISIONS made once, on that scale.
 *
 * The difference matters. A screen that reaches for `space.xl` because 24
 * looked right is deciding its own rhythm, and the next screen decides
 * differently — which is how the same app ends up with a 40pt gap under one
 * header and a 24pt gap under the next. These seven numbers name the gaps a
 * Keeply screen is made of, so a screen composes blocks instead of tuning
 * margins, and changing the rhythm is one edit here rather than forty.
 *
 * The one rule that makes the rest work: **a block owns the gap ABOVE itself,
 * and never the gap below.** Two adjacent blocks then contribute one gap
 * rather than two — React Native does not collapse margins, and stacking a
 * header's `paddingBottom` onto a section's `paddingTop` is exactly where the
 * dead space in the Phase 2 screenshots came from.
 */
export interface ThemeLayout {
  /** Horizontal page inset. Every screen, every list, the same number. */
  gutter: number;
  /**
   * Above a section heading, or any standalone block in a screen's flow.
   * The largest gap a screen uses: it is what says "a new thing starts here".
   */
  section: number;
  /** Between a section heading and the card it introduces. */
  heading: number;
  /** Between two sibling blocks inside one section. */
  block: number;
  /**
   * Between a card and the caption that describes it. Deliberately a THIRD of
   * `section`, because a caption that sits equidistant between two cards
   * belongs to neither — it has to be visibly nearer the thing it explains.
   */
  caption: number;
  /**
   * Left AND right inset of a hairline drawn between two rows sharing one
   * fill. Symmetric, at the row's own horizontal padding.
   *
   * It used to be inset on the left to the TEXT column and flush to the card's
   * right edge — Apple's convention, and defensible for a row that has an
   * avatar to anchor it, but half of Keeply's grouped rows have no leading
   * glyph at all, so the line started 54pt in on a card whose text started at
   * 16pt and ran off the other side. Repeated on every card in the app, an
   * accident. Symmetric at 16 is Material's documented inset, aligns with the
   * row's content whenever there is no glyph, and cannot read as a mistake.
   */
  separatorInset: number;
  /**
   * Height of the header row that carries the navigation control and the
   * screen's actions. They share one baseline; 44 because both ends of it are
   * touch targets.
   */
  controlRow: number;
  /**
   * Design space above a screen header's FIRST row — and the only thing
   * allowed between the safe-area inset and it.
   *
   * ── WHY IT IS ZERO ─────────────────────────────────────────────────────
   * A safe-area inset is clearance from the hardware, not design spacing. On
   * this class of device it is already ~59pt, and `ScreenHeader` used to add
   * `space.md` on top of it — a second gap, chosen by a second component,
   * that nobody could see the reason for. Stacked with the navigation row it
   * made three separate bands above the title, each decided independently.
   *
   * Zero is a decision, not an omission: the design gap is measured FROM the
   * end of the inset, and the first row of the header begins there. It lives
   * here rather than as a literal in `ScreenHeader` so that raising it is one
   * edit that moves every screen together — which is the whole point.
   */
  headerTop: number;
}

export type TypeVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'amountLg'
  | 'amountMd'
  | 'amountSm'
  | 'mono';

export type ThemeType = Record<TypeVariant, TextStyle>;

export interface ThemeShadow {
  /**
   * Nothing. Kept as a name so `shadow.card` still resolves, but a card that
   * never leaves the page does not cast a shadow — see the elevation budget
   * below.
   */
  card: ViewStyle;
  /** Floating controls that really do sit above the page: a FAB, a stuck bar. */
  raised: ViewStyle;
  /** Bottom sheets and modals. */
  sheet: ViewStyle;
}

export interface Theme {
  mode: ThemeMode;
  color: ThemeColor;
  status: ThemeStatus;
  space: ThemeSpace;
  radius: ThemeRadius;
  layout: ThemeLayout;
  type: ThemeType;
  shadow: ThemeShadow;
  /** Extra touch area for small controls. */
  hitSlop: Insets;
  /** 44pt — the minimum height/width of anything tappable. */
  minTouchTarget: number;
  /** Hairline for separators. */
  hairline: number;
}

/* ------------------------------------------------------------------ *
 * Shared, mode-independent scales
 * ------------------------------------------------------------------ */

export const MIN_TOUCH_TARGET = 44;

/** Clamp OS font scaling so financial layouts stay readable. */
export const MAX_FONT_SCALE = 1.6;
/** Numerics and display type get a tighter clamp — they blow out layouts. */
export const MAX_FONT_SCALE_TIGHT = 1.3;

export const space: ThemeSpace = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius: ThemeRadius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
};

/** The layout decisions, on the `space` scale. See {@link ThemeLayout}. */
export const layout: ThemeLayout = {
  gutter: space.lg,
  section: space.xl,
  heading: space.sm,
  block: space.md,
  caption: space.sm,
  separatorInset: space.lg,
  controlRow: MIN_TOUCH_TARGET,
  headerTop: 0,
};

export const hitSlop: Insets = { top: 8, bottom: 8, left: 8, right: 8 };

const HAIRLINE = Platform.select({ ios: 0.5, default: 1 });

const MONO_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/** Money and countdowns must line up column-to-column. */
const TABULAR: NonNullable<TextStyle['fontVariant']> = ['tabular-nums'];

export const typography: ThemeType = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  heading: { fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.2 },
  subheading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  label: { fontSize: 13, lineHeight: 17, fontWeight: '600', letterSpacing: 0.2 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  amountLg: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.4,
    fontVariant: TABULAR,
  },
  amountMd: { fontSize: 20, lineHeight: 25, fontWeight: '600', fontVariant: TABULAR },
  amountSm: { fontSize: 15, lineHeight: 20, fontWeight: '600', fontVariant: TABULAR },
  mono: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
    fontFamily: MONO_FAMILY,
    fontVariant: TABULAR,
  },
};

/**
 * ── THE ELEVATION BUDGET ───────────────────────────────────────────────────
 * Two levels, and a name that means "none".
 *
 * A shadow says "this floats above the page". A card that scrolls with the
 * page does not float, so a shadow on it is decoration — and decoration spent
 * here is unavailable later, when something genuinely does need to read as
 * lifted. Without hue, shadow and outline are most of the vocabulary left, so
 * the budget is tighter than it was, not looser: `raised` for a control that
 * hovers over content, `sheet` for a modal, and nothing at all for the
 * ordinary surfaces a screen is made of.
 */
function shadows(shadowColor: string, opacities: [number, number]): ThemeShadow {
  return {
    // Deliberately empty. Static content is separated by its fill, once.
    card: {},
    raised: Platform.select<ViewStyle>({
      ios: {
        shadowColor,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: opacities[0],
        shadowRadius: 12,
      },
      default: { elevation: 4 },
    }),
    sheet: Platform.select<ViewStyle>({
      ios: {
        shadowColor,
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: opacities[1],
        shadowRadius: 28,
      },
      default: { elevation: 12 },
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Light
 * ------------------------------------------------------------------ */


/**
 * The nine states, as a ladder of fill weight plus one outlined pair.
 *
 *   solid ink      overdue, expired          — already failed
 *   heavy fill     dueToday                  — acts today
 *   light fill +   dueSoon, expiringSoon     — coming, prepare
 *     dark outline
 *   mid fill       upcoming                  — on the radar, no action
 *   outlined       paid, valid               — settled; nothing to do
 *   faint fill     inactive                  — deliberately switched off
 */

export const lightTheme: Theme = {
  mode: 'light',
  color: lightColor,
  status: lightStatus,
  space,
  radius,
  layout,
  type: typography,
  shadow: shadows('#0A0A0A', [0.1, 0.16]),
  hitSlop,
  minTouchTarget: MIN_TOUCH_TARGET,
  hairline: HAIRLINE,
};

/* ------------------------------------------------------------------ *
 * Dark
 * ------------------------------------------------------------------ */


/** The same ladder, inverted. Solid means light-on-dark here. */

export const darkTheme: Theme = {
  mode: 'dark',
  color: darkColor,
  status: darkStatus,
  space,
  radius,
  layout,
  type: typography,
  shadow: shadows('#000000', [0.5, 0.7]),
  hitSlop,
  minTouchTarget: MIN_TOUCH_TARGET,
  hairline: HAIRLINE,
};

export const themes: Record<ThemeMode, Theme> = {
  light: lightTheme,
  dark: darkTheme,
};

/** Ordered for iteration in the UI preview / filter chips. */
export const STATUS_KEYS: readonly StatusKey[] = [
  'overdue',
  'dueToday',
  'dueSoon',
  'upcoming',
  'paid',
  'expired',
  'expiringSoon',
  'valid',
  'inactive',
];

export { darkColor, darkStatus, lightColor, lightStatus } from './palette';
