/**
 * Keeply — the allowance data layer's contract (Phase 9).
 *
 * Four operations: read the allowance in force, read the history, set one,
 * remove one. Everything else about an allowance — where the period starts,
 * what is left — is computed by `period.ts` and `status.ts`, which are pure.
 * This file only talks to the database.
 *
 * ── A DAMAGED ROW ──────────────────────────────────────────────────────────
 * SQLite is dynamically typed, so a float can sit in `amount_minor` past the
 * `> 0` CHECK. The policy is the one the receipts layer settled on, applied to
 * a single-row read: `allowanceInForce()` returns `null` rather than throwing.
 *
 * That differs from `getReceipt()`, which throws, and the difference is
 * deliberate. A user asking for one specific receipt has asked a question that
 * has no honest answer if the row is unreadable. But nobody asks for "the
 * allowance in force" — it is read on the way to drawing a card on Home, and a
 * throw there blanks the dashboard over a row the user never chose to look at.
 * `null` renders "no allowance set", which is a state the UI already has, and
 * the history list is where a damaged row can still be seen and deleted.
 */
import { DEFAULT_CURRENCY } from '@/theme/format';

import { isAllowancePeriod, type AllowancePeriod } from './period';
import {
  selectAllowanceHistory,
  selectAllowanceInForce,
  softDeleteAllowance,
  upsertAllowance,
} from './sql';
import type { AllowanceStore } from './store';
import type { AllowanceRecord, NewAllowance } from './types';
import { minorUnits, type MinorUnits } from '@/db/money';

/** How many past allowances the history screen asks for by default. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** A row exactly as the driver hands it back, keyed by column name. */
interface AllowanceRow {
  id: unknown;
  period: unknown;
  amount_minor: unknown;
  currency: unknown;
  effective_from: unknown;
  created_at: unknown;
  updated_at: unknown;
}

/**
 * A row to a record, or `null` when the row cannot be trusted.
 *
 * Every field is checked rather than cast. The one that matters is
 * `amount_minor`: `Number.isInteger` is what stops a float — which the `> 0`
 * CHECK happily accepts — from becoming a `MinorUnits` and being subtracted
 * from a total as if it were centavos.
 */
export function mapAllowanceRow(row: AllowanceRow): AllowanceRecord | null {
  const { id, period, amount_minor, currency, effective_from, created_at, updated_at } = row;
  if (typeof id !== 'string' || id === '') return null;
  if (!isAllowancePeriod(period)) return null;
  if (typeof amount_minor !== 'number' || !Number.isInteger(amount_minor) || amount_minor <= 0) {
    return null;
  }
  if (typeof currency !== 'string' || currency === '') return null;
  if (typeof effective_from !== 'string' || effective_from === '') return null;
  if (typeof created_at !== 'number' || typeof updated_at !== 'number') return null;

  return {
    id,
    period,
    amountMinor: minorUnits(amount_minor),
    currency,
    effectiveFrom: effective_from,
    createdAt: created_at,
    updatedAt: updated_at,
  };
}

export interface AllowanceApi {
  /**
   * The allowance in force for the period starting `periodStartISO`, or `null`
   * when none had started by then (or the row is unreadable — see the header).
   */
  allowanceInForce(
    period: AllowancePeriod,
    periodStartISO: string,
  ): Promise<AllowanceRecord | null>;
  /** Every allowance ever set for a cadence, newest effective date first. */
  allowanceHistory(period: AllowancePeriod, limit?: number): Promise<AllowanceRecord[]>;
  /** Record an allowance. Setting one twice for the same start day corrects it. */
  setAllowance(input: NewAllowance): Promise<void>;
  /** Soft-delete an allowance by id. Removing one that is already gone is a no-op. */
  removeAllowance(id: string): Promise<void>;
}

export interface AllowanceApiDeps {
  store: AllowanceStore;
  newId(): string;
  nowMs(): number;
  /**
   * The first day of the period this cadence is currently in — supplied by the
   * caller rather than computed here, so this module never needs a clock and
   * the timezone rules stay in `period.ts`.
   */
  currentPeriodStartISO(period: AllowancePeriod): string;
}

export function createAllowanceApi(deps: AllowanceApiDeps): AllowanceApi {
  const { store, newId, nowMs, currentPeriodStartISO } = deps;

  return {
    async allowanceInForce(period, periodStartISO) {
      const rows = await store.all<AllowanceRow>(
        selectAllowanceInForce(period, periodStartISO),
      );
      const row = rows[0];
      return row === undefined ? null : mapAllowanceRow(row);
    },

    async allowanceHistory(period, limit = DEFAULT_HISTORY_LIMIT) {
      const rows = await store.all<AllowanceRow>(selectAllowanceHistory(period, limit));
      // A list SKIPS what it cannot read rather than throwing — one damaged row
      // must not blank a screen the user can otherwise act on.
      return rows
        .map(mapAllowanceRow)
        .filter((record): record is AllowanceRecord => record !== null);
    },

    async setAllowance(input) {
      const amountMinor: MinorUnits = input.amountMinor;
      // Defended here as well as by the CHECK, so the failure is a named error
      // and not a driver's raw constraint message reaching the user.
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error('allowance amount must be a positive whole number of minor units');
      }
      await store.execute(
        upsertAllowance({
          id: newId(),
          period: input.period,
          amountMinor,
          currency: input.currency ?? DEFAULT_CURRENCY,
          effectiveFrom: input.effectiveFrom ?? currentPeriodStartISO(input.period),
          nowMs: nowMs(),
        }),
      );
    },

    async removeAllowance(id) {
      await store.execute(softDeleteAllowance(id, nowMs()));
    },
  };
}
