import { Stack } from 'expo-router';

/**
 * The reminders stack: the overview, and one screen per record kind.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`.
 */
export default function RemindersLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
