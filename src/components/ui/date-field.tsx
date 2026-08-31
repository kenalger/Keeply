/**
 * A calendar-date field. In and out, the value is a `YYYY-MM-DD` string.
 *
 * ── THE VALUE IS NEVER A `Date` ────────────────────────────────────────────
 * A due date, an expiry, a purchase date is a *calendar day*, not an instant.
 * The moment one becomes a `Date` it acquires a time and a timezone, and
 * `new Date('2026-10-12')` — UTC midnight — is 12 October in London and
 * 12 October 08:00 in Manila but 11 October in Los Angeles. That single line
 * is this project's highest-risk bug class, which is why the lint config
 * rejects it outright.
 *
 * So: the prop is a string, the callback gives a string, and the only place a
 * `Date` exists at all is the three-line hop into and out of the native
 * picker, through `toLocalDate` (which builds `new Date(y, m - 1, d)` — a
 * local calendar day, unambiguous) and `toCalendarString`. No date arithmetic
 * is written here; the presets go through `addCalendarDays`, which does its
 * arithmetic on a DST-free day index.
 *
 * ── THE PICKER IS THE PLATFORM'S ───────────────────────────────────────────
 * `@expo/ui`'s `DateTimePicker` is a real `UIDatePicker` / Material date
 * picker. On iOS it is presented inside this app's own `<Sheet/>`, so the
 * chrome around it is themed and the presets sit next to it; on Android it is
 * mounted as the platform's dialog, which is where an Android user expects to
 * find it.
 */
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';

import {
  addCalendarDays,
  formatDate,
  MIN_TOUCH_TARGET,
  parseCalendarDate,
  toCalendarString,
  todayCalendarString,
  toLocalDate,
  useTheme,
  useThemedStyles,
  type Theme,
} from '@/theme';

import { Button } from './button';
import { FieldBox, FieldShell, fieldAccessibilityLabel } from './field-shell';
import { Icon } from './icon';
import { Sheet } from './sheet';
import { Text } from './text';

/** A one-tap relative date. Everything here is `today ± n days`. */
export type DatePresetKey = 'today' | 'tomorrow' | 'nextWeek';

const PRESET_LABEL: Record<DatePresetKey, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  nextWeek: 'Next week',
};

const PRESET_OFFSET: Record<DatePresetKey, number> = {
  today: 0,
  tomorrow: 1,
  nextWeek: 7,
};

const DEFAULT_PRESETS: readonly DatePresetKey[] = ['today', 'tomorrow', 'nextWeek'];

export interface DateFieldProps {
  label: string;
  /** `YYYY-MM-DD`, or `null` for "not set". Never a `Date`. */
  value: string | null;
  /** Receives `YYYY-MM-DD`. `null` only when `clearable` and cleared. */
  onChangeValue: (value: string | null) => void;
  helper?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  /** Text shown when there is no value. Defaults to "Choose a date". */
  placeholder?: string;
  /** Earliest selectable day, `YYYY-MM-DD`. */
  minDate?: string;
  /** Latest selectable day, `YYYY-MM-DD`. */
  maxDate?: string;
  /** One-tap relative days. Pass `[]` to hide them. */
  presets?: readonly DatePresetKey[];
  /** Offer a control that returns the field to `null`. */
  clearable?: boolean;
  /** Title of the picker sheet. Defaults to the label. */
  sheetTitle?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    valueText: { flex: 1 },
    presets: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, marginBottom: t.space.lg },
    // Outline at rest, fill when chosen — the same fill-versus-outline
    // vocabulary the status pills use, never both at once.
    chip: {
      minHeight: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: t.space.lg,
      borderRadius: t.radius.pill,
      borderWidth: 1,
      borderColor: t.color.borderStrong,
      backgroundColor: 'transparent',
    },
    chipSelected: { backgroundColor: t.color.accent, borderColor: t.color.accent },
    chipPressed: { backgroundColor: t.color.pressed },
    picker: { alignSelf: 'stretch', marginBottom: t.space.md },
    footerRow: { flexDirection: 'row', gap: t.space.md },
    footerButton: { flex: 1 },
  });

export function DateField({
  label,
  value,
  onChangeValue,
  helper,
  error,
  required = false,
  disabled = false,
  placeholder = 'Choose a date',
  minDate,
  maxDate,
  presets = DEFAULT_PRESETS,
  clearable = false,
  sheetTitle,
  accessibilityHint,
  style,
  testID,
}: DateFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  const invalid = typeof error === 'string' && error.length > 0;
  const valid = parseCalendarDate(value) !== null;
  const shown = valid && value !== null ? formatDate(value) : placeholder;

  // The picker needs a Date. This is the only conversion in the component, and
  // it goes through the local-calendar-day helper, never `new Date(string)`.
  const pickerDate = useMemo(
    () => (valid && value !== null ? toLocalDate(value) : null) ?? new Date(),
    [valid, value],
  );
  const minimumDate = useMemo(() => (minDate === undefined ? undefined : toLocalDate(minDate) ?? undefined), [minDate]);
  const maximumDate = useMemo(() => (maxDate === undefined ? undefined : toLocalDate(maxDate) ?? undefined), [maxDate]);

  const commit = useCallback(
    (iso: string) => {
      onChangeValue(iso);
    },
    [onChangeValue],
  );

  const handlePicked = useCallback(
    (_event: unknown, date: Date) => {
      commit(toCalendarString(date));
    },
    [commit],
  );

  const openPicker = useCallback(() => setOpen(true), []);
  const closePicker = useCallback(() => setOpen(false), []);

  const today = todayCalendarString();
  const presetDates = useMemo(
    () =>
      presets
        .map((key) => ({ key, iso: addCalendarDays(today, PRESET_OFFSET[key]) }))
        .filter((entry): entry is { key: DatePresetKey; iso: string } => entry.iso !== null),
    [presets, today],
  );

  const presetRow =
    presetDates.length === 0 ? null : (
      <View style={styles.presets}>
        {presetDates.map((entry) => (
          <Pressable
            key={entry.key}
            accessibilityRole="button"
            accessibilityLabel={`${PRESET_LABEL[entry.key]}, ${formatDate(entry.iso)}`}
            accessibilityState={{ selected: value === entry.iso }}
            onPress={() => {
              commit(entry.iso);
              closePicker();
            }}
            style={({ pressed }) => [
              styles.chip,
              value === entry.iso ? styles.chipSelected : null,
              pressed ? styles.chipPressed : null,
            ]}>
            <Text
              variant="bodyStrong"
              color={value === entry.iso ? 'onAccent' : 'text'}
              numberOfLines={1}>
              {PRESET_LABEL[entry.key]}
            </Text>
          </Pressable>
        ))}
      </View>
    );

  return (
    <FieldShell
      label={label}
      required={required}
      helper={helper}
      error={error}
      style={style}
      testID={testID}>
      <FieldBox
        onPress={openPicker}
        disabled={disabled}
        invalid={invalid}
        focused={open}
        expanded={open}
        accessibilityLabel={fieldAccessibilityLabel(label, required, error)}
        accessibilityValue={{ text: valid && value !== null ? formatDate(value) : 'Not set' }}
        accessibilityHint={accessibilityHint ?? 'Opens a date picker'}
        testID={testID === undefined ? undefined : `${testID}-trigger`}>
        <Icon name="calendar" size={17} color={open ? 'accent' : 'textTertiary'} />
        <Text
          variant="body"
          color={valid ? 'text' : 'textTertiary'}
          numberOfLines={1}
          style={styles.valueText}>
          {shown}
        </Text>
        <Icon name="chevronDown" size={13} color="textTertiary" />
      </FieldBox>

      {/* iOS: the picker lives in this app's own sheet, next to the presets. */}
      {Platform.OS === 'ios' ? (
        <Sheet
          visible={open}
          onClose={closePicker}
          title={sheetTitle ?? label}
          subtitle={valid && value !== null ? formatDate(value) : undefined}
          testID={testID === undefined ? undefined : `${testID}-sheet`}
          footer={
            <View style={styles.footerRow}>
              {clearable ? (
                <Button
                  title="Clear"
                  variant="secondary"
                  onPress={() => {
                    onChangeValue(null);
                    closePicker();
                  }}
                  style={styles.footerButton}
                />
              ) : null}
              <Button title="Done" onPress={closePicker} style={styles.footerButton} />
            </View>
          }>
          {presetRow}
          <DateTimePicker
            mode="date"
            display="inline"
            value={pickerDate}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            accentColor={theme.color.accent}
            themeVariant={theme.mode}
            onValueChange={handlePicked}
            style={styles.picker}
            testID={testID === undefined ? undefined : `${testID}-picker`}
          />
        </Sheet>
      ) : null}

      {/* Android: the platform dialog, mounted only while it is open. It is
          unmounted in response to either callback, per the component's own
          contract. */}
      {Platform.OS !== 'ios' && open ? (
        <DateTimePicker
          mode="date"
          presentation="dialog"
          value={pickerDate}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          accentColor={theme.color.accent}
          onValueChange={(event, date) => {
            handlePicked(event, date);
            closePicker();
          }}
          onDismiss={closePicker}
          testID={testID === undefined ? undefined : `${testID}-picker`}
        />
      ) : null}
    </FieldShell>
  );
}
