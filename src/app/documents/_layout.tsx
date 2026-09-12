import { Stack } from 'expo-router';

/**
 * The documents stack: the tab's list → detail, plus the add form.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`; a
 * navigator header would sit above it and say the title twice.
 */
export default function DocumentsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
