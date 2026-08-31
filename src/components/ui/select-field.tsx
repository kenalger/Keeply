/**
 * Pick one of a list. The list lives in a sheet, not in a native picker wheel.
 *
 * ── WHY A SHEET ────────────────────────────────────────────────────────────
 * A wheel picker is a poor fit for the lists this app actually has —
 * categories, cycles, payment methods, vehicles — because they are short,
 * unordered, and want an icon and sometimes a second line. A sheet of rows
 * shows every option at once, needs one tap instead of a scroll-and-confirm,
 * and can carry a search box the moment the list stops being short.
 *
 * The rows go through `<List/>`, so a category list that grows to two hundred
 * entries is virtualized rather than mounting two hundred rows.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type ListRenderItem,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { MIN_TOUCH_TARGET, useThemedStyles, type Theme } from '@/theme';

import { FieldBox, FieldShell, fieldAccessibilityLabel } from './field-shell';
import { Icon, type IconName } from './icon';
import { List } from './list';
import { Sheet } from './sheet';
import { Text } from './text';
import { TextField } from './text-field';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** One line of context under the label. */
  hint?: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface SelectFieldProps<T extends string> {
  label: string;
  /** Controlled. `null` means nothing chosen yet. */
  value: T | null;
  onChangeValue: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  helper?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  /** Show a search box in the sheet. Defaults to on past 8 options. */
  searchable?: boolean;
  /**
   * Seed the sheet open on mount.
   *
   * The field stays UNCONTROLLED — this only chooses the initial value of the
   * same `open` state a tap sets — so a preview or a screenshot pass renders the
   * identical code path, rather than a parallel one that can pass while the real
   * one is broken. That distinction is the whole reason this prop exists: the
   * open sheet is the render that proves the component works, and for a year
   * nothing in the repo produced it. Remount (a changed `key`) to reopen.
   */
  defaultOpen?: boolean;
  /** Sheet heading. Defaults to `Choose <label>`. */
  sheetTitle?: string;
  /** Shown in the sheet when a search matches nothing. */
  emptyMessage?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Past this many options, hunting beats scanning and a search box earns its space. */
const SEARCH_THRESHOLD = 8;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    valueText: { flex: 1 },
    search: { marginBottom: t.space.md },
    listContent: { paddingBottom: t.space.md },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: MIN_TOUCH_TARGET + t.space.sm,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.xs,
    },
    optionPressed: { backgroundColor: t.color.pressed },
    optionDisabled: { opacity: 0.45 },
    optionBody: { flex: 1 },
    optionHint: { marginTop: 1 },
    empty: { paddingVertical: t.space.xl, alignItems: 'center' },
  });

export function SelectField<T extends string>({
  label,
  value,
  onChangeValue,
  options,
  placeholder = 'Choose one',
  helper,
  error,
  required = false,
  disabled = false,
  searchable,
  defaultOpen = false,
  sheetTitle,
  emptyMessage = 'Nothing matches that.',
  accessibilityHint,
  style,
  testID,
}: SelectFieldProps<T>) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');

  const invalid = typeof error === 'string' && error.length > 0;
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle.length === 0
        ? options
        : options.filter(
            (option) =>
              option.label.toLowerCase().includes(needle) ||
              (option.hint ?? '').toLowerCase().includes(needle),
          ),
    [options, needle],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const choose = useCallback(
    (option: SelectOption<T>) => {
      onChangeValue(option.value);
      close();
    },
    [onChangeValue, close],
  );

  const renderOption = useCallback<ListRenderItem<SelectOption<T>>>(
    ({ item }) => (
      <OptionRow
        option={item}
        selected={item.value === value}
        onSelect={choose}
        styles={styles}
      />
    ),
    [value, choose, styles],
  );

  const keyExtractor = useCallback((option: SelectOption<T>) => option.value, []);

  return (
    <FieldShell
      label={label}
      required={required}
      helper={helper}
      error={error}
      style={style}
      testID={testID}>
      <FieldBox
        onPress={() => setOpen(true)}
        disabled={disabled}
        invalid={invalid}
        focused={open}
        expanded={open}
        accessibilityRole="combobox"
        accessibilityLabel={fieldAccessibilityLabel(label, required, error)}
        accessibilityValue={{ text: selected?.label ?? 'Not set' }}
        accessibilityHint={accessibilityHint ?? 'Opens a list of options'}
        testID={testID === undefined ? undefined : `${testID}-trigger`}>
        {selected?.icon === undefined ? null : (
          <Icon name={selected.icon} size={17} color="textSecondary" />
        )}
        <Text
          variant="body"
          color={selected === null ? 'textTertiary' : 'text'}
          numberOfLines={1}
          style={styles.valueText}>
          {selected?.label ?? placeholder}
        </Text>
        <Icon name="chevronDown" size={13} color="textTertiary" />
      </FieldBox>

      <Sheet
        visible={open}
        onClose={close}
        title={sheetTitle ?? `Choose ${label.toLowerCase()}`}
        testID={testID === undefined ? undefined : `${testID}-sheet`}>
        {showSearch ? (
          <TextField
            label="Search"
            content="search"
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${label.toLowerCase()}`}
            icon="search"
            clearable
            returnKeyType="search"
            onSubmitEditing={() => undefined}
            style={styles.search}
          />
        ) : null}
        <List<SelectOption<T>>
          data={visible}
          renderItem={renderOption}
          keyExtractor={keyExtractor}
          extraData={value}
          separator="none"
          // A sheet sizes to its content and has no height to fill; a filling
          // list would lay out at zero height here. See `ListProps.fill`.
          fill={false}
          contentContainerStyle={styles.listContent}
          accessibilityLabel={`${label} options`}
          empty={
            <View style={styles.empty}>
              <Text variant="body" color="textSecondary">
                {emptyMessage}
              </Text>
            </View>
          }
        />
      </Sheet>
    </FieldShell>
  );
}

interface OptionRowProps<T extends string> {
  option: SelectOption<T>;
  selected: boolean;
  onSelect: (option: SelectOption<T>) => void;
  styles: ReturnType<typeof makeStyles>;
}

/**
 * One choice. `radio` rather than `button`, because "checked" is the piece of
 * information a screen-reader user needs and a button cannot carry it.
 */
function OptionRow<T extends string>({ option, selected, onSelect, styles }: OptionRowProps<T>) {
  const isDisabled = option.disabled === true;
  return (
    <Pressable
      accessible
      accessibilityRole="radio"
      accessibilityLabel={option.hint === undefined ? option.label : `${option.label}, ${option.hint}`}
      accessibilityState={{ checked: selected, disabled: isDisabled, selected }}
      disabled={isDisabled}
      onPress={() => onSelect(option)}
      style={({ pressed }) => [
        styles.option,
        pressed && !isDisabled ? styles.optionPressed : null,
        isDisabled ? styles.optionDisabled : null,
      ]}>
      {option.icon === undefined ? null : (
        <Icon name={option.icon} size={19} color={selected ? 'accent' : 'textSecondary'} />
      )}
      <View style={styles.optionBody}>
        <Text variant={selected ? 'bodyStrong' : 'body'} numberOfLines={1}>
          {option.label}
        </Text>
        {option.hint === undefined ? null : (
          <Text variant="caption" color="textSecondary" numberOfLines={2} style={styles.optionHint}>
            {option.hint}
          </Text>
        )}
      </View>
      {selected ? <Icon name="check" size={17} color="accent" /> : null}
    </Pressable>
  );
}
