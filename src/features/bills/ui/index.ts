/**
 * Keeply — the bill VIEW layer, colocated with its domain (§7).
 *
 * ```ts
 * import { useBillList, BillForm } from '@/features/bills/ui';
 * ```
 *
 * ── WHERE THE LINE IS ──────────────────────────────────────────────────────
 * `@/features/bills` is the data layer: statements, validation, transactions,
 * typed errors, the reminder port, and no React anywhere in it. Everything in
 * this folder is the other side of that line — hooks that resolve a read into
 * the four render states, the words a screen puts on a state, the form, and
 * the write wrappers that publish staleness.
 *
 * Nothing here re-implements anything from the data layer. `isOverdue` and
 * `daysUntilDue` are the ones SQLite derived on the row against the device's
 * local today; the totals are the ones SQLite summed; the roll-forward is the
 * data layer's, anchored. Screens (`src/app/bills/**`) hold layout and
 * navigation and nothing else.
 */
export {
  LIST_PAGE_SIZE,
  useBillFilter,
  useBillList,
  useBillPayments,
  useBillRecord,
  useBillTotals,
  useUpcomingBills,
  type AsyncStatus,
  type AsyncValue,
  type BillListView,
  type BillStateFilter,
} from './hooks';
export { BillForm, type BillFormProps } from './bill-form';
export { BillFilterSheet, type BillFilterSheetProps } from './filter-sheet';
export { isDraftDirty, pickDraft } from './draft';
export {
  BILL_CATEGORIES_ORDERED,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  CYCLE_LABELS,
  STATE_LABELS,
  amountLine,
  billState,
  billStatusKey,
  billSubtitle,
  categoryLabel,
  describeCycle,
  describeRecurrence,
  dueCountdown,
  estimateNote,
} from './labels';
export {
  fieldMessages,
  formMessage,
  messageFor,
  writeFailureMessage,
  type FieldMessages,
} from './messages';
export {
  archiveBill,
  deleteBill,
  deleteBillPayment,
  markBillPaid,
  saveBillEdit,
  saveBillPaymentEdit,
  saveNewBill,
  undoBillPayment,
} from './mutations';
export { PaymentEditSheet, type PaymentEditSheetProps } from './payment-edit-sheet';
