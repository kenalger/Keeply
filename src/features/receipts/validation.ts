/**
 * Keeply — §29 validation for receipts, at the boundary.
 *
 * Pure and synchronous: no database, no clock, no I/O. Every mutation in
 * `queries.ts` runs its input through here BEFORE opening a transaction, and
 * returns `ReceiptResult` rather than throwing — a person mistyping an amount
 * is not an exception, it is a form that needs a message next to a field.
 * Storage failures still throw; those are exceptional.
 *
 * WHAT THIS DUPLICATES, AND WHY THAT IS RIGHT. The database already enforces
 * some of this — `receipts_amount_minor_check`, `receipts_purchase_date_check`,
 * `receipts_category_check`, `receipts_currency_check`. Those are the backstop,
 * and they fail as an opaque `SQLITE_CONSTRAINT` with no idea which field was
 * wrong. This layer exists to fail *legibly*, and to catch what a CHECK cannot
 * see at all: a merchant of only spaces, a note long enough to be a paste
 * accident, and — the one that matters most here — an image URI that is not a
 * local file.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT IS NOT A COLUMN CHECK: A RECEIPT IMAGE IS LOCAL
 * ---------------------------------------------------------------------------
 * `local_image_uri` is a bare `text` column; SQLite will happily store
 * `https://example.com/receipt.jpg` in it. The moment a list view rendered that
 * row it would fetch over the network — the offline-first invariant (§1, §25,
 * §34) and the receipt-privacy rule (§10) both broken by a string in a column,
 * with no lint rule and no CHECK anywhere that could have caught it. So a URI
 * either carries no scheme at all (a sandbox-relative path) or carries `file:`,
 * and anything else is refused here.
 *
 * ---------------------------------------------------------------------------
 * MESSAGES NEVER CONTAIN THE VALUE — AND FOR URIs THAT IS NOT A STYLE RULE
 * ---------------------------------------------------------------------------
 * An amount, a note and a merchant are user data (§18). An image URI is worse:
 * §10 lists it explicitly, because the path to a photo of someone's card
 * statement is itself identifying, and an error message is the one string in
 * this system most likely to be logged, rendered, or attached to a crash
 * report by a caller who never read this file. Every `fieldError()` below names
 * the FIELD and stops. `tests/receipts-privacy.test.ts` feeds hostile URIs
 * through every entry point and asserts no error message ever contains one.
 */
import { isMinorUnits, type MinorUnits } from '@/db/money';
import { DEFAULT_CURRENCY, isValidCalendarDate } from '@/theme/format';

import {
  failed,
  fieldError,
  isReceiptCategory,
  ok,
  type ReceiptCategory,
  type ReceiptError,
  type ReceiptField,
  type ReceiptFilter,
  type ReceiptPatch,
  type ReceiptResult,
  type NewReceiptInput,
} from './types';

/** Long enough for "SM Hypermarket — North EDSA (Branch 0142)". */
export const MERCHANT_MAX_LENGTH = 200;
export const PAYMENT_METHOD_MAX_LENGTH = 120;
export const NOTES_MAX_LENGTH = 4000;
/**
 * A sandbox path plus a UUID plus an extension is well under 200 characters.
 * A kilobyte is generous headroom; anything longer is a paste accident or an
 * attempt to smuggle a payload into a column, and neither belongs on a device
 * with no server-side correction.
 */
export const IMAGE_URI_MAX_LENGTH = 1024;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** A leading `scheme:` if the URI has one. `file` is the only one allowed. */
const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * Control characters, including the NUL that would truncate a C string on the
 * way to the filesystem and the newline that would split a log line in two.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Everything a validated receipt is, ready for `insertReceipt()`. */
export interface ValidatedReceipt {
  merchant: string;
  amountMinor: MinorUnits;
  currency: string;
  category: ReceiptCategory;
  purchaseDate: string;
  paymentMethod: string | null;
  notes: string | null;
  localImageUri: string | null;
  localThumbnailUri: string | null;
}

/** Trim, and treat an all-whitespace optional field as "not provided". */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkMerchant(value: unknown, errors: ReceiptError[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(fieldError('invalid-merchant', 'merchant', 'A receipt needs a merchant'));
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length > MERCHANT_MAX_LENGTH) {
    errors.push(
      fieldError(
        'too-long',
        'merchant',
        `A merchant may be at most ${MERCHANT_MAX_LENGTH} characters`,
      ),
    );
  }
  return trimmed;
}

/**
 * §29: an amount must be greater than zero, and it must be a whole number of
 * minor units. A ₱0 receipt is a data-entry mistake, and a fractional centavo
 * is a float that escaped `AmountField` (§30).
 *
 * REQUIRED, unlike a bill's expected amount. `receipts.amount_minor` is NOT
 * NULL: a bill may legitimately have no estimate yet, but a receipt with no
 * amount is not a receipt, and coercing a missing one to `0` would put a lie
 * into every total that sums this column.
 */
export function checkAmount(value: unknown, errors: ReceiptError[]): MinorUnits {
  if (value === undefined || value === null) {
    errors.push(fieldError('invalid-amount', 'amountMinor', 'A receipt needs an amount'));
    return 0 as MinorUnits;
  }
  if (!isMinorUnits(value)) {
    errors.push(
      fieldError(
        'invalid-amount',
        'amountMinor',
        'An amount must be a whole number of minor units',
      ),
    );
    return 0 as MinorUnits;
  }
  if (value <= 0) {
    errors.push(
      fieldError('invalid-amount', 'amountMinor', 'An amount must be greater than zero'),
    );
    return 0 as MinorUnits;
  }
  return value;
}

function checkCurrency(value: unknown, errors: ReceiptError[]): string {
  if (value === undefined || value === null) return DEFAULT_CURRENCY;
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    errors.push(
      fieldError('invalid-currency', 'currency', 'A currency must be a three-letter ISO code'),
    );
    return DEFAULT_CURRENCY;
  }
  return value;
}

function checkCategory(value: unknown, errors: ReceiptError[]): ReceiptCategory {
  if (value === undefined || value === null) return 'other';
  if (!isReceiptCategory(value)) {
    errors.push(fieldError('invalid-category', 'category', 'That is not a receipt category'));
    return 'other';
  }
  return value;
}

/** §29: a real calendar date. `2026-02-30` and `2026-1-1` are not. */
function checkCalendarDate(
  value: unknown,
  field: ReceiptField,
  errors: ReceiptError[],
): string {
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    errors.push(
      fieldError('invalid-date', field, 'That must be a real calendar date in YYYY-MM-DD form'),
    );
    return '';
  }
  // `parseCalendarDate` tolerates a trailing time; the column must not.
  return value.trim().slice(0, 10);
}

function checkBoundedText(
  value: unknown,
  field: 'paymentMethod' | 'notes',
  maxLength: number,
  errors: ReceiptError[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(fieldError('too-long', field, 'That field must be text'));
    return null;
  }
  if (value.length > maxLength) {
    errors.push(
      fieldError('too-long', field, `That field may be at most ${maxLength} characters`),
    );
    return null;
  }
  return normalizeOptionalText(value);
}

/**
 * A local image URI, or `null`. See the file header for why the scheme matters.
 *
 * NOTE what is deliberately NOT checked: whether the file exists. This layer
 * has no filesystem and must not acquire one — a missing file is a rendering
 * state (§26, "Image unavailable"), not a validation failure, and a receipt
 * whose photo the user later deleted from the sandbox must remain editable.
 */
export function checkImageUri(
  value: unknown,
  field: 'localImageUri' | 'localThumbnailUri',
  errors: ReceiptError[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(fieldError('invalid-uri', field, 'That field must be text'));
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > IMAGE_URI_MAX_LENGTH) {
    // Length only. The value itself never appears in a message (§10).
    errors.push(
      fieldError('too-long', field, `That field may be at most ${IMAGE_URI_MAX_LENGTH} characters`),
    );
    return null;
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    errors.push(fieldError('invalid-uri', field, 'That field may not contain control characters'));
    return null;
  }
  const scheme = URI_SCHEME_PATTERN.exec(trimmed);
  if (scheme !== null && scheme[1].toLowerCase() !== 'file') {
    errors.push(
      fieldError('invalid-uri', field, 'A receipt image must be a local file on this device'),
    );
    return null;
  }
  return trimmed;
}

/**
 * Validate a whole new receipt. Every field is checked — the result lists ALL
 * the problems, not just the first, because a form should not make a person fix
 * one mistake at a time.
 *
 * `todayISO` supplies a missing `purchaseDate` rather than rejecting the input:
 * "photograph the receipt, save it, type the details later" is §9's workflow,
 * and today is the honest answer to a date nobody typed. It is the DEVICE's
 * local calendar day, injected — never SQLite's UTC `date('now')`, which flips
 * a day early in PH time.
 */
export function validateNewReceipt(
  input: NewReceiptInput,
  todayISO: string,
): ReceiptResult<ValidatedReceipt> {
  const errors: ReceiptError[] = [];

  const merchant = checkMerchant(input.merchant, errors);
  const amountMinor = checkAmount(input.amountMinor, errors);
  const currency = checkCurrency(input.currency, errors);
  const category = checkCategory(input.category, errors);
  const purchaseDate = checkCalendarDate(
    input.purchaseDate ?? todayISO,
    'purchaseDate',
    errors,
  );
  const paymentMethod = checkBoundedText(
    input.paymentMethod,
    'paymentMethod',
    PAYMENT_METHOD_MAX_LENGTH,
    errors,
  );
  const notes = checkBoundedText(input.notes, 'notes', NOTES_MAX_LENGTH, errors);
  const localImageUri = checkImageUri(input.localImageUri, 'localImageUri', errors);
  const localThumbnailUri = checkImageUri(
    input.localThumbnailUri,
    'localThumbnailUri',
    errors,
  );

  if (errors.length > 0) return failed(errors);

  return ok({
    merchant,
    amountMinor,
    currency,
    category,
    purchaseDate,
    paymentMethod,
    notes,
    localImageUri,
    localThumbnailUri,
  });
}

/** Only the fields the caller actually asked to change. */
export interface ValidatedReceiptPatch {
  readonly changes: ReadonlyMap<keyof ValidatedReceipt, unknown>;
}

/**
 * Validate a partial edit.
 *
 * No `current` row is needed, unlike `validateBillPatch`: a receipt has no
 * cross-field rule (no cycle to reconcile, no status/date pair) and no
 * cross-row rule (no ledger, no anchor). Each field stands alone.
 *
 * `null` CLEARS a nullable column and is refused for the four the schema
 * declares NOT NULL — clearing a merchant or an amount is not an edit a receipt
 * survives, and letting it through would fail at a CHECK with no field name.
 *
 * An empty patch is an error rather than a no-op: `updateReceipt()` would
 * otherwise build an UPDATE with no SET list, and silently writing only
 * `updated_at` would tell a future sync queue (§21) that something changed when
 * nothing did.
 */
export function validateReceiptPatch(
  patch: ReceiptPatch,
): ReceiptResult<ValidatedReceiptPatch> {
  const errors: ReceiptError[] = [];
  const changes = new Map<keyof ValidatedReceipt, unknown>();

  if (patch.merchant !== undefined) {
    changes.set('merchant', checkMerchant(patch.merchant, errors));
  }
  if (patch.amountMinor !== undefined) {
    changes.set('amountMinor', checkAmount(patch.amountMinor, errors));
  }
  // Typed as `string`, but a patch may arrive from an untyped edge (a restore,
  // a form that was never type-checked). `null` on a NOT NULL column is a
  // refusal with a field name, not a fall-through to the default.
  const currency: unknown = patch.currency;
  if (currency !== undefined) {
    if (currency === null) {
      errors.push(fieldError('invalid-currency', 'currency', 'A receipt must have a currency'));
    } else {
      changes.set('currency', checkCurrency(currency, errors));
    }
  }
  const category: unknown = patch.category;
  if (category !== undefined) {
    if (category === null) {
      errors.push(fieldError('invalid-category', 'category', 'A receipt must have a category'));
    } else {
      changes.set('category', checkCategory(category, errors));
    }
  }
  if (patch.purchaseDate !== undefined) {
    changes.set(
      'purchaseDate',
      checkCalendarDate(patch.purchaseDate, 'purchaseDate', errors),
    );
  }
  if (patch.paymentMethod !== undefined) {
    changes.set(
      'paymentMethod',
      checkBoundedText(
        patch.paymentMethod,
        'paymentMethod',
        PAYMENT_METHOD_MAX_LENGTH,
        errors,
      ),
    );
  }
  if (patch.notes !== undefined) {
    changes.set('notes', checkBoundedText(patch.notes, 'notes', NOTES_MAX_LENGTH, errors));
  }
  // `null` here is the ONLY way a screen detaches a photo, and it is what makes
  // the old file an orphan the caller must unlink. See `queries.ts`.
  if (patch.localImageUri !== undefined) {
    changes.set('localImageUri', checkImageUri(patch.localImageUri, 'localImageUri', errors));
  }
  if (patch.localThumbnailUri !== undefined) {
    changes.set(
      'localThumbnailUri',
      checkImageUri(patch.localThumbnailUri, 'localThumbnailUri', errors),
    );
  }

  if (changes.size === 0 && errors.length === 0) {
    errors.push(fieldError('empty-patch', 'patch', 'That edit changes nothing'));
  }
  if (errors.length > 0) return failed(errors);

  return ok({ changes });
}

/**
 * Check a filter's ranges before a screen sends it.
 *
 * Not called by `listReceipts()` — a list returns a page, not a result, and a
 * nonsensical range legitimately matches nothing. This exists so a filter sheet
 * with two amount boxes and two date boxes can say "the maximum is below the
 * minimum" next to the right field, instead of showing an empty list and
 * letting the user work it out.
 */
export function validateReceiptFilter(filter: ReceiptFilter): ReceiptResult<ReceiptFilter> {
  const errors: ReceiptError[] = [];

  if (filter.fromISO !== undefined) checkCalendarDate(filter.fromISO, 'purchaseDate', errors);
  if (filter.toISO !== undefined) checkCalendarDate(filter.toISO, 'purchaseDate', errors);
  if (
    typeof filter.fromISO === 'string' &&
    typeof filter.toISO === 'string' &&
    filter.fromISO > filter.toISO
  ) {
    // `'YYYY-MM-DD'` sorts lexicographically the same way it sorts as a date,
    // which is the entire reason the column is TEXT in that format.
    errors.push(
      fieldError('invalid-range', 'filter', 'The end of the range is before its start'),
    );
  }

  for (const [value, field] of [
    [filter.minAmountMinor, 'minAmountMinor'],
    [filter.maxAmountMinor, 'maxAmountMinor'],
  ] as const) {
    if (value !== undefined && !isMinorUnits(value)) {
      errors.push(
        fieldError(
          'invalid-amount',
          'amountMinor',
          `${field} must be a whole number of minor units`,
        ),
      );
    }
  }
  if (
    typeof filter.minAmountMinor === 'number' &&
    typeof filter.maxAmountMinor === 'number' &&
    filter.minAmountMinor > filter.maxAmountMinor
  ) {
    errors.push(
      fieldError('invalid-range', 'filter', 'The top of the amount range is below its bottom'),
    );
  }

  if (errors.length > 0) return failed(errors);
  return ok(filter);
}
