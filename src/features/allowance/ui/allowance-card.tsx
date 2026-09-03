/**
 * "₱10,409 left this month" — one component, three placements.
 *
 * Home's band, the Money tab's card and the allowance screen's header all
 * render THIS, from one `AllowanceStatus`. They must not each assemble their
 * own version: two cards showing different numbers for the same question is
 * worse than one card showing the wrong number, because there is no way for the
 * user to tell which to believe.
 *
 * ── THE STATES ARE THE DESIGN ──────────────────────────────────────────────
 * Six, all of them reachable and all of them drawn on purpose:
 *
 *   loading         a skeleton, not an empty card that pops
 *   no allowance    an invitation, with the spend still shown — a user logging
 *                   expenses before setting a budget is not an error
 *   normal          amount left, meter, per-day pace
 *   overspent       "₱420 over", the meter full, in `danger`
 *   mixed currency  no subtraction at all, and it says why
 *   error           what failed and a way to retry
 *
 * ── OVERSPEND IS CARRIED BY WORDS, NOT BY COLOUR ───────────────────────────
 * The palette is monochrome on purpose: `danger` is `#FFFFFF` on dark and
 * `#000000` on light — maximum contrast, not red. It outranks `text` by about
 * six values, which is invisible as a signal (the same trap `SegmentedField`'s
 * header describes, where a chip one shade above its track could not be seen).
 *
 * So the overspent state is announced the only way that survives this palette,
 * greyscale and colour blindness alike: the meter reads full, and the words say
 * "₱1,030.50" over "over your allowance". `danger` is still applied to the
 * figure and the fill — as emphasis, because it IS the highest-contrast ink
 * available — but nothing depends on anyone noticing it.
 *
 * ── NO PROGRESS BAR PAST FULL ──────────────────────────────────────────────
 * `spentFraction` clamps at 1. A bar that overflows its track says "very over"
 * with no scale, and at 3x it just looks broken. The overspend is stated in
 * words instead, which is legible at any magnitude.
 */
import { StyleSheet, View } from 'react-native';

import {
  Amount,
  Button,
  Card,
  Skeleton,
  Text,
  type IconName,
} from '@/components/ui';
import { minorUnits } from '@/db/money';
import {
  remainingPerDay,
  spentFraction,
  type AllowanceStatus,
} from '@/features/allowance';
import { useThemedStyles, type Theme } from '@/theme';

export interface AllowanceCardProps {
  status: AllowanceStatus | null;
  loading: boolean;
  error?: unknown;
  /** Opens the allowance screen. Omit to render the card as a flat panel. */
  onPress?: () => void;
  /** Retry a failed read. */
  onRetry?: () => void;
  /** Set or change the allowance — shown only when there is none. */
  onSetAllowance?: () => void;
  testID?: string;
}

/** "September", "This week", "Today" — what the period is called out loud. */
export function periodLabel(status: AllowanceStatus): string {
  switch (status.period.period) {
    case 'daily':
      return 'Today';
    case 'weekly':
      return 'This week';
    case 'monthly':
      return monthName(status.period.startIso);
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The month a `YYYY-MM-DD` names.
 *
 * Sliced from the string, never `new Date(iso).toLocaleString()` — that parses
 * as UTC midnight and renders "August" for the 1st of September in Manila.
 */
function monthName(iso: string): string {
  const month = Number(iso.slice(5, 7));
  return MONTHS[month - 1] ?? iso;
}

/** "12 days left", "last day" — the period's remaining span in words. */
function remainingLabel(status: AllowanceStatus): string {
  const { remainingDays, period } = status.period;
  if (period === 'daily') return 'today';
  if (remainingDays <= 1) return 'last day';
  return `${remainingDays} days left`;
}

export function AllowanceCard({
  status,
  loading,
  error,
  onPress,
  onRetry,
  onSetAllowance,
  testID,
}: AllowanceCardProps) {
  const styles = useThemedStyles(makeStyles);

  if (loading && status === null) {
    return (
      <Card testID={testID}>
        <Skeleton width="40%" height={16} />
        <View style={styles.skeletonGap} />
        <Skeleton width="65%" height={34} />
        <View style={styles.skeletonGap} />
        <Skeleton width="100%" height={8} />
      </Card>
    );
  }

  if (status === null) {
    return (
      <Card testID={testID}>
        <Text variant="body">That did not load.</Text>
        <Text variant="caption" color="textSecondary" style={styles.subline}>
          Your data is fine — this is only the summary.
        </Text>
        {onRetry !== undefined ? (
          <Button title="Try again" variant="secondary" onPress={onRetry} style={styles.action} />
        ) : null}
      </Card>
    );
  }

  const over = status.remainingMinor !== null && status.remainingMinor < 0;
  const fraction = spentFraction(status);

  return (
    <Card onPress={onPress} testID={testID} accessibilityLabel={accessibilityLabel(status)}>
      <View style={styles.header}>
        <Text variant="label" color="textSecondary">
          {periodLabel(status)}
        </Text>
        <Text variant="caption" color="textTertiary">
          {remainingLabel(status)}
        </Text>
      </View>

      {status.allowanceMinor === null ? (
        <NoAllowance status={status} onSetAllowance={onSetAllowance} />
      ) : status.mixedCurrencies ? (
        <MixedCurrencies status={status} />
      ) : (
        <Headline status={status} over={over} />
      )}

      {fraction === null ? null : (
        <View
          style={styles.track}
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        >
          <View
            style={[
              styles.fill,
              // `flex` rather than a percentage width so the bar cannot round
              // to a sliver that disappears; `flexBasis: 'auto'` would not
              // override `flex: 1` in Yoga, which is why both sides are set.
              { flex: fraction },
              over ? styles.fillOver : null,
            ]}
          />
          <View style={[styles.rest, { flex: Math.max(0, 1 - fraction) }]} />
        </View>
      )}

      {error !== undefined && error !== null ? (
        <Text variant="caption" color="textTertiary" style={styles.subline}>
          Showing the last figures that loaded.
        </Text>
      ) : null}

      {status.damagedCount > 0 ? (
        <Text variant="caption" color="textTertiary" style={styles.subline}>
          {status.damagedCount === 1
            ? '1 expense could not be added up.'
            : `${status.damagedCount} expenses could not be added up.`}
        </Text>
      ) : null}
    </Card>
  );
}

/** The headline pair: what is left, and what it is left out of. */
function Headline({ status, over }: { status: AllowanceStatus; over: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const remaining = status.remainingMinor;
  const allowance = status.allowanceMinor;
  if (remaining === null || allowance === null) return null;

  const perDay = remainingPerDay(status);

  return (
    <>
      <View style={styles.headline}>
        <Amount
          // An overspend is stated as a positive number with the word "over";
          // "-₱420" reads as a refund.
          minor={over ? minorUnits(-remaining) : remaining}
          currency={status.currency}
          size="lg"
          color={over ? 'danger' : undefined}
        />
        {/* The denominator, in both states. Saying "over" here as well as in
            the line below printed the word twice, one under the other, and
            dropped the one piece of context an overspend actually needs: what
            it went over. */}
        <Text variant="caption" color="textSecondary" style={styles.of}>
          of {formatOf(allowance, status.currency)}
        </Text>
      </View>
      <View style={styles.footerRow}>
        <Text variant="caption" color="textSecondary">
          {over ? 'over your allowance' : 'left to spend'}
        </Text>
        {perDay === null ? null : (
          // "from here", and not just "a day", because the allowance FORM shows
          // the flat pace (allowance ÷ whole period) a few rows below this. The
          // two numbers are different on every day but the first, and side by
          // side without labels they read as the card contradicting itself.
          <Text variant="caption" color="textSecondary">
            <Amount minor={perDay} currency={status.currency} size="sm" /> a day from here
          </Text>
        )}
      </View>
    </>
  );
}

/** The card before a budget exists. Spending is still real and still shown. */
function NoAllowance({
  status,
  onSetAllowance,
}: {
  status: AllowanceStatus;
  onSetAllowance?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <View style={styles.headline}>
        <Amount minor={status.spentMinor} currency={status.currency} size="lg" />
      </View>
      <Text variant="caption" color="textSecondary">
        {status.expenseCount === 1 ? 'spent, on 1 expense' : `spent, on ${status.expenseCount} expenses`}
      </Text>
      {onSetAllowance === undefined ? null : (
        <Button
          title="Set an allowance"
          variant="secondary"
          onPress={onSetAllowance}
          style={styles.action}
        />
      )}
    </>
  );
}

/** Two currencies in one period. The card refuses to subtract and says so. */
function MixedCurrencies({ status }: { status: AllowanceStatus }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <View style={styles.headline}>
        <Amount minor={status.spentMinor} currency={status.currency} size="lg" />
      </View>
      <Text variant="caption" color="textSecondary" style={styles.subline}>
        Spent in {status.currency}. There is spending in another currency this period, so
        what is left cannot be worked out.
      </Text>
    </>
  );
}

/** "of ₱15,000" — the denominator, as text rather than a second `<Amount/>`. */
function formatOf(allowanceMinor: number, currency: string): string {
  // `<Amount/>` cannot be nested inline here without the two sizes fighting;
  // this is the one place a money value becomes a string outside the formatter,
  // and it goes through the same one.
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(allowanceMinor / 100);
}

/** One sentence for a screen reader, instead of five disconnected fragments. */
function accessibilityLabel(status: AllowanceStatus): string {
  if (status.allowanceMinor === null) return `${periodLabel(status)}. No allowance set.`;
  if (status.mixedCurrencies) return `${periodLabel(status)}. Mixed currencies this period.`;
  const remaining = status.remainingMinor ?? 0;
  const amount = Math.abs(remaining) / 100;
  return remaining < 0
    ? `${periodLabel(status)}. ${amount} over your allowance.`
    : `${periodLabel(status)}. ${amount} left to spend, ${remainingLabel(status)}.`;
}

/** Named so a screen can render the same icon beside a row that links here. */
export const ALLOWANCE_ICON: IconName = 'wallet';

const METER_HEIGHT = 8;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    headline: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: t.space.sm,
      marginTop: t.space.sm,
    },
    of: { flexShrink: 1 },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginTop: t.space.xs,
    },
    // A block owns the gap ABOVE itself and never below — a bottom margin here
    // plus the next block's top padding is what produced 40pt of dead space
    // under every header.
    track: {
      flexDirection: 'row',
      height: METER_HEIGHT,
      borderRadius: METER_HEIGHT / 2,
      backgroundColor: t.color.surfaceAlt,
      overflow: 'hidden',
      marginTop: t.space.md,
    },
    fill: { backgroundColor: t.color.text },
    fillOver: { backgroundColor: t.color.danger },
    rest: { backgroundColor: 'transparent' },
    subline: { marginTop: t.space.xs },
    action: { marginTop: t.space.md },
    skeletonGap: { height: t.space.sm },
  });
