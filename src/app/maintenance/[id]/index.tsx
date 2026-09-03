import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  Amount,
  Button,
  Card,
  EmptyState,
  IconButton,
  Row,
  Screen,
  ScreenHeader,
  Text,
} from '@/components/ui';
import { isVehicle } from '@/features/maintenance';
import {
  KIND_LABELS,
  VEHICLE_TYPE_LABELS,
  describeItem,
  removeItem,
  useItemTotals,
  useMaintenanceItem,
} from '@/features/maintenance/ui';
import { log } from '@/lib/log';
import { formatDate, maskIdentifier, useThemedStyles, type Theme } from '@/theme';

/**
 * One maintenance item (Phase 5).
 *
 * ── WHAT IS HERE AND WHAT IS NOT ───────────────────────────────────────────
 * The facts, what it has cost, and the way out. Service history, renewals and
 * "what is due next" are steps 5b–5c and are deliberately absent rather than
 * stubbed: a section reading "Coming soon" on a record the user just created is
 * a promise made at the worst possible moment.
 *
 * ── THE IDENTIFIER IS MASKED ───────────────────────────────────────────────
 * `maskIdentifier` — the same treatment a document number gets (§10, §14). It
 * is shown here and on no other screen, because this is the one place someone
 * has deliberately opened the record to look at it.
 */
export default function MaintenanceItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);

  const item = useMaintenanceItem(id);
  const totals = useItemTotals(id);

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

  const spend = totals.value;

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

      <View style={styles.block}>
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
              title={isVehicle(record.kind) ? 'Plate' : 'Serial'}
              value={maskIdentifier(record.identifier)}
              chevron={false}
            />
          )}
          {record.currentMileage === null ? null : (
            <Row
              title="Odometer"
              value={`${record.currentMileage.toLocaleString('en-PH')} km`}
              chevron={false}
            />
          )}
          {record.isActive ? null : (
            <Row title="Status" value="Retired" chevron={false} />
          )}
        </Card>
      </View>

      <View style={styles.block}>
        <Text variant="label" color="textSecondary">
          What it has cost
        </Text>
        <Card style={styles.spend}>
          {spend === null || spend.costCount === 0 ? (
            <Text variant="caption" color="textSecondary">
              Nothing recorded against it yet.
            </Text>
          ) : (
            <>
              <Amount minor={spend.totalMinor} currency={spend.currency} size="lg" />
              <Text variant="caption" color="textSecondary">
                {`across ${spend.costCount} ${spend.costCount === 1 ? 'entry' : 'entries'}`}
              </Text>
              {spend.damagedCount === 0 ? null : (
                <Text variant="caption" color="textTertiary">
                  {`${spend.damagedCount} could not be added up.`}
                </Text>
              )}
            </>
          )}
        </Card>
      </View>

      {record.notes === null ? null : (
        <View style={styles.block}>
          <Text variant="label" color="textSecondary">
            Notes
          </Text>
          <Card style={styles.spend}>
            <Text variant="body">{record.notes}</Text>
          </Card>
        </View>
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
    block: { marginTop: t.layout.section, gap: t.space.sm },
    spend: { gap: t.space.xs },
    delete: { marginTop: t.layout.section },
  });
