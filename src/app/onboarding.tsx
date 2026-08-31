import { OnboardingWizard } from '@/features/onboarding/ui';

/**
 * The first-run wizard (`plan/onboarding.md`), as a route.
 *
 * ── WHY IT IS ADDRESSABLE ──────────────────────────────────────────────────
 * `resolveOnboardingGate()` in `_layout.tsx` replaces the tab stack with this
 * one on a launch where the wizard is still due — which is any launch before it
 * has been finished or explicitly skipped. A route is what that redirect needs;
 * a boolean inside a component could not be reached from the boot path, and
 * `keeply:///onboarding` would not exist for a "finish setting up" nudge later.
 *
 * The screen itself is `@/features/onboarding/ui`, so this file stays what every
 * other route in Keeply is: the address, and nothing else.
 */
export default function OnboardingRoute() {
  return <OnboardingWizard />;
}
