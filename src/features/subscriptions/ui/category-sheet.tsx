import { useCallback } from 'react';
import { type ListRenderItemInfo } from 'react-native';

import { List, Row, Sheet, StatusPill } from '@/components/ui';

import { SUBSCRIPTION_CATEGORIES, type SubscriptionCategory } from '../types';
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
  title?: string;
  testID?: string;
}

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
  title = 'Choose a category',
  testID = 'category-sheet',
}: CategorySheetProps) {
  const options = includeAll ? WITH_ALL : CATEGORY_OPTION_ROWS;

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
