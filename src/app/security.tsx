import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Icon,
  ListSectionHeader,
  Screen,
  ScreenHeader,
  SegmentedField,
  SwitchField,
  Text,
  type IconName,
} from '@/components/ui';
import { lockIsUnsatisfiable } from '@/features/security';
import {
  useAppLockStore,
  useBiometricCapability,
  useBiometricLabel,
} from '@/stores/app-lock-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * App lock, and an honest account of what it does (§17, §18).
 *
 * ── THE SCREEN'S REAL JOB IS THE SCOPE, NOT THE SWITCH ─────────────────────
 * The switch is two taps. What this screen owes the user is the difference
 * between the two promises Keeply makes about their data, because a lock icon
 * invites them to believe one thing protects everything:
 *
 *   THE LOCK      stops whoever picks up an unlocked phone from reading your
 *                 records. It is a presence check.
 *   THE DATABASE  is encrypted by SQLCipher with a key held in this device's
 *                 keychain. That is true whether the lock is on or off.
 *
 * Someone who turns the lock off has not made their data less safe, and
 * someone who turns it on has not made the file readable to anyone new. Saying
 * so is what makes the rest of the claim believable.
 *
 * ── A DEVICE THAT CANNOT LOCK SAYS SO, AND THE SWITCH GOES QUIET ───────────
 * Offering a toggle that cannot take effect is the thing that makes a security
 * screen untrustworthy. The preference is still STORED — a user who enrols
 * Face ID later gets what they asked for without coming back here.
 */

/**
 * How long the app may sit in the background before it asks again.
 *
 * Four options, not a slider: the difference between 15 and 20 seconds is not
 * a decision anybody wants to make, and the useful distinctions are "always",
 * "long enough to answer a call", and "long enough to look something up".
 */
type GraceKey = 'always' | '30s' | '1m' | '5m';

const GRACE_OPTIONS: readonly { value: GraceKey; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: '30s', label: '30s' },
  { value: '1m', label: '1 min' },
  { value: '5m', label: '5 min' },
];

const GRACE_SECONDS: Readonly<Record<GraceKey, number>> = {
  always: 0,
  '30s': 30,
  '1m': 60,
  '5m': 300,
};

/**
 * The stored number back to a chip.
 *
 * Nearest match rather than an exact lookup: the value is persisted and a
 * future build (or a restored bundle) may carry a number no chip names, and a
 * segmented control with NOTHING selected reads as broken. Rounding to the
 * closest offered option is always truthful about which bucket the user is in.
 */
function graceKeyFor(seconds: number): GraceKey {
  const keys = Object.keys(GRACE_SECONDS) as GraceKey[];
  return keys.reduce((best, key) =>
    Math.abs(GRACE_SECONDS[key] - seconds) < Math.abs(GRACE_SECONDS[best] - seconds)
      ? key
      : best,
  );
}

/** The three promises, as prose. See the render for why they are not rows. */
const FACTS: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'lock',
    title: 'The database is encrypted',
    body: "SQLCipher, with a key kept in this phone's keychain and marked so it never leaves this device. True whether or not the lock above is on.",
  },
  {
    icon: 'eyeSlash',
    title: 'Nothing leaves the device',
    body: "No account, no server, no uploads. Photos, scans and every number you type stay in Keeply's own storage.",
  },
  {
    icon: 'doc',
    title: 'Left out of device backups',
    body: 'Your records are not copied into iCloud. Use Backup in More to make a copy you control, encrypted with a passphrase you choose.',
  },
];

export default function SecurityScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const appLockEnabled = useSettingsStore((s) => s.appLockEnabled);
  const appLockGraceSeconds = useSettingsStore((s) => s.appLockGraceSeconds);
  const update = useSettingsStore((s) => s.update);

  const capability = useBiometricCapability();
  const label = useBiometricLabel();
  const check = useAppLockStore((s) => s.check);

  // Re-read on every visit: the user may have enrolled Face ID since the last
  // time, and a screen that still says "not set up" would be wrong about the
  // phone in their hand.
  useEffect(() => {
    void check();
  }, [check]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/more');
  }, [router]);

  const unsatisfiable = lockIsUnsatisfiable(capability);
  const method = label ?? 'your biometrics';

  return (
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title="Security"
        subtitle="What it takes to open Keeply, and what protects your data either way."
        onBack={leave}
        backLabel="Back to More"
      />

      <View style={styles.block}>
        <Card>
          <SwitchField
            label="Require unlock to open Keeply"
            value={appLockEnabled}
            onChangeValue={(next) => update({ appLockEnabled: next })}
            description={
              unsatisfiable
                ? capability === 'not-enrolled'
                  ? `This phone has ${method}, but nothing is set up in it yet. Set it up in Settings and Keeply will start asking.`
                  : 'This phone has no biometric sensor Keeply can use, so it will open without asking.'
                : `Keeply will ask for ${method}, or your phone's passcode.`
            }
            // Still writable when unsatisfiable: a user who enrols later gets
            // what they asked for without coming back here. It is the LOCK that
            // stands down, not the preference.
            testID="security-app-lock"
          />
        </Card>
        {!unsatisfiable || !appLockEnabled ? null : (
          <Text variant="caption" color="textSecondary" style={styles.note}>
            Saved — Keeply will start asking as soon as this phone can.
          </Text>
        )}
      </View>

      {!appLockEnabled ? null : (
        <View style={styles.block}>
          <ListSectionHeader title="After you leave the app" />
          <Card>
            <SegmentedField<GraceKey>
              label="Ask again"
              value={graceKeyFor(appLockGraceSeconds)}
              onChangeValue={(next) =>
                update({ appLockGraceSeconds: GRACE_SECONDS[next] })
              }
              options={GRACE_OPTIONS}
              helper="How long Keeply may sit in the background before it asks again. Answering a call is faster than 30 seconds."
              testID="security-grace"
            />
          </Card>
        </View>
      )}

      <View style={styles.block}>
        <ListSectionHeader title="What protects your data" />
        <Card style={styles.facts}>
          {/* PROSE, not `<Row/>`. A row's subtitle is `numberOfLines={2}` and
              silently truncates — the same trap that cut expense notes in half
              and had to be fixed once already. These are the paragraphs the
              whole screen exists to deliver; a security claim ending in "…" is
              worse than not making it. */}
          {FACTS.map((fact) => (
            <View key={fact.title} style={styles.fact}>
              <Icon name={fact.icon} size={20} color="textSecondary" />
              <View style={styles.factBody}>
                <Text variant="body">{fact.title}</Text>
                <Text variant="caption" color="textSecondary">
                  {fact.body}
                </Text>
              </View>
            </View>
          ))}
        </Card>
        <Text variant="caption" color="textTertiary" style={styles.note}>
          {/* The honest limit, stated where someone deciding about the lock can
              read it. A lock that oversells itself is worse than none. */}
          The lock stops someone who picks up your unlocked phone. It is not what
          keeps the file unreadable — the encryption does that, with or without it.
        </Text>
      </View>
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    block: { marginTop: t.layout.section, gap: t.space.sm },
    note: { marginTop: t.layout.caption },
    facts: { gap: t.space.lg },
    fact: { flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' },
    factBody: { flex: 1, gap: 2 },
  });
