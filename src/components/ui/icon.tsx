import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { AndroidSymbol } from 'expo-symbols';

import { useTheme, type ColorKey } from '@/theme';

/**
 * `expo-symbols` renders SF Symbols on iOS and Material Symbols on Android —
 * but only when the `name` prop carries *both* platform names. Passing a bare
 * SF Symbol string renders nothing but the fallback on Android, so every icon
 * the app uses is registered here as an explicit iOS/Android pair.
 *
 * Add new icons here rather than passing raw symbol strings at call sites; the
 * names are validated against `sf-symbols-typescript` and the bundled Material
 * Symbols index.
 */
export const ICONS = {
  chevronRight: { ios: 'chevron.right', android: 'chevron_right' },
  chevronLeft: { ios: 'chevron.left', android: 'chevron_left' },
  chevronDown: { ios: 'chevron.down', android: 'expand_more' },
  plus: { ios: 'plus', android: 'add' },
  close: { ios: 'xmark', android: 'close' },
  check: { ios: 'checkmark', android: 'check' },
  checkCircle: { ios: 'checkmark.circle.fill', android: 'check_circle' },
  bell: { ios: 'bell', android: 'notifications' },
  calendar: { ios: 'calendar', android: 'calendar_month' },
  clock: { ios: 'clock', android: 'schedule' },
  wallet: { ios: 'wallet.pass', android: 'wallet' },
  creditcard: { ios: 'creditcard', android: 'credit_card' },
  receipt: { ios: 'doc.plaintext', android: 'receipt_long' },
  car: { ios: 'car', android: 'directions_car' },
  motorcycle: { ios: 'scooter', android: 'two_wheeler' },
  fuel: { ios: 'fuelpump', android: 'local_gas_station' },
  wrench: { ios: 'wrench.and.screwdriver', android: 'build' },
  doc: { ios: 'doc.text', android: 'description' },
  folder: { ios: 'folder', android: 'folder' },
  shield: { ios: 'lock.shield', android: 'shield' },
  lock: { ios: 'lock', android: 'lock' },
  faceid: { ios: 'faceid', android: 'face' },
  gear: { ios: 'gearshape', android: 'settings' },
  search: { ios: 'magnifyingglass', android: 'search' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter_list' },
  trash: { ios: 'trash', android: 'delete' },
  pencil: { ios: 'pencil', android: 'edit' },
  camera: { ios: 'camera', android: 'photo_camera' },
  photo: { ios: 'photo', android: 'image' },
  warning: { ios: 'exclamationmark.triangle.fill', android: 'warning' },
  errorCircle: { ios: 'exclamationmark.circle.fill', android: 'error' },
  info: { ios: 'info.circle', android: 'info' },
  arrowUp: { ios: 'arrow.up', android: 'arrow_upward' },
  arrowDown: { ios: 'arrow.down', android: 'arrow_downward' },
  tray: { ios: 'tray', android: 'inbox' },
  house: { ios: 'house', android: 'home' },
  ellipsis: { ios: 'ellipsis', android: 'more_horiz' },
  repeat: { ios: 'repeat', android: 'repeat' },
  sparkle: { ios: 'sparkles', android: 'auto_awesome' },
  eye: { ios: 'eye', android: 'visibility' },
  eyeSlash: { ios: 'eye.slash', android: 'visibility_off' },
  pause: { ios: 'pause.circle', android: 'pause_circle' },
  chartBar: { ios: 'chart.bar', android: 'bar_chart' },
  tag: { ios: 'tag', android: 'sell' },
  banknote: { ios: 'banknote', android: 'payments' },
  person: { ios: 'person', android: 'person' },
  download: { ios: 'square.and.arrow.down', android: 'download' },
  upload: { ios: 'square.and.arrow.up', android: 'upload' },
  moon: { ios: 'moon', android: 'dark_mode' },
  sun: { ios: 'sun.max', android: 'light_mode' },
  /* Category glyphs. A monochrome list is told apart by its symbols, so a
     category that falls back to a generic one — "cloud storage" drawn as a
     folder — is the category losing its only visual identity. */
  cloud: { ios: 'cloud', android: 'cloud' },
  music: { ios: 'music.note', android: 'music_note' },
  video: { ios: 'play.rectangle', android: 'smart_display' },
  gaming: { ios: 'gamecontroller', android: 'sports_esports' },
  fitness: { ios: 'dumbbell', android: 'fitness_center' },
  education: { ios: 'graduationcap', android: 'school' },
  news: { ios: 'newspaper', android: 'newspaper' },
  bolt: { ios: 'bolt', android: 'bolt' },
} as const satisfies Record<string, { ios: SFSymbol; android: AndroidSymbol }>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Point size of the glyph. Defaults to 20. */
  size?: number;
  /** Theme colour key. Ignored when `tint` is given. */
  color?: ColorKey;
  /** Explicit colour, for status tokens that are not in `theme.color`. */
  tint?: string;
  style?: StyleProp<ViewStyle>;
}

const styles = StyleSheet.create({
  fallback: { borderRadius: 999 },
});

/**
 * A themed symbol. On platforms with no symbol support (web, or a symbol the
 * font is missing) it degrades to a coloured dot of the same footprint so
 * layouts never jump.
 */
function IconBase({ name, size = 20, color = 'text', tint, style }: IconProps) {
  const theme = useTheme();
  const resolved = tint ?? theme.color[color];
  const symbol = ICONS[name];

  return (
    <SymbolView
      name={symbol}
      size={size}
      tintColor={resolved}
      resizeMode="scaleAspectFit"
      style={style}
      fallback={
        <View
          style={[
            styles.fallback,
            {
              width: size * 0.5,
              height: size * 0.5,
              margin: size * 0.25,
              backgroundColor: resolved,
            },
          ]}
        />
      }
    />
  );
}

export const Icon = memo(IconBase);
Icon.displayName = 'Icon';
