/**
 * Keeply — the "What it has cost" card, as sentences (§30).
 *
 * The card shows one figure and up to three captions, and which ones appear is
 * a decision about the three buckets in `MaintenanceItemTotals`. It used to be
 * made inline in the screen, with `costCount` as the test for both "is there
 * anything to show" and "how many entries is this across" — which is how a ₱
 * total came to be captioned "across 5 entries" when two of the five were in
 * dollars.
 *
 * `describeSpend()` is pure, so the decision is testable without a renderer.
 * `tests/maintenance-records.test.ts` proves the counts it reads are right;
 * this file proves the sentences built from them are.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { describeSpend, describeYearRows } from '@/features/maintenance/ui/labels';
import type { MaintenanceYearTotal } from '@/features/maintenance/types';

const NONE = { costCount: 0, damagedCount: 0, otherCurrencyCount: 0, otherCurrencies: [] };

describe('describeSpend / an empty ledger', () => {
  test('says nothing is recorded, and shows no figure', () => {
    const summary = describeSpend(NONE);
    assert.equal(summary.isEmpty, true);
    assert.equal(summary.showsAmount, false);
    assert.equal(summary.countLine, null);
    assert.equal(summary.damagedLine, null);
    assert.equal(summary.otherCurrencyLine, null);
  });
});

describe('describeSpend / the ordinary case', () => {
  test('one currency, nothing damaged, one caption', () => {
    const summary = describeSpend({ ...NONE, costCount: 4 });
    assert.equal(summary.isEmpty, false);
    assert.equal(summary.showsAmount, true);
    assert.equal(summary.countLine, 'across 4 entries');
    assert.equal(summary.damagedLine, null);
    assert.equal(summary.otherCurrencyLine, null);
  });

  test('one entry is not "1 entries"', () => {
    assert.equal(describeSpend({ ...NONE, costCount: 1 }).countLine, 'across 1 entry');
  });
});

describe('describeSpend / money that cannot be added', () => {
  test('the audit case: three in one currency, two in another', () => {
    const summary = describeSpend({
      costCount: 3,
      damagedCount: 0,
      otherCurrencyCount: 2,
      otherCurrencies: ['USD'],
    });
    // The figure is captioned with what it is actually made of…
    assert.equal(summary.countLine, 'across 3 entries');
    // …and the rest is stated, not hidden and not converted.
    assert.equal(summary.otherCurrencyLine, '2 entries in USD are not in this total.');
  });

  test('a single foreign entry reads as singular', () => {
    assert.equal(
      describeSpend({ ...NONE, costCount: 2, otherCurrencyCount: 1, otherCurrencies: ['JPY'] })
        .otherCurrencyLine,
      '1 entry in JPY is not in this total.',
    );
  });

  test('several currencies are listed the way a person would say them', () => {
    assert.equal(
      describeSpend({
        ...NONE,
        costCount: 1,
        otherCurrencyCount: 3,
        otherCurrencies: ['EUR', 'JPY', 'USD'],
      }).otherCurrencyLine,
      '3 entries in EUR, JPY and USD are not in this total.',
    );
  });
});

describe('describeSpend / damaged rows', () => {
  test('are reported alongside the figure', () => {
    const summary = describeSpend({ ...NONE, costCount: 2, damagedCount: 1 });
    assert.equal(summary.showsAmount, true);
    assert.equal(summary.countLine, 'across 2 entries');
    assert.equal(summary.damagedLine, '1 entry could not be read and is not counted here.');
  });

  test('an item whose ONLY rows are damaged still shows the card', () => {
    const summary = describeSpend({ ...NONE, damagedCount: 2 });
    // Not empty — something was recorded, it just cannot be read.
    assert.equal(summary.isEmpty, false);
    // And no figure: ₱0.00 would claim this item cost nothing, which is a
    // different statement from "these could not be added up".
    assert.equal(summary.showsAmount, false);
    assert.equal(summary.countLine, null);
    assert.equal(summary.damagedLine, '2 entries could not be read and are not counted here.');
  });

  test('a figure-less summary still reports what is there', () => {
    // NOT reachable from `itemTotals()` today: the primary currency is the
    // group with the most in it, so a readable row elsewhere means a readable
    // row in the primary group too. Pinned anyway — `describeSpend` decides
    // what the card renders, and "no figure" must never mean "no card".
    const summary = describeSpend({
      ...NONE,
      otherCurrencyCount: 1,
      otherCurrencies: ['USD'],
    });
    assert.equal(summary.isEmpty, false);
    assert.equal(summary.showsAmount, false);
    assert.equal(summary.otherCurrencyLine, '1 entry in USD is not in this total.');
  });
});

/* -------------------------------------------------------------------------- */
/* By year — where the same fix was needed one card lower                      */
/* -------------------------------------------------------------------------- */

/**
 * Found by running the app, not by reading it.
 *
 * `selectTotalsByYear` groups by year AND currency — it has to, two currencies
 * cannot be summed — so an item with ₱ and $ costs in 2026 returns TWO rows
 * saying `2026`. The screen used the year as both the React key and the title,
 * which rendered "2026 / 2026" under a red "Encountered two children with the
 * same key" toast. Unreachable until an item has two currencies, which is the
 * exact case the card above it was just fixed for.
 */
const year = (
  y: string,
  currency: string,
  totalMinor: number,
  costCount: number,
): MaintenanceYearTotal =>
  ({ year: y, currency, totalMinor, costCount }) as MaintenanceYearTotal;

describe('describeYearRows / a year can appear once per currency', () => {
  test('the key is unique even when the year is not', () => {
    const rows = describeYearRows([year('2026', 'PHP', 600_000, 3), year('2026', 'USD', 9_000, 2)]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ['2026-PHP', '2026-USD'],
    );
    assert.equal(new Set(rows.map((row) => row.key)).size, 2, 'and the two do not collide');
  });

  test('a repeated year says which currency it is', () => {
    const rows = describeYearRows([year('2026', 'PHP', 600_000, 3), year('2026', 'USD', 9_000, 2)]);
    assert.deepEqual(
      rows.map((row) => row.subtitle),
      ['3 entries · PHP', '2 entries · USD'],
    );
  });

  test('an ordinary single-currency item is not captioned with a currency code', () => {
    // It is already beside the amount. Every item in this app but a rare one
    // has a single currency, and that case must stay clean.
    const rows = describeYearRows([year('2026', 'PHP', 600_000, 3), year('2025', 'PHP', 10_000, 1)]);
    assert.deepEqual(
      rows.map((row) => row.subtitle),
      ['3 entries', '1 entry'],
    );
    assert.deepEqual(
      rows.map((row) => row.key),
      ['2026-PHP', '2025-PHP'],
    );
  });

  test('only the repeated year is disambiguated, not its neighbours', () => {
    const rows = describeYearRows([
      year('2026', 'PHP', 600_000, 3),
      year('2026', 'USD', 9_000, 2),
      year('2025', 'PHP', 10_000, 1),
    ]);
    assert.deepEqual(
      rows.map((row) => row.subtitle),
      ['3 entries · PHP', '2 entries · USD', '1 entry'],
    );
  });

  test('the title stays the year, and the amount keeps its own currency', () => {
    const rows = describeYearRows([year('2026', 'USD', 9_000, 2)]);
    assert.equal(rows[0]!.title, '2026');
    assert.equal(rows[0]!.currency, 'USD');
    assert.equal(rows[0]!.totalMinor, 9_000);
  });
});

