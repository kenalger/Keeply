import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import type { ListRenderItemInfo } from 'react-native';

import {
  Badge,
  List,
  ListBlock,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  groupPosition,
  useTabScreenContentStyle,
  type GroupPosition,
  type IconName,
} from '@/components/ui';
import type { ReminderKindSlug } from '@/features/settings';
import { isDev } from '@/lib/env';
import { log } from '@/lib/log';
import {
  describeReminderLeadTimes,
  formatReminderHour,
  useAppLockEnabled,
  useReminderDefaults,
} from '@/stores/settings-store';
import {
  useThemePreference,
  useUiStore,
  type SampleDashboardMode,
  type ThemePreference,
} from '@/stores/ui-store';

/**
 * More tab (§4): settings, security, backup and export.
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
 * This was the worst offender in the app: four full-height `EmptyState`s —
 * 1,665pt, more than two screens — announcing "Reminder defaults coming soon",
 * "App lock coming soon", "Backup coming soon". A settings screen that is
 * itself empty is a category error. Settings are not records: there is nothing
 * for the user to add, so "nothing here yet" was never the right sentence, and
 * a 72pt icon and a centred paragraph per unbuilt feature turned a page the
 * user opens to *change something* into a roadmap.
 *
 * It now reads as what it is — a settings list. Every entry is a row with a
 * name, one line of explanation and its current state, so the whole screen is
 * scannable at a glance and the things that already work sit next to the
 * things that do not, at the same weight, in the same place they will always
 * be. A "Soon" chip is a smaller and more honest promise than a placeholder
 * that occupies a viewport.
 *
 * ── WHAT IS REAL TODAY ─────────────────────────────────────────────────────
 * More of this screen is live than the old placeholders suggested:
 *   - Appearance genuinely switches the theme (`ui-store` → `@/theme`).
 *   - The reminder rows print the actual scheduling defaults out of the
 *     settings store; they are not copy.
 *   - "Database encryption · On" is a fact by construction: `assertSQLCipher()`
 *     runs before `open()`, and the tab tree only mounts once boot has
 *     succeeded, so this row cannot render on a plaintext database.
 *   - Version comes from the Expo config, not a typed-in literal.
 *
 * PHASE 7: reminder rows and App lock become navigable pickers.
 * PHASE 8: the backup rows gain their actions.
 */

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

/** Current state of a setting, rendered in the row's value slot. */
type SettingState =
  | { readonly kind: 'text'; readonly label: string }
  | { readonly kind: 'on'; readonly label: string }
  | { readonly kind: 'soon' }
  | { readonly kind: 'none' };

interface SettingItem {
  readonly key: string;
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle?: string;
  readonly state: SettingState;
  readonly onPress?: () => void;
  readonly hint?: string;
  /**
   * A row that changes its own value in place rather than opening something.
   * It suppresses the disclosure chevron, which would otherwise promise a
   * screen that does not exist.
   */
  readonly cycles?: boolean;
}

type MoreRow =
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | {
      kind: 'setting';
      key: string;
      group: GroupPosition;
      item: SettingItem;
      /**
       * This row opens a group that has no heading above it, so it has to
       * carry the section gap itself — otherwise the first card on the screen
       * butts straight against the header's subtitle.
       */
      leadsSection?: boolean;
    };

const SAMPLE_LABELS: Readonly<Record<SampleDashboardMode, string>> = {
  off: 'Off',
  busy: 'Busy',
  quiet: 'Quiet',
};

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const THEME_ICONS: Readonly<Record<ThemePreference, IconName>> = {
  system: 'gear',
  light: 'sun',
  dark: 'moon',
};

const THEME_ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

/**
 * Push one run of rows, correctly grouped, onto the flat row list.
 *
 * `title: null` is a headerless group — the iOS-settings convention for the
 * first group on a screen, where a heading would only repeat the single row
 * underneath it.
 */
function pushSection(
  rows: MoreRow[],
  title: string | null,
  items: readonly SettingItem[],
  note?: string,
): void {
  if (items.length === 0) return;
  if (title !== null) rows.push({ kind: 'sectionHeader', key: `h:${title}`, title });
  items.forEach((item, index) =>
    rows.push({
      kind: 'setting',
      key: `s:${item.key}`,
      group: groupPosition(index, items.length),
      item,
      leadsSection: title === null && index === 0,
    }),
  );
  if (note !== undefined) {
    rows.push({ kind: 'note', key: `n:${title ?? items[0].key}`, text: note });
  }
}

interface MoreRowInput {
  readonly themePreference: ThemePreference;
  readonly cycleTheme: () => void;
  readonly reminders: ReturnType<typeof useReminderDefaults>;
  readonly sampleDashboard: SampleDashboardMode;
  readonly cycleSampleDashboard: () => void;
  readonly openReminders: () => void;
  readonly openReminderKind: (slug: ReminderKindSlug) => void;
  readonly openExport: () => void;
  readonly openRestore: () => void;
  readonly openDesignSystem: () => void;
  readonly restartOnboarding: () => void;
  /** The user asked for an app lock during setup (`plan/onboarding.md` step 6). */
  readonly appLockChosen: boolean;
  readonly appVersion: string;
}

function buildMoreRows(input: MoreRowInput): readonly MoreRow[] {
  const rows: MoreRow[] = [];

  pushSection(rows, null, [
    {
      key: 'theme',
      icon: THEME_ICONS[input.themePreference],
      title: 'Appearance',
      subtitle: 'Follow the device, or pick light or dark',
      state: { kind: 'text', label: THEME_LABELS[input.themePreference] },
      onPress: input.cycleTheme,
      hint: 'Cycles between System, Light and Dark.',
      cycles: true,
    },
  ]);

  pushSection(
    rows,
    'Reminders',
    [
      {
        key: 'bills',
        icon: 'banknote',
        title: 'Bill reminders',
        subtitle: describeReminderLeadTimes(input.reminders.billReminderLeadTimes),
        state: { kind: 'none' },
        // Straight to the one kind, not to the reminders index. Each of these
        // rows already names a kind and states its answer; landing on a page
        // that says the same four things again is a tap that changed nothing.
        onPress: () => input.openReminderKind('bills'),
      },
      {
        key: 'subs',
        icon: 'repeat',
        title: 'Subscription renewals',
        subtitle: describeReminderLeadTimes(input.reminders.subscriptionReminderLeadTimes),
        state: { kind: 'none' },
        onPress: () => input.openReminderKind('subscriptions'),
      },
      {
        key: 'docs',
        icon: 'doc',
        title: 'Document expiry',
        subtitle: describeReminderLeadTimes(input.reminders.documentReminderLeadTimes),
        state: { kind: 'none' },
        onPress: () => input.openReminderKind('documents'),
      },
      {
        key: 'hour',
        icon: 'clock',
        title: 'Delivered at',
        subtitle: 'Local time, scheduled on this device',
        state: { kind: 'text', label: formatReminderHour(input.reminders.reminderHour) },
        // The hour is not a per-kind setting, so it goes to the index, which
        // is where it lives.
        onPress: input.openReminders,
      },
    ],
    // WAS: "Any single record can override these." It could not. The
    // mechanism exists in `notifications-plan.ts` (`ReminderEntity.leadTimes`)
    // and is tested, but nothing in the app ever sets it — no form has the
    // control — so the sentence promised a feature that does not exist, on the
    // screen where a user would go looking for it.
    'These apply to every record of their kind.',
  );

  pushSection(rows, 'Security', [
    {
      key: 'encryption',
      icon: 'shield',
      title: 'Database encryption',
      subtitle: 'SQLCipher, with a key held only in this device’s keychain',
      state: { kind: 'on', label: 'On' },
    },
    {
      key: 'applock',
      icon: 'faceid',
      title: 'App lock',
      // The wizard's protect step writes this preference before the lock screen
      // itself exists (Phase 7). Saying "Soon" while silently holding the user's
      // answer would read as the app having forgotten it.
      subtitle: input.appLockChosen
        ? 'You asked for it during setup — the unlock screen arrives with the security update'
        : 'Require Face ID, Touch ID or your passcode to open Keeply',
      state: { kind: 'soon' },
    },
  ]);

  pushSection(rows, 'Backup', [
    {
      key: 'export',
      icon: 'download',
      title: 'Export an encrypted backup',
      subtitle: 'A file you keep yourself — there is no cloud account',
      state: { kind: 'none' },
      onPress: input.openExport,
    },
    {
      key: 'restore',
      icon: 'upload',
      title: 'Restore from a backup',
      subtitle: 'Replaces everything currently stored on this device',
      state: { kind: 'none' },
      onPress: input.openRestore,
    },
  ]);

  if (isDev) {
    pushSection(
      rows,
      'Developer',
      [
        {
          key: 'design-system',
          icon: 'sparkle',
          title: 'Design system',
          subtitle: 'Every primitive, token and status, in both themes',
          state: { kind: 'none' },
          onPress: input.openDesignSystem,
        },
        {
          key: 'sample-data',
          icon: 'chartBar',
          title: 'Sample dashboard data',
          subtitle: 'Cycle Home through off → busy → quiet',
          state: { kind: 'text', label: SAMPLE_LABELS[input.sampleDashboard] },
          onPress: input.cycleSampleDashboard,
          hint: 'Cycles the Home dashboard fixture.',
          cycles: true,
        },
        {
          key: 'rerun-onboarding',
          icon: 'sparkle',
          title: 'Run first-run setup again',
          // Forgets the wizard's progress only. The records the user created
          // during it are theirs and stay — this re-runs setup, it does not
          // undo it.
          subtitle: 'Clears the wizard’s progress and reopens it. Your records stay.',
          state: { kind: 'none' },
          onPress: input.restartOnboarding,
        },
      ],
      'Development builds only — this section does not exist in a release bundle.',
    );
  }

  pushSection(rows, 'About', [
    {
      key: 'offline',
      icon: 'lock',
      title: 'Offline, and stays on this device',
      subtitle: 'No account, no server, no uploads — it all works in airplane mode',
      state: { kind: 'none' },
    },
    {
      key: 'version',
      icon: 'info',
      title: 'Version',
      state: { kind: 'text', label: input.appVersion },
    },
  ]);

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

/** `expoConfig` is null only in contexts this app cannot run in; be tidy anyway. */
const APP_VERSION = Constants.expoConfig?.version ?? '—';

export default function MoreScreen() {
  const router = useRouter();
  const contentStyle = useTabScreenContentStyle();

  const preference = useThemePreference();
  const reminders = useReminderDefaults();
  const appLockChosen = useAppLockEnabled();
  const sampleDashboard = useUiStore((state) => state.sampleDashboard);
  const cycleSampleDashboard = useUiStore((state) => state.cycleSampleDashboard);
  const setThemePreference = useUiStore((state) => state.setThemePreference);

  // `ui-store` holds the *stated* preference and `useThemePreferenceSync()`,
  // mounted in the root layout, mirrors it into the theme runtime. So the write
  // goes to the store and nowhere else — one source of truth, no second setter
  // for the two to disagree about.
  const cycleTheme = useCallback(() => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length];
    setThemePreference(next);
  }, [preference, setThemePreference]);

  const openReminders = useCallback(() => router.push('/reminders'), [router]);
  const openReminderKind = useCallback(
    (kind: ReminderKindSlug) =>
      router.push({ pathname: '/reminders/[kind]', params: { kind } }),
    [router],
  );
  const openExport = useCallback(() => router.push('/backup/export'), [router]);
  const openRestore = useCallback(() => router.push('/backup/restore'), [router]);
  const openDesignSystem = useCallback(() => router.push('/ui-preview'), [router]);

  /**
   * Development only: forget the wizard and open it again.
   *
   * A first-run flow is otherwise testable exactly once per install, which is
   * how first-run flows end up shipping broken. `resetOnboarding()` clears the
   * `onboarding.` namespace and nothing else — every other preference, and
   * every record, survives.
   */
  const restartOnboarding = useCallback(() => {
    void (async () => {
      try {
        const { resetOnboarding } = await import('@/features/onboarding');
        await resetOnboarding();
        router.replace('/onboarding');
      } catch (error) {
        log.error('onboarding: could not restart the wizard', error);
      }
    })();
  }, [router]);

  const rows = useMemo(
    () =>
      buildMoreRows({
        openReminders,
        openReminderKind,
        openExport,
        openRestore,
        themePreference: preference,
        cycleTheme,
        reminders,
        sampleDashboard,
        cycleSampleDashboard,
        openDesignSystem,
        restartOnboarding,
        appLockChosen,
        appVersion: APP_VERSION,
      }),
    [
      preference,
      cycleTheme,
      reminders,
      sampleDashboard,
      cycleSampleDashboard,
      openDesignSystem,
      restartOnboarding,
      appLockChosen,
    ],
  );

  return (
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <List<MoreRow>
        data={rows}
        renderItem={renderMoreRow}
        keyExtractor={moreRowKey}
        separator="none"
        header={<ScreenHeader title="More" subtitle="Settings, security and your backups." />}
        contentContainerStyle={contentStyle}
        accessibilityLabel="More settings"
        testID="more-screen"
      />
    </Screen>
  );
}

const moreRowKey = (row: MoreRow): string => row.key;
const renderMoreRow = ({ item }: ListRenderItemInfo<MoreRow>) => <MoreRowView row={item} />;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

const MoreRowView = memo(function MoreRowView({ row }: { row: MoreRow }) {
  switch (row.kind) {
    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'note':
      return <ListNote>{row.text}</ListNote>;

    case 'setting': {
      const { item } = row;
      const { value, valueLabel } = renderState(item.state);
      return (
        <ListBlock gap={row.leadsSection === true ? 'section' : 'none'}>
          <ListGroup position={row.group}>
            <Row
              icon={item.icon}
              title={item.title}
              subtitle={item.subtitle}
              value={value}
              valueLabel={valueLabel}
              onPress={item.onPress}
              chevron={item.cycles === true ? false : undefined}
              accessibilityHint={item.hint}
              testID={`more-row-${item.key}`}
            />
          </ListGroup>
        </ListBlock>
      );
    }
  }
});

/**
 * A row's value slot, plus the string VoiceOver should read for it.
 *
 * `<Badge/>` is an element, so `Row` cannot read a label out of it — hence the
 * paired `valueLabel`. Status is never carried by colour alone: every chip
 * spells out its own state.
 */
function renderState(state: SettingState): {
  value: ReactNode;
  valueLabel: string | undefined;
} {
  switch (state.kind) {
    case 'text':
      return { value: state.label, valueLabel: undefined };
    case 'on':
      return {
        value: <Badge tone="success" label={state.label} icon="check" />,
        valueLabel: state.label,
      };
    case 'soon':
      return { value: <Badge tone="neutral" label="Soon" />, valueLabel: 'Coming soon' };
    case 'none':
      return { value: undefined, valueLabel: undefined };
  }
}
