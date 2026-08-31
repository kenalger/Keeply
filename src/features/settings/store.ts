/**
 * Keeply — the seam between settings SQL and a driver.
 *
 * There is ONE seam contract in this codebase, and it is the one
 * `src/features/subscriptions/store.ts` documents at length: a three-method
 * interface (`all` / `execute` / `atomically`) that `index.ts` implements over
 * drizzle + op-sqlite and that `tests/*.test.ts` implements over `node:sqlite`.
 * This module aliases it rather than declaring a second, structurally identical
 * copy — a settings feature with its own private notion of "a statement" would
 * be exactly the parallel solution the codebase cannot afford, and would drift
 * the first time the contract gained a method.
 *
 * The import is from `./store` rather than the `@/features/subscriptions`
 * barrel deliberately: the barrel reaches `@/db`, which loads op-sqlite, and
 * every module a `node --test` suite imports must load in plain Node. These are
 * types, so the statement is erased either way — but the deep path makes it
 * impossible for a future edit to accidentally promote it to a runtime import.
 *
 * `atomically` is spelled that way because eslint bans the member name
 * `transaction` outside `src/db`: drizzle's `db.transaction()` dispatches
 * `begin`/`commit` without awaiting them, so it is neither atomic nor
 * recoverable. `./index.ts` implements this over `withTransaction()` from `@/db`.
 */
import type {
  SqlStatement,
  SqlValue,
  SubscriptionStore,
} from '@/features/subscriptions/store';

export type { SqlStatement, SqlValue };

/**
 * A store over one database handle, for the settings feature.
 *
 * Identical to the subscriptions seam by construction, so a caller that already
 * holds one (onboarding, which writes progress and subscriptions in the same
 * flow) can hand the same object to both features.
 */
export type SettingsStore = SubscriptionStore;
