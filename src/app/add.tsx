import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { AddItemSheet } from '@/components/add-item-sheet';

/**
 * §28's `+ Add`, as a route.
 *
 * ── WHY A ROUTE AND NOT A PIECE OF SCREEN STATE ────────────────────────────
 * The five tabs stay mounted at once. A sheet driven by shared state would be
 * rendered five times over; a sheet driven by per-screen state has to be
 * repeated in every screen that offers it, and each copy is a place for the two
 * to drift. A route exists exactly once, wherever it was opened from.
 *
 * It also makes the add flow addressable — `keeply:///add`. That is what a Home
 * Screen quick action, a Siri shortcut and a notification's "add another" all
 * need, and none of them can reach a boolean inside a component.
 *
 * Presented as a transparent modal so whatever the user was looking at stays
 * behind the sheet's scrim, which is the whole visual premise of a bottom
 * sheet: you have not left, you have been handed a drawer.
 */
export default function AddItemRoute() {
  const router = useRouter();

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return <AddItemSheet visible onClose={close} />;
}
