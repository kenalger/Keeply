/**
 * The loading screen — the splash, continued in JavaScript.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 * Boot used to render `null` under the native splash and hide the splash only
 * once the tabs were ready. Two things were wrong with that. On a slow boot — a
 * migration, a cold SQLCipher key derivation — the user stared at a static
 * picture with no sign anything was happening. And on the paths where the
 * splash was ALREADY gone — "Try again" after a failed boot, the erase-and-
 * start-over flow — the window went blank until the database opened.
 *
 * This screen draws the same mark, at the same size, on the same canvas colour
 * as the native splash (`app.json` → `expo-splash-screen`: `imageWidth` 180,
 * `backgroundColor` = the theme's `bg`). Lifting the splash over it is
 * therefore invisible; the only thing that changes is that a caption fades in
 * underneath saying what the app is doing. `LOADING_MARK_SIZE` and those two
 * `app.json` values MUST stay in step, or the bird jumps on every launch.
 *
 * ── THE CAPTION IS POSITIONED ABSOLUTELY ───────────────────────────────────
 * So the mark never moves. A caption laid out in the same column would push
 * the mark up by half its own height the moment it appeared, and again each
 * time its length changed.
 */
import { Image } from 'expo-image';
import {
  StyleSheet,
  View,
  type ImageRequireSource,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { useTheme, useThemedStyles, type Theme } from '@/theme';

import { Text } from './text';

// `require`, not `import`: Metro bundles the asset either way, but nothing in
// this project declares a module type for `*.png`, and the lint config allows
// `require` for exactly this — image extensions are on its allow-list.
const markDark: ImageRequireSource = require('../../../assets/images/splash-icon-dark.png');
const markLight: ImageRequireSource = require('../../../assets/images/splash-icon.png');

/** Points. Equal to the splash's `imageWidth`, so the mark does not move. */
export const LOADING_MARK_SIZE = 180;

export interface LoadingScreenProps {
  /** What is happening — "Opening your data…". Spoken as well as shown. */
  caption?: string | null;
  /** Fired once the screen has laid out: the moment the native splash can lift. */
  onReady?: () => void;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.bg,
    },
    mark: { width: LOADING_MARK_SIZE, height: LOADING_MARK_SIZE },
    caption: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: '50%',
      marginTop: LOADING_MARK_SIZE / 2 + t.space.xl,
      alignItems: 'center',
      paddingHorizontal: t.layout.gutter,
    },
  });

export function LoadingScreen({ caption = null, onReady, testID }: LoadingScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const handleLayout = (event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height > 0) onReady?.();
  };

  return (
    <View
      style={styles.root}
      onLayout={onReady === undefined ? undefined : handleLayout}
      accessibilityRole="progressbar"
      accessibilityLabel={caption ?? 'Loading'}
      testID={testID}>
      <Image
        source={theme.mode === 'dark' ? markDark : markLight}
        style={styles.mark}
        contentFit="contain"
        accessibilityIgnoresInvertColors
        accessible={false}
      />
      {caption === null ? null : (
        <Animated.View
          entering={FadeIn.duration(220)}
          style={styles.caption}
          accessibilityLiveRegion="polite">
          <Text variant="body" color="textSecondary" align="center">
            {caption}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}
