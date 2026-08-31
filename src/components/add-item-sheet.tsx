import { useRouter } from 'expo-router';
import { Fragment, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { Divider, Row, Sheet, type IconName } from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

/**
 * §28's `+ Add` — the one entry point into every kind of record.
 *
 * ── THE DEAD END THIS REPLACES ─────────────────────────────────────────────
 * Home's "Add your first record" used to route to the Money tab, which held
 * three explanatory rows and no way to add anything. A brand-new user pressed
 * the only button on the screen and arrived somewhere with nothing to do — the
 * exact moment `plan/onboarding.md` (F1) identifies as where this product loses
 * people. One tap now reaches a form.
 *
 * ── WHY THE UNBUILT KINDS ARE SHOWN, DISABLED ──────────────────────────────
 * Bills, receipts, vehicle expenses and documents are Phases 3–6. Listing them
 * greyed out costs one line each and tells the user what Keeply is FOR — the
 * shape of the product is legible from the first sheet they open, and the
 * absence of a "Bill" row would otherwise read as "this app does not do bills".
 *
 * They are `disabled`, not hidden and not tappable-with-an-alert: a control
 * that looks live and then apologises is worse than one that never claimed to
 * work. They keep their `onPress` so `<Row/>` renders a real button carrying
 * `accessibilityState.disabled` — a screen reader then says "dimmed" rather
 * than reading out a line that looks tappable and is not.
 *
 * ── FIVE FIXED ROWS, SO NOT A `<List/>` ────────────────────────────────────
 * `<List/>` exists because an unbounded array must be virtualized. This array
 * is five entries decided at compile time, and — more to the point — a
 * `FlatList` cannot be placed directly in a `<Sheet/>`: the sheet sizes to its
 * content and a list styled `flex: 1` resolves to a flex-basis of zero, so it
 * lays out at no height at all. Rows in a `<View/>` is the design system's own
 * reference usage for exactly this (`src/components/ui/preview.tsx`).
 */

interface AddOption {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: IconName;
  /** `null` while the module does not exist yet. */
  readonly route: '/subscriptions/new' | null;
}

const OPTIONS: readonly AddOption[] = [
  {
    key: 'subscription',
    title: 'Subscription',
    subtitle: 'Something that renews — Netflix, iCloud, a gym',
    icon: 'repeat',
    route: '/subscriptions/new',
  },
  {
    key: 'bill',
    title: 'Bill',
    subtitle: 'Coming next — electricity, water, internet, rent',
    icon: 'banknote',
    route: null,
  },
  {
    key: 'receipt',
    title: 'Receipt',
    subtitle: 'Coming later — photograph and keep a purchase',
    icon: 'receipt',
    route: null,
  },
  {
    key: 'vehicle-expense',
    title: 'Vehicle expense',
    subtitle: 'Coming later — fuel, repairs, maintenance',
    icon: 'car',
    route: null,
  },
  {
    key: 'document',
    title: 'Document',
    subtitle: 'Coming later — licences, registrations, IDs',
    icon: 'doc',
    route: null,
  },
];

export interface AddItemSheetProps {
  visible: boolean;
  onClose: () => void;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    rows: { marginBottom: t.space.sm },
  });

/**
 * The sheet itself. Mounted only by the `/add` route — see `src/app/add.tsx`
 * for why the add flow is addressable rather than a boolean in five screens.
 */
export function AddItemSheet({ visible, onClose }: AddItemSheetProps) {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const choose = useCallback(
    (option: AddOption) => {
      if (option.route === null) return;
      // `replace`, not close-then-push: the sheet IS a route, and Back out of
      // the form should return to where Add was pressed rather than to the
      // sheet that has already done its job.
      router.replace(option.route);
    },
    [router],
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Add"
      subtitle="Everything you add stays on this device."
      testID="add-item-sheet">
      <View style={styles.rows} accessibilityLabel="What to add">
        {OPTIONS.map((option, index) => {
          const available = option.route !== null;
          return (
            <Fragment key={option.key}>
              {index === 0 ? null : <Divider />}
              <Row
                icon={option.icon}
                title={option.title}
                subtitle={option.subtitle}
                disabled={!available}
                chevron={available}
                onPress={() => choose(option)}
                accessibilityHint={
                  available ? 'Opens a new subscription form' : undefined
                }
                testID={`add-item-${option.key}`}
              />
            </Fragment>
          );
        })}
      </View>
    </Sheet>
  );
}
