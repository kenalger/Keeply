import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, type ReactNode } from 'react';
import { Alert, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  Amount,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListNote,
  ListSectionHeader,
  Row,
  Screen,
  ScreenHeader,
  StatusPill,
  Text,
  amountLabel,
} from '@/components/ui';
import { isVehicle } from '@/features/maintenance';
import {
  ANALYTICS_GAP_MESSAGES,
  COST_TYPE_ICONS,
  COST_TYPE_LABELS,
  KIND_LABELS,
  RENEWAL_KIND_ICONS,
  RENEWAL_KIND_LABELS,
  VEHICLE_TYPE_LABELS,
  describeItem,
  formatEfficiency,
  formatKilometres,
  removeItem,
  useDueNext,
  useItemAnalytics,
  useItemCosts,
  useItemRenewals,
  useItemServices,
  useMaintenanceItem,
} from '@/features/maintenance/ui';
import { log } from '@/lib/log';
import {
  formatDate,
  formatRelativeDue,
  maskIdentifier,
  statusForDue,
  statusForExpiry,
  useThemedStyles,
  type Theme,
} from '@/theme';

/** How many child rows the detail screen shows before deferring to a list. */
const SERVICE_PREVIEW = 3;
const COST_PREVIEW = 5;

/**
 * One maintenance item, and everything that has happened to it (Phase 5c).
 *
 * ── WHAT CHANGED IN 5c ─────────────────────────────────────────────────────
 * Until now this screen said "Nothing recorded against it yet" and meant it
 * literally: there was no way to record anything. It now carries the four
 * things an item is actually for — what is due next, what it has cost, what
 * has been done to it, and what cover it is under — each with a way in.
 *
 * ── DUE NEXT IS FIRST, AND IS NOT ALWAYS THERE ─────────────────────────────
 * It is the reason anyone opens the screen, so it sits above the facts. It is
 * also absent rather than empty when nothing is scheduled: a card reading
 * "Nothing due" on a record with no history teaches nothing and takes the
 * position the user's eye goes to first.
 *
 * ── THE PREVIEWS ARE CAPPED, AND SAY SO ────────────────────────────────────
 * Three services and five costs, then a count and a way to the full list. A
 * detail screen that grows without bound with the record's age buries the
 * delete button under four years of fill-ups.
 *
 * ── THE IDENTIFIER IS MASKED ───────────────────────────────────────────────
 * `maskIdentifier` — the same treatment a document number gets (§10, §14). It
 * is shown here and on no other screen, because this is the one place someone
 * has deliberately opened the record to look at it.
 */
/**
 * An eyebrow and the block it labels.
 *
 * `<Section/>` would be the obvious choice and is the wrong one here: it still
 * renders its title as a 17pt `subheading` in the PRIMARY text colour, which
 * is what `4ecb864` took out of `FormSection` and `ListSectionHeader` and did
 * not take out of `Section` — reasonably, since `Section` is the unit the Home
 * DASHBOARD is built from, where a title really is a heading.
 *
 * This screen is not a dashboard. It is six labelled groups under one page
 * title, and at `subheading` weight they read as six equally loud slabs with
 * no focal point — the exact failure that commit describes. `ListSectionHeader`
 * is the same eyebrow the bills detail screen uses, and a signpost has to be
 * quieter than what it points at.
 */
function Block({
  title,
  children,
  style,
}: {
  title: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <ListSectionHeader title={title} />
      {children}
    </View>
  );
}

export default function MaintenanceItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const item = useMaintenanceItem(id);
  const due = useDueNext(id);
  const analytics = useItemAnalytics(id);
  const services = useItemServices(id, SERVICE_PREVIEW);
  const renewals = useItemRenewals(id);
  const costs = useItemCosts(id, COST_PREVIEW);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/maintenance');
  }, [router]);

  const confirmDelete = useCallback(() => {
    const record = item.value;
    if (record === null) return;

    Alert.alert(
      `Delete ${record.name}?`,
      'Its whole history — costs, services and renewals — goes with it. This cannot be undone.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeItem(record.id);
                router.replace('/(tabs)/maintenance');
              } catch (error) {
                log.error('maintenance: deleting an item failed', error);
                Alert.alert('Not deleted', 'Keeply could not remove this item. Try again.');
              }
            })();
          },
        },
      ],
    );
  }, [item.value, router]);

  if (item.status === 'loading' && item.value === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Item" onBack={leave} />
      </Screen>
    );
  }

  const record = item.value;
  if (record === null) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader title="Item" onBack={leave} />
        <EmptyState
          icon="errorCircle"
          title="This item is gone"
          description="It may have been deleted on this device."
          actionLabel="Back to Maintenance"
          onAction={() => router.replace('/(tabs)/maintenance')}
          fill={false}
        />
      </Screen>
    );
  }

  const spend = analytics.value;
  const dueNext = due.value;
  const vehicle = isVehicle(record.kind);
  const hasDue =
    dueNext !== null &&
    (dueNext.nextServiceDate !== null || dueNext.nextExpiryDate !== null);

  return (
    <Screen edges={['top']} scroll>
      <ScreenHeader
        title={record.name}
        subtitle={describeItem(record)}
        onBack={leave}
        backLabel="Back to Maintenance"
        right={
          <IconButton
            name="pencil"
            accessibilityLabel={`Edit ${record.name}`}
            onPress={() =>
              router.push({ pathname: '/maintenance/[id]/edit', params: { id: record.id } })
            }
            testID="maintenance-edit"
          />
        }
      />

      {/* Absent, not empty, when nothing is scheduled — see the header. */}
      {hasDue ? (
        <Block title="Due next" style={styles.block}>
          <Card>
            {dueNext.nextServiceDate === null ? null : (
              <Row
                icon="wrench"
                title="Service"
                subtitle={
                  dueNext.nextServiceMileage === null
                    ? formatDate(dueNext.nextServiceDate)
                    : `${formatDate(dueNext.nextServiceDate)} · or ${formatKilometres(dueNext.nextServiceMileage)}`
                }
                value={
                  <StatusPill
                    status={statusForDue(dueNext.nextServiceDate)}
                    label={formatRelativeDue(dueNext.nextServiceDate)}
                  />
                }
                valueLabel={formatRelativeDue(dueNext.nextServiceDate)}
                chevron={false}
              />
            )}
            {dueNext.nextExpiryDate === null || dueNext.nextExpiryKind === null ? null : (
              <Row
                icon={RENEWAL_KIND_ICONS[dueNext.nextExpiryKind]}
                title={RENEWAL_KIND_LABELS[dueNext.nextExpiryKind]}
                subtitle={`Expires ${formatDate(dueNext.nextExpiryDate)}`}
                value={<StatusPill status={statusForExpiry(dueNext.nextExpiryDate)} />}
                valueLabel={`Expires ${formatDate(dueNext.nextExpiryDate)}`}
                chevron={false}
              />
            )}
          </Card>
        </Block>
      ) : null}

      <Block title="What it is" style={styles.block}>
        <Card>
          <Row title="Kind" value={KIND_LABELS[record.kind]} chevron={false} />
          {record.vehicleType === null ? null : (
            // The LABEL, never the stored value — "car" is the enum, "Car" is
            // the word. `VEHICLE_TYPE_LABELS` is exhaustive, so a new type is a
            // compile error here rather than a lowercase slug on a screen.
            <Row
              title="Type"
              value={VEHICLE_TYPE_LABELS[record.vehicleType]}
              chevron={false}
            />
          )}
          {record.purchaseDate === null ? null : (
            <Row title="Bought" value={formatDate(record.purchaseDate)} chevron={false} />
          )}
          {record.identifier === null ? null : (
            <Row
              title={vehicle ? 'Plate' : 'Serial'}
              value={maskIdentifier(record.identifier)}
              chevron={false}
            />
          )}
          {record.currentMileage === null ? null : (
            <Row
              title="Odometer"
              value={formatKilometres(record.currentMileage)}
              chevron={false}
            />
          )}
          {record.isActive ? null : <Row title="Status" value="Retired" chevron={false} />}
        </Card>
      </Block>

      <Block title="What it has cost" style={styles.block}>
        <Card style={styles.spend}>
          {spend === null || spend.totals.costCount === 0 ? (
            <Text variant="caption" color="textSecondary">
              Nothing recorded against it yet.
            </Text>
          ) : (
            <>
              <Amount
                minor={spend.totals.totalMinor}
                currency={spend.totals.currency}
                size="lg"
              />
              <Text variant="caption" color="textSecondary">
                {`across ${spend.totals.costCount} ${spend.totals.costCount === 1 ? 'entry' : 'entries'}`}
              </Text>
              {spend.totals.damagedCount === 0 ? null : (
                <Text variant="caption" color="textTertiary">
                  {`${spend.totals.damagedCount} could not be added up.`}
                </Text>
              )}
            </>
          )}
        </Card>

        {/* Per year, and only once there is more than one — a single row
            headed "By year" restates the figure directly above it. */}
        {spend !== null && spend.byYear.length > 1 ? (
          <Card style={styles.stacked}>
            {spend.byYear.map((year) => (
              <Row
                key={year.year}
                title={year.year}
                subtitle={`${year.costCount} ${year.costCount === 1 ? 'entry' : 'entries'}`}
                value={<Amount minor={year.totalMinor} currency={year.currency} size="sm" />}
                valueLabel={amountLabel(year.totalMinor, { currency: year.currency })}
                chevron={false}
              />
            ))}
          </Card>
        ) : null}

        {/* Vehicle-only, and only on a vehicle — not a greyed panel telling an
            aircon's owner about kilometres per litre. */}
        {vehicle && spend !== null ? (
          <Card style={styles.stacked}>
            {spend.costPerKm.available ? (
              <Row
                icon="chartBar"
                title="Cost per kilometre"
                subtitle={`over ${formatKilometres(spend.costPerKm.value.distanceKm)}, ${formatDate(spend.costPerKm.value.fromISO)} – ${formatDate(spend.costPerKm.value.toISO)}`}
                value={
                  <Amount
                    minor={spend.costPerKm.value.costPerKmMinor}
                    currency={spend.costPerKm.value.currency}
                    size="sm"
                  />
                }
                valueLabel={amountLabel(spend.costPerKm.value.costPerKmMinor, {
                  currency: spend.costPerKm.value.currency,
                })}
                chevron={false}
              />
            ) : (
              <Row
                icon="chartBar"
                title="Cost per kilometre"
                // A NAMED gap, not a blank: every owner is in this state for
                // weeks, and the sentence says what to record next.
                subtitle={ANALYTICS_GAP_MESSAGES[spend.costPerKm.gap]}
                value={<Text variant="body" color="textSecondary">—</Text>}
                valueLabel="Not enough data yet"
                chevron={false}
              />
            )}
            {spend.fuel.available ? (
              <Row
                icon="fuel"
                title="Fuel"
                subtitle={`${formatKilometres(spend.fuel.value.distanceKm)} on ${spend.fuel.value.fillCount} ${spend.fuel.value.fillCount === 1 ? 'fill' : 'fills'}`}
                value={
                  <Text variant="body">
                    {formatEfficiency(spend.fuel.value.kilometresPerLitre)}
                  </Text>
                }
                valueLabel={formatEfficiency(spend.fuel.value.kilometresPerLitre)}
                chevron={false}
              />
            ) : (
              <Row
                icon="fuel"
                title="Fuel"
                subtitle={ANALYTICS_GAP_MESSAGES[spend.fuel.gap]}
                value={<Text variant="body" color="textSecondary">—</Text>}
                valueLabel="Not enough data yet"
                chevron={false}
              />
            )}
          </Card>
        ) : null}
      </Block>

      <Block title="Service history" style={styles.block}>
        {services.rows.length === 0 ? (
          <ListNote>Nothing done to it yet.</ListNote>
        ) : (
          <Card>
            {services.rows.map((service) => (
              <Row
                key={service.id}
                icon="wrench"
                title={service.serviceType}
                subtitle={
                  service.odometer === null
                    ? formatDate(service.serviceDate)
                    : `${formatDate(service.serviceDate)} · ${formatKilometres(service.odometer)}`
                }
                value={
                  service.costMinor === null ? undefined : (
                    <Amount
                      minor={service.costMinor}
                      currency={service.costCurrency ?? spend?.totals.currency ?? 'PHP'}
                      size="sm"
                    />
                  )
                }
                valueLabel={
                  service.costMinor === null
                    ? undefined
                    : amountLabel(service.costMinor, {
                        currency: service.costCurrency ?? undefined,
                      })
                }
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/[id]/service',
                    params: { id: record.id, serviceId: service.id },
                  })
                }
              />
            ))}
            {services.total <= SERVICE_PREVIEW ? null : (
              <Row
                title={`See all ${services.total}`}
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/[id]/services',
                    params: { id: record.id },
                  })
                }
                testID="maintenance-see-services"
              />
            )}
          </Card>
        )}
        {services.damagedCount === 0 ? null : (
          <ListNote>{`${services.damagedCount} could not be read.`}</ListNote>
        )}
        <Button
          title="Record a service"
          variant="secondary"
          icon="plus"
          onPress={() =>
            router.push({ pathname: '/maintenance/[id]/service', params: { id: record.id } })
          }
          style={styles.stacked}
          testID="maintenance-add-service"
        />
      </Block>

      <Block title="Cover" style={styles.block}>
        {renewals.rows.length === 0 ? (
          <ListNote>No insurance, registration or warranty on file.</ListNote>
        ) : (
          <Card>
            {renewals.rows.map((renewal) => (
              <Row
                key={renewal.id}
                icon={RENEWAL_KIND_ICONS[renewal.kind]}
                title={RENEWAL_KIND_LABELS[renewal.kind]}
                subtitle={
                  renewal.provider ??
                  (renewal.expiryDate === null
                    ? 'No expiry date'
                    : `Expires ${formatDate(renewal.expiryDate)}`)
                }
                value={
                  renewal.expiryDate === null ? undefined : (
                    <StatusPill status={statusForExpiry(renewal.expiryDate)} />
                  )
                }
                valueLabel={
                  renewal.expiryDate === null
                    ? undefined
                    : `Expires ${formatDate(renewal.expiryDate)}`
                }
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/[id]/renewal',
                    params: { id: record.id, renewalId: renewal.id },
                  })
                }
              />
            ))}
          </Card>
        )}
        <Button
          title="Add cover"
          variant="secondary"
          icon="plus"
          onPress={() =>
            router.push({ pathname: '/maintenance/[id]/renewal', params: { id: record.id } })
          }
          style={styles.stacked}
          testID="maintenance-add-renewal"
        />
      </Block>

      <Block title="Ledger" style={styles.block}>
        {costs.rows.length === 0 ? (
          <ListNote>No money recorded against it yet.</ListNote>
        ) : (
          <Card>
            {costs.rows.map((cost) => (
              <Row
                key={cost.id}
                icon={COST_TYPE_ICONS[cost.type]}
                title={cost.description ?? COST_TYPE_LABELS[cost.type]}
                subtitle={
                  cost.vendor === null
                    ? formatDate(cost.costDate)
                    : `${formatDate(cost.costDate)} · ${cost.vendor}`
                }
                value={<Amount minor={cost.amountMinor} currency={cost.currency} size="sm" />}
                valueLabel={amountLabel(cost.amountMinor, { currency: cost.currency })}
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/[id]/cost',
                    params: { id: record.id, costId: cost.id },
                  })
                }
              />
            ))}
            {costs.total <= COST_PREVIEW ? null : (
              <Row
                title={`See all ${costs.total}`}
                onPress={() =>
                  router.push({
                    pathname: '/maintenance/[id]/costs',
                    params: { id: record.id },
                  })
                }
                testID="maintenance-see-costs"
              />
            )}
          </Card>
        )}
        {costs.damagedCount === 0 ? null : (
          <ListNote>{`${costs.damagedCount} could not be read.`}</ListNote>
        )}
        <Button
          title="Record a cost"
          variant="secondary"
          icon="plus"
          onPress={() =>
            router.push({ pathname: '/maintenance/[id]/cost', params: { id: record.id } })
          }
          style={styles.stacked}
          testID="maintenance-add-cost"
        />
      </Block>

      {record.notes === null ? null : (
        <Block title="Notes" style={styles.block}>
          <Card style={styles.spend}>
            <Text variant="body">{record.notes}</Text>
          </Card>
        </Block>
      )}

      <Button
        title="Delete"
        variant="ghost"
        icon="trash"
        onPress={confirmDelete}
        style={styles.delete}
        testID="maintenance-delete"
      />
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // A block owns the gap above itself, never below.
    block: { marginTop: t.layout.section },
    spend: { gap: t.space.xs },
    // A block owns the gap above itself, never below.
    stacked: { marginTop: t.space.sm },
    delete: { marginTop: t.layout.section },
  });
