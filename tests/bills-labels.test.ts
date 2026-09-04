/**
 * Keeply — the words a bill screen puts on a record (§7, §23).
 *
 * This is where a bill's derived STATE becomes a sentence, and getting it
 * wrong is not cosmetic: telling somebody their electricity is "Upcoming" on
 * the day it was cut off is the same defect class as a wrong amount. The cases
 * here are the ones where being wrong is expensive:
 *
 *  - A PAID bill whose due date has passed must never read as overdue. The
 *    data layer's rule is that a settled period is settled whatever its date,
 *    and this module is the one place a screen could contradict it.
 *  - A variable bill with no estimate has `amountMinor === null`. Rendering
 *    that as ₱0.00 is a specific false claim about an electricity bill.
 *  - The countdown reads `daysUntilDue` — the exact julian-day difference
 *    SQLite computed against the device's LOCAL today. Re-deriving it from
 *    `dueDate` with `new Date()` is the UTC-midnight bug, one day early.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits } from '@/db/money';
import {
  BILL_CATEGORIES,
  type BillCategory,
  type BillRecord,
  type BillState,
} from '@/features/bills/types';
import {
  BILL_CATEGORIES_ORDERED,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
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
} from '@/features/bills/ui/labels';

function bill(overrides: Partial<BillRecord> = {}): BillRecord {
  return {
    id: 'bill-1',
    name: 'Meralco',
    category: 'electricity',
    amountMinor: minorUnits(154900),
    currency: 'PHP',
    isVariable: false,
    dueDate: '2026-10-12',
    billingCycle: 'monthly',
    customCycleDays: null,
    isRecurring: true,
    autopay: false,
    status: 'unpaid',
    paymentMethod: null,
    notes: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    anchorDate: '2026-01-12',
    isOverdue: false,
    daysUntilDue: 5,
    paymentCount: 0,
    lastPaidAmountMinor: null,
    lastPaidDate: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('categories', () => {
  test('every category has a label and an icon', () => {
    // A category added to the schema and not to these maps renders as
    // `undefined` — which is a blank row, not a crash, and so ships.
    for (const category of BILL_CATEGORIES) {
      assert.equal(typeof CATEGORY_LABELS[category], 'string', category);
      assert.ok(CATEGORY_LABELS[category].length > 0, category);
      assert.equal(typeof CATEGORY_ICONS[category], 'string', category);
      assert.ok(CATEGORY_ICONS[category].length > 0, category);
    }
  });

  test('`repeat` is reserved for subscriptions and spent on nothing else', () => {
    // It is the Subscriptions tab's own mark. Reusing it for a phone bill
    // makes a Globe Postpaid row and a Netflix row look the same at a glance.
    const usingRepeat = BILL_CATEGORIES.filter((c) => CATEGORY_ICONS[c] === 'repeat');
    assert.deepEqual(usingRepeat, ['subscription']);
  });

  test('the maps have no entries for categories that do not exist', () => {
    const known = new Set<string>(BILL_CATEGORIES);
    for (const key of Object.keys(CATEGORY_LABELS)) assert.ok(known.has(key), key);
    for (const key of Object.keys(CATEGORY_ICONS)) assert.ok(known.has(key), key);
  });

  test('the picker offers EVERY category, exactly once', () => {
    // A category in the schema and not in this list is one the user cannot
    // choose — invisible, because the form still compiles and still renders.
    assert.deepEqual(
      [...BILL_CATEGORIES_ORDERED].sort(),
      [...BILL_CATEGORIES].sort(),
    );
    assert.equal(new Set(BILL_CATEGORIES_ORDERED).size, BILL_CATEGORIES_ORDERED.length);
  });

  test('the picker leads with what a household actually has, and ends on other', () => {
    // A picker whose first screenful is the common answer is one tap instead
    // of a scroll; `other` is the fallback, not a choice.
    assert.equal(BILL_CATEGORIES_ORDERED[0], 'electricity');
    assert.equal(BILL_CATEGORIES_ORDERED[BILL_CATEGORIES_ORDERED.length - 1], 'other');
  });

  test('categoryLabel reads the map', () => {
    assert.equal(categoryLabel('credit_card'), 'Credit card');
    assert.equal(categoryLabel('electricity' as BillCategory), 'Electricity');
  });
});

/* -------------------------------------------------------------------------- */

describe('cycles', () => {
  test('a named cycle uses its label', () => {
    assert.equal(describeCycle('monthly', null), 'Monthly');
    assert.equal(describeCycle('quarterly', null), 'Quarterly');
  });

  test('a custom cycle is spelled out, because "Custom" says nothing', () => {
    assert.equal(describeCycle('custom', 45), 'Every 45 days');
    assert.equal(describeCycle('custom', 1), 'Every day');
  });

  test('a custom cycle with no interval degrades rather than lying', () => {
    assert.equal(describeCycle('custom', null), 'Custom');
    assert.equal(describeCycle('custom', 0), 'Custom');
    assert.equal(describeCycle('custom', -3), 'Custom');
  });

  test('a ONE-OFF bill says so instead of naming a cycle it does not use', () => {
    // `billingCycle` is still stored on a non-recurring bill. Reading it would
    // tell the user a one-off electricity bill is "Monthly".
    assert.equal(describeRecurrence(bill({ isRecurring: false })), 'One-off');
    assert.equal(describeRecurrence(bill({ isRecurring: true })), 'Monthly');
  });
});

/* -------------------------------------------------------------------------- */

describe('which state a row is in', () => {
  test('PAID wins over a due date that has passed', () => {
    // The data layer's rule: a paid bill is never overdue, whatever its date.
    // This is the one place a screen could contradict it.
    const settled = bill({ status: 'paid', isOverdue: true, daysUntilDue: -9 });
    assert.equal(billState(settled), 'paid');
    assert.equal(billStatusKey(billState(settled)), 'paid');
  });

  test('overdue wins over due-today', () => {
    assert.equal(billState(bill({ isOverdue: true, daysUntilDue: -1 })), 'overdue');
  });

  test('due today is its own state, not "upcoming in 0 days"', () => {
    assert.equal(billState(bill({ daysUntilDue: 0 })), 'due-today');
    assert.equal(billStatusKey('due-today'), 'dueToday');
  });

  test('anything else ahead is upcoming', () => {
    assert.equal(billState(bill({ daysUntilDue: 5 })), 'upcoming');
    assert.equal(billStatusKey('upcoming'), 'upcoming');
  });

  test('every state has a label and a colour key', () => {
    const states: readonly BillState[] = ['paid', 'unpaid', 'upcoming', 'overdue', 'due-today'];
    for (const state of states) {
      assert.ok(STATE_LABELS[state].length > 0, state);
      // Onto tokens the design system ALREADY has, so a late bill and an
      // expired document are the same red — they are only the same red if
      // they ask for the same token.
      assert.ok(
        ['paid', 'overdue', 'dueToday', 'upcoming', 'inactive'].includes(
          billStatusKey(state),
        ),
        `${state} -> ${billStatusKey(state)}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the due countdown', () => {
  test('reads the days SQLite computed, in every direction', () => {
    assert.equal(dueCountdown(0), 'Due today');
    assert.equal(dueCountdown(1), 'Due tomorrow');
    assert.equal(dueCountdown(5), 'Due in 5 days');
    assert.equal(dueCountdown(-1), '1 day overdue');
    assert.equal(dueCountdown(-9), '9 days overdue');
  });

  test('one day late is singular', () => {
    // The plural bug that ships: "1 days overdue".
    assert.match(dueCountdown(-1), /^1 day overdue$/);
  });

  test('the boundary between today and late is exact', () => {
    // 0 is the due date itself and is NOT late. Getting this off by one makes
    // every bill overdue on the morning it is due.
    assert.equal(dueCountdown(0), 'Due today');
    assert.ok(!/overdue/.test(dueCountdown(0)));
    assert.match(dueCountdown(-1), /overdue/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the line under a row', () => {
  test('a settled period says what was actually charged', () => {
    // §7's expected-vs-actual: the forecast was ₱1,549, the charge was ₱3,450.
    const paid = bill({
      status: 'paid',
      lastPaidAmountMinor: minorUnits(345000),
      isOverdue: false,
      daysUntilDue: -3,
    });
    assert.equal(billSubtitle(paid), 'Paid ₱3,450.00');
  });

  test('a settled period with no recorded amount says only that it is paid', () => {
    // "Paid ₱0.00" would be a claim about the charge. There isn't one.
    const paid = bill({ status: 'paid', lastPaidAmountMinor: null });
    assert.equal(billSubtitle(paid), 'Paid');
  });

  test('an unsettled period counts down', () => {
    assert.equal(billSubtitle(bill({ daysUntilDue: 2 })), 'Due in 2 days');
    assert.equal(billSubtitle(bill({ isOverdue: true, daysUntilDue: -4 })), '4 days overdue');
  });
});

/* -------------------------------------------------------------------------- */

describe('amounts', () => {
  test('an expected amount is formatted as money', () => {
    assert.equal(amountLine(bill({ amountMinor: minorUnits(154900) })), '₱1,549.00');
  });

  test('NO estimate is an em dash, never zero', () => {
    // §7's variable bill. ₱0.00 is a specific false claim about an electricity
    // bill; the dash says "not known" in the width a number would have taken.
    assert.equal(amountLine(bill({ amountMinor: null })), '—');
    assert.notEqual(amountLine(bill({ amountMinor: null })), '₱0.00');
  });

  test('a real zero is impossible, but a real amount is never a dash', () => {
    assert.notEqual(amountLine(bill({ amountMinor: minorUnits(1) })), '—');
  });

  test('the currency on the row is the one used', () => {
    assert.equal(
      amountLine(bill({ amountMinor: minorUnits(1999), currency: 'USD' })),
      '$19.99',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('the variable-bill caveat', () => {
  test('a fixed bill has none', () => {
    assert.equal(estimateNote(bill({ isVariable: false })), null);
  });

  test('a variable bill WITH an estimate says the estimate is one', () => {
    // Presenting a forecast in the same weight as a settled amount tells the
    // user something untrue. This is the sentence that stops it.
    const note = estimateNote(bill({ isVariable: true, amountMinor: minorUnits(154900) }));
    assert.match(note ?? '', /Estimated/);
  });

  test('a variable bill with NO estimate says that instead', () => {
    const note = estimateNote(bill({ isVariable: true, amountMinor: null }));
    assert.match(note ?? '', /no estimate yet/);
  });
});
