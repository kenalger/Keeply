import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useTheme } from '@/theme';

/**
 * The five-tab bar (§4): Home, Money, Vehicles, Documents, More.
 *
 * Rendered by `app/(tabs)/_layout.tsx`. Kept as its own component so the route
 * file stays a thin layout and the tab configuration is readable in one place.
 *
 * Icons are declared twice per tab on purpose:
 *   `sf`  — SF Symbols on iOS, with a filled variant when the tab is selected.
 *   `md`  — Material Symbols on Android, which is the platform-native fallback.
 * `expo-symbols` supplies both name unions, so a typo is a type error rather
 * than a blank icon at runtime.
 */
export default function AppTabs() {
  const theme = useTheme();

  return (
    <NativeTabs
      backgroundColor={theme.color.bgElevated}
      tintColor={theme.color.accent}
      iconColor={{ default: theme.color.textTertiary, selected: theme.color.accent }}
      indicatorColor={theme.color.surface}
      rippleColor={theme.color.surface}
      labelStyle={{
        default: { color: theme.color.textTertiary },
        selected: { color: theme.color.accent },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="money">
        <NativeTabs.Trigger.Label>Money</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'creditcard', selected: 'creditcard.fill' }}
          md={{ default: 'payments', selected: 'payments' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="vehicles">
        <NativeTabs.Trigger.Label>Vehicles</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'car', selected: 'car.fill' }}
          md={{ default: 'directions_car', selected: 'directions_car' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="documents">
        <NativeTabs.Trigger.Label>Documents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'doc.text', selected: 'doc.text.fill' }}
          md={{ default: 'description', selected: 'description' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'ellipsis.circle', selected: 'ellipsis.circle.fill' }}
          md={{ default: 'more_horiz', selected: 'more_horiz' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
