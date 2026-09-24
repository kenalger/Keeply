import { Redirect } from 'expo-router';

import AppTabs from '@/components/app-tabs';
import { useOnboardingStore } from '@/stores/onboarding-store';

/**
 * Bottom-tab layout for the five main sections (§4).
 *
 * ── A FIRST RUN NEVER PAINTS THE TABS ──────────────────────────────────────
 * Whether the wizard is due is decided in `LockGate` before this can mount
 * (`useOnboardingStore.decide()`, one settings read). While it is due this
 * renders a redirect to the wizard and nothing else, so no tab reads and none
 * paints; the wizard's own exit brings the user back here with `due` false.
 * The gate used to be resolved after the navigator had mounted, so a first run
 * painted Home and then replaced it.
 *
 * `null` means the decision could not be made (the read threw). The tabs are
 * the safe default: a user who cannot be onboarded still gets an app that works.
 */
export default function TabsLayout() {
  const due = useOnboardingStore((store) => store.due);
  if (due === true) return <Redirect href="/onboarding" />;
  return <AppTabs />;
}
