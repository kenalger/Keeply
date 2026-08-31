/**
 * Keeply — the sanctioned form of everything `violations.ts` gets wrong.
 *
 * This half of the fixture matters as much as the other: a rule that reports
 * the correct code as well as the incorrect code is worse than no rule, because
 * the next author learns to reach for `eslint-disable` instead of the API.
 *
 * `tests/lint-rules.test.ts` asserts this file produces ZERO errors under the
 * project's own rule set — the same rule set that produces a dozen on
 * `violations.ts`.
 */
import { daysUntil, formatDate, statusForDue, toLocalDate } from '@/theme/format';

interface BillRow {
  dueDate: string;
  createdAt: number;
}

declare const row: BillRow;
declare const live: { bills: { id: string } };
declare const logger: { info(message: string, meta?: Record<string, string>): void };
declare const theme: { status: Record<string, string> };
declare function withTransaction<T>(fn: () => Promise<T>): Promise<T>;

const queryBuilder = {
  from(table: unknown): unknown {
    return table;
  },
};

/** A calendar string is read as a LOCAL calendar day. */
export const dueDate = toLocalDate(row.dueDate);
export const daysLeft = daysUntil(row.dueDate);
export const dueLabel = formatDate(row.dueDate);
export const dueStatus = statusForDue(row.dueDate);

/** Epoch millis go to `Date` as a number, which is what they are. */
export const createdAt = new Date(row.createdAt);

/** "Now" and explicit calendar components are both fine. */
export const now = new Date();
export const explicit = new Date(2026, 9, 12);

/** Writes that span more than one row go through the sanctioned wrapper. */
export async function payBill(): Promise<void> {
  await withTransaction(async () => {
    // ...
  });
}

/** Reads go through the live view. */
export const liveRows = queryBuilder.from(live.bills);

/** Output goes through the redacting logger. */
export function narrate(): void {
  logger.info('bill saved', { status: 'paid' });
}

/** Colours come from the theme. */
export const overdueColor = theme.status.overdue;

/** A `#` in a string that is not a colour must not be reported. */
export const anchor = '#top';
export const heading = '# Keeply';
export const issueReference = 'see #12';
