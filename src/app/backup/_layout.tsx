import { Stack } from 'expo-router';

/**
 * The backup stack: export and restore.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`.
 */
export default function BackupLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
