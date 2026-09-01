/**
 * The add / edit receipt form.
 *
 * ── §28: A RECEIPT IN WELL UNDER TWENTY SECONDS ────────────────────────────
 * §28 spells the flow out: `Camera → Amount → Category → Save`. That is met by
 * removing taps, and every decision below is one:
 *
 *   THE PHOTO IS ALREADY DONE. The user arrives here from the camera with the
 *   image in the sandbox and in the draft. The section at the top confirms it
 *   landed and then gets out of the way; it is never a field to fill in.
 *
 *   AMOUNT IS FIRST AND AUTOFOCUSED, with the decimal keypad up. It is the
 *   number the user is reading off the paper in their hand, and starting
 *   anywhere else costs a tap on every single receipt.
 *
 *   EVERYTHING INFERABLE IS DEFAULTED. The date is TODAY, which is right for
 *   the "photograph it at the till" case the data layer's `NewReceiptInput`
 *   documents as the common one. The category is the last one used this
 *   launch — somebody entering four receipts in a sitting is usually entering
 *   four of the same kind.
 *
 *   SO THE COMMON CASE IS TWO ENTRIES: an amount and a merchant. Payment method
 *   and notes are below the fold in their own section, so they do not read as
 *   work to be done.
 *
 * ── NEVER LOSE WHAT WAS TYPED ──────────────────────────────────────────────
 * State lives in `./draft-store.ts`, outside the React tree. This form is
 * reached THROUGH a camera route and can be interrupted by a system photo
 * picker and an OS permission dialog before a character is typed, so a
 * screen-local `useState` would lose the lot several times over. A form that
 * clears is a defect, not a nuisance: the user does not retype it, they leave.
 *
 * ── MONEY NEVER STOPS BEING AN INTEGER ─────────────────────────────────────
 * `<AmountField/>` parses text into `MinorUnits` once, at the boundary. The
 * draft holds `MinorUnits | null` and the data layer takes `MinorUnits`; no
 * float and no formatted string exists anywhere between the keypad and the
 * `amount_minor` column (§30).
 *
 * ── THE PHOTO'S TWO LIFETIMES ──────────────────────────────────────────────
 * Removing or replacing a photo means something different depending on whether
 * a row references it yet, and the form is where that difference lives:
 *
 *   ADDING   nothing references the file, so it is unlinked immediately.
 *   EDITING  the row still points at it until Save commits, so the file is
 *            LEFT ALONE and `updateReceipt()` reports it in `orphanedUris` —
 *            which `saveReceiptEdit()` unlinks after the write. Row first,
 *            file second, exactly as `queries.ts` requires.
 */
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
  Text,
  TextField,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  MERCHANT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  type NewReceiptInput,
  type ReceiptCategory,
  type ReceiptPatch,
  type ReceiptRecord,
} from '@/features/receipts';
import { log } from '@/lib/log';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { useImageCapture } from './capture';
import {
  lastReceiptCategory,
  NEW_RECEIPT_DRAFT,
  useReceiptDraftStore,
  type ReceiptDraft,
  type ReceiptDraftKey,
} from './draft-store';
import { CATEGORY_OPTIONS } from './labels';
import { fieldMessages, formMessage, type FieldMessages } from './messages';
import { saveNewReceipt, saveReceiptEdit } from './mutations';
import { openAppSettings } from './permissions';
import { ReceiptImage } from './receipt-image';
import { unlinkOrphanedImages } from './storage';

export interface ReceiptFormProps {
  /** The record being edited, or `undefined` when adding. */
  record?: ReceiptRecord;
  /** Open the camera. The screen owns navigation; this form never routes. */
  onTakePhoto: (draftKey: ReceiptDraftKey) => void;
  onSaved: (record: ReceiptRecord) => void;
  onCancel: () => void;
}

/* -------------------------------------------------------------------------- */
/* Draft shaping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A blank receipt.
 *
 * Exported because the capture route seeds a draft with a photo before this
 * form has ever rendered, and the two must agree on what "blank" is or the
 * photo would land on a draft the form then replaces.
 */
export function emptyReceiptDraft(): ReceiptDraft {
  return {
    merchant: '',
    amountMinor: null,
    category: lastReceiptCategory() ?? 'other',
    // Today, not null: `NewReceiptInput.purchaseDate` documents "photograph the
    // receipt now, type the date later" as the common flow, and today is the
    // honest answer to a missing one.
    purchaseDate: todayCalendarString(),
    paymentMethod: '',
    notes: '',
    imageUri: null,
    thumbnailUri: null,
  };
}

function draftForRecord(record: ReceiptRecord): ReceiptDraft {
  return {
    merchant: record.merchant,
    amountMinor: record.amountMinor,
    category: record.category,
    purchaseDate: record.purchaseDate,
    paymentMethod: record.paymentMethod ?? '',
    notes: record.notes ?? '',
    imageUri: record.localImageUri,
    thumbnailUri: record.localThumbnailUri,
  };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function ReceiptForm({ record, onTakePhoto, onSaved, onCancel }: ReceiptFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const draftKey = editing ? record.id : NEW_RECEIPT_DRAFT;

  const initial = useMemo(
    () => (record === undefined ? emptyReceiptDraft() : draftForRecord(record)),
    [record],
  );
  const stored = useReceiptDraftStore((state) => state.drafts[draftKey]);
  const write = useReceiptDraftStore((state) => state.write);
  const clear = useReceiptDraftStore((state) => state.clear);
  const draft = stored ?? initial;

  const capture = useImageCapture();
  const [errors, setErrors] = useState<FieldMessages>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = useCallback(
    (changes: Partial<ReceiptDraft>) => {
      write(draftKey, { ...draft, ...changes });
    },
    [write, draftKey, draft],
  );

  /**
   * Clear one field's error the moment it is edited.
   *
   * A message that stays put while the user fixes the thing it complains about
   * reads as "still wrong", and they stop trusting the messages.
   */
  const clearError = useCallback((field: keyof FieldMessages) => {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  /* --- the photo ------------------------------------------------------- */

  /**
   * Let go of a file the draft was holding.
   *
   * Only safe while ADDING, where nothing has ever referenced it. On an edit
   * the row still points at the original until Save commits, so the unlink is
   * `updateReceipt()`'s to order — see the file header.
   */
  const releaseDraftImage = useCallback(
    (previous: ReceiptDraft) => {
      if (editing) return;
      const uris = [previous.imageUri, previous.thumbnailUri].filter(
        (uri): uri is string => uri !== null,
      );
      if (uris.length === 0) return;
      void unlinkOrphanedImages(uris);
    },
    [editing],
  );

  const chooseFromLibrary = useCallback(() => {
    void (async () => {
      const image = await capture.pickFromLibrary();
      if (image === null) return;
      releaseDraftImage(draft);
      patch({ imageUri: image.imageUri, thumbnailUri: image.thumbnailUri });
    })();
  }, [capture, draft, patch, releaseDraftImage]);

  const removePhoto = useCallback(() => {
    releaseDraftImage(draft);
    patch({ imageUri: null, thumbnailUri: null });
  }, [draft, patch, releaseDraftImage]);

  /* --- the fields ------------------------------------------------------ */

  const setAmount = useCallback(
    (amountMinor: MinorUnits | null) => {
      patch({ amountMinor });
      clearError('amountMinor');
    },
    [patch, clearError],
  );

  const setMerchant = useCallback(
    (merchant: string) => {
      patch({ merchant });
      clearError('merchant');
    },
    [patch, clearError],
  );

  const setCategory = useCallback(
    (category: ReceiptCategory) => {
      patch({ category });
      clearError('category');
    },
    [patch, clearError],
  );

  const setDate = useCallback(
    (purchaseDate: string | null) => {
      patch({ purchaseDate });
      clearError('purchaseDate');
    },
    [patch, clearError],
  );

  const setPaymentMethod = useCallback(
    (paymentMethod: string) => {
      patch({ paymentMethod });
      clearError('paymentMethod');
    },
    [patch, clearError],
  );

  const setNotes = useCallback(
    (notes: string) => {
      patch({ notes });
      clearError('notes');
    },
    [patch, clearError],
  );

  /* --- save ------------------------------------------------------------ */

  const submit = useCallback(() => {
    if (saving) return;

    // Two guards live here rather than in the validator, because the data
    // layer's input type will not ACCEPT a missing amount or date and so has
    // nothing to report. Everything else — an empty merchant, an over-long
    // note — goes to the validator and comes back attached to its field.
    const amountMinor = draft.amountMinor;
    const purchaseDate = draft.purchaseDate;
    if (amountMinor === null || purchaseDate === null) {
      setErrors({
        ...(amountMinor === null ? { amountMinor: 'Enter an amount greater than zero.' } : {}),
        ...(purchaseDate === null
          ? { purchaseDate: 'Choose the date printed on the receipt.' }
          : {}),
      });
      setFormError(null);
      return;
    }

    setSaving(true);
    void (async () => {
      try {
        const result = editing
          ? await saveReceiptEdit(record.id, {
              merchant: draft.merchant,
              amountMinor,
              category: draft.category,
              purchaseDate,
              paymentMethod: draft.paymentMethod,
              notes: draft.notes,
              localImageUri: draft.imageUri,
              localThumbnailUri: draft.thumbnailUri,
            } satisfies ReceiptPatch)
          : await saveNewReceipt({
              merchant: draft.merchant,
              amountMinor,
              category: draft.category,
              purchaseDate,
              paymentMethod: draft.paymentMethod,
              notes: draft.notes,
              // The bytes are already in the sandbox. The row is written last
              // and points at a file that exists — never the reverse.
              localImageUri: draft.imageUri,
              localThumbnailUri: draft.thumbnailUri,
            } satisfies NewReceiptInput);

        if (!result.ok) {
          // Every message lands on its field. Nothing modal, nothing lost —
          // and the photo is still attached, because it lives in the draft.
          setErrors(fieldMessages(result.errors));
          setFormError(formMessage(result.errors));
          setSaving(false);
          return;
        }

        clear(draftKey);
        onSaved(result.value);
      } catch (error) {
        log.error('receipts: save failed', error);
        setFormError('Keeply could not save this. Try again.');
        setSaving(false);
      }
    })();
  }, [saving, draft, editing, record, clear, draftKey, onSaved]);

  // Only the state where the "Choose from library" button below will silently
  // do nothing. Deliberately shorter than `permissionCopy('library','blocked')`
  // — that copy is written for a screen where the permission is the subject;
  // here it is a footnote under a form the user came to fill in.
  const libraryBlocked = capture.library === 'blocked';

  return (
    <FormScreen
      onSubmit={submit}
      testID="receipt-form"
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Save receipt'}
          onPrimary={submit}
          primaryDisabled={saving}
          secondaryLabel="Cancel"
          onSecondary={onCancel}
          testID="receipt-form-actions"
        />
      }>
      <ScreenHeader
        title={editing ? 'Edit receipt' : 'New receipt'}
        subtitle={
          editing ? undefined : 'Amount and merchant are all Keeply needs. The rest is filled in.'
        }
        onBack={onCancel}
        backLabel="Back"
      />

      {formError === null ? null : (
        <View style={styles.formError}>
          <Text variant="caption" color="danger">
            {formError}
          </Text>
        </View>
      )}

      <FormSection
        title="Photo"
        description={
          draft.imageUri === null
            ? 'Optional. A receipt saves perfectly well without one.'
            : 'Stored inside Keeply on this device. It is never uploaded.'
        }>
        <ReceiptImage
          uri={draft.imageUri}
          height={draft.imageUri === null ? 140 : 240}
          emptyLabel="No photo attached"
          testID="receipt-form-photo"
        />

        {capture.error === null ? null : (
          <Text variant="caption" color="danger">
            {capture.error}
          </Text>
        )}

        <View style={styles.photoActions}>
          <Button
            title={draft.imageUri === null ? 'Take a photo' : 'Retake'}
            variant="secondary"
            icon="camera"
            fullWidth
            disabled={capture.busy || saving}
            onPress={() => onTakePhoto(draftKey)}
            accessibilityHint="Opens the camera"
            testID="receipt-form-camera"
          />
          <Button
            title={draft.imageUri === null ? 'Choose from library' : 'Choose a different photo'}
            variant="secondary"
            icon="photo"
            fullWidth
            disabled={capture.busy || saving}
            onPress={chooseFromLibrary}
            accessibilityHint="Opens your photos"
            testID="receipt-form-library"
          />
          {draft.imageUri === null ? null : (
            <Button
              title="Remove the photo"
              variant="dangerGhost"
              icon="trash"
              fullWidth
              disabled={capture.busy || saving}
              onPress={removePhoto}
              accessibilityHint={
                editing
                  ? 'Detaches the photo. It is deleted from this device when you save.'
                  : 'Deletes the photo from this device'
              }
              testID="receipt-form-remove-photo"
            />
          )}
        </View>

        {libraryBlocked ? (
          <View style={styles.permissionNote}>
            <Text variant="caption" color="textSecondary">
              Choosing a photo will not work until the photo library is allowed
              in Settings.
            </Text>
            <Button
              title="Open Settings"
              variant="ghost"
              icon="gear"
              onPress={() => void openAppSettings()}
              accessibilityHint="Opens Keeply in Settings"
              testID="receipt-form-library-settings"
            />
          </View>
        ) : null}
      </FormSection>

      <FormSection>
        <AmountField
          label="Amount"
          value={draft.amountMinor}
          onChangeValue={setAmount}
          error={errors.amountMinor}
          required
          autoFocus={!editing}
          helper="The total printed on the receipt."
          testID="receipt-amount"
        />

        <TextField
          label="Merchant"
          content="organization"
          value={draft.merchant}
          onChangeText={setMerchant}
          placeholder="SM Hypermarket"
          error={errors.merchant}
          required
          maxLength={MERCHANT_MAX_LENGTH}
          clearable
          testID="receipt-merchant"
        />

        <SelectField
          label="Category"
          value={draft.category}
          onChangeValue={setCategory}
          options={CATEGORY_OPTIONS}
          error={errors.category}
          helper="Groups this receipt in your totals and filters"
          accessibilityHint="Opens the list of categories"
          testID="receipt-category"
        />

        <DateField
          label="Purchase date"
          value={draft.purchaseDate}
          onChangeValue={setDate}
          error={errors.purchaseDate}
          required
          // Not `maxDate={today}`: a receipt is dated by what is printed on it,
          // and a till whose clock is a day ahead is not the user's problem to
          // argue with a date picker about.
          helper="Defaults to today — change it if the receipt says otherwise."
          testID="receipt-date"
        />
      </FormSection>

      <FormSection title="Optional" description="Nothing below is needed to save.">
        <TextField
          label="Payment method"
          content="organization"
          value={draft.paymentMethod}
          onChangeText={setPaymentMethod}
          placeholder="GCash"
          error={errors.paymentMethod}
          maxLength={PAYMENT_METHOD_MAX_LENGTH}
          testID="receipt-payment-method"
        />

        <TextField
          label="Notes"
          content="notes"
          value={draft.notes}
          onChangeText={setNotes}
          placeholder="Weekly shop, split with Ana"
          error={errors.notes}
          maxLength={NOTES_MAX_LENGTH}
          rows={3}
          testID="receipt-notes"
        />
      </FormSection>
    </FormScreen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    formError: {
      marginTop: t.layout.section,
      padding: t.space.md,
      borderRadius: t.radius.md,
      backgroundColor: t.color.dangerBg,
    },
    photoActions: { gap: t.space.sm },
    permissionNote: { gap: t.space.xs },
  });
