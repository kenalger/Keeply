import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
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
import {
  DOCUMENT_NUMBER_MAX_LENGTH,
  DocumentError,
  NAME_MAX_LENGTH,
  type DocumentRecord,
  type DocumentType,
} from '@/features/documents';
import { log } from '@/lib/log';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { useDocumentAttach } from './attach';
import { DocumentFile } from './document-file';
import { DOCUMENT_TYPE_OPTIONS } from './labels';
import { saveDocumentPatch, saveNewDocument } from './mutations';

/**
 * Add or edit a document (Phase 6).
 *
 * ── ONLY A NAME AND A TYPE ARE REQUIRED ────────────────────────────────────
 * Not the number, not the dates, not the scan. A form that demands a passport
 * number before it will save anything is a form people abandon halfway through
 * — and the whole point of the record is the countdown, which one date turns on
 * whenever the user gets round to it.
 *
 * ── THE EXPIRY DATE IS OPTIONAL AND SAYS SO ────────────────────────────────
 * A birth certificate does not expire. The field is clearable and its helper
 * states the consequence of leaving it empty, because "no reminders" is a real
 * choice and a silently inert field is not.
 *
 * ── THE FILE IS WRITTEN BEFORE THE ROW ─────────────────────────────────────
 * `useDocumentAttach` copies the picked file into the sandbox immediately and
 * this form holds the resulting URI. So a form abandoned after attaching leaves
 * a stray FILE — invisible, recoverable, costs disk — rather than a row
 * pointing at bytes that never existed. That asymmetry is the whole ordering
 * contract; `ui/mutations.ts` has the other half.
 *
 * ── THE NUMBER IS §14 MATERIAL ─────────────────────────────────────────────
 * `content="reference"` so iOS offers no autofill and no autocorrect — both
 * actively corrupt one — and no placeholder that looks like a real passport
 * number, because an example in a field for sensitive data invites a
 * screenshot of it.
 */
export interface DocumentFormProps {
  /** Absent when adding. */
  record?: DocumentRecord;
  onSaved: (record: DocumentRecord) => void;
  onCancel: () => void;
  /** Remove this document. Absent when adding. */
  onDelete?: () => void;
}

export function DocumentForm({ record, onSaved, onCancel, onDelete }: DocumentFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const today = useMemo(() => todayCalendarString(), []);
  const attach = useDocumentAttach();

  const [name, setName] = useState(record?.name ?? '');
  const [type, setType] = useState<DocumentType>(record?.type ?? 'passport');
  const [documentNumber, setDocumentNumber] = useState(record?.documentNumber ?? '');
  const [issueDate, setIssueDate] = useState<string | null>(record?.issueDate ?? null);
  const [expiryDate, setExpiryDate] = useState<string | null>(record?.expiryDate ?? null);
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [fileUri, setFileUri] = useState<string | null>(record?.localFileUri ?? null);
  const [mimeType, setMimeType] = useState<string | null>(record?.fileMimeType ?? null);

  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const errorFor = useCallback(
    (field: string) => (fieldError?.field === field ? fieldError.message : null),
    [fieldError],
  );

  const adopt = useCallback((stored: { fileUri: string; mimeType: string } | null) => {
    if (stored === null) return;
    setFileUri(stored.fileUri);
    setMimeType(stored.mimeType);
  }, []);

  const attachFromLibrary = useCallback(() => {
    void (async () => adopt(await attach.pickFromLibrary()))();
  }, [attach, adopt]);

  const attachFile = useCallback(() => {
    void (async () => adopt(await attach.pickFile()))();
  }, [attach, adopt]);

  const removeFile = useCallback(() => {
    Alert.alert('Remove the attached file?', 'The document and its dates stay.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          // Only the form's state. The BYTES are unlinked by
          // `saveDocumentPatch` once the row has stopped pointing at them —
          // never here, or a cancelled edit would have deleted the file.
          setFileUri(null);
          setMimeType(null);
        },
      },
    ]);
  }, []);

  const save = useCallback(() => {
    setFieldError(null);
    setFormError(null);
    setSaving(true);

    void (async () => {
      try {
        // Empty text is ABSENT, not empty — the validator trims and nulls, so
        // `''` becomes `null` in the row rather than a blank that renders as a
        // gap on the detail screen.
        const input = {
          name,
          type,
          documentNumber,
          issueDate,
          expiryDate,
          notes,
          localFileUri: fileUri,
          fileMimeType: mimeType,
        };

        const saved = editing
          ? await saveDocumentPatch(record.id, input)
          : await saveNewDocument(input);
        onSaved(saved);
      } catch (error) {
        // A validation failure names a FIELD and never a value (§14), so it can
        // be shown under the control that caused it.
        if (error instanceof DocumentError && error.code === 'invalid-field') {
          setFieldError({ field: error.field ?? '', message: error.message });
        } else {
          log.error('documents: saving failed', error);
          setFormError('That could not be saved. Nothing was changed.');
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [
    name,
    type,
    documentNumber,
    issueDate,
    expiryDate,
    notes,
    fileUri,
    mimeType,
    editing,
    record,
    onSaved,
  ]);

  return (
    <FormScreen
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add document'}
          onPrimary={save}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
        />
      }
    >
      <ScreenHeader
        title={editing ? 'Edit document' : 'Add a document'}
        subtitle={
          editing ? undefined : 'A name and what it is. Everything else can wait.'
        }
        onBack={onCancel}
      />

      <FormSection title="What it is">
        <SelectField<DocumentType>
          label="Type"
          value={type}
          onChangeValue={setType}
          options={DOCUMENT_TYPE_OPTIONS}
          required
          error={errorFor('type')}
          testID="document-type"
        />
        <TextField
          label="Name"
          content="organization"
          value={name}
          onChangeText={setName}
          placeholder="My passport, Mum's PhilHealth"
          maxLength={NAME_MAX_LENGTH}
          required
          autoFocus={!editing}
          error={errorFor('name')}
          helper="What you call it. This is the only thing you cannot leave out."
          testID="document-name"
        />
      </FormSection>

      <FormSection
        title="Dates"
        description="The expiry date is what Keeply counts down to."
      >
        <DateField
          label="Expires"
          value={expiryDate}
          onChangeValue={setExpiryDate}
          clearable
          placeholder="Does not expire"
          error={errorFor('expiryDate')}
          // Says the consequence out loud. "No reminders" is a real choice and
          // a silently inert field is not.
          helper="Leave it empty for something that never expires — a birth certificate, a diploma. Keeply will not remind you about those."
          testID="document-expiry"
        />
        <DateField
          label="Issued"
          value={issueDate}
          onChangeValue={setIssueDate}
          clearable
          placeholder="Not set"
          maxDate={today}
          error={errorFor('issueDate')}
          testID="document-issue"
        />
      </FormSection>

      <FormSection title="Details" description="All optional — add what you know.">
        <TextField
          label="Document number"
          content="reference"
          value={documentNumber}
          onChangeText={setDocumentNumber}
          maxLength={DOCUMENT_NUMBER_MAX_LENGTH}
          error={errorFor('documentNumber')}
          // No placeholder that looks like a real number, and the helper states
          // both §14 promises: it is masked, and it is never searched.
          helper="Kept on this device and shown masked. Keeply never searches on it."
          testID="document-number"
        />
        <TextField
          label="Notes"
          content="notes"
          value={notes}
          onChangeText={setNotes}
          error={errorFor('notes')}
          testID="document-notes"
        />
      </FormSection>

      <FormSection
        title="Scan or PDF"
        description="Stays on this device. Never uploaded, never sent anywhere."
      >
        {fileUri === null ? null : (
          <View style={styles.preview}>
            <DocumentFile uri={fileUri} mimeType={mimeType} height={220} testID="document-file" />
          </View>
        )}

        <View style={styles.attachRow}>
          <Button
            title={fileUri === null ? 'Choose a photo' : 'Replace with a photo'}
            variant="secondary"
            icon="photo"
            onPress={attachFromLibrary}
            loading={attach.busy}
            style={styles.attachButton}
            testID="document-attach-photo"
          />
          <Button
            title={fileUri === null ? 'Choose a file' : 'Replace with a file'}
            variant="secondary"
            icon="folder"
            onPress={attachFile}
            loading={attach.busy}
            style={styles.attachButton}
            testID="document-attach-file"
          />
        </View>

        {fileUri === null ? null : (
          <Button
            title="Remove the file"
            variant="ghost"
            icon="trash"
            onPress={removeFile}
            testID="document-remove-file"
          />
        )}

        {attach.error === null ? null : (
          <View style={styles.attachError}>
            <Text variant="caption" color="danger">
              {attach.error}
            </Text>
            {/* A sentence alone is still a wall when the refusal can only be
                undone in Settings — iOS shows no dialog once a permission is
                blocked, so the button would otherwise do nothing forever. */}
            {attach.needsSettings ? (
              <Button
                title="Open Settings"
                variant="secondary"
                icon="gear"
                onPress={() => {
                  void attach.openSettings();
                }}
                testID="document-open-settings"
              />
            ) : null}
          </View>
        )}
      </FormSection>

      {onDelete === undefined ? null : (
        <Button
          title="Delete"
          variant="ghost"
          icon="trash"
          onPress={onDelete}
          style={styles.delete}
          testID="document-delete"
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
    preview: { marginBottom: t.space.sm },
    attachRow: { flexDirection: 'row', gap: t.space.sm },
    attachError: { gap: t.space.sm },
    attachButton: { flex: 1 },
    // A block owns the gap above itself, never below.
    delete: { marginTop: t.layout.section },
    formError: { marginTop: t.space.lg },
  });
