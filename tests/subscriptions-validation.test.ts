/**
 * Keeply — §29 validation at the subscription boundary.
 *
 * Pure: no database here. These are the checks that run BEFORE a transaction
 * opens, and the thing they must get right is failing *legibly* — the CHECK
 * constraints in `drizzle/0000_*.sql` are the backstop, and they can only say
 * `SQLITE_CONSTRAINT`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { minorUnits } from '@/db/money';
import {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  validateNewSubscription,
  validatePatch,
} from '@/features/subscriptions/validation';
import {
  SUBSCRIPTION_CATEGORIES,
  type NewSubscriptionInput,
} from '@/features/subscriptions/types';

const VALID: NewSubscriptionInput = {
  name: 'Netflix',
  category: 'video',
  amountMinor: minorUnits(549_00),
  billingCycle: 'monthly',
  nextBillingDate: '2026-10-12',
};

function codesOf(result: ReturnType<typeof validateNewSubscription>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

function fieldsOf(result: ReturnType<typeof validateNewSubscription>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.field);
}

describe('validateNewSubscription', () => {
  test('a complete, valid subscription passes and is normalized', () => {
    const result = validateNewSubscription({
      ...VALID,
      name: '  Netflix  ',
      paymentMethod: '  GCash ',
      notes: '   ',
    });
    assert.ok(result.ok);
    assert.equal(result.value.name, 'Netflix', 'trimmed');
    assert.equal(result.value.paymentMethod, 'GCash');
    assert.equal(result.value.notes, null, 'whitespace-only optional text is not stored');
    assert.equal(result.value.currency, 'PHP', '§30 default');
    assert.equal(result.value.category, 'video');
    assert.equal(result.value.isActive, true);
    assert.equal(result.value.customCycleDays, null, 'not a custom cycle');

    const noCategory = validateNewSubscription({
      name: 'Gym',
      amountMinor: minorUnits(1_500_00),
      billingCycle: 'monthly',
      nextBillingDate: '2026-10-12',
    });
    assert.ok(noCategory.ok);
    assert.equal(noCategory.value.category, 'other', 'defaulted when omitted');
  });

  test('§29: an amount must be greater than zero', () => {
    for (const amount of [0, -1, -549_00]) {
      const result = validateNewSubscription({ ...VALID, amountMinor: minorUnits(amount) });
      assert.deepEqual(codesOf(result), ['invalid-amount'], `amount ${amount}`);
      assert.deepEqual(fieldsOf(result), ['amountMinor']);
    }
  });

  test('§29: a fractional or non-finite amount is refused, not rounded', () => {
    for (const amount of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      const result = validateNewSubscription({
        ...VALID,
        amountMinor: amount as ReturnType<typeof minorUnits>,
      });
      assert.deepEqual(codesOf(result), ['invalid-amount'], `amount ${amount}`);
    }
  });

  test('§29: the renewal date must be a real calendar date', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', 'bogus', '', '2026/10/12']) {
      const result = validateNewSubscription({ ...VALID, nextBillingDate: date });
      assert.deepEqual(codesOf(result), ['invalid-date'], `date ${date}`);
    }
    assert.ok(validateNewSubscription({ ...VALID, nextBillingDate: '2024-02-29' }).ok);
    assert.equal(
      validateNewSubscription({ ...VALID, nextBillingDate: '2026-02-29' }).ok,
      false,
      '2026 is not a leap year',
    );
  });

  test('a datetime string is trimmed to the calendar day the column accepts', () => {
    const result = validateNewSubscription({
      ...VALID,
      nextBillingDate: '2026-10-12T00:00:00.000Z',
    });
    assert.ok(result.ok);
    assert.equal(result.value.nextBillingDate, '2026-10-12');
  });

  test('§29: a custom cycle needs a positive whole number of days', () => {
    for (const days of [undefined, null, 0, -7, 1.5, CUSTOM_CYCLE_DAYS_MAX + 1]) {
      const result = validateNewSubscription({
        ...VALID,
        billingCycle: 'custom',
        customCycleDays: days as number | null | undefined,
      });
      assert.deepEqual(codesOf(result), ['invalid-custom-days'], `days ${String(days)}`);
    }
    const good = validateNewSubscription({
      ...VALID,
      billingCycle: 'custom',
      customCycleDays: 45,
    });
    assert.ok(good.ok);
    assert.equal(good.value.customCycleDays, 45);
  });

  test('a stale interval on a non-custom cycle is cleared, not rejected', () => {
    // A form that has just switched from custom to monthly still holds the old
    // number. Stale is not corrupt; refusing the save would be wrong.
    const result = validateNewSubscription({
      ...VALID,
      billingCycle: 'monthly',
      customCycleDays: 45,
    });
    assert.ok(result.ok);
    assert.equal(result.value.customCycleDays, null);
  });

  test('the currency must be three uppercase letters, matching the column GLOB', () => {
    for (const currency of ['php', 'PH', 'PHPP', 'PH1', '   ', '₱']) {
      const result = validateNewSubscription({ ...VALID, currency });
      assert.deepEqual(codesOf(result), ['invalid-currency'], `currency ${currency}`);
    }
    assert.ok(validateNewSubscription({ ...VALID, currency: 'USD' }).ok);
  });

  test('every schema category is accepted and nothing else is', () => {
    for (const category of SUBSCRIPTION_CATEGORIES) {
      assert.ok(validateNewSubscription({ ...VALID, category }).ok, category);
    }
    const result = validateNewSubscription({
      ...VALID,
      category: 'crypto' as (typeof SUBSCRIPTION_CATEGORIES)[number],
    });
    assert.deepEqual(codesOf(result), ['invalid-category']);
  });

  test('a name of only whitespace is not a name', () => {
    for (const name of ['', '   ', '\t\n']) {
      assert.deepEqual(codesOf(validateNewSubscription({ ...VALID, name })), ['invalid-name']);
    }
  });

  test('over-long text is refused at the boundary', () => {
    assert.deepEqual(
      codesOf(validateNewSubscription({ ...VALID, name: 'x'.repeat(NAME_MAX_LENGTH + 1) })),
      ['too-long'],
    );
    assert.deepEqual(
      codesOf(validateNewSubscription({ ...VALID, notes: 'x'.repeat(NOTES_MAX_LENGTH + 1) })),
      ['too-long'],
    );
    assert.ok(validateNewSubscription({ ...VALID, name: 'x'.repeat(NAME_MAX_LENGTH) }).ok);
  });

  test('every problem is reported at once, not one per attempt', () => {
    const result = validateNewSubscription({
      name: '  ',
      amountMinor: minorUnits(0),
      billingCycle: 'custom',
      customCycleDays: 0,
      nextBillingDate: '2026-02-30',
      currency: 'peso',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result).sort(), [
      'invalid-amount',
      'invalid-currency',
      'invalid-custom-days',
      'invalid-date',
      'invalid-name',
    ]);
  });

  test('no error message ever repeats the value it rejected (§18)', () => {
    const result = validateNewSubscription({
      ...VALID,
      name: 'SupersecretGymMembership'.repeat(10),
      notes: 'card ending 4242'.repeat(400),
      paymentMethod: 'BPI **** 4242'.padEnd(300, '!'),
      amountMinor: minorUnits(-123_456),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    for (const error of result.errors) {
      assert.ok(!error.message.includes('4242'), error.message);
      assert.ok(!error.message.includes('Supersecret'), error.message);
      assert.ok(!error.message.includes('123456'), error.message);
      assert.ok(!error.message.includes('-123456'), error.message);
    }
  });
});

describe('validatePatch', () => {
  const current = { billingCycle: 'custom' as const, customCycleDays: 45 };

  test('an empty patch is refused rather than issuing a no-op UPDATE', () => {
    const result = validatePatch({}, current);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, 'empty-patch');
  });

  test('only the mentioned fields are changed', () => {
    const result = validatePatch({ name: ' Spotify ' }, current);
    assert.ok(result.ok);
    assert.deepEqual([...result.value.changes.keys()], ['name']);
    assert.equal(result.value.changes.get('name'), 'Spotify');
  });

  test('switching away from custom clears the interval the caller never mentioned', () => {
    const result = validatePatch({ billingCycle: 'monthly' }, current);
    assert.ok(result.ok);
    assert.equal(result.value.changes.get('billingCycle'), 'monthly');
    assert.equal(result.value.changes.get('customCycleDays'), null);
  });

  test('switching TO custom without an interval is refused', () => {
    const result = validatePatch(
      { billingCycle: 'custom' },
      { billingCycle: 'monthly', customCycleDays: null },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].code, 'invalid-custom-days');
  });

  test('a patch that keeps a custom cycle keeps its interval untouched', () => {
    const result = validatePatch({ amountMinor: minorUnits(199_00) }, current);
    assert.ok(result.ok);
    assert.equal(result.value.changes.has('customCycleDays'), false);
  });

  test('an explicit null clears an optional field', () => {
    const result = validatePatch({ notes: null }, current);
    assert.ok(result.ok);
    assert.equal(result.value.changes.get('notes'), null);
  });

  test('the same §29 rules apply to an edit as to a create', () => {
    assert.equal(validatePatch({ amountMinor: minorUnits(0) }, current).ok, false);
    assert.equal(validatePatch({ nextBillingDate: '2026-02-30' }, current).ok, false);
    assert.equal(validatePatch({ name: '   ' }, current).ok, false);
  });
});
