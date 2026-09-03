/**
 * §23's expense filters — merchant, category, date range, amount range, photo —
 * and the order the results come back in.
 *
 * ── WHY THREE OF THE FOUR ARE IN A SHEET ───────────────────────────────────
 * The merchant search is not here — it lives in the list header, always one tap
 * away, because it is the filter that gets used constantly and typing into it
 * is the fastest way to find one specific receipt.
 *
 * The other three are two controls each. Six controls above a list would push
 * the receipts themselves below the fold on every screen, including the vast
 * majority of visits where nothing is being filtered at all. So they open on
 * demand — and the list's subtitle states what is currently set, so a filtered
 * list can never be mistaken for an empty app.
 *
 * ── EVERY FILTER IS APPLIED BY SQLITE ──────────────────────────────────────
 * Nothing on this screen filters anything. Each control writes one field of
 * `ReceiptFilterState`, `useReceiptFilter()` turns that into the data layer's
 * `ReceiptFilter`, and `sql.ts` builds one WHERE clause that both the page and
 * its total are evaluated against. The `total` above a filtered list is a
 * `count(*)` over that same predicate, not `rows.length` (§23, §33).
 *
 * ── CHANGES APPLY IMMEDIATELY ──────────────────────────────────────────────
 * There is no Apply button. A local read is a millisecond, so the list behind
 * the sheet updates as each control is touched, and "Done" only closes. An
 * Apply button would be a promise that something is being computed, which on
 * this device is never true (§25).
 *
 * ── THE RANGES CAN BE SET BACKWARDS, AND SAY SO ────────────────────────────
 * The data layer refuses a range whose end is below its start
 * (`invalid-range`), and refusing is right — such a range matches nothing, so
 * silently swapping the bounds would answer a question the user did not ask.
 * The sheet catches it first and says so under the offending control, because
 * an empty list with no explanation is the worst possible way to learn this.
 */
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountField,
  Button,
  DateField,
  ErrorText,
  FieldLabel,
  SegmentedField,
  SelectField,
  Sheet,
  type SegmentedOption,
  type SelectOption,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import { useThemedStyles, type Theme } from '@/theme';

import type { ReceiptCategory, ReceiptSort } from '../types';
import type { ReceiptFilterState } from './hooks';
import { CATEGORY_OPTIONS } from './labels';

/** `'all'` is the ABSENCE of a category filter. `SelectOption` cannot spell `null`. */
type CategoryChoice = ReceiptCategory | 'all';

/**
 * SORT IS NOT A FILTER, and this sheet holds both anyway.
 *
 * It changes the ORDER of what matched, never what matched — which is why it
 * is excluded from `activeFilterCount()` and from `isFiltered()`, and why
 * "Clear all filters" leaves it alone. Resetting the order the user chose
 * because they cleared a category would be answering a question nobody asked.
 *
 * It lives in this sheet rather than in the header because the header already
 * carries a search field and two buttons; a fourth control there would push the
 * expenses themselves below the fold on every visit, including the majority
 * where nothing is sorted or filtered at all.
 */
const SORT_OPTIONS: readonly SegmentedOption<ReceiptSort>[] = [
  { value: 'purchase-date', label: 'Date' },
  { value: 'amount', label: 'Amount' },
  { value: 'merchant', label: 'Name' },
];

/**
 * Each order's direction and its consequence, said out loud.
 *
 * The consequence matters: day grouping only makes sense while the list is in
 * date order. Sorted by amount, one day's expenses are scattered down the list,
 * and a "day total" over a scattered run would be a partial sum wearing the
 * name of a whole one.
 */
const SORT_HELPERS: Record<ReceiptSort, string> = {
  'purchase-date': 'Newest first, grouped by day with a total for each.',
  amount: 'Largest first. Days are not grouped — the list is no longer in date order.',
  merchant: 'A to Z. Days are not grouped — the list is no longer in date order.',
};

/** `'any'` is the ABSENCE of a photo filter. A segment cannot spell `null`. */
type PhotoChoice = 'any' | 'with' | 'without';

const PHOTO_OPTIONS: readonly SegmentedOption<PhotoChoice>[] = [
  { value: 'any', label: 'Any' },
  { value: 'with', label: 'With photo' },
  { value: 'without', label: 'No photo' },
];

function photoChoice(hasImage: boolean | null): PhotoChoice {
  if (hasImage === null) return 'any';
  return hasImage ? 'with' : 'without';
}

function hasImageFor(choice: PhotoChoice): boolean | null {
  if (choice === 'any') return null;
  return choice === 'with';
}

const CATEGORY_CHOICES: readonly SelectOption<CategoryChoice>[] = [
  { value: 'all', label: 'All categories', icon: 'tag' },
  ...CATEGORY_OPTIONS,
];

export interface ReceiptFilterSheetProps {
  visible: boolean;
  onClose: () => void;
  value: ReceiptFilterState;
  onChange: (next: ReceiptFilterState) => void;
  /** Reset every filter, including the search box the sheet does not own. */
  onClearAll: () => void;
  testID?: string;
}

export function ReceiptFilterSheet({
  visible,
  onClose,
  value,
  onChange,
  onClearAll,
  testID = 'receipt-filters',
}: ReceiptFilterSheetProps) {
  const styles = useThemedStyles(makeStyles);

  const set = useCallback(
    (changes: Partial<ReceiptFilterState>) => onChange({ ...value, ...changes }),
    [onChange, value],
  );

  const datesBackwards =
    value.fromISO !== null && value.toISO !== null && value.fromISO > value.toISO;
  const amountsBackwards =
    value.minAmountMinor !== null &&
    value.maxAmountMinor !== null &&
    value.minAmountMinor > value.maxAmountMinor;

  // NO SUBTITLE. It used to read "Every filter and the order are applied by the
  // database on this device" — true, and reassurance worth giving once, not
  // every time someone changes a sort order. Two wrapped lines of it sat above
  // the first control and pushed the whole sheet down.
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Filter and sort"
      scroll
      testID={testID}
      footer={
        <>
          <Button
            title="Done"
            size="lg"
            fullWidth
            onPress={onClose}
            testID={`${testID}-done`}
          />
          <Button
            title="Clear all filters"
            variant="ghost"
            fullWidth
            onPress={onClearAll}
            accessibilityHint="Removes the search, the category, the photo filter and both ranges. The sort order is kept."
            testID={`${testID}-clear`}
          />
        </>
      }>
      <View style={styles.body}>
        <SegmentedField<ReceiptSort>
          label="Sort by"
          variant="underline"
          value={value.sort}
          onChangeValue={(next) => set({ sort: next })}
          options={SORT_OPTIONS}
          helper={SORT_HELPERS[value.sort]}
          testID={`${testID}-sort`}
        />

        <SelectField<CategoryChoice>
          label="Category"
          value={value.category ?? 'all'}
          onChangeValue={(next) => set({ category: next === 'all' ? null : next })}
          options={CATEGORY_CHOICES}
          accessibilityHint="Opens the list of categories"
          testID={`${testID}-category`}
        />

        <SegmentedField<PhotoChoice>
          label="Photo"
          variant="underline"
          value={photoChoice(value.hasImage)}
          onChangeValue={(next) => set({ hasImage: hasImageFor(next) })}
          options={PHOTO_OPTIONS}
          testID={`${testID}-photo`}
        />

        <View style={styles.group}>
          <FieldLabel>Purchase date</FieldLabel>
          <DateField
            label="From"
            value={value.fromISO}
            onChangeValue={(next) => set({ fromISO: next })}
            clearable
            placeholder="Any date"
            testID={`${testID}-from`}
          />
          <DateField
            label="To"
            value={value.toISO}
            onChangeValue={(next) => set({ toISO: next })}
            clearable
            placeholder="Any date"
            error={datesBackwards ? 'This is before the "From" date, so nothing matches.' : null}
            testID={`${testID}-to`}
          />
        </View>

        <View style={styles.group}>
          <FieldLabel>Amount</FieldLabel>
          <AmountField
            label="At least"
            value={value.minAmountMinor}
            onChangeValue={(next: MinorUnits | null) => set({ minAmountMinor: next })}
            testID={`${testID}-min`}
          />
          <AmountField
            label="At most"
            value={value.maxAmountMinor}
            onChangeValue={(next: MinorUnits | null) => set({ maxAmountMinor: next })}
            error={amountsBackwards ? 'This is below the minimum, so nothing matches.' : null}
            testID={`${testID}-max`}
          />
          {/* The ranges are the only place a user can ask an impossible
              question, so the consequence is stated once, plainly. */}
          <ErrorText>
            {datesBackwards || amountsBackwards
              ? 'A range that runs backwards matches nothing. Keeply leaves it to you to fix rather than quietly swapping the two.'
              : null}
          </ErrorText>
        </View>
      </View>
    </Sheet>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    body: { gap: t.layout.section, paddingBottom: t.space.md },
    group: { gap: t.space.sm },
  });
