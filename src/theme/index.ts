/**
 * Keeply theme runtime.
 *
 * Public surface (feature code should import only from `@/theme`):
 *
 *   import { ThemeProvider, useTheme, useThemeMode, useThemedStyles } from '@/theme';
 *   import type { Theme, ThemeMode, StatusKey } from '@/theme';
 */
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

import { darkTheme, lightTheme, type Theme, type ThemeMode } from './tokens';

export type {
  ColorKey,
  StatusKey,
  StatusToken,
  Theme,
  ThemeColor,
  ThemeLayout,
  ThemeMode,
  ThemeRadius,
  ThemeShadow,
  ThemeSpace,
  ThemeStatus,
  ThemeType,
  TypeVariant,
} from './tokens';

export {
  darkTheme,
  hitSlop,
  layout,
  lightTheme,
  MAX_FONT_SCALE,
  MAX_FONT_SCALE_TIGHT,
  MIN_TOUCH_TARGET,
  radius,
  space,
  STATUS_KEYS,
  themes,
  typography,
} from './tokens';

export * from './format';

/** What the user asked for, as opposed to what is currently rendered. */
export type ThemePreference = 'system' | 'light' | 'dark';

export interface ThemeModeControl {
  /** The mode actually in effect right now. */
  mode: ThemeMode;
  /** The stored preference. `'system'` means "follow the OS". */
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

const ThemeContext = createContext<Theme | null>(null);
const ThemeModeContext = createContext<ThemeModeControl | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /**
   * Seed the preference. A later phase reads this from persisted settings and
   * passes it in; nothing here writes to storage.
   */
  initialPreference?: ThemePreference;
}

export const ThemeProvider: FC<ThemeProviderProps> = ({
  children,
  initialPreference = 'system',
}) => {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  // RN 0.86 returns 'light' | 'dark' | 'unspecified'.
  const systemScheme = useColorScheme();

  const mode: ThemeMode =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const theme = mode === 'dark' ? darkTheme : lightTheme;

  const modeControl = useMemo<ThemeModeControl>(
    () => ({ mode, preference, setPreference }),
    [mode, preference],
  );

  return createElement(
    ThemeContext.Provider,
    { value: theme },
    createElement(ThemeModeContext.Provider, { value: modeControl }, children),
  );
};

/** The active theme. Throws if used outside `<ThemeProvider>`. */
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error('useTheme() must be used inside <ThemeProvider>.');
  }
  return theme;
}

/** Read and change the light/dark preference. */
export function useThemeMode(): ThemeModeControl {
  const control = useContext(ThemeModeContext);
  if (control === null) {
    throw new Error('useThemeMode() must be used inside <ThemeProvider>.');
  }
  return control;
}

export type NamedStyles<T> = {
  [P in keyof T]: ViewStyle | TextStyle | ImageStyle;
};

/**
 * Build a `StyleSheet` from the active theme, rebuilt only when the theme
 * identity changes — not on every render.
 *
 * Define the factory at module scope so it is allocated once:
 *
 * ```ts
 * const makeStyles = (t: Theme) => StyleSheet.create({ root: { padding: t.space.lg } });
 * // ...
 * const styles = useThemedStyles(makeStyles);
 * ```
 */
export function useThemedStyles<T extends NamedStyles<T>>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  // Intentionally keyed on theme identity only: the factory is expected to be
  // a stable module-scope function, and re-running it per render is exactly
  // what this hook exists to avoid.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => factory(theme), [theme]);
}
