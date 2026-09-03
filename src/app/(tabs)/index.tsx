import { useRouter } from 'expo-router';
import { createContext, memo, useCallback, useContext, useMemo } from 'react';
import type { ReactElement } from 'react';
import type { ListRenderItemInfo } from 'react-native';

import {
  Amount,
  EmptyState,
  IconButton,
  List,
  ListBlock,
  ListGroup,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  StatusPill,
  amountLabel,
  groupPosition,
  useTabScreenContentStyle,
  type GroupPosition,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  attentionCount,
  hasNoRecords,
  isAllClear,
  useDashboardData,
  type DashboardData,
  type ExpiringDocumentItem,
  type OverdueItem,
  type RecentActivityItem,
  type SpendingBucket,
  type UpcomingPaymentItem,
  type UpcomingSubscriptionItem,
} from '@/lib/dashboard';
import { AllowanceSummary } from '@/features/allowance/ui';
import { formatMonthYear } from '@/theme';

/**
 * Home dashboard.
 *
 * The whole screen answers one question (§24):
 *
 *     "Is there anything I need to deal with today?"
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
 * This screen used to render six sections unconditionally, each with a
 * full-size empty state. An empty dashboard — which is every dashboard on day
 * one — was roughly 1,900pt of "nothing here", about three screens of scrolling
 * to learn that nothing needs you. §24 explicitly warns against overwhelming
 * the user, and a wall of placeholders is the most overwhelming way possible to
 * say "no".
 *
 * So emptiness now collapses rather than expands:
 *
 *   - nothing recorded at all  → ONE compact card and a way in. Nothing else.
 *   - records, nothing urgent  → the same card, one line, then whatever
 *                                context the user does have.
 *   - a section with no rows   → the section is not rendered. Its absence is
 *                                the answer; "This month" is the one exception
 *                                and collapses to a single quiet line, because
 *                                a missing spending block reads as a bug.
 *
 * The populated order is unchanged and still §24's:
 *   1. Overdue          — already late; the only genuinely urgent thing
 *   2. Upcoming payments— money leaving soon
 *   3. Expiring documents
 *   4. Upcoming subscriptions
 *   5. Monthly spending — context, not a task
 *   6. Recent activity  — reassurance that things got saved
 *
 * ── WHY ONE LIST ───────────────────────────────────────────────────────────
 * The screen is a single virtualized `<List/>` over flattened rows, not a
 * `ScrollView` containing six lists. Nesting same-axis virtualized lists
 * disables virtualization completely, so the sections are flattened here and
 * grouped visually with `<ListGroup/>`. Phase 2 can add a thousand receipts to
 * "recent activity" without changing anything on this screen.
 *
 * ── PHASE 2 ───────────────────────────────────────────────────────────────
 * `useDashboardData()` now reads the database. It returns a SNAPSHOT rather
 * than data, because a screen that renders four states has to be told which one
 * it is in: `loading` is the first read of a launch and draws the skeleton,
 * `error` draws a retry, and the two flavours of empty are still decided by
 * `hasNoRecords()` / `isAllClear()`. Every refresh after a write keeps the old
 * rows on screen until the new ones land, so the dashboard never blinks — a
 * local read is a millisecond and there is nothing to wait for (§25).
 *
 * The first-run call to action opens the §28 add sheet. It used to route to the
 * Money tab, which had nothing to add with: the one button a brand-new user
 * presses led to a dead end, which is the exact moment `plan/onboarding.md`
 * (F1) says this product loses people.
 */

/** Rows kept per section until the queries carry their own `LIMIT` (B6). */
const MAX_ROWS_PER_SECTION = 5;

/* -------------------------------------------------------------------------- */
/* Row model                                                                   */
/* -------------------------------------------------------------------------- */

type HomeRow =
  | { kind: 'allClear'; key: string; firstRun: boolean }
  | { kind: 'sectionHeader'; key: string; title: string }
  | { kind: 'quiet'; key: string; text: string }
  | { kind: 'allowance'; key: string }
  | { kind: 'overdue'; key: string; group: GroupPosition; item: OverdueItem }
  | { kind: 'payment'; key: string; group: GroupPosition; item: UpcomingPaymentItem }
  | { kind: 'expiry'; key: string; group: GroupPosition; item: ExpiringDocumentItem }
  | { kind: 'renewal'; key: string; group: GroupPosition; item: UpcomingSubscriptionItem }
  | { kind: 'bucket'; key: string; group: GroupPosition; bucket: SpendingBucket }
  | { kind: 'total'; key: string; group: GroupPosition; totalMinor: MinorUnits }
  | { kind: 'activity'; key: string; group: GroupPosition; item: RecentActivityItem };

/**
 * Flatten `DashboardData` into the rows the list renders.
 *
 * All of the "should this section exist at all?" logic lives here, in one pure
 * function, rather than as six `? :` branches in JSX — which is what let six
 * full-height placeholders creep in unnoticed.
 */
function buildHomeRows(data: DashboardData): readonly HomeRow[] {
  const rows: HomeRow[] = [];

  if (hasNoRecords(data)) {
    return [
      { kind: 'allClear', key: 'all-clear', firstRun: true },
      // Where things live, in one line — the only orientation a first-run
      // screen needs, and cheaper than five placeholder sections that each
      // explain themselves.
      {
        kind: 'quiet',
        key: 'first-run-hint',
        text: 'Bills, subscriptions and expenses live in Money. Maintenance keeps what your car, appliances and gadgets cost to look after; Documents keeps licences and registrations.',
      },
    ];
  }

  if (isAllClear(data)) {
    rows.push({ kind: 'allClear', key: 'all-clear', firstRun: false });
  }

  const section = <T,>(
    title: string,
    items: readonly T[],
    toRow: (item: T, group: GroupPosition) => HomeRow,
  ): void => {
    if (items.length === 0) return; // A section with nothing in it is not a section.
    const shown = items.slice(0, MAX_ROWS_PER_SECTION);
    rows.push({ kind: 'sectionHeader', key: `h:${title}`, title });
    shown.forEach((item, index) => rows.push(toRow(item, groupPosition(index, shown.length))));
    const hidden = items.length - shown.length;
    if (hidden > 0) {
      rows.push({
        kind: 'quiet',
        key: `more:${title}`,
        text: `+${hidden} more ${hidden === 1 ? 'item' : 'items'}`,
      });
    }
  };

  section('Overdue', data.overdue, (item, group) => ({
    kind: 'overdue',
    key: `overdue:${item.id}`,
    group,
    item,
  }));

  section('Upcoming payments', data.upcomingPayments, (item, group) => ({
    kind: 'payment',
    key: `payment:${item.id}`,
    group,
    item,
  }));

  section('Expiring documents', data.expiringDocuments, (item, group) => ({
    kind: 'expiry',
    key: `expiry:${item.id}`,
    group,
    item,
  }));

  section('Upcoming subscriptions', data.upcomingSubscriptions, (item, group) => ({
    kind: 'renewal',
    key: `renewal:${item.id}`,
    group,
    item,
  }));

  // "This month" is the one section that stays when it is empty: a spending
  // block that vanishes reads as a broken total, not as a quiet month. It
  // collapses to a single line instead.
  const spending = data.monthlySpending;
  const monthLabel = formatMonthYear(`${spending.month}-01`);

  // The allowance sits ABOVE "This month" and below everything urgent (§24).
  // It is context, not a task: an overdue bill still outranks it. Unlike the
  // rest of this function the row carries no payload — the card reads its own
  // data, because `HomeRowView` is a switch and a hook cannot live in a branch.
  //
  // It gets a heading like every other block. Without one it was the only
  // unlabelled card on the screen, sitting directly under the subscriptions
  // group — which made it read as part of that group rather than as its own
  // answer to its own question.
  rows.push({ kind: 'sectionHeader', key: 'h:allowance', title: 'Allowance' });
  rows.push({ kind: 'allowance', key: 'allowance' });

  rows.push({ kind: 'sectionHeader', key: 'h:month', title: 'This month' });
  if (spending.totalMinor === 0) {
    rows.push({
      kind: 'quiet',
      key: 'month:empty',
      text: `Nothing recorded in ${monthLabel} yet.`,
    });
  } else {
    const buckets = spending.buckets;
    buckets.forEach((bucket, index) =>
      rows.push({
        kind: 'bucket',
        key: `bucket:${bucket.key}`,
        // The total is the last row of this card, so no bucket is ever `last`.
        group: index === 0 ? 'first' : 'middle',
        bucket,
      }),
    );
    rows.push({
      kind: 'total',
      key: 'bucket:total',
      group: 'last',
      totalMinor: spending.totalMinor,
    });
  }

  section('Recent activity', data.recentActivity, (item, group) => ({
    kind: 'activity',
    key: `activity:${item.id}`,
    group,
    item,
  }));

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function HomeScreen() {
  const snapshot = useDashboardData();
  const contentStyle = useTabScreenContentStyle();
  const router = useRouter();

  const data = snapshot.data;
  const rows = useMemo(() => buildHomeRows(data), [data]);
  const attention = attentionCount(data);

  const openAdd = useCallback(() => router.push('/add'), [router]);
  const openSubscription = useCallback(
    (id: string) => router.push({ pathname: '/subscriptions/[id]', params: { id } }),
    [router],
  );
  const actions = useMemo<HomeActions>(
    () => ({ openAdd, openSubscription }),
    [openAdd, openSubscription],
  );

  return (
    // `edges={['top']}` only: the native tab bar owns the bottom inset.
    // `padded={false}`: the list owns its gutter, so the scroll indicator sits
    // at the screen edge rather than inside the margin.
    <Screen edges={['top']} padded={false} keyboardAvoiding={false}>
      <HomeActionsContext value={actions}>
        <List<HomeRow>
          data={rows}
          renderItem={renderHomeRow}
          keyExtractor={homeRowKey}
          // `<ListGroup/>` draws its own hairlines between grouped rows; a list
          // separator here would also draw between a card and the next heading.
          separator="none"
          loading={snapshot.status === 'loading'}
          skeletonLeading={false}
          error={
            snapshot.status === 'error' ? (
              <EmptyState
                icon="errorCircle"
                title="Keeply could not read your records"
                description="Everything is stored on this device, so this is not a connection problem. Trying again usually clears it."
                actionLabel="Try again"
                actionIcon="repeat"
                onAction={snapshot.reload}
                fill={false}
              />
            ) : undefined
          }
          header={
            <ScreenHeader
              title="Home"
              subtitle={
                attention === 0
                  ? 'Nothing needs you today.'
                  : `${attention} ${attention === 1 ? 'thing needs' : 'things need'} your attention.`
              }
              right={
                <IconButton
                  name="plus"
                  accessibilityLabel="Add a record"
                  accessibilityHint="Opens the list of things you can add"
                  onPress={openAdd}
                  testID="home-add"
                />
              }
            />
          }
          contentContainerStyle={contentStyle}
          accessibilityLabel="Home dashboard"
          testID="home-dashboard"
        />
      </HomeActionsContext>
    </Screen>
  );
}

/**
 * How a memoised row reaches the screen's actions.
 *
 * `renderHomeRow` lives at module scope so a new function identity per render
 * cannot defeat row memoization — which means it cannot close over the screen's
 * callbacks. A context is how a stable renderer reaches unstable state without
 * either side giving up what it is for.
 */
interface HomeActions {
  openAdd: () => void;
  openSubscription: (id: string) => void;
}

const HomeActionsContext = createContext<HomeActions>({
  openAdd: () => undefined,
  openSubscription: () => undefined,
});

/* Module scope: a new identity per render would defeat row memoization. */
const homeRowKey = (row: HomeRow): string => row.key;
const renderHomeRow = ({ item }: ListRenderItemInfo<HomeRow>) => <HomeRowView row={item} />;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One dashboard row.
 *
 * `memo`-ised and given a single prop whose identity is stable for as long as
 * the dashboard data is: scrolling a populated dashboard re-renders nothing.
 */
const HomeRowView = memo(function HomeRowView({ row }: { row: HomeRow }) {
  switch (row.kind) {
    case 'allClear':
      return (
        <ListBlock>
          <AllClear firstRun={row.firstRun} />
        </ListBlock>
      );

    case 'allowance':
      // `gap="none"`: the section header above owns the gap below itself
      // (`layout.heading`), and `ListBlock`'s default `section` gap would stack
      // on top of it — which is precisely the 40pt of dead space that once sat
      // under every header on this screen.
      return (
        <ListBlock gap="none">
          <AllowanceSummary testID="home-allowance" />
        </ListBlock>
      );

    case 'sectionHeader':
      return <ListSectionHeader title={row.title} />;

    case 'quiet':
      return <ListNote>{row.text}</ListNote>;

    case 'overdue': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            icon="warning"
            iconColor="danger"
            title={item.title}
            subtitle={overdueLabel(item.daysOverdue)}
            value={
              item.amountMinor === null ? (
                <StatusPill status={item.status} showIcon />
              ) : (
                <Amount minor={item.amountMinor} />
              )
            }
            valueLabel={
              item.amountMinor === null ? undefined : amountLabel(item.amountMinor)
            }
          />
        </ListGroup>
      );
    }

    case 'payment': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            icon="banknote"
            title={item.title}
            subtitle={dueLabel(item.dueInDays)}
            // A VARIABLE bill has no expected amount until its invoice arrives
            // (§7). Showing ₱0.00 there would be a number the user might act
            // on, so the status carries the row instead — the same choice the
            // overdue rows above make.
            value={
              item.amountMinor === null ? (
                <StatusPill status={item.status} showIcon />
              ) : (
                <Amount minor={item.amountMinor} />
              )
            }
            valueLabel={
              item.amountMinor === null ? undefined : amountLabel(item.amountMinor)
            }
          />
        </ListGroup>
      );
    }

    case 'expiry': {
      const { item } = row;
      const label = expiryLabel(item.expiresInDays);
      return (
        <ListGroup position={row.group}>
          <Row
            icon="doc"
            title={item.title}
            value={<StatusPill status={item.status} label={label} showIcon />}
            valueLabel={label}
          />
        </ListGroup>
      );
    }

    case 'renewal': {
      const { item } = row;
      return (
        <ListGroup position={row.group}>
          <SubscriptionLink id={item.id}>
            {(open) => (
              <Row
                icon="repeat"
                title={item.title}
                subtitle={dueLabel(item.renewsInDays)}
                value={<Amount minor={item.amountMinor} />}
                valueLabel={amountLabel(item.amountMinor)}
                onPress={open}
                accessibilityHint="Opens this subscription"
              />
            )}
          </SubscriptionLink>
        </ListGroup>
      );
    }

    case 'bucket': {
      const { bucket } = row;
      return (
        <ListGroup position={row.group}>
          <Row
            title={bucket.label}
            value={<Amount minor={bucket.amountMinor} size="sm" color="textSecondary" />}
            valueLabel={amountLabel(bucket.amountMinor)}
          />
        </ListGroup>
      );
    }

    case 'total':
      return (
        <ListGroup position={row.group}>
          <Row
            title="Total"
            // The one number the "This month" card exists to give: rendered a
            // full step larger than its own breakdown and larger than every
            // other amount on the screen, so which figure matters is not a
            // question the reader has to answer.
            value={<Amount minor={row.totalMinor} size="lg" />}
            valueLabel={amountLabel(row.totalMinor)}
          />
        </ListGroup>
      );

    case 'activity': {
      const { item } = row;
      const body = (open?: () => void) => (
        <Row
          icon={ACTIVITY_ICON[item.source]}
          title={item.title}
          subtitle={activityLabel(item.occurredAt)}
          value={
            item.amountMinor === null ? undefined : (
              <Amount minor={item.amountMinor} size="sm" />
            )
          }
          valueLabel={item.amountMinor === null ? undefined : amountLabel(item.amountMinor)}
          onPress={open}
        />
      );
      return (
        <ListGroup position={row.group}>
          {item.source === 'subscription' ? (
            <SubscriptionLink id={item.id}>{body}</SubscriptionLink>
          ) : (
            body()
          )}
        </ListGroup>
      );
    }
  }
});

/**
 * Hands a row the "open this subscription" callback out of context.
 *
 * A render prop rather than a wrapper element, because `<Row/>` owns its own
 * press handling and accessibility label — wrapping it in a `Pressable` would
 * nest two buttons and announce the row twice.
 */
function SubscriptionLink({
  id,
  children,
}: {
  id: string;
  children: (open: () => void) => ReactElement;
}): ReactElement {
  const { openSubscription } = useContext(HomeActionsContext);
  return children(() => openSubscription(id));
}

const ACTIVITY_ICON = {
  subscription: 'repeat',
  bill: 'banknote',
  receipt: 'receipt',
  'vehicle-expense': 'fuel',
  document: 'doc',
} as const;

/**
 * The compact answer to "is there anything I need to deal with today?".
 *
 * One `EmptyState variant="compact"` card, ~110pt, at the top of the screen.
 * It replaces what used to be six stacked full-height empty states. On first
 * run it also carries the only action a brand new user can take.
 */
const AllClear = memo(function AllClear({ firstRun }: { firstRun: boolean }) {
  const { openAdd } = useContext(HomeActionsContext);

  return (
    <EmptyState
      variant="compact"
      icon="checkCircle"
      title="You’re all caught up"
      description={
        firstRun
          ? 'Nothing is tracked yet. Add a bill, subscription, expense or document and Keeply watches the dates for you — on this device, offline.'
          : 'Nothing is overdue, nothing is due soon and no document is close to expiring.'
      }
      actionLabel={firstRun ? 'Add your first record' : undefined}
      onAction={firstRun ? openAdd : undefined}
      actionHint={firstRun ? 'Opens the list of things you can add.' : undefined}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Local label helpers                                                         */
/* -------------------------------------------------------------------------- */
/* Deliberately plain: no relative-time library, no locale negotiation, no      */
/* network. Richer formatting arrives with the real data in Phase 2.            */

function overdueLabel(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'Due today';
  if (daysOverdue === 1) return '1 day late';
  return `${daysOverdue} days late`;
}

function dueLabel(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function expiryLabel(days: number): string {
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `${days} days left`;
}

/**
 * `occurredAt` is epoch millis (it mirrors `created_at`), so `new Date(number)`
 * is correct here. `new Date(<string>)` is the banned form, and this type is a
 * number precisely so nobody is invited to write it.
 */
function activityLabel(occurredAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - occurredAt) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}
