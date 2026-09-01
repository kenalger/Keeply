/**
 * Keeply — the receipt queries and mutations (§9, §10, §23, §29).
 *
 * Built over the `ReceiptStore` seam so the identical code runs against
 * op-sqlite on a device and against `node:sqlite` in `tests/receipts-*.test.ts`.
 * `index.ts` binds them to `@/db`; nothing in this file may import it (see
 * `store.ts`).
 *
 * ---------------------------------------------------------------------------
 * The rules this module keeps
 * ---------------------------------------------------------------------------
 * READS come from `receipts_live`, never the base table. A soft delete does not
 * cascade and a tombstone read is a deleted receipt back in the user's total —
 * and, worse than for any other entity, a screen trying to render the image of
 * a row the user believes they erased.
 *
 * AGGREGATES happen in SQLite. `receiptTotals()` issues three grouped queries
 * and never sees a receipt row; `listReceipts()` counts its matches with
 * `count(*)` rather than `rows.length`. Nothing in this file reduces over rows.
 *
 * MULTI-STATEMENT WRITES run inside `store.atomically()`, which `index.ts`
 * implements over `withTransaction()` from `@/db`.
 *
 * EVERY MUTATION sets `updated_at`, and nothing is ever hard-deleted.
 *
 * WHAT THE CLOCK IS. `nowMs` and `todayISO` are injected rather than read from
 * the ambient environment: `now` is a timestamp in epoch millis, `today` is a
 * calendar date in the DEVICE's local timezone, and the two are never derived
 * from each other. SQLite's `date('now')` is UTC and flips a day early in PH
 * time, so it appears nowhere in this feature.
 *
 * ---------------------------------------------------------------------------
 * A DAMAGED ROW IS SKIPPED BY A LIST AND STILL DELETABLE
 * ---------------------------------------------------------------------------
 * SQLite is dynamically typed, so `amount_minor = 1234.5` sits happily past the
 * `> 0` CHECK. Mapping such a row throws.
 *
 *  - A LIST skips it and reports `damagedCount` (`ReceiptPage`), because
 *    throwing from a list makes one bad record blank the whole screen behind a
 *    "Try again" that re-runs the identical query forever.
 *  - `getReceipt(id)` still THROWS, because the caller named that row: silently
 *    returning `null` for a record that exists would tell the user it is gone.
 *  - `softDeleteReceipt()` NEVER MAPS. It reads the id and the two URI columns
 *    and nothing else, so whatever is wrong with the rest of the row, the user
 *    can always get rid of it. This is the policy `existsById` established in
 *    `src/features/bills/queries.ts`, with a payload attached.
 *
 * ---------------------------------------------------------------------------
 * THE IMAGE FILE: WHY THE ROW IS WRITTEN FIRST AND THE FILE UNLINKED SECOND
 * ---------------------------------------------------------------------------
 * A receipt is two things in two storage systems: a row in SQLCipher and a JPEG
 * in the app sandbox. There is no transaction spanning both, no server to
 * reconcile them, and no re-fetch to repair either. So the ORDER of the two
 * writes is the whole design, and it is fixed here rather than left to each
 * screen:
 *
 *     1. commit the row write (soft delete, or the patch that replaces the URI)
 *     2. THEN unlink the file, using the URIs this module hands back
 *
 * Never the reverse. The two failure modes are not symmetric:
 *
 *  - FILE FIRST, then a crash before the row write → an ORPHANED ROW: a receipt
 *    the user still sees, pointing at bytes that are gone. Every list renders it
 *    as "Image unavailable" forever, and nothing in the app knows the image was
 *    deliberately destroyed rather than lost. The user's record is corrupted and
 *    unrecoverable.
 *  - ROW FIRST, then a crash before the unlink → an ORPHANED FILE: bytes on
 *    disk that no live row references. The user sees exactly what they expect.
 *    The cost is disk space, and it is recoverable.
 *
 * An orphaned row cannot be repaired. An orphaned file can. That asymmetry —
 * not performance, not tidiness — is the reason for the order.
 *
 * AND THE ORPHAN IS NOT UNREACHABLE GARBAGE. The delete is SOFT: the tombstone
 * keeps `local_image_uri`, so the stranded bytes are still NAMED by a row. A
 * future sweep can unlink exactly those files by reading the tombstones,
 * instead of scanning a directory and guessing which files nothing points at —
 * which is the sweep that would eventually delete a photo it should not have.
 * `sql.ts`'s `softDeleteReceipt` documents that the tombstone retains the URI
 * for this reason; do not "tidy" it to NULL.
 *
 * WHAT THE CALLER GETS, SO IT CAN HONOUR THIS. Both writes that can strand
 * bytes return the URIs they stranded:
 *
 *     const removed = await softDeleteReceipt(id);
 *     if (removed.ok) for (const uri of removed.value.orphanedUris) await unlink(uri);
 *
 *     const saved = await updateReceipt(id, { localImageUri: fresh });
 *     if (saved.ok) for (const uri of saved.value.orphanedUris) await unlink(uri);
 *
 * `orphanedUris` is computed from the row as it was INSIDE the transaction, so
 * it cannot be stale, and it is empty unless a URI actually stopped being
 * referenced. A caller that ignores it leaks disk; a caller that unlinks before
 * awaiting corrupts data. Only the second is unrecoverable, which is why the
 * API makes the first the easy mistake.
 *
 * CAPTURE, the mirror image, belongs to the screens: write the FILE first, then
 * `createReceipt()`. A crash between them orphans a file, never a row. Same
 * asymmetry, same conclusion — the durable, user-visible record is written last
 * on the way in and first on the way out.
 *
 * ---------------------------------------------------------------------------
 * WHERE A URI IS ALLOWED TO GO
 * ---------------------------------------------------------------------------
 * Into a `ReceiptRecord`, into `orphanedUris`, and nowhere else. It is never
 * interpolated into an error message (`corrupt()` and every `fieldError()` name
 * the FIELD), never passed to `log.*`, and never used in a WHERE clause that
 * compares it to anything (`sql.ts` header). §10 and §19 are explicit that a
 * receipt image path is sensitive; this module contains no `log` import at all,
 * so there is no line to accidentally add one to.
 */
import { minorUnits, type MinorUnits } from '@/db/money';
import { DEFAULT_CURRENCY } from '@/theme/format';

import * as statements from './sql';
import type { ReceiptStore, SqlValue } from './store';
import {
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_ROWS,
  failed,
  fieldError,
  isReceiptCategory,
  ok,
  type DeletedReceipt,
  type ReceiptCategory,
  type ReceiptCategoryTotal,
  type ReceiptCurrencyTotal,
  type ReceiptFilter,
  type ReceiptPage,
  type ReceiptPatch,
  type ReceiptRecord,
  type ReceiptResult,
  type ReceiptTotals,
  type ReceiptTotalsOptions,
  type ReceiptWrite,
  type NewReceiptInput,
} from './types';
import { validateNewReceipt, validateReceiptPatch } from './validation';

export interface ReceiptsApiDeps {
  store: ReceiptStore;
  /** A fresh UUIDv4. `newId()` from `@/db` on a device. */
  newId(): string;
  /** Epoch milliseconds, for `created_at` / `updated_at` / `deleted_at`. */
  nowMs(): number;
  /** Today in the DEVICE's local calendar, `'YYYY-MM-DD'`. */
  todayISO(): string;
}

export interface ReceiptsApi {
  /** §23: merchant search, category, date range, amount range. Always paged. */
  listReceipts(filter?: ReceiptFilter): Promise<ReceiptPage>;
  /**
   * One receipt, or `null` if no live row has that id.
   *
   * @throws {TypeError} if the row exists but is corrupt. The caller named this
   *         record; returning `null` would claim it does not exist.
   */
  getReceipt(id: string): Promise<ReceiptRecord | null>;
  createReceipt(input: NewReceiptInput): Promise<ReceiptResult<ReceiptRecord>>;
  /** Edit. Returns the committed row plus any image URIs the edit stranded. */
  updateReceipt(id: string, patch: ReceiptPatch): Promise<ReceiptResult<ReceiptWrite>>;
  /** Soft delete. Returns the URIs to unlink — see the header for the order. */
  softDeleteReceipt(id: string): Promise<ReceiptResult<DeletedReceipt>>;
  /** Spending, grouped by currency and by category, aggregated in SQL (§5). */
  receiptTotals(options?: ReceiptTotalsOptions): Promise<ReceiptTotals>;
  /** §5's "Recent Activity": the newest receipts, capped. */
  recentReceipts(limit?: number): Promise<readonly ReceiptRecord[]>;
}

/* -------------------------------------------------------------------------- */
/* Row mapping — corrupt storage fails loudly, it does not render              */
/* -------------------------------------------------------------------------- */

/**
 * SQLite is dynamically typed: affinity is a preference, not a guarantee, so a
 * column declared INTEGER can hold text if something ever wrote text to it.
 * Every field is therefore checked on the way out rather than cast.
 *
 * These throw. A receipt whose amount is not an integer is corruption, and
 * rendering it as if it were fine is how a wrong number ends up in a total the
 * user then trusts. There is no server to repair it and no re-fetch to try. The
 * callers decide what to do with the throw: a list catches and counts, a
 * single-record read lets it out, a delete never gets here at all.
 */
function corrupt(field: string): never {
  // Field name only. The value is user data, and for a URI column it is
  // sensitive user data (§10) that must not reach a message someone may log.
  throw new TypeError(`Corrupt receipt row: ${field}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') corrupt(field);
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) corrupt(field);
  return value;
}

function readMinor(value: unknown, field: string): MinorUnits {
  return minorUnits(readInteger(value, field));
}

function readCategory(value: unknown, field: string): ReceiptCategory {
  if (!isReceiptCategory(value)) corrupt(field);
  return value;
}

export function mapReceiptRow(row: statements.ReceiptRow): ReceiptRecord {
  return {
    id: readString(row.id, 'id'),
    merchant: readString(row.merchant, 'merchant'),
    amountMinor: readMinor(row.amount_minor, 'amount_minor'),
    currency: readString(row.currency, 'currency'),
    category: readCategory(row.category, 'category'),
    purchaseDate: readString(row.purchase_date, 'purchase_date'),
    paymentMethod: readNullableString(row.payment_method, 'payment_method'),
    notes: readNullableString(row.notes, 'notes'),
    localImageUri: readNullableString(row.local_image_uri, 'local_image_uri'),
    localThumbnailUri: readNullableString(row.local_thumbnail_uri, 'local_thumbnail_uri'),
    createdAt: readInteger(row.created_at, 'created_at'),
    updatedAt: readInteger(row.updated_at, 'updated_at'),
  };
}

/** `sum()` over no rows is NULL, and `count()` over none is 0. Both mean zero. */
function readAggregate(value: unknown, field: string): number {
  if (value === null || value === undefined) return 0;
  return readInteger(value, field);
}

/**
 * A URI off a raw row, for the delete/replace path. NEVER throws.
 *
 * Deliberately more forgiving than `readNullableString`: if something has
 * written a number into `local_image_uri`, there is no file to unlink and no
 * reason to stop the user removing the record. A damaged row must always be
 * removable — that is the whole policy — and it must not be made unremovable by
 * the very column the delete exists to clean up after.
 */
function uriOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The distinct, non-empty image URIs a row references. Order is stable. */
function urisOf(row: {
  local_image_uri: unknown;
  local_thumbnail_uri: unknown;
}): string[] {
  const found: string[] = [];
  for (const value of [row.local_image_uri, row.local_thumbnail_uri]) {
    const uri = uriOrNull(value);
    if (uri !== null && !found.includes(uri)) found.push(uri);
  }
  return found;
}

const ZERO_TOTAL = (currency: string): ReceiptCurrencyTotal => ({
  currency,
  receiptCount: 0,
  totalMinor: minorUnits(0),
});

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a receipts API over one store.
 *
 * Exported for the same reason `createBillsApi` is: a caller that already holds
 * a transaction — a restore writing forty receipts all-or-nothing — cannot call
 * the module-level `createReceipt()` inside it, because that binding's store
 * opens its own `withTransaction()` and op-sqlite serialises transactions
 * through a lock queue, so the inner one would wait forever for a slot the
 * outer one holds. Build a second API over the transaction's own handle
 * instead: same factory, same statements, same §29 validation, one BEGIN.
 */
export function createReceiptsApi(deps: ReceiptsApiDeps): ReceiptsApi {
  const store = deps.store;

  async function readById(
    reader: ReceiptStore,
    id: string,
  ): Promise<ReceiptRecord | null> {
    const rows = await reader.all<statements.ReceiptRow>(statements.selectReceiptById(id));
    return rows.length === 0 ? null : mapReceiptRow(rows[0]);
  }

  /** Re-read the row a mutation just wrote, inside the same transaction. */
  async function requireById(
    reader: ReceiptStore,
    id: string,
  ): Promise<ReceiptResult<ReceiptRecord>> {
    const record = await readById(reader, id);
    if (record === null) {
      return failed([fieldError('not-found', 'id', 'That receipt no longer exists')]);
    }
    return ok(record);
  }

  return {
    /**
     * §23: merchant, category, date range, amount range — paginated, newest
     * first.
     *
     * `total` is `count(*)` over the same WHERE, so "showing 50 of 128" is a
     * fact from SQLite rather than a guess. The two statements are not wrapped
     * in a transaction: this is a single-user, single-connection app, and a
     * read does not need to lock out a write that cannot be concurrent.
     *
     * NEVER UNBOUNDED. `resolvePageSize()` clamps to `MAX_PAGE_SIZE` and
     * defaults to `DEFAULT_PAGE_SIZE`, so a receipt journal five years deep
     * cannot be pulled into memory by a caller that forgot a limit (§33).
     */
    async listReceipts(filter: ReceiptFilter = {}): Promise<ReceiptPage> {
      const limit = statements.resolvePageSize(filter.limit);
      const offset = statements.resolveOffset(filter.offset);
      const rows = await store.all<statements.ReceiptRow>(
        statements.selectReceipts(filter),
      );
      const counted = await store.all<statements.CountRow>(
        statements.countReceipts(filter),
      );
      const total = counted.length === 0 ? 0 : readAggregate(counted[0].n, 'count');

      // Skip, do not throw. One row with a float amount would otherwise take
      // the whole journal down; the row is still counted so the screen can say
      // a record could not be read, and `softDeleteReceipt()` can still remove
      // it.
      const mapped: ReceiptRecord[] = [];
      let damagedCount = 0;
      for (const row of rows) {
        try {
          mapped.push(mapReceiptRow(row));
        } catch {
          damagedCount += 1;
        }
      }

      return {
        rows: mapped,
        damagedCount,
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      };
    },

    async getReceipt(id: string): Promise<ReceiptRecord | null> {
      // Maps, and therefore throws on a corrupt row. See the header: the caller
      // named this record, so "unreadable" and "absent" must not look alike.
      return readById(store, id);
    },

    /**
     * Validate, insert, read back — the last two inside one transaction so the
     * record returned is provably the row that was committed.
     *
     * The type is a hint, not the check: a restore and an import both reach
     * here, and `validateNewReceipt` re-checks every field against §29 whatever
     * the compiler was told.
     *
     * THE FILE IS ALREADY ON DISK when this is called. See the header: capture
     * writes the bytes first, so a crash here orphans a file, never a row.
     */
    async createReceipt(input: NewReceiptInput): Promise<ReceiptResult<ReceiptRecord>> {
      const validated = validateNewReceipt(input, deps.todayISO());
      if (!validated.ok) return validated;

      const id = deps.newId();
      const now = deps.nowMs();

      return store.atomically(async (tx) => {
        await tx.execute(
          statements.insertReceipt({
            id,
            merchant: validated.value.merchant,
            amountMinor: validated.value.amountMinor,
            currency: validated.value.currency,
            category: validated.value.category,
            purchaseDate: validated.value.purchaseDate,
            paymentMethod: validated.value.paymentMethod,
            notes: validated.value.notes,
            localImageUri: validated.value.localImageUri,
            localThumbnailUri: validated.value.localThumbnailUri,
            nowMs: now,
          }),
        );
        return requireById(tx, id);
      });
    },

    /**
     * Edit one receipt.
     *
     * The URIs the row referenced BEFORE the write are read inside the same
     * transaction, off the raw row and without mapping it, then compared with
     * the URIs it references after. Anything that dropped off is returned in
     * `orphanedUris` for the caller to unlink — after this resolves, never
     * before. See the header.
     *
     * @throws {TypeError} if the row is corrupt. Unlike a delete, an edit has
     *         to read the record back to return it, and a record that cannot be
     *         mapped cannot be returned. Deleting it still works.
     */
    async updateReceipt(
      id: string,
      patch: ReceiptPatch,
    ): Promise<ReceiptResult<ReceiptWrite>> {
      const validated = validateReceiptPatch(patch);
      if (!validated.ok) return failed<ReceiptWrite>(validated.errors);

      const now = deps.nowMs();
      return store.atomically(async (tx) => {
        const existing = await tx.all<statements.ReceiptImageRow>(
          statements.selectReceiptImagesById(id),
        );
        if (existing.length === 0) {
          return failed<ReceiptWrite>([
            fieldError('not-found', 'id', 'That receipt no longer exists'),
          ]);
        }
        const before = urisOf(existing[0]);

        const assignments = new Map<statements.PatchableReceiptField, SqlValue>();
        for (const [field, value] of validated.value.changes) {
          assignments.set(field as statements.PatchableReceiptField, value as SqlValue);
        }
        await tx.execute(statements.updateReceipt(id, assignments, now));

        const reread = await requireById(tx, id);
        if (!reread.ok) return failed<ReceiptWrite>(reread.errors);

        const after = new Set(
          [reread.value.localImageUri, reread.value.localThumbnailUri].filter(
            (uri): uri is string => uri !== null,
          ),
        );
        return ok({
          record: reread.value,
          orphanedUris: before.filter((uri) => !after.has(uri)),
        });
      });
    },

    /**
     * Soft delete (§21). The row leaves every list and every total; the
     * tombstone — and the URI on it — stays.
     *
     * NEVER MAPS THE ROW. It reads the id and the two URI columns, and both are
     * read forgivingly (`uriOrNull`), so a receipt with a float amount, a
     * corrupt category or a number where a path should be is still removable.
     * That is the policy: a record the user can neither see nor delete is the
     * worst state this app can reach, and it is reachable in one bad write.
     *
     * The returned `orphanedUris` is the caller's instruction to unlink — after
     * this resolves `ok`, never before. The header argues the ordering.
     */
    async softDeleteReceipt(id: string): Promise<ReceiptResult<DeletedReceipt>> {
      const now = deps.nowMs();
      return store.atomically(async (tx) => {
        const rows = await tx.all<statements.ReceiptImageRow>(
          statements.selectReceiptImagesById(id),
        );
        if (rows.length === 0) {
          return failed<DeletedReceipt>([
            fieldError('not-found', 'id', 'That receipt no longer exists'),
          ]);
        }
        const orphanedUris = urisOf(rows[0]);
        await tx.execute(statements.softDeleteReceipt(id, now));
        return ok({ id, deletedAt: now, orphanedUris });
      });
    },

    /**
     * §5's receipt figures, aggregated entirely by SQLite.
     *
     * THREE grouped statements, and not one addition in JavaScript. The
     * cross-currency `receiptCount` comes from its own `count(*)` rather than
     * from summing `byCurrency`, because an aggregate assembled outside SQLite
     * is an aggregate that can disagree with the list it sits under.
     *
     * The options are the list filter minus pagination, so "the total of what
     * you are looking at" is the same WHERE clause, built by the same function.
     */
    async receiptTotals(options: ReceiptTotalsOptions = {}): Promise<ReceiptTotals> {
      const currencyRows = await store.all<statements.ReceiptCurrencyTotalRow>(
        statements.selectReceiptTotalsByCurrency(options),
      );
      const categoryRows = await store.all<statements.ReceiptCategoryTotalRow>(
        statements.selectReceiptTotalsByCategory(options),
      );
      const countRows = await store.all<statements.ReceiptCountsRow>(
        statements.selectReceiptCounts(options),
      );

      const byCurrency: ReceiptCurrencyTotal[] = currencyRows.map((row) => ({
        currency: readString(row.currency, 'currency'),
        receiptCount: readAggregate(row.receipt_count, 'receipt_count'),
        totalMinor: minorUnits(readAggregate(row.total_minor, 'total_minor')),
      }));

      const byCategory: ReceiptCategoryTotal[] = categoryRows.map((row) => ({
        currency: readString(row.currency, 'currency'),
        category: readCategory(row.category, 'category'),
        receiptCount: readAggregate(row.receipt_count, 'receipt_count'),
        totalMinor: minorUnits(readAggregate(row.total_minor, 'total_minor')),
      }));

      const counts = countRows.length === 0 ? undefined : countRows[0];

      return {
        byCurrency,
        byCategory,
        primary:
          byCurrency.find((total) => total.currency === DEFAULT_CURRENCY) ??
          ZERO_TOTAL(DEFAULT_CURRENCY),
        receiptCount:
          counts === undefined ? 0 : readAggregate(counts.receipt_count, 'receipt_count'),
        withoutImageCount:
          counts === undefined
            ? 0
            : readAggregate(counts.without_image_count, 'without_image_count'),
        damagedCount:
          counts === undefined ? 0 : readAggregate(counts.damaged_count, 'damaged_count'),
      };
    },

    /**
     * The newest receipts, for §5's "Recent Activity".
     *
     * Damaged rows are SKIPPED rather than thrown, like any other list — Home
     * must not blank because one row in the journal has a float in it. There is
     * no `damagedCount` channel on a plain array; `listReceipts()` is where the
     * count surfaces, and the Receipts screen is where a user would act on it.
     */
    async recentReceipts(
      limit: number = DEFAULT_RECENT_LIMIT,
    ): Promise<readonly ReceiptRecord[]> {
      const capped = Number.isFinite(limit)
        ? Math.min(MAX_RECENT_ROWS, Math.max(1, Math.floor(limit)))
        : DEFAULT_RECENT_LIMIT;
      const rows = await store.all<statements.ReceiptRow>(
        statements.selectRecentReceipts(capped),
      );
      const mapped: ReceiptRecord[] = [];
      for (const row of rows) {
        try {
          mapped.push(mapReceiptRow(row));
        } catch {
          // Counted nowhere on purpose — see the doc comment.
        }
      }
      return mapped;
    },
  };
}
