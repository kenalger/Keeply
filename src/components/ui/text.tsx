import { memo } from 'react';
import {
  StyleSheet,
  Text as RNText,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';

import {
  MAX_FONT_SCALE,
  MAX_FONT_SCALE_TIGHT,
  useThemedStyles,
  type ColorKey,
  type Theme,
  type TypeVariant,
} from '@/theme';

export type TextAlign = 'auto' | 'left' | 'right' | 'center';

export interface TextProps extends Omit<RNTextProps, 'style'> {
  /** Which entry of `theme.type` to render. Defaults to `body`. */
  variant?: TypeVariant;
  /** Which entry of `theme.color` to paint with. Defaults to `text`. */
  color?: ColorKey;
  align?: TextAlign;
  style?: StyleProp<TextStyle>;
}

/**
 * Variants whose layouts break under aggressive OS font scaling get a tighter
 * clamp. Everything else scales up to 1.6x.
 */
const TIGHT_VARIANTS: ReadonlySet<TypeVariant> = new Set<TypeVariant>([
  'display',
  'title',
  'amountLg',
  'amountMd',
]);

const HEADER_VARIANTS: ReadonlySet<TypeVariant> = new Set<TypeVariant>([
  'display',
  'title',
  'heading',
]);

const makeVariantStyles = (t: Theme): Record<TypeVariant, TextStyle> =>
  StyleSheet.create(t.type);

const makeColorStyles = (t: Theme): Record<ColorKey, TextStyle> => {
  const sheet = {} as Record<ColorKey, TextStyle>;
  for (const key of Object.keys(t.color) as ColorKey[]) {
    sheet[key] = { color: t.color[key] };
  }
  return StyleSheet.create(sheet);
};

const alignStyles = StyleSheet.create<Record<TextAlign, TextStyle>>({
  auto: { textAlign: 'auto' },
  left: { textAlign: 'left' },
  right: { textAlign: 'right' },
  center: { textAlign: 'center' },
});

/**
 * The only text component the app uses. It binds typography and colour to the
 * theme so no screen ever writes a `fontSize` or a hex value.
 */
function TextBase({
  variant = 'body',
  color = 'text',
  align,
  style,
  maxFontSizeMultiplier,
  accessibilityRole,
  ...rest
}: TextProps) {
  const variantStyles = useThemedStyles(makeVariantStyles);
  const colorStyles = useThemedStyles(makeColorStyles);

  const clamp =
    maxFontSizeMultiplier ??
    (TIGHT_VARIANTS.has(variant) ? MAX_FONT_SCALE_TIGHT : MAX_FONT_SCALE);

  const role = accessibilityRole ?? (HEADER_VARIANTS.has(variant) ? 'header' : undefined);

  return (
    <RNText
      {...rest}
      accessibilityRole={role}
      maxFontSizeMultiplier={clamp}
      style={[
        variantStyles[variant],
        colorStyles[color],
        align === undefined ? null : alignStyles[align],
        style,
      ]}
    />
  );
}

export const Text = memo(TextBase);
Text.displayName = 'Text';
