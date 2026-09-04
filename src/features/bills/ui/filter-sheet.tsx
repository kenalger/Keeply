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

import type { BillCategory, BillSort } from '../types';
import { BILL_CATEGORIES_ORDERED, CATEGORY_ICONS, CATEGORY_LABELS } from './labels';

/**
 * The §23 category filter and sort order for the bills list.
 *
 * A `<Sheet/>` of rows rather than a `<SelectField/>`, for the two reasons the
 * subscriptions equivalent gives: it is opened from a toolbar control so there
 * is no field for a trigger to be, and "All categories" is the ABSENCE of a
 * value, which `SelectOption`'s required `value: T` cannot spell.
 *
 * Sort lives here rather than in the header because the header already carries
 * a search field and the paid/unpaid/overdue control. A third row there would
 * push the bills themselves below the fold on every visit — which on this
 * screen means pushing "what is overdue" out of sight, the one thing somebody
 * opens a bills list to find out.
 */

export interface BillFilterSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The chosen category, or `null` for all categories. */
  selected: BillCategory | null;
  onSelect: (category: BillCategory | null) => void;
  sort: BillSort;
  onChangeSort: (sort: BillSort) => void;
  testID?: string;
}

const SORT_OPTIONS: readonly SegmentedOption<BillSort>[] = [
  { value: 'due-date', label: 'Due' },
  { value: 'amount', label: 'Amount' },
  { value: 'name', label: 'Name' },
];

/** Each order's direction, which the one-word segment label cannot carry. */
const SORT_HELPERS: Record<BillSort, string> = {
  'due-date': 'Soonest due first, and anything overdue at the top.',
  amount: 'Largest first. Bills with no amount yet come last.',
  name: 'A to Z.',
};

interface CategoryOption {
  readonly key: string;
  readonly value: BillCategory | null;
  readonly label: string;
}

const OPTIONS: readonly CategoryOption[] = [
  { key: 'all', value: null, label: 'All categories' },
  ...BILL_CATEGORIES_ORDERED.map((category) => ({
    key: category,
    value: category,
    label: CATEGORY_LABELS[category],
  })),
];

export function BillFilterSheet({
  visible,
  onClose,
  selected,
  onSelect,
  sort,
  onChangeSort,
  testID = 'bill-filter-sheet',
}: BillFilterSheetProps) {
  const styles = useThemedStyles(makeStyles);

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
    <Sheet visible={visible} onClose={onClose} title="Filter and sort" testID={testID}>
      <View style={styles.sort}>
        <SegmentedField<BillSort>
          label="Sort by"
          variant="underline"
          value={sort}
          onChangeValue={onChangeSort}
          options={SORT_OPTIONS}
          helper={SORT_HELPERS[sort]}
          testID={`${testID}-sort`}
        />
        <FieldLabel>Category</FieldLabel>
      </View>
      {/* A sheet sizes to its content and has no height to fill, so the list
          must not try to fill one. See `ListProps.fill`. */}
      <List<CategoryOption>
        data={OPTIONS}
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
    sort: { gap: t.space.lg, marginBottom: t.space.xs },
  });
