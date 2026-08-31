import { Stack } from 'expo-router';

/**
 * The subscriptions stack: list → detail → edit, plus the add form.
 *
 * Headers are off because every screen in Keeply draws its own `<ScreenHeader/>`
 * — a large title that scrolls with the content, with the screen's own actions
 * in it. A navigator header would sit above that and say the title twice.
 */
export default function SubscriptionsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
