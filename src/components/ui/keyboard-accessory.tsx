/**
 * A "Next"/"Done" bar above the keyboard.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * The iOS numeric keypads — `decimal-pad`, `number-pad`, `phone-pad` — have no
 * return key. There is literally nothing on that keyboard that dismisses it or
 * moves to the next field, so an amount field leaves the user reaching around
 * a keyboard to tap whatever is behind it. On a form whose target is twenty
 * seconds, that is the single most expensive omission available.
 *
 * `InputAccessoryView` is iOS-only, so on Android this renders nothing and the
 * platform's own keyboard controls (a real enter key, the back gesture) do the
 * job they already do.
 */
import { InputAccessoryView, Platform, StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

import { Button } from './button';

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      borderTopWidth: t.hairline,
      borderTopColor: t.color.border,
      backgroundColor: t.color.bgElevated,
    },
  });

export interface KeyboardAccessoryProps {
  /** Must match the input's `inputAccessoryViewID`. */
  nativeID: string;
  /** `true` renders "Next", `false` renders "Done". */
  hasNext: boolean;
  onPress: () => void;
  testID?: string;
}

/** True when this platform can show an accessory bar at all. */
export const SUPPORTS_KEYBOARD_ACCESSORY = Platform.OS === 'ios';

export function KeyboardAccessory({ nativeID, hasNext, onPress, testID }: KeyboardAccessoryProps) {
  const styles = useThemedStyles(makeStyles);
  if (!SUPPORTS_KEYBOARD_ACCESSORY) return null;

  return (
    <InputAccessoryView nativeID={nativeID}>
      <View style={styles.bar}>
        <Button
          title={hasNext ? 'Next' : 'Done'}
          variant="ghost"
          onPress={onPress}
          accessibilityHint={
            hasNext ? 'Moves to the next field' : 'Closes the keyboard'
          }
          testID={testID}
        />
      </View>
    </InputAccessoryView>
  );
}
