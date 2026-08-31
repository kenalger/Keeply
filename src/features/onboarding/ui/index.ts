/**
 * The wizard's screens.
 *
 * Kept out of `src/features/onboarding/index.ts` on purpose: that module is the
 * feature's data entrypoint and is imported by the root layout's first-run gate,
 * where pulling in React Native views would be dead weight. Same split as
 * `src/features/subscriptions/ui`.
 */
export { OnboardingWizard } from './wizard';
export { WizardFrame, WizardProgress, type WizardFrameProps } from './wizard-frame';
