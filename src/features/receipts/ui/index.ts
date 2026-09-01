/**
 * Keeply — the receipt VIEW layer, colocated with its domain.
 *
 * ```ts
 * import { useReceiptList, ReceiptForm } from '@/features/receipts/ui';
 * ```
 *
 * ── WHERE THE LINE IS ──────────────────────────────────────────────────────
 * `@/features/receipts` is the data layer: statements, validation,
 * transactions, typed errors, and no React anywhere in it. It is FINAL, and
 * nothing in this folder modifies or re-implements it — the totals are the ones
 * SQLite summed, the page count is the one SQLite counted, the validation
 * messages are rendered from `code` + `field` rather than from the validator's
 * own developer-facing strings.
 *
 * Everything in this folder is the other side of that line: hooks that resolve
 * a read into the four render states, the words a screen puts on a category,
 * the form, the capture flow, and the FILESYSTEM — which the data layer
 * deliberately does not own. Screens (`src/app/receipts/**`) hold layout and
 * navigation and nothing else.
 *
 * ── THE ONE THING TO READ BEFORE CHANGING ANY OF THIS ──────────────────────
 * `./mutations.ts`. A receipt is a row in SQLCipher and a file in the sandbox
 * with no transaction spanning them, and the ORDER of those two writes — row
 * first and file second on the way out, file first and row second on the way
 * in — is the whole design. `queries.ts`'s header argues it; `./mutations.ts`
 * and `./storage.ts` are the only two places in the app that implement it.
 */
export {
  activeFilterCount,
  EMPTY_FILTER,
  isFiltered,
  LIST_PAGE_SIZE,
  totalsOptionsFor,
  useReceiptFilter,
  useReceiptList,
  useReceiptRecord,
  useReceiptTotals,
  type AsyncStatus,
  type AsyncValue,
  type ReceiptFilterState,
  type ReceiptListView,
} from './hooks';

export {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  categoryLabel,
  damagedNote,
  rowSubtitle,
  SORT_LABELS,
  summaryLine,
} from './labels';

export { fieldMessages, formMessage, messageFor, type FieldMessages } from './messages';

export { deleteReceipt, saveNewReceipt, saveReceiptEdit } from './mutations';

export {
  describeCameraPermission,
  describeLibraryPermission,
  openAppSettings,
  permissionAllows,
  permissionCanAsk,
  permissionCopy,
  permissionNeedsSettings,
  type MediaPermission,
  type MediaPermissionKind,
  type PermissionCopy,
} from './permissions';

export { useImageCapture, type ImageCapture } from './capture';

export {
  imageFileExists,
  storeReceiptImage,
  unlinkOrphanedImages,
  ReceiptStorageError,
  type StoredReceiptImage,
} from './storage';

export {
  attachDraftImage,
  clearReceiptDraft,
  lastReceiptCategory,
  NEW_RECEIPT_DRAFT,
  readReceiptDraft,
  rememberReceiptCategory,
  useReceiptDraftStore,
  type ReceiptDraft,
  type ReceiptDraftKey,
} from './draft-store';

export { CameraCapture, type CameraCaptureProps } from './camera-capture';
export { ReceiptFilterSheet, type ReceiptFilterSheetProps } from './filter-sheet';
export {
  ReceiptImage,
  ReceiptThumbnail,
  type ReceiptImageProps,
  type ReceiptThumbnailProps,
} from './receipt-image';
export { emptyReceiptDraft, ReceiptForm, type ReceiptFormProps } from './receipt-form';
