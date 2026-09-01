import { Stack } from 'expo-router';

/**
 * The receipts stack: list → detail → edit, plus the capture flow and the add
 * form.
 *
 * Headers are off because every screen in Keeply draws its own `<ScreenHeader/>`
 * — a large title that scrolls with the content, with the screen's own actions
 * in it. A navigator header would sit above that and say the title twice.
 */
export default function ReceiptsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
