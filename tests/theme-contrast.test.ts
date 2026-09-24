/**
 * Keeply — the palette, measured.
 *
 * The design system has claimed "measured contrast in both themes" since the
 * monochrome pass, and nothing measured it: the numbers were checked by hand
 * once and then trusted through every palette edit since. This is that claim,
 * enforced.
 *
 * ── WHY IT MATTERS MORE NOW ────────────────────────────────────────────────
 * Until the accent landed, every colour in the app was a grey and getting one
 * wrong was visible instantly. A hue is different: `#8AB4F8` and `#5B7FB8`
 * look like the same blue in a mockup and differ by 3:1 against a dark card.
 * A contrast failure in an accent is invisible to the person who introduced it
 * and obvious to the person who cannot read the button.
 *
 * WCAG thresholds used here:
 *   4.5:1  normal text against its background (AA)
 *   3.0:1  large text, and non-text UI — a focus ring, a control's fill, an
 *          active tab indicator (AA, 1.4.11)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { darkColor, darkStatus, lightColor, lightStatus } from '@/theme/palette';

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (pair: string): number => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6))
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;
const AA_UI = 3;
/**
 * NOT a WCAG number — the project's own floor. A status pill with no outline
 * carries its weight in its fill (`tokens.ts`, "FILL WEIGHT"), and below about
 * 1.08:1 against the card it sits on that fill is not there: the light theme's
 * `inactive` sat at 1.04:1 once the islands went grey and read as bare text.
 */
const FILL_FLOOR = 1.08;

const THEMES = [
  { name: 'light', color: lightColor, status: lightStatus },
  { name: 'dark', color: darkColor, status: darkStatus },
] as const;

/* -------------------------------------------------------------------------- */

describe('the contrast checker itself', () => {
  // A checker that is wrong makes every assertion below vacuous.
  test('agrees with the known extremes', () => {
    assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21);
    assert.equal(Math.round(contrast('#FFFFFF', '#FFFFFF')), 1);
  });

  test('is symmetric', () => {
    assert.equal(contrast('#175CD3', '#FFFFFF'), contrast('#FFFFFF', '#175CD3'));
  });
});

/* -------------------------------------------------------------------------- */

describe('body text is readable on every surface it lands on', () => {
  for (const { name, color } of THEMES) {
    test(`${name}: primary text`, () => {
      for (const surface of [color.bg, color.surface, color.surfaceAlt, color.bgElevated]) {
        assert.ok(
          contrast(color.text, surface) >= AA_TEXT,
          `${color.text} on ${surface} = ${contrast(color.text, surface).toFixed(2)}`,
        );
      }
    });

    test(`${name}: secondary text`, () => {
      for (const surface of [color.bg, color.surface, color.surfaceAlt]) {
        assert.ok(
          contrast(color.textSecondary, surface) >= AA_TEXT,
          `${color.textSecondary} on ${surface} = ${contrast(color.textSecondary, surface).toFixed(2)}`,
        );
      }
    });

    test(`${name}: tertiary text — the section eyebrow`, () => {
      // The quietest type in the app, and the one most likely to be pushed
      // past the line in pursuit of "subtle".
      for (const surface of [color.bg, color.surface]) {
        assert.ok(
          contrast(color.textTertiary, surface) >= AA_TEXT,
          `${color.textTertiary} on ${surface} = ${contrast(color.textTertiary, surface).toFixed(2)}`,
        );
      }
    });
  }
});

/* -------------------------------------------------------------------------- */

describe('status chips stay legible on an island', () => {
  for (const { name, color, status } of THEMES) {
    test(`${name}: every label is readable on its fill`, () => {
      for (const [key, token] of Object.entries(status)) {
        // An outlined chip has no fill of its own; its label sits on the card.
        const fill = token.bg === 'transparent' ? color.surface : token.bg;
        assert.ok(
          contrast(token.fg, fill) >= AA_TEXT,
          `${key}: ${token.fg} on ${fill} = ${contrast(token.fg, fill).toFixed(2)}`,
        );
      }
    });

    test(`${name}: every outline clears what it is drawn on`, () => {
      for (const [key, token] of Object.entries(status)) {
        if (token.border === undefined) continue;
        const fill = token.bg === 'transparent' ? color.surface : token.bg;
        assert.ok(
          contrast(token.border, fill) >= AA_UI,
          `${key}: border ${token.border} on ${fill} = ${contrast(token.border, fill).toFixed(2)}`,
        );
      }
    });

    test(`${name}: a fill with no outline is visible against the island`, () => {
      for (const [key, token] of Object.entries(status)) {
        if (token.border !== undefined || token.bg === 'transparent') continue;
        assert.ok(
          contrast(token.bg, color.surface) >= FILL_FLOOR,
          `${key}: fill ${token.bg} on island ${color.surface} = ${contrast(token.bg, color.surface).toFixed(3)}`,
        );
      }
    });
  }
});

describe('the accent', () => {
  for (const { name, color } of THEMES) {
    test(`${name}: its label is readable on it`, () => {
      // The primary button and a selected chip both paint `accent` and write
      // `onAccent` on top. This is the pair that breaks first when someone
      // picks a prettier hue.
      const ratio = contrast(color.onAccent, color.accent);
      assert.ok(ratio >= AA_TEXT, `${color.onAccent} on ${color.accent} = ${ratio.toFixed(2)}`);
    });

    test(`${name}: it is visible as a control against every surface`, () => {
      // A focus ring, an active tab indicator, a switch track: non-text UI,
      // so 3:1 — but it must clear it on the CARD as well as on the canvas,
      // and a card is the lower-contrast case in dark mode.
      for (const surface of [color.bg, color.surface, color.surfaceAlt]) {
        const ratio = contrast(color.accent, surface);
        assert.ok(ratio >= AA_UI, `${color.accent} on ${surface} = ${ratio.toFixed(2)}`);
      }
    });

    test(`${name}: text stays readable on the muted tint`, () => {
      // `accentMuted` is a background only — a tinted icon button, a focus
      // ring's fill — so whatever sits on it is normal text.
      const ratio = contrast(color.text, color.accentMuted);
      assert.ok(ratio >= AA_TEXT, `${color.text} on ${color.accentMuted} = ${ratio.toFixed(2)}`);
    });
  }

  test('the dark accent is LIGHTER than the light one', () => {
    // Not a style preference. An accent tuned for a white canvas is too dark
    // to see on a near-black one; shipping one value for both themes is the
    // single most common way an accent becomes invisible in dark mode.
    assert.ok(
      luminance(darkColor.accent) > luminance(lightColor.accent),
      `${darkColor.accent} must be lighter than ${lightColor.accent}`,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('the greyscale discipline', () => {
  /** How far a colour is from grey: 0 for any `#RRGGBB` with R === G === B. */
  function saturation(hex: string): number {
    const v = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b);
  }

  /** The accent is the exception; everything else stays grey. */
  const ACCENT_KEYS = new Set(['accent', 'accentMuted']);

  for (const { name, color } of THEMES) {
    test(`${name}: only the accent carries a hue`, () => {
      // The rule the palette's header states, enforced. Colour in this app
      // means "interactive or selected" and nothing else — the moment a
      // status token also carries a hue, neither meaning survives.
      for (const [key, value] of Object.entries(color)) {
        if (ACCENT_KEYS.has(key)) continue;
        if (typeof value !== 'string' || !value.startsWith('#')) continue;
        assert.ok(
          saturation(value) <= 2,
          `${key} = ${value} is not greyscale (saturation ${saturation(value)})`,
        );
      }
    });

    test(`${name}: the accent DOES carry a hue`, () => {
      // The other direction: an accent that has drifted back to grey means
      // the app silently lost its only colour.
      assert.ok(saturation(color.accent) > 20, `${color.accent} is not a hue`);
    });
  }
});
