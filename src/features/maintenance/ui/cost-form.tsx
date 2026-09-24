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
  SelectField,
  SwitchField,
  Text,
  TextField,
  holdBusy,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  DESCRIPTION_MAX_LENGTH,
  MaintenanceError,
  VENDOR_MAX_LENGTH,
  isVehicle,
  type MaintenanceCostRecord,
  type MaintenanceCostType,
  type MaintenanceItemRecord,
} from '@/features/maintenance';
import { log } from '@/lib/log';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { formatLitresDraft, parseLitres } from '../litres';
import { COST_TYPE_OPTIONS } from './labels';
import { saveCostPatch, saveNewCost } from './mutations';

/**
 * Record what something cost (Phase 5c).
 *
 * ── THE FORM CHANGES SHAPE TWICE ───────────────────────────────────────────
 * Once with the ITEM's kind, and once with the COST's type. An aircon's form
 * has no odometer; a repair's has no litres. Both sets of fields are GONE
 * rather than disabled, for the reason the item form gives — an empty field
 * nobody can fill is a question the screen is asking and the user cannot
 * answer.
 *
 * `validateNewCost` nulls both sets at the boundary too, so a cost typed as
 * fuel, given litres and then switched to `repair` does not keep them.
 *
 * ── LITRES ARE MILLILITRES ─────────────────────────────────────────────────
 * Same rule as money, same reason (§30): no binary float reaches the database.
 * `42.5` litres is `42500` millilitres, parsed here and nowhere else. The text
 * field is the only place a decimal point exists.
 */
export interface CostFormProps {
  /** The item this is recorded against. Its kind decides the vehicle fields. */
  item: MaintenanceItemRecord;
  /** Absent when adding. */
  record?: MaintenanceCostRecord;
  onSaved: (record: MaintenanceCostRecord) => void;
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

export function CostForm({ item, record, onSaved, onCancel, onDelete }: CostFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const today = useMemo(() => todayCalendarString(), []);

  const [type, setType] = useState<MaintenanceCostType>(record?.type ?? 'fuel');
  const [amount, setAmount] = useState<MinorUnits | null>(record?.amountMinor ?? null);
  const [costDate, setCostDate] = useState<string>(record?.costDate ?? today);
  const [odometer, setOdometer] = useState(
    record?.odometer === null || record?.odometer === undefined ? '' : String(record.odometer),
  );
  const [description, setDescription] = useState(record?.description ?? '');
  const [vendor, setVendor] = useState(record?.vendor ?? '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [litres, setLitres] = useState(formatLitresDraft(record?.fuelLitersMilli ?? null));
  const [isFullTank, setIsFullTank] = useState(record?.isFullTank ?? true);

  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const showsOdometer = isVehicle(item.kind);
  const showsFuel = type === 'fuel';

  const errorFor = useCallback(
    (field: string) => (fieldError?.field === field ? fieldError.message : null),
    [fieldError],
  );

  const save = useCallback(() => {
    setFieldError(null);
    setFormError(null);

    // Caught here rather than at the data layer because the data layer never
    // sees the text — `parseLitres` returning null is the only evidence that
    // "4o" was typed, and the message has to point at the field that holds it.
    const litresMilli = showsFuel && litres.trim() !== '' ? parseLitres(litres) : null;
    if (showsFuel && litres.trim() !== '' && litresMilli === null) {
      setFieldError({ field: 'fuelLitersMilli', message: 'Enter litres as a number' });
      return;
    }

    setSaving(true);
    void (async () => {
      try {
        const input = {
          itemId: item.id,
          type,
          amountMinor: amount ?? 0,
          costDate,
          odometer:
            showsOdometer && odometer.trim() !== '' ? Number.parseInt(odometer, 10) : null,
          description,
          vendor,
          notes,
          fuelLitersMilli: litresMilli,
          // Only meaningful once litres are known: "full tank" with no volume
          // tells the efficiency walk where a window ends but not what it cost.
          isFullTank: showsFuel && litresMilli !== null ? isFullTank : null,
        };

        // Held, not delayed: the row is written at once; "Saving…" stays up
        // long enough to be seen. See `BusyOverlay`.
        const saved = await holdBusy(
          editing ? saveCostPatch(record.id, input) : saveNewCost(input),
        );
        onSaved(saved);
      } catch (error) {
        if (error instanceof MaintenanceError && error.code === 'invalid-field') {
          setFieldError({ field: error.field ?? '', message: error.message });
        } else {
          log.error('maintenance: saving a cost failed', error);
          setFormError('That could not be saved. Nothing was changed.');
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [
    item.id,
    type,
    amount,
    costDate,
    odometer,
    description,
    vendor,
    notes,
    litres,
    isFullTank,
    showsOdometer,
    showsFuel,
    editing,
    record,
    onSaved,
  ]);

  return (
    <FormScreen
      busy={saving ? 'Saving…' : null}
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add cost'}
          onPrimary={save}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
        />
      }
    >
      <ScreenHeader
        title={editing ? 'Edit cost' : 'Record a cost'}
        subtitle={item.name}
        onBack={onCancel}
      />

      <FormSection title="What and how much">
        <SelectField<MaintenanceCostType>
          label="What for"
          value={type}
          onChangeValue={setType}
          options={COST_TYPE_OPTIONS}
          required
          error={errorFor('type')}
          testID="cost-type"
        />
        <AmountField
          label="Amount"
          value={amount}
          onChangeValue={setAmount}
          required
          autoFocus={!editing}
          error={errorFor('amountMinor')}
          testID="cost-amount"
        />
        <DateField
          label="Date"
          value={costDate}
          onChangeValue={(value) => setCostDate(value ?? today)}
          required
          // A cost is something that HAPPENED. Bounding the picker says so
          // before the save does, rather than after.
          maxDate={today}
          error={errorFor('costDate')}
          testID="cost-date"
        />
      </FormSection>

      {showsFuel ? (
        <FormSection
          title="Fill-up"
          description="Litres let Keeply work out kilometres per litre."
        >
          <TextField
            label="Litres"
            content="number"
            value={litres}
            onChangeText={setLitres}
            placeholder="40"
            error={errorFor('fuelLitersMilli')}
            testID="cost-litres"
          />
          <SwitchField
            label="Filled to full"
            value={isFullTank}
            onChangeValue={setIsFullTank}
            // Not a cosmetic flag: efficiency is distance over fuel burned, and
            // the only moment the tank's level is known is when it is full.
            description="Turn this off for a partial fill. Full tanks are what the km/L figure is measured between."
            testID="cost-full-tank"
          />
        </FormSection>
      ) : null}

      <FormSection title="Details" description="All optional — add what you know.">
        {showsOdometer ? (
          <TextField
            label="Odometer"
            content="number"
            value={odometer}
            onChangeText={setOdometer}
            placeholder={
              item.currentMileage === null ? '0' : String(item.currentMileage)
            }
            helper="Whole kilometres. Two readings are what cost per kilometre needs."
            error={errorFor('odometer')}
            testID="cost-odometer"
          />
        ) : null}
        <TextField
          label="Description"
          content="organization"
          value={description}
          onChangeText={setDescription}
          placeholder="Brake pads, aircon cleaning"
          maxLength={DESCRIPTION_MAX_LENGTH}
          error={errorFor('description')}
          testID="cost-description"
        />
        <TextField
          label={showsFuel ? 'Station' : 'Shop or provider'}
          content="organization"
          value={vendor}
          onChangeText={setVendor}
          placeholder={showsFuel ? 'Shell, Petron' : 'Where you had it done'}
          maxLength={VENDOR_MAX_LENGTH}
          error={errorFor('vendor')}
          testID="cost-vendor"
        />
        <TextField
          label="Notes"
          content="notes"
          value={notes}
          onChangeText={setNotes}
          error={errorFor('notes')}
          testID="cost-notes"
        />
      </FormSection>

      {onDelete === undefined ? null : (
        <Button
          title="Delete"
          variant="ghost"
          icon="trash"
          onPress={onDelete}
          style={styles.delete}
          testID="maintenance-cost-delete"
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
    // A block owns the gap above itself, never below.
    formError: { marginTop: t.space.lg },
    delete: { marginTop: t.layout.section },
  });
