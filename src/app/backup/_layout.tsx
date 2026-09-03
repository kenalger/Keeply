import { Stack } from 'expo-router';

/**
 * The backup stack. Export today; restore joins it in 8c.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`.
 */
export default function BackupLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
