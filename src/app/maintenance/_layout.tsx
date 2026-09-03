import { Stack } from 'expo-router';

/**
 * The maintenance stack: list → detail, plus the add form.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`; a
 * navigator header would sit above it and say the title twice.
 */
export default function MaintenanceLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
