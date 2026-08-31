import { Stack, useRouter } from 'expo-router';

import { FallbackScreen } from '@/lib/fallback-screen';

/**
 * Themed 404.
 *
 * Reachable from a stale deep link (`keeply://…`) or a route that was removed
 * between app versions. Offline-first framing: this is never "page not found
 * on the server", it is a link that no longer points anywhere in the app.
 */
export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <FallbackScreen
        title="That screen no longer exists"
        body="The link you followed points somewhere Keeply does not have. Nothing is wrong with your data — head back to your dashboard and carry on."
        actionLabel="Go to Home"
        onAction={() => {
          router.replace('/');
        }}
        secondaryLabel={router.canGoBack() ? 'Go back' : undefined}
        onSecondaryAction={router.canGoBack() ? () => router.back() : undefined}
      />
    </>
  );
}
