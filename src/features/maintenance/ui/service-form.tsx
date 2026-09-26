import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountField,
  Button,
  DateField,
  FormActions,
  FormScreen,
  FormSection,
  ScreenHeader,
  Text,
  TextField,
  holdBusy,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  SERVICE_TYPE_MAX_LENGTH,
  SHOP_MAX_LENGTH,
  isVehicle,
  type MaintenanceItemRecord,
  type MaintenanceServiceRecord,
} from '@/features/maintenance';
import { log } from '@/lib/log';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { saveNewService, saveServicePatch } from './mutations';
import { placeSaveError } from './field-errors';

/**
 * Record a job done, and when the next one is due (Phase 5c).
 *
 * ── THE AMOUNT IS ONE FIELD AND ONE LEDGER ROW ─────────────────────────────
 * Typing ₱1,850 here writes a `maintenance_costs` row of type `service` and
 * links it (§A3). The user does not record the oil change and then record
 * paying for the oil change; the running total moves because the service knows
 * what it cost.
 *
 * Clearing the field deletes that row. There is no ₱0 state — a service that
 * cost nothing has an ABSENT amount, which is a different fact from a free one.
 *
 * ── WHAT IS DUE NEXT IS THE POINT ──────────────────────────────────────────
 * The history is worth having, but "next oil change 1 March" is why anyone
 * opens the screen. Both next-due fields sit in their own section rather than
 * at the bottom of a details list, so the question gets asked while the user
 * still has the receipt in front of them.
 */
export interface ServiceFormProps {
  item: MaintenanceItemRecord;
  record?: MaintenanceServiceRecord;
  onSaved: (record: MaintenanceServiceRecord) => void;
  onCancel: () => void;
  /**
   * Remove this record. Absent when adding.
   *
   * A delete lives at the BOTTOM of the form it edits rather than behind an
   * icon in the header: it is the least likely thing the user came here to do,
   * and a destructive action reachable by a mis-tap next to Back is one people
   * learn to approach the screen carefully.
   */
  onDelete?: () => void;
}

/**
 * The fields this form draws a control for. `errorFor` is typed against it,
 * so a failure on any other field goes to the form message instead of
 * vanishing (see `./field-errors`).
 */
const RENDERED_FIELDS = ['amountMinor', 'nextServiceDate', 'nextServiceMileage', 'notes', 'odometer', 'serviceDate', 'serviceType', 'shop'] as const;
type RenderedField = (typeof RENDERED_FIELDS)[number];

export function ServiceForm({
  item,
  record,
  onSaved,
  onCancel,
  onDelete,
}: ServiceFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const today = useMemo(() => todayCalendarString(), []);

  const [serviceType, setServiceType] = useState(record?.serviceType ?? '');
  const [serviceDate, setServiceDate] = useState<string>(record?.serviceDate ?? today);
  const [amount, setAmount] = useState<MinorUnits | null>(record?.costMinor ?? null);
  const [shop, setShop] = useState(record?.shop ?? '');
  const [odometer, setOdometer] = useState(
    record?.odometer === null || record?.odometer === undefined ? '' : String(record.odometer),
  );
  const [nextDate, setNextDate] = useState<string | null>(record?.nextServiceDate ?? null);
  const [nextMileage, setNextMileage] = useState(
    record?.nextServiceMileage === null || record?.nextServiceMileage === undefined
      ? ''
      : String(record.nextServiceMileage),
  );
  const [notes, setNotes] = useState(record?.notes ?? '');

  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const showsVehicleFields = isVehicle(item.kind);

  const errorFor = useCallback(
    (field: RenderedField) => (fieldError?.field === field ? fieldError.message : null),
    [fieldError],
  );

  const save = useCallback(() => {
    setFieldError(null);
    setFormError(null);
    setSaving(true);

    void (async () => {
      try {
        const input = {
          itemId: item.id,
          serviceType,
          serviceDate,
          odometer:
            showsVehicleFields && odometer.trim() !== ''
              ? Number.parseInt(odometer, 10)
              : null,
          nextServiceDate: nextDate,
          nextServiceMileage:
            showsVehicleFields && nextMileage.trim() !== ''
              ? Number.parseInt(nextMileage, 10)
              : null,
          shop,
          notes,
          // `null` is what removes the linked cost row. `0` would be refused,
          // and would mean something different if it were not.
          amountMinor: amount,
        };

        // Held, not delayed: the row is written at once; "Saving…" stays up
        // long enough to be seen. See `BusyOverlay`.
        const saved = await holdBusy(
          editing ? saveServicePatch(record.id, input) : saveNewService(input),
        );
        onSaved(saved);
      } catch (error) {
        const placed = placeSaveError(RENDERED_FIELDS, error);
        if (placed === null) {
          log.error('maintenance: saving a service failed', error);
          setFormError('That could not be saved. Nothing was changed.');
        } else if (placed.at === 'field') {
          setFieldError({ field: placed.field, message: placed.message });
        } else {
          setFormError(placed.message);
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [
    item.id,
    serviceType,
    serviceDate,
    odometer,
    nextDate,
    nextMileage,
    shop,
    notes,
    amount,
    showsVehicleFields,
    editing,
    record,
    onSaved,
  ]);

  return (
    <FormScreen
      busy={saving ? 'Saving…' : null}
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add service'}
          onPrimary={save}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
        />
      }
    >
      <ScreenHeader
        title={editing ? 'Edit service' : 'Record a service'}
        subtitle={item.name}
        onBack={onCancel}
      />

      <FormSection title="What was done">
        <TextField
          label="Service"
          content="organization"
          value={serviceType}
          onChangeText={setServiceType}
          placeholder="Oil change, aircon cleaning, battery replacement"
          maxLength={SERVICE_TYPE_MAX_LENGTH}
          required
          autoFocus={!editing}
          error={errorFor('serviceType')}
          testID="service-type"
        />
        <DateField
          label="Date"
          value={serviceDate}
          onChangeValue={(value) => setServiceDate(value ?? today)}
          required
          maxDate={today}
          error={errorFor('serviceDate')}
          testID="service-date"
        />
        <AmountField
          label="What it cost"
          value={amount}
          onChangeValue={setAmount}
          // Says out loud what the linked cost row does, because otherwise the
          // running total moves for a reason the screen never mentioned.
          helper="Goes into this item's running total. Leave it empty if it was free."
          error={errorFor('amountMinor')}
          testID="service-amount"
        />
        <TextField
          label="Shop"
          content="organization"
          value={shop}
          onChangeText={setShop}
          placeholder="Where you had it done"
          maxLength={SHOP_MAX_LENGTH}
          error={errorFor('shop')}
          testID="service-shop"
        />
        {showsVehicleFields ? (
          <TextField
            label="Odometer"
            content="number"
            value={odometer}
            onChangeText={setOdometer}
            placeholder={item.currentMileage === null ? '0' : String(item.currentMileage)}
            helper="Whole kilometres, at the time of the service."
            error={errorFor('odometer')}
            testID="service-odometer"
          />
        ) : null}
      </FormSection>

      <FormSection
        title="When it is due again"
        description="Optional, and the reason to fill it in now: Keeply can remind you."
      >
        <DateField
          label="Next service"
          value={nextDate}
          onChangeValue={setNextDate}
          clearable
          placeholder="Not set"
          minDate={serviceDate}
          error={errorFor('nextServiceDate')}
          testID="service-next-date"
        />
        {showsVehicleFields ? (
          <TextField
            label="Or at"
            content="number"
            value={nextMileage}
            onChangeText={setNextMileage}
            placeholder="45000"
            helper="Kilometres. Whichever comes first."
            error={errorFor('nextServiceMileage')}
            testID="service-next-mileage"
          />
        ) : null}
      </FormSection>

      <FormSection title="Details">
        <TextField
          label="Notes"
          content="notes"
          value={notes}
          onChangeText={setNotes}
          error={errorFor('notes')}
          testID="service-notes"
        />
      </FormSection>

      {onDelete === undefined ? null : (
        <Button
          title="Delete"
          variant="ghost"
          icon="trash"
          onPress={onDelete}
          style={styles.delete}
          testID="maintenance-service-delete"
        />
      )}

      {formError === null ? null : (
        <View style={styles.formError}>
          <Text variant="caption" color="danger">
            {formError}
          </Text>
        </View>
      )}
    </FormScreen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    formError: { marginTop: t.space.lg },
    delete: { marginTop: t.layout.section },
  });
