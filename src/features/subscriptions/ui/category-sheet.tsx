import { useCallback } from 'react';

import { StyleSheet, View, type ListRenderItemInfo } from 'react-native';

import {
  FieldLabel,
  List,
  Row,
  SegmentedField,
  Sheet,
  StatusPill,
  type SegmentedOption,
} from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

import {
  SUBSCRIPTION_CATEGORIES,
  type SubscriptionCategory,
  type SubscriptionSort,
} from '../types';
import { CATEGORY_ICONS, CATEGORY_LABELS } from './labels';

/**
 * The §23 category FILTER for the subscriptions list.
 *
 * ── WHAT THIS IS NOT, ANY MORE ─────────────────────────────────────────────
 * This used to exist because `<SelectField/>` was broken: its option `<List/>`
 * laid out at zero height inside a `<Sheet/>`, so this file boxed a list in a
 * `<View>` with a hard-coded height to give it one. That bug is fixed — the
 * cause was the `flex: 1` a `<List/>` applies, which Yoga resolves to a flex
 * basis of 0, and the cure is `<List fill={false}/>`. The add/edit FORM now uses
 * `<SelectField/>` directly, as it always should have.
 *
 * What is left is the filter, and it is genuinely not a `<SelectField/>`:
 *  - it is opened by a toolbar filter control, not by a labelled field box, so
 *    there is no field for `<SelectField/>`'s trigger to be;
 *  - "All categories" is the ABSENCE of a value, and `SelectOption` has no way
 *    to spell `null` — `value: T` is required.
 * So it stays a plain `<Sheet/>` of rows, and it no longer works around anything.
 */

export interface CategorySheetProps {
  visible: boolean;
  onClose: () => void;
  /** The chosen category, or `null` for "no category chosen / all categories". */
  selected: SubscriptionCategory | null;
  /**
   * Offer an "All categories" row. On for the list filter, off for the form —
   * a subscription always has a category (the column has a default).
   */
  includeAll?: boolean;
  onSelect: (category: SubscriptionCategory | null) => void;
  /**
   * The list's order. Supply BOTH of these to add a sort control above the
   * categories; the add/edit form supplies neither and is unaffected.
   *
   * Sort lives beside the category filter rather than in the header because the
   * header already carries a search field and the active/paused control, and a
   * third row there would push the subscriptions themselves below the fold on
   * every visit — the same argument the expenses filter sheet makes.
   */
  sort?: SubscriptionSort;
  onChangeSort?: (sort: SubscriptionSort) => void;
  title?: string;
  testID?: string;
}

const SORT_OPTIONS: readonly SegmentedOption<SubscriptionSort>[] = [
  { value: 'next-billing', label: 'Due' },
  { value: 'amount', label: 'Amount' },
  { value: 'name', label: 'Name' },
];

/** Each order's direction, which the one-word segment label cannot carry. */
const SORT_HELPERS: Record<SubscriptionSort, string> = {
  'next-billing': 'Soonest renewal first.',
  amount: 'Most expensive first.',
  name: 'A to Z.',
};

interface CategoryOption {
  readonly key: string;
  readonly value: SubscriptionCategory | null;
  readonly label: string;
}

const ALL_OPTION: CategoryOption = { key: 'all', value: null, label: 'All categories' };

const CATEGORY_OPTION_ROWS: readonly CategoryOption[] = SUBSCRIPTION_CATEGORIES.map(
  (category) => ({ key: category, value: category, label: CATEGORY_LABELS[category] }),
);

const WITH_ALL: readonly CategoryOption[] = [ALL_OPTION, ...CATEGORY_OPTION_ROWS];

export function CategorySheet({
  visible,
  onClose,
  selected,
  includeAll = false,
  onSelect,
  sort,
  onChangeSort,
  title = 'Choose a category',
  testID = 'category-sheet',
}: CategorySheetProps) {
  const styles = useThemedStyles(makeStyles);
  const options = includeAll ? WITH_ALL : CATEGORY_OPTION_ROWS;
  const showsSort = sort !== undefined && onChangeSort !== undefined;

  const renderOption = useCallback(
    ({ item }: ListRenderItemInfo<CategoryOption>) => (
      <Row
        icon={item.value === null ? 'tag' : CATEGORY_ICONS[item.value]}
        title={item.label}
        chevron={false}
        trailing={
          item.value === selected ? <StatusPill status="valid" label="Chosen" /> : undefined
        }
        onPress={() => onSelect(item.value)}
        testID={`${testID}-${item.key}`}
      />
    ),
    [selected, onSelect, testID],
  );

  return (
    <Sheet visible={visible} onClose={onClose} title={title} testID={testID}>
      {showsSort ? (
        <View style={styles.sort}>
          <SegmentedField<SubscriptionSort>
            label="Sort by"
            variant="underline"
            value={sort}
            onChangeValue={onChangeSort}
            options={SORT_OPTIONS}
            helper={SORT_HELPERS[sort]}
            testID={`${testID}-sort`}
          />
          {/* Only when the sort control is above it. On its own the sheet's
              title already says what the list is, and a heading repeating it
              would be the "Notes / Notes" duplication again. */}
          <FieldLabel>Category</FieldLabel>
        </View>
      ) : null}
      {/* A sheet sizes to its content and has no height to fill, so the list
          must not try to fill one. See `ListProps.fill`. */}
      <List<CategoryOption>
        data={options}
        renderItem={renderOption}
        keyExtractor={optionKey}
        extraData={selected}
        fill={false}
        separator="hairline"
        accessibilityLabel="Categories"
      />
    </Sheet>
  );
}

const optionKey = (option: CategoryOption): string => option.key;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // `gap` between the segmented control and the "Category" label, and a
    // smaller bottom margin because the label must sit against the list it
    // names rather than float between the two controls.
    sort: { gap: t.space.lg, marginBottom: t.space.xs },
  });
