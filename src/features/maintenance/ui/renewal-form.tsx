import { useCallback, useState } from 'react';
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
  Text,
  TextField,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  MaintenanceError,
  PROVIDER_MAX_LENGTH,
  REFERENCE_MAX_LENGTH,
  type MaintenanceItemRecord,
  type MaintenanceRenewalKind,
  type MaintenanceRenewalRecord,
} from '@/features/maintenance';
import { log } from '@/lib/log';
import { useThemedStyles, type Theme } from '@/theme';

import { RENEWAL_KIND_LABELS, RENEWAL_KIND_OPTIONS } from './labels';
import { saveNewRenewal, saveRenewalPatch } from './mutations';

/**
 * Record cover that expires (Phase 5c).
 *
 * Insurance, registration and warranty are one form because they were always
 * one shape: a provider, a reference number, a term, and a premium. `kind` is
 * the only thing that differed, and three near-identical forms would have been
 * three places for the expiry logic to drift (`plan/phase5-maintenance.md` §3).
 *
 * ── NEITHER DATE IS BOUNDED BY TODAY ───────────────────────────────────────
 * Unlike a cost or a service, a renewal is a promise about the future. A policy
 * that starts next month and runs to 2029 is the ordinary case, and an expired
 * one kept on file is how you know what the last premium was. Only the order is
 * enforced.
 *
 * ── THE REFERENCE NUMBER IS SENSITIVE (§10) ────────────────────────────────
 * A policy number or an OR/CR reference gets the treatment a plate gets:
 * `content="reference"` so iOS offers no autofill and no autocorrect — both
 * actively corrupt one — no example placeholder, and masked wherever it is
 * shown back.
 */
export interface RenewalFormProps {
  item: MaintenanceItemRecord;
  record?: MaintenanceRenewalRecord;
  /** Preselect the kind, when the screen was opened from a specific one. */
  initialKind?: MaintenanceRenewalKind;
  onSaved: (record: MaintenanceRenewalRecord) => void;
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

export function RenewalForm({
  item,
  record,
  initialKind,
  onSaved,
  onCancel,
  onDelete,
}: RenewalFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;

  const [kind, setKind] = useState<MaintenanceRenewalKind>(
    record?.kind ?? initialKind ?? 'insurance',
  );
  const [provider, setProvider] = useState(record?.provider ?? '');
  const [reference, setReference] = useState(record?.referenceNumber ?? '');
  const [startDate, setStartDate] = useState<string | null>(record?.startDate ?? null);
  const [expiryDate, setExpiryDate] = useState<string | null>(record?.expiryDate ?? null);
  const [amount, setAmount] = useState<MinorUnits | null>(record?.costMinor ?? null);
  const [notes, setNotes] = useState(record?.notes ?? '');

  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const errorFor = useCallback(
    (field: string) => (fieldError?.field === field ? fieldError.message : null),
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
          kind,
          provider,
          referenceNumber: reference,
          startDate,
          expiryDate,
          notes,
          amountMinor: amount,
        };

        const saved = editing
          ? await saveRenewalPatch(record.id, input)
          : await saveNewRenewal(input);
        onSaved(saved);
      } catch (error) {
        if (error instanceof MaintenanceError && error.code === 'invalid-field') {
          setFieldError({ field: error.field ?? '', message: error.message });
        } else {
          log.error('maintenance: saving a renewal failed', error);
          setFormError('That could not be saved. Nothing was changed.');
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [
    item.id,
    kind,
    provider,
    reference,
    startDate,
    expiryDate,
    notes,
    amount,
    editing,
    record,
    onSaved,
  ]);

  return (
    <FormScreen
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add cover'}
          onPrimary={save}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
        />
      }
    >
      <ScreenHeader
        title={editing ? `Edit ${RENEWAL_KIND_LABELS[kind].toLowerCase()}` : 'Add cover'}
        subtitle={item.name}
        onBack={onCancel}
      />

      <FormSection title="What kind of cover">
        <SelectField<MaintenanceRenewalKind>
          label="Cover"
          value={kind}
          onChangeValue={setKind}
          options={RENEWAL_KIND_OPTIONS}
          required
          error={errorFor('kind')}
          testID="renewal-kind"
        />
        <TextField
          label="Provider"
          content="organization"
          value={provider}
          onChangeText={setProvider}
          placeholder="Insurer, LTO, the manufacturer"
          maxLength={PROVIDER_MAX_LENGTH}
          autoFocus={!editing}
          error={errorFor('provider')}
          testID="renewal-provider"
        />
      </FormSection>

      <FormSection title="How long it runs">
        <DateField
          label="Starts"
          value={startDate}
          onChangeValue={setStartDate}
          clearable
          placeholder="Not set"
          error={errorFor('startDate')}
          testID="renewal-start"
        />
        <DateField
          label="Expires"
          value={expiryDate}
          onChangeValue={setExpiryDate}
          clearable
          placeholder="Not set"
          minDate={startDate ?? undefined}
          helper="The date Keeply counts down to."
          error={errorFor('expiryDate')}
          testID="renewal-expiry"
        />
      </FormSection>

      <FormSection title="Details" description="All optional — add what you know.">
        <AmountField
          label="Premium"
          value={amount}
          onChangeValue={setAmount}
          helper="Goes into this item's running total. Leave it empty if there was no charge."
          error={errorFor('amountMinor')}
          testID="renewal-amount"
        />
        <TextField
          label="Reference number"
          content="reference"
          value={reference}
          onChangeText={setReference}
          maxLength={REFERENCE_MAX_LENGTH}
          error={errorFor('referenceNumber')}
          // No placeholder that looks like a real policy number: an example in
          // a field for sensitive data invites a screenshot of it.
          helper="Policy or OR/CR number. Kept on this device and shown masked."
          testID="renewal-reference"
        />
        <TextField
          label="Notes"
          content="notes"
          value={notes}
          onChangeText={setNotes}
          error={errorFor('notes')}
          testID="renewal-notes"
        />
      </FormSection>

      {onDelete === undefined ? null : (
        <Button
          title="Delete"
          variant="ghost"
          icon="trash"
          onPress={onDelete}
          style={styles.delete}
          testID="maintenance-renewal-delete"
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
