import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import {
  AmountField,
  DateField,
  FormActions,
  FormScreen,
  FormSection,
  ScreenHeader,
  SegmentedField,
  SelectField,
  SwitchField,
  Text,
  TextField,
  holdBusy,
  type SegmentedOption,
  type SelectOption,
} from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  type BillCategory,
  type BillPatch,
  type BillRecord,
  type NewBillInput,
} from '@/features/bills';
import { log } from '@/lib/log';
import { nextOccurrence, type BillingCycle } from '@/lib/recurrence';
import { useBillDraftStore, type BillDraft } from '@/stores/bill-draft-store';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { isDraftDirty, pickDraft } from './draft';
import { BILL_CATEGORIES_ORDERED, CYCLE_LABELS, categoryLabel } from './labels';
import { fieldMessages, formMessage, type FieldMessages } from './messages';
import { saveBillEdit, saveNewBill } from './mutations';

/**
 * The add / edit bill form (§7).
 *
 * ── HOW THIS DIFFERS FROM THE SUBSCRIPTION FORM, AND WHY ───────────────────
 * They look alike on purpose — the two sit in the same Money tab and a user
 * should not have to learn them twice. Three differences are real:
 *
 *  1. **The amount is OPTIONAL.** §7's variable bill is one the user cannot
 *     estimate: electricity, water, a phone bill. The subscription form
 *     refuses to save without a number; refusing here would make people invent
 *     one, and an invented ₱1,500 is worse than a blank, because it feeds
 *     totals and reminders as though it were real.
 *  2. **"Amount varies" is a first-class switch**, not a note. Turning it on
 *     changes what the amount field CLAIMS — "Amount" becomes "Expected
 *     amount", and the helper says the actual charge will differ. That is the
 *     whole of §7's expected-vs-actual promise at the point of entry.
 *  3. **The due date defaults to the NEXT occurrence, not today.** Same
 *     reasoning as the subscription form: a date the user must correct on
 *     every record is worse than no default. It follows the cycle until they
 *     touch it.
 *
 * ── WHAT THIS FORM DOES NOT DO ─────────────────────────────────────────────
 * It never marks a bill paid. Settling a period writes a ledger row, moves the
 * due date and re-schedules a reminder — `payBill()` in the data layer — and
 * putting a "paid" switch on an edit form would offer a second, lossy way to
 * do it that skips the ledger entirely. Paying happens on the detail screen
 * and in the list, against the period, which is what a payment belongs to.
 *
 * ── NEVER LOSE WHAT WAS TYPED ──────────────────────────────────────────────
 * State lives in `@/stores/bill-draft-store`, outside the React tree. The trip
 * that kills React state here is the likeliest one in the app: going to look
 * at the actual bill.
 */

export interface BillFormProps {
  /** The record being edited, or `undefined` when adding. */
  record?: BillRecord;
  /** Where to go after a successful write. */
  onSaved: (record: BillRecord) => void;
  onCancel: () => void;
}

/* -------------------------------------------------------------------------- */
/* Draft shaping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One cycle from today.
 *
 * Deliberately not today: a due date the user has to correct on every single
 * record is worse than no default at all.
 */
function defaultDueDate(cycle: BillingCycle, customCycleDays: number | null): string {
  const today = todayCalendarString();
  try {
    return nextOccurrence(today, cycle, customCycleDays);
  } catch {
    // A `custom` cycle with nothing typed in it yet. Today is a valid calendar
    // date and the user is about to choose one anyway.
    return today;
  }
}

function draftForNew(): BillDraft {
  const cycle: BillingCycle = 'monthly';
  return {
    name: '',
    amountMinor: null,
    category: 'other',
    isVariable: false,
    dueDate: defaultDueDate(cycle, null),
    billingCycle: cycle,
    customCycleDays: '',
    isRecurring: true,
    autopay: false,
    paymentMethod: '',
    notes: '',
    isActive: true,
    dateTouched: false,
    basedOnUpdatedAt: null,
  };
}

function draftForRecord(record: BillRecord): BillDraft {
  return {
    name: record.name,
    amountMinor: record.amountMinor,
    category: record.category,
    isVariable: record.isVariable,
    dueDate: record.dueDate,
    billingCycle: record.billingCycle,
    customCycleDays: record.customCycleDays === null ? '' : String(record.customCycleDays),
    isRecurring: record.isRecurring,
    autopay: record.autopay,
    paymentMethod: record.paymentMethod ?? '',
    notes: record.notes ?? '',
    isActive: record.isActive,
    // An existing record's date was chosen by somebody. Never re-derive it.
    dateTouched: true,
    basedOnUpdatedAt: record.updatedAt,
  };
}

/**
 * The four cycles a segmented control holds at a legible width.
 *
 * `custom` is the fifth and is reached by a switch, matching the subscription
 * form: five labels on a 393pt screen truncate, and a control that lies about
 * its own tap targets is worse than one extra tap on the rare option.
 */
const CYCLE_SEGMENTS: readonly SegmentedOption<CalendarCycle>[] = [
  { value: 'weekly', label: CYCLE_LABELS.weekly },
  { value: 'monthly', label: CYCLE_LABELS.monthly },
  { value: 'quarterly', label: 'Quarter' },
  { value: 'yearly', label: CYCLE_LABELS.yearly },
];

type CalendarCycle = Exclude<BillingCycle, 'custom'>;

const CATEGORY_OPTIONS: readonly SelectOption<BillCategory>[] = BILL_CATEGORIES_ORDERED.map(
  (value: BillCategory) => ({ value, label: categoryLabel(value) }),
);

/** Digits only, and no leading zeros to confuse `Number()`. */
function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 4);
}

function parsedCustomDays(draft: BillDraft): number | null {
  if (draft.billingCycle !== 'custom') return null;
  if (draft.customCycleDays.length === 0) return null;
  const parsed = Number(draft.customCycleDays);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    formError: {
      marginTop: t.layout.section,
      padding: t.space.md,
      borderRadius: t.radius.md,
      backgroundColor: t.color.dangerBg,
    },
  });

export function BillForm({ record, onSaved, onCancel }: BillFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const draftKey = editing ? record.id : 'new';

  const initial = useMemo(
    () => (record === undefined ? draftForNew() : draftForRecord(record)),
    [record],
  );
  const stored = useBillDraftStore((state) => state.drafts[draftKey]);
  const write = useBillDraftStore((state) => state.write);
  const clear = useBillDraftStore((state) => state.clear);

  /**
   * A stored draft is used ONLY if it was derived from the record we now hold.
   *
   * See `./draft.ts` — for a bill this is not a corner case, because
   * `payBill()` moves the record without the user editing it.
   */
  const draft = pickDraft(stored, initial);

  const [errors, setErrors] = useState<FieldMessages>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = useCallback(
    (changes: Partial<BillDraft>) => {
      write(draftKey, { ...draft, ...changes });
    },
    [write, draftKey, draft],
  );

  /**
   * Clear one field's error the moment it is edited. A message that stays put
   * while the user fixes the thing it complains about reads as "still wrong".
   */
  const clearError = useCallback((field: keyof FieldMessages) => {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const setName = useCallback(
    (name: string) => {
      patch({ name });
      clearError('name');
    },
    [patch, clearError],
  );

  const setAmount = useCallback(
    (amountMinor: MinorUnits | null) => {
      patch({ amountMinor });
      clearError('amountMinor');
    },
    [patch, clearError],
  );

  const setVariable = useCallback(
    (isVariable: boolean) => patch({ isVariable }),
    [patch],
  );

  /**
   * Changing the cycle also moves the due date — but only while the user has
   * not chosen one. This is the inference that makes "Quarterly" a single tap.
   */
  const applyCycle = useCallback(
    (billingCycle: BillingCycle, customDays: number | null) => {
      patch({
        billingCycle,
        ...(draft.dateTouched ? {} : { dueDate: defaultDueDate(billingCycle, customDays) }),
      });
      clearError('billingCycle');
      clearError('customCycleDays');
    },
    [patch, draft, clearError],
  );

  const setCycle = useCallback(
    (billingCycle: CalendarCycle) => applyCycle(billingCycle, null),
    [applyCycle],
  );

  const setUsesCustomCycle = useCallback(
    (custom: boolean) =>
      custom
        ? applyCycle('custom', parsedCustomDays({ ...draft, billingCycle: 'custom' }))
        : applyCycle('monthly', null),
    [applyCycle, draft],
  );

  const setCustomDays = useCallback(
    (value: string) => {
      const customCycleDays = digitsOnly(value);
      const next = { ...draft, customCycleDays };
      patch({
        customCycleDays,
        ...(draft.dateTouched
          ? {}
          : { dueDate: defaultDueDate('custom', parsedCustomDays(next)) }),
      });
      clearError('customCycleDays');
    },
    [patch, draft, clearError],
  );

  const setDate = useCallback(
    (dueDate: string | null) => {
      patch({ dueDate, dateTouched: true });
      clearError('dueDate');
    },
    [patch, clearError],
  );

  const setCategory = useCallback(
    (category: BillCategory) => {
      patch({ category });
      clearError('category');
    },
    [patch, clearError],
  );

  const setRecurring = useCallback(
    (isRecurring: boolean) => patch({ isRecurring }),
    [patch],
  );

  const setAutopay = useCallback((autopay: boolean) => patch({ autopay }), [patch]);

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

  const setActiveFlag = useCallback((isActive: boolean) => patch({ isActive }), [patch]);

  const submit = useCallback(() => {
    if (saving) return;

    // ONE guard lives here rather than in the validator: the data layer's
    // input type will not accept a missing due date, so there is nothing to
    // hand it and nothing for it to report. The AMOUNT is deliberately not
    // guarded — `null` is a legal, saved value for a variable bill (§7).
    const dueDate = draft.dueDate;
    if (dueDate === null) {
      setErrors({ dueDate: 'Choose a due date.' });
      setFormError(null);
      return;
    }

    const customCycleDays = parsedCustomDays(draft);
    const shared = {
      name: draft.name,
      category: draft.category,
      amountMinor: draft.amountMinor,
      isVariable: draft.isVariable,
      dueDate,
      billingCycle: draft.billingCycle,
      customCycleDays,
      isRecurring: draft.isRecurring,
      autopay: draft.autopay,
      paymentMethod: draft.paymentMethod,
      notes: draft.notes,
      isActive: draft.isActive,
    };

    setSaving(true);
    void (async () => {
      try {
        // Held, not delayed: the row is written at once; "Saving…" stays up
        // long enough to be seen. See `BusyOverlay`.
        const result = await holdBusy(
          editing
            ? saveBillEdit(record.id, shared satisfies BillPatch)
            : saveNewBill(shared satisfies NewBillInput),
        );

        if (!result.ok) {
          // Every message lands on its field. Nothing modal, nothing lost.
          setErrors(fieldMessages(result.errors));
          setFormError(formMessage(result.errors));
          setSaving(false);
          return;
        }

        // Saved: the draft has served its purpose and must not reappear.
        clear(draftKey);
        onSaved(result.value);
      } catch (error) {
        log.error('bills: save failed', error);
        setFormError('Keeply could not save this. Try again.');
        setSaving(false);
      }
    })();
  }, [saving, draft, editing, record, clear, draftKey, onSaved]);

  /**
   * Cancel DISCARDS. Navigating away keeps. (T1 — see the subscription form's
   * comment; the rule is the same and so is the reason.)
   */
  const cancel = useCallback(() => {
    if (!isDraftDirty(draft, initial)) {
      clear(draftKey);
      onCancel();
      return;
    }
    Alert.alert(
      'Discard changes?',
      editing
        ? 'This bill goes back to how it was. Nothing is deleted, and no payment is affected.'
        : 'What you typed here will not be kept.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            clear(draftKey);
            onCancel();
          },
        },
      ],
    );
  }, [draft, initial, clear, draftKey, editing, onCancel]);

  return (
    <FormScreen
      onSubmit={submit}
      busy={saving ? 'Saving…' : null}
      testID="bill-form"
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add bill'}
          onPrimary={submit}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={cancel}
          testID="bill-form-actions"
        />
      }>
      <ScreenHeader
        title={editing ? 'Edit bill' : 'New bill'}
        subtitle={
          editing ? undefined : 'A name and a due date are all Keeply needs.'
        }
        onBack={cancel}
        backLabel="Back"
      />

      {formError === null ? null : (
        <View style={styles.formError}>
          <Text variant="caption" color="danger">
            {formError}
          </Text>
        </View>
      )}

      <FormSection>
        <TextField
          label="Name"
          content="organization"
          value={draft.name}
          onChangeText={setName}
          placeholder="Meralco"
          error={errors.name}
          required
          autoFocus={!editing}
          maxLength={NAME_MAX_LENGTH}
          clearable
          testID="bill-name"
        />

        <AmountField
          label={draft.isVariable ? 'Expected amount' : 'Amount'}
          value={draft.amountMinor}
          onChangeValue={setAmount}
          error={errors.amountMinor}
          helper={
            draft.isVariable
              ? 'Roughly what you expect. Leave it blank if you have no idea yet.'
              : 'Leave blank if the amount is not fixed.'
          }
          testID="bill-amount"
        />

        <SwitchField
          label="The amount varies"
          value={draft.isVariable}
          onChangeValue={setVariable}
          description="Electricity, water, a phone bill. Keeply will show the amount above as an estimate and record what you actually pay."
          testID="bill-variable"
        />

        <DateField
          label="Due date"
          value={draft.dueDate}
          onChangeValue={setDate}
          error={errors.dueDate}
          required
          helper="Keeply counts forward from this date every cycle."
          testID="bill-date"
        />

        {draft.billingCycle === 'custom' || !draft.isRecurring ? null : (
          <SegmentedField<CalendarCycle>
            label="How often"
            value={draft.billingCycle}
            onChangeValue={setCycle}
            options={CYCLE_SEGMENTS}
            error={errors.billingCycle}
            required
            testID="bill-cycle"
          />
        )}

        {draft.isRecurring ? (
          <SwitchField
            label="Arrives on a custom interval"
            value={draft.billingCycle === 'custom'}
            onChangeValue={setUsesCustomCycle}
            description="For anything that does not land on a week, month, quarter or year."
            testID="bill-custom-toggle"
          />
        ) : null}

        {draft.isRecurring && draft.billingCycle === 'custom' ? (
          <TextField
            label="Days between bills"
            content="number"
            value={draft.customCycleDays}
            onChangeText={setCustomDays}
            placeholder="45"
            helper={`Between 1 and ${CUSTOM_CYCLE_DAYS_MAX} days.`}
            error={errors.customCycleDays}
            required
            maxLength={4}
            testID="bill-custom-days"
          />
        ) : null}

        <SwitchField
          label="This bill repeats"
          value={draft.isRecurring}
          onChangeValue={setRecurring}
          description="Turn off for a one-off bill. It will not move to a new period when you mark it paid."
          testID="bill-recurring"
        />

        <SelectField
          label="Category"
          value={draft.category}
          onChangeValue={setCategory}
          options={CATEGORY_OPTIONS}
          error={errors.category}
          helper="Groups this bill in your totals and filters"
          accessibilityHint="Opens the list of categories"
          testID="bill-category"
        />
      </FormSection>

      <FormSection
        title="Optional"
        description="Nothing below is needed to save, or to be reminded.">
        <SwitchField
          label="Paid automatically"
          value={draft.autopay}
          onChangeValue={setAutopay}
          description="Keeply still reminds you, so you can check it went through."
          testID="bill-autopay"
        />

        <TextField
          label="Payment method"
          content="organization"
          value={draft.paymentMethod}
          onChangeText={setPaymentMethod}
          placeholder="GCash"
          error={errors.paymentMethod}
          maxLength={PAYMENT_METHOD_MAX_LENGTH}
          testID="bill-payment-method"
        />

        <TextField
          label="Notes"
          content="notes"
          value={draft.notes}
          onChangeText={setNotes}
          placeholder="Account 1234-5678"
          error={errors.notes}
          maxLength={NOTES_MAX_LENGTH}
          rows={3}
          testID="bill-notes"
        />

        {editing ? (
          <SwitchField
            label="Active"
            value={draft.isActive}
            onChangeValue={setActiveFlag}
            description="An archived bill leaves your totals and stops reminding you. Its payment history is kept."
            testID="bill-active"
          />
        ) : null}
      </FormSection>
    </FormScreen>
  );
}
