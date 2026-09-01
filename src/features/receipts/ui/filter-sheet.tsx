/**
 * §23's receipt filters: merchant, category, date range, amount range.
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
  SelectField,
  Sheet,
  type SelectOption,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import { useThemedStyles, type Theme } from '@/theme';

import type { ReceiptCategory } from '../types';
import type { ReceiptFilterState } from './hooks';
import { CATEGORY_OPTIONS } from './labels';

/** `'all'` is the ABSENCE of a category filter. `SelectOption` cannot spell `null`. */
type CategoryChoice = ReceiptCategory | 'all';

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

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Filter receipts"
      subtitle="Everything here is applied by the database on this device."
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
            accessibilityHint="Removes the search, the category and both ranges"
            testID={`${testID}-clear`}
          />
        </>
      }>
      <View style={styles.body}>
        <SelectField<CategoryChoice>
          label="Category"
          value={value.category ?? 'all'}
          onChangeValue={(next) => set({ category: next === 'all' ? null : next })}
          options={CATEGORY_CHOICES}
          accessibilityHint="Opens the list of categories"
          testID={`${testID}-category`}
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
