import { Stack } from 'expo-router';

/**
 * The allowance stack. One screen today — set the budget and see its history.
 *
 * Headers are off because every screen in Keeply draws its own
 * `<ScreenHeader/>`; a navigator header would sit above that and say the title
 * twice.
 */
export default function AllowanceLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
