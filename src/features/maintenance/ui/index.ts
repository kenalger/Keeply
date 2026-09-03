/**
 * The maintenance feature's UI barrel (Phase 5).
 *
 * Screens import from here; nothing under `src/app` reaches into a file inside
 * this directory. Same contract as `src/features/receipts/ui/index.ts`.
 */
export {
  KIND_DESCRIPTIONS,
  KIND_ICONS,
  KIND_LABELS,
  KIND_OPTIONS,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPE_OPTIONS,
  describeItem,
} from './labels';
export {
  useItemTotals,
  useMaintenanceItem,
  useMaintenanceList,
  type AsyncStatus,
  type AsyncValue,
  type KindFilter,
  type MaintenanceListView,
} from './hooks';
export { removeItem, saveItemPatch, saveNewItem } from './mutations';
export { MaintenanceForm } from './maintenance-form';
