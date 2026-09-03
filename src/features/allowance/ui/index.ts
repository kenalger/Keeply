/**
 * The allowance feature's UI barrel (Phase 9).
 *
 * Screens import from here; nothing under `src/app` reaches into a file inside
 * this directory. Same contract as `src/features/receipts/ui/index.ts`.
 */
export { AllowanceCard, ALLOWANCE_ICON, periodLabel } from './allowance-card';
export { AllowanceSummary } from './allowance-summary';
export type { AllowanceCardProps } from './allowance-card';
export {
  DEFAULT_CADENCE,
  useAllowanceCadence,
  useAllowanceHistory,
  useAllowanceStatus,
} from './hooks';
export type { AsyncStatus, AsyncValue } from './hooks';
export { deleteAllowance, saveAllowance } from './mutations';
