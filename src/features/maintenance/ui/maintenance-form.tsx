import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  DateField,
  FormActions,
  FormScreen,
  FormSection,
  ScreenHeader,
  SelectField,
  Text,
  TextField,
  holdBusy,
} from '@/components/ui';
import {
  MIN_YEAR,
  NAME_MAX_LENGTH,
  isVehicle,
  type MaintenanceItemKind,
  type MaintenanceItemRecord,
  type VehicleType,
} from '@/features/maintenance';
import { log } from '@/lib/log';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { KIND_OPTIONS, VEHICLE_TYPE_OPTIONS } from './labels';
import { saveItemPatch, saveNewItem } from './mutations';
import { placeSaveError } from './field-errors';

/**
 * Add or edit a maintenance item (Phase 5).
 *
 * ── THE FORM CHANGES SHAPE WITH THE KIND ───────────────────────────────────
 * This is the whole reason one table with a `kind` beats two tables. Choose
 * "Vehicle" and the form grows a vehicle type, a plate and an odometer. Choose
 * "Appliance" and those three disappear — not disabled, not greyed, GONE, so an
 * aircon's form is short and has no empty vehicle fields staring at it.
 *
 * Fields that stop applying are also cleared by `validateItemPatch`, so an item
 * changed from a car to an appliance does not keep a mileage no screen offers a
 * way to edit.
 *
 * ── ONLY THE NAME AND THE KIND ARE REQUIRED ────────────────────────────────
 * Everything else can be filled in later, from the detail screen. A form that
 * demands a serial number before it will save anything is a form people abandon
 * — and the point of the record is the history you attach to it, not the
 * paperwork you can find today.
 *
 * ── THE IDENTIFIER IS SENSITIVE (§10) ──────────────────────────────────────
 * A plate or a serial. `content="reference"` so iOS offers no autofill and no
 * autocorrect — both actively corrupt one — and the helper says what it is for
 * rather than showing an example that looks like real data.
 */
export interface MaintenanceFormProps {
  /** Absent when adding. */
  record?: MaintenanceItemRecord;
  onSaved: (record: MaintenanceItemRecord) => void;
  onCancel: () => void;
}

/**
 * The fields this form draws a control for. `errorFor` is typed against it,
 * so a failure on any other field goes to the form message instead of
 * vanishing (see `./field-errors`).
 */
const RENDERED_FIELDS = ['brand', 'currentMileage', 'identifier', 'kind', 'model', 'name', 'notes', 'purchaseDate', 'vehicleType', 'year'] as const;
type RenderedField = (typeof RENDERED_FIELDS)[number];

export function MaintenanceForm({ record, onSaved, onCancel }: MaintenanceFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;

  const [name, setName] = useState(record?.name ?? '');
  const [kind, setKind] = useState<MaintenanceItemKind>(record?.kind ?? 'vehicle');
  const [vehicleType, setVehicleType] = useState<VehicleType>(record?.vehicleType ?? 'car');
  const [brand, setBrand] = useState(record?.brand ?? '');
  const [model, setModel] = useState(record?.model ?? '');
  const [year, setYear] = useState(record?.year === null ? '' : String(record?.year ?? ''));
  const [identifier, setIdentifier] = useState(record?.identifier ?? '');
  const [purchaseDate, setPurchaseDate] = useState<string | null>(record?.purchaseDate ?? null);
  const [mileage, setMileage] = useState(
    record?.currentMileage === null ? '' : String(record?.currentMileage ?? ''),
  );
  const [notes, setNotes] = useState(record?.notes ?? '');

  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const showsVehicleFields = isVehicle(kind);
  const today = useMemo(() => todayCalendarString(), []);

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
        // Empty text is ABSENT, not empty — `validateNewItem` trims and nulls,
        // so `''` here becomes `null` in the row rather than a blank string
        // that renders as a gap on the detail screen.
        const input = {
          name,
          kind,
          vehicleType: showsVehicleFields ? vehicleType : null,
          brand,
          model,
          year: year.trim() === '' ? null : Number.parseInt(year, 10),
          identifier,
          purchaseDate,
          currentMileage:
            showsVehicleFields && mileage.trim() !== ''
              ? Number.parseInt(mileage, 10)
              : null,
          notes,
        };

        // Held, not delayed: the row is written at once; "Saving…" stays up
        // long enough to be seen. See `BusyOverlay`.
        const saved = await holdBusy(
          editing ? saveItemPatch(record.id, input) : saveNewItem(input),
        );
        onSaved(saved);
      } catch (error) {
        // A validation failure names a FIELD and never a value (§10), so it can
        // be shown under the control that caused it.
        const placed = placeSaveError(RENDERED_FIELDS, error);
        if (placed === null) {
          log.error('maintenance: saving an item failed', error);
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
    name,
    kind,
    vehicleType,
    brand,
    model,
    year,
    identifier,
    purchaseDate,
    mileage,
    notes,
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
          primaryLabel={editing ? 'Save changes' : 'Add item'}
          onPrimary={save}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
        />
      }
    >
      <ScreenHeader
        title={editing ? 'Edit item' : 'Add something to look after'}
        subtitle={
          editing
            ? undefined
            : 'A name and what kind of thing it is. Everything else can wait.'
        }
        onBack={onCancel}
      />

      <FormSection title="What is it">
        <SelectField<MaintenanceItemKind>
          label="Kind"
          value={kind}
          onChangeValue={setKind}
          options={KIND_OPTIONS}
          required
          error={errorFor('kind')}
          testID="maintenance-kind"
        />
        <TextField
          label="Name"
          content="organization"
          value={name}
          onChangeText={setName}
          placeholder="Vios, Living room aircon, Work laptop"
          maxLength={NAME_MAX_LENGTH}
          required
          autoFocus={!editing}
          error={errorFor('name')}
          helper="What you call it. This is the only thing you cannot leave out."
          testID="maintenance-name"
        />
      </FormSection>

      {showsVehicleFields ? (
        <FormSection title="Vehicle">
          {/* A SELECT, not a segmented control — on `SegmentedField`'s own
              advice: four options with "Motorcycle" among them shrank the
              segments until the label read "Motorc…", which is a control
              lying about what it holds. */}
          <SelectField<VehicleType>
            label="Type"
            value={vehicleType}
            onChangeValue={setVehicleType}
            options={VEHICLE_TYPE_OPTIONS}
            error={errorFor('vehicleType')}
            testID="maintenance-vehicle-type"
          />
          <TextField
            label="Odometer"
            content="number"
            value={mileage}
            onChangeText={setMileage}
            placeholder="0"
            helper="Whole kilometres. Lets Keeply work out cost per kilometre later."
            error={errorFor('currentMileage')}
            testID="maintenance-mileage"
          />
        </FormSection>
      ) : null}

      <FormSection title="Details" description="All optional — add what you know.">
        <TextField
          label="Brand"
          content="organization"
          value={brand}
          onChangeText={setBrand}
          placeholder="Toyota, Panasonic, Apple"
          error={errorFor('brand')}
          testID="maintenance-brand"
        />
        <TextField
          label="Model"
          content="organization"
          value={model}
          onChangeText={setModel}
          placeholder="Vios 1.3 XE"
          error={errorFor('model')}
          testID="maintenance-model"
        />
        <TextField
          label="Year"
          content="number"
          value={year}
          onChangeText={setYear}
          placeholder={String(MIN_YEAR)}
          error={errorFor('year')}
          testID="maintenance-year"
        />
        <TextField
          label={showsVehicleFields ? 'Plate number' : 'Serial number'}
          content="reference"
          value={identifier}
          onChangeText={setIdentifier}
          error={errorFor('identifier')}
          // No placeholder that looks like a real plate or serial: an example
          // in a field for sensitive data invites a screenshot of it.
          helper="Kept on this device and shown masked. Useful for warranty claims."
          testID="maintenance-identifier"
        />
        <DateField
          label="Bought on"
          value={purchaseDate}
          onChangeValue={setPurchaseDate}
          clearable
          placeholder="Not set"
          maxDate={today}
          error={errorFor('purchaseDate')}
          helper="Used to work out how old it is, and when a warranty runs out."
          testID="maintenance-purchase-date"
        />
        <TextField
          label="Notes"
          content="notes"
          value={notes}
          onChangeText={setNotes}
          error={errorFor('notes')}
          testID="maintenance-notes"
        />
      </FormSection>

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
  });
