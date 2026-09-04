import { Stack } from 'expo-router';

/**
 * The bills stack: list, add, detail, edit.
 *
 * Headers are off because every screen draws its own `<ScreenHeader/>`.
 */
export default function BillsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
