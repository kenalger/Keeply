import { Redirect, Stack } from 'expo-router';

import { UIPreview } from '@/components/ui/preview';
import { isDev } from '@/lib/env';

/**
 * The design-system gallery, behind a development-only route.
 *
 * KEPT RATHER THAN DELETED. `preview.tsx` renders every primitive, every type
 * variant, every status token and every icon on one page in both themes. It is
 * the only way to see the whole system at once, and it is exactly the surface
 * that makes a regression like six full-height empty states obvious before it
 * reaches a screenshot. Unreferenced, it would have rotted within a phase; a
 * route means it breaks the build the moment a primitive's API changes, which
 * is the entire value of keeping it.
 *
 * In a release bundle this redirects Home, so the gallery is unreachable even
 * if someone deep-links `keeply://ui-preview`. Reached in development from
 * More → Developer → Design system.
 */
export default function UIPreviewRoute() {
  if (!isDev) return <Redirect href="/" />;

  return (
    <>
      <Stack.Screen
        options={{ headerShown: true, title: 'Design system', headerBackTitle: 'Back' }}
      />
      <UIPreview />
    </>
  );
}
