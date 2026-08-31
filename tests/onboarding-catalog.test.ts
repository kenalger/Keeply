/**
 * Keeply — the onboarding catalogue's integrity.
 *
 * The catalogue is data, and data with no test is a typo waiting to reach a
 * user. Three things are checked here, in descending order of how badly they
 * would hurt:
 *
 *  1. NO ENTRY CAN CARRY A WRITABLE AMOUNT. Both structurally (no property a
 *     subscription insert reads) and by type (`AmountHint` is not `MinorUnits`).
 *     The type half is a `@ts-expect-error`, so `npx tsc --noEmit` fails if the
 *     brand is ever weakened — the assertion is verified by the compiler, not
 *     by this file.
 *  2. EVERY CATEGORY AND CYCLE IS REAL. A category the schema's CHECK
 *     constraint does not accept turns a tapped chip into an opaque
 *     `SQLITE_CONSTRAINT` at the end of the wizard.
 *  3. IDS ARE STABLE AND UNIQUE. A selection is keyed by id; a duplicate would
 *     make two chips the same record, and a re-ordered list would silently move
 *     a user's choice onto a different provider.
 *
 * Pure — no database. `tests/onboarding-flow.test.ts` is where the catalogue
 * meets SQLite.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { MinorUnits } from '@/db/money';
import {
  amountHint,
  BILL_CATALOG,
  BILL_CATEGORIES,
  CATALOG,
  catalogById,
  catalogGroups,
  catalogHint,
  catalogPrefill,
  catalogProblems,
  isBillCategory,
  searchCatalog,
  SUBSCRIPTION_CATALOG,
  type AmountHint,
  type CatalogEntry,
} from '@/features/onboarding/catalog';
import { isSubscriptionCategory } from '@/features/subscriptions/types';
import type { NewSubscriptionInput } from '@/features/subscriptions/types';
import { isBillingCycle } from '@/lib/recurrence';

/** Every provider `plan/onboarding.md` §4 names by hand. */
const REQUIRED_PROVIDERS = [
  'Meralco',
  'Maynilad',
  'Manila Water',
  'Globe',
  'Smart',
  'PLDT',
  'Converge',
  'Sky',
  'Cignal',
  'Netflix',
  'Spotify',
  'YouTube Premium',
  'iCloud',
  'Google One',
  'Disney+',
  'HBO Max',
  'Viu',
  'Gym',
  'Condo',
  'Pag-IBIG',
  'PhilHealth',
  'SSS',
] as const;

describe('catalog / integrity', () => {
  test('the catalogue reports no structural problems', () => {
    assert.deepEqual(catalogProblems(), []);
  });

  test('every entry has a real category for its kind', () => {
    for (const entry of CATALOG) {
      if (entry.kind === 'subscription') {
        assert.ok(
          isSubscriptionCategory(entry.category),
          `${entry.id}: ${entry.category} is not a subscription category`,
        );
      } else {
        assert.ok(
          isBillCategory(entry.category),
          `${entry.id}: ${entry.category} is not a bill category`,
        );
      }
    }
  });

  test('every entry has a real billing cycle, and never `custom`', () => {
    for (const entry of CATALOG) {
      assert.ok(isBillingCycle(entry.billingCycle), `${entry.id}: bad cycle`);
      // `custom` needs an interval the catalogue cannot know, and a row without
      // one is excluded from every total the payoff step shows.
      assert.notEqual(entry.billingCycle, 'custom', `${entry.id}: custom cycle`);
    }
  });

  test('ids are unique, stable-looking, and resolvable', () => {
    const ids = new Set<string>();
    for (const entry of CATALOG) {
      assert.ok(!ids.has(entry.id), `duplicate id: ${entry.id}`);
      ids.add(entry.id);
      assert.match(entry.id, /^[a-z0-9-]+$/);
      assert.equal(catalogById(entry.id), entry);
    }
    assert.equal(catalogById('no-such-entry'), null);
  });

  test('the split is real: both sides are populated and disjoint', () => {
    assert.ok(SUBSCRIPTION_CATALOG.length >= 20);
    assert.ok(BILL_CATALOG.length >= 20);
    assert.equal(CATALOG.length, SUBSCRIPTION_CATALOG.length + BILL_CATALOG.length);
    assert.ok(SUBSCRIPTION_CATALOG.every((entry) => entry.kind === 'subscription'));
    assert.ok(BILL_CATALOG.every((entry) => entry.kind === 'bill'));
  });

  test('every provider the analysis names is present', () => {
    const names = CATALOG.map((entry) => entry.name.toLowerCase());
    for (const provider of REQUIRED_PROVIDERS) {
      assert.ok(
        names.some((name) => name.includes(provider.toLowerCase())),
        `catalogue is missing ${provider}`,
      );
    }
  });

  test('utilities and telcos are bills; streaming is a subscription', () => {
    const kindOf = (id: string): string | undefined => catalogById(id)?.kind;
    for (const id of ['meralco', 'maynilad', 'manila-water', 'globe-postpaid', 'pldt-home']) {
      assert.equal(kindOf(id), 'bill', `${id} should be bill-shaped`);
    }
    for (const id of ['netflix', 'spotify', 'youtube-premium', 'icloud', 'gym-membership']) {
      assert.equal(kindOf(id), 'subscription', `${id} should be subscription-shaped`);
    }
  });

  test('bills that genuinely vary are flagged, fixed-price ones are not', () => {
    const variable = (id: string): boolean => {
      const entry = catalogById(id);
      assert.ok(entry !== null && entry.kind === 'bill');
      return entry.isVariable;
    };
    assert.equal(variable('meralco'), true);
    assert.equal(variable('maynilad'), true);
    assert.equal(variable('credit-card'), true);
    assert.equal(variable('pldt-home'), false);
    assert.equal(variable('rent'), false);
  });

  test('every declared bill category is a schema bill category', () => {
    // `BILL_CATEGORIES` is duplicated from the schema (the import is banned
    // outside `src/db`), so the runtime list is checked as well as the type.
    assert.equal(new Set(BILL_CATEGORIES).size, BILL_CATEGORIES.length);
    for (const category of BILL_CATEGORIES) assert.ok(isBillCategory(category));
  });
});

describe('catalog / a hint is not an amount', () => {
  test('no entry has a property a subscription insert would read as an amount', () => {
    for (const entry of CATALOG) {
      const keys = Object.keys(entry);
      assert.ok(!keys.includes('amountMinor'), `${entry.id} carries amountMinor`);
      assert.ok(!keys.includes('amount'), `${entry.id} carries amount`);
      assert.ok(!keys.includes('amount_minor'), `${entry.id} carries amount_minor`);
      // No key anywhere on an entry contains "amount" — the hint is called
      // something else entirely, which is the first of the three defences.
      assert.deepEqual(
        keys.filter((key) => /amount/i.test(key)),
        [],
        `${entry.id} has an amount-named property`,
      );
      // And exactly one money-shaped key exists at all: the hint.
      assert.deepEqual(
        keys.filter((key) => /minor|hint/i.test(key)),
        ['hintMinor'],
        `${entry.id} has an unexpected money field`,
      );
    }
  });

  test('a prefill carries no amount field of any name', () => {
    for (const entry of CATALOG) {
      const prefill = catalogPrefill(entry);
      const keys = Object.keys(prefill);
      assert.equal(
        keys.filter((key) => /amount|hint|minor/i.test(key)).length,
        0,
        `${entry.id} prefill leaks a money field: ${keys.join(', ')}`,
      );
      assert.equal(prefill.name, entry.name);
      assert.equal(prefill.billingCycle, entry.billingCycle);
    }
  });

  test('`AmountHint` is not assignable to `MinorUnits` — checked by tsc', () => {
    const hint: AmountHint = amountHint(549_00);

    // @ts-expect-error A hint is a distinct brand. If this line ever stops
    // being an error, a placeholder has become storable as a real amount and
    // `npx tsc --noEmit` is the thing that catches it.
    const amount: MinorUnits = hint;
    void amount;

    // Same value at runtime — the brand is erased, which is the whole point:
    // it costs nothing but a compile error at the wrong assignment.
    assert.equal(Number(hint), 549_00);
  });

  test('a prefill cannot complete a subscription insert on its own', () => {
    const netflix = catalogById('netflix');
    assert.ok(netflix !== null && netflix.kind === 'subscription');

    // @ts-expect-error `NewSubscriptionInput` requires `amountMinor`, and a
    // prefill has no field that can supply it. The user types it, always.
    const input: NewSubscriptionInput = {
      ...catalogPrefill(netflix),
      nextBillingDate: '2026-10-20',
    };
    void input;
    assert.ok(true);
  });

  test('hints are positive integers of minor units, or absent', () => {
    for (const entry of CATALOG) {
      const hint = catalogHint(entry);
      if (hint === null) continue;
      assert.ok(Number.isSafeInteger(hint), `${entry.id}: non-integer hint`);
      assert.ok(hint > 0, `${entry.id}: non-positive hint`);
    }
    // Several entries deliberately have NO hint, because any number would
    // mislead. If that ever becomes zero, someone has invented figures.
    assert.ok(CATALOG.some((entry) => entry.hintMinor === null));
  });

  test('amountHint refuses anything that is not a positive integer', () => {
    assert.throws(() => amountHint(0), RangeError);
    assert.throws(() => amountHint(-1), RangeError);
    assert.throws(() => amountHint(549.5), RangeError);
    assert.throws(() => amountHint(Number.NaN), RangeError);
  });
});

describe('catalog / search', () => {
  const idsOf = (entries: readonly CatalogEntry[]): string[] =>
    entries.map((entry) => entry.id);

  test('an empty query returns the whole catalogue, in declaration order', () => {
    assert.deepEqual(idsOf(searchCatalog('')), idsOf(CATALOG));
    assert.deepEqual(idsOf(searchCatalog('   ')), idsOf(CATALOG));
  });

  test('a name prefix ranks above a keyword match', () => {
    const results = searchCatalog('net');
    assert.equal(results[0].id, 'netflix');
  });

  test('case, spaces and punctuation are ignored', () => {
    for (const query of ['NETFLIX', 'net flix', ' Netflix ']) {
      assert.ok(
        idsOf(searchCatalog(query)).includes('netflix'),
        `"${query}" did not find Netflix`,
      );
    }
    assert.ok(idsOf(searchCatalog('golds gym')).includes('golds-gym'));
    assert.ok(idsOf(searchCatalog('disney')).includes('disney-plus'));
  });

  test('keywords find what the user actually types', () => {
    assert.ok(idsOf(searchCatalog('kuryente')).includes('meralco'));
    assert.ok(idsOf(searchCatalog('tubig')).includes('maynilad'));
    assert.ok(idsOf(searchCatalog('hbo go')).includes('hbo-max'));
  });

  test('kind filters the result', () => {
    assert.ok(searchCatalog('', { kind: 'bill' }).every((entry) => entry.kind === 'bill'));
    assert.ok(
      searchCatalog('', { kind: 'subscription' }).every(
        (entry) => entry.kind === 'subscription',
      ),
    );
  });

  test('the order is total, so the same query is always the same list', () => {
    // Not merely "sorted": two entries must never compare equal, or a
    // re-render could move a selection onto a different chip.
    for (const query of ['', 'e', 'a', 'gym', 'bill']) {
      const first = idsOf(searchCatalog(query));
      const again = idsOf(searchCatalog(query));
      assert.deepEqual(first, again, `unstable order for "${query}"`);
      assert.equal(new Set(first).size, first.length);
    }
  });

  test('ties are broken by declaration order, pinned exactly', () => {
    // "gym" matches three entries by name and three by keyword. The exact list
    // is asserted rather than a property, so a change to the ranking or to the
    // tie-break shows up here as a diff instead of passing silently.
    assert.deepEqual(idsOf(searchCatalog('gym')), [
      'gym-membership',
      'golds-gym',
      'anytime-fitness',
      'fitness-first',
    ]);
  });

  test('limit caps the result without changing the order', () => {
    const all = idsOf(searchCatalog('a'));
    assert.deepEqual(idsOf(searchCatalog('a', { limit: 3 })), all.slice(0, 3));
    assert.deepEqual(idsOf(searchCatalog('a', { limit: 0 })), []);
  });

  test('an unmatched query returns nothing rather than everything', () => {
    assert.deepEqual(searchCatalog('zzzzzzzz'), []);
  });
});

describe('catalog / grouping', () => {
  test('every entry lands in exactly one group', () => {
    const groups = catalogGroups();
    const seen = new Set<string>();
    for (const group of groups) {
      assert.ok(group.entries.length > 0, `${group.id} is empty`);
      for (const entry of group.entries) {
        assert.ok(!seen.has(entry.id), `${entry.id} is in two groups`);
        seen.add(entry.id);
      }
    }
    assert.equal(seen.size, CATALOG.length);
  });

  test('grouping a filtered list drops empty sections', () => {
    const groups = catalogGroups(searchCatalog('netflix'));
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].entries.map((entry) => entry.id),
      ['netflix'],
    );
  });
});
