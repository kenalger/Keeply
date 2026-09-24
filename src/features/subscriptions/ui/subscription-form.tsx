import { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { isDraftDirty, pickDraft, refreshUntouchedRenewal } from './draft';

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
} from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { MinorUnits } from '@/db';
import {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  type NewSubscriptionInput,
  type SubscriptionCategory,
  type SubscriptionPatch,
  type SubscriptionRecord,
} from '@/features/subscriptions';
import { log } from '@/lib/log';
import { nextOccurrence, type BillingCycle } from '@/lib/recurrence';
import {
  lastRememberedCategory,
  useSubscriptionDraftStore,
  type SubscriptionDraft,
} from '@/stores/subscription-draft-store';
import { todayCalendarString, useThemedStyles, type Theme } from '@/theme';

import { CATEGORY_OPTIONS, CYCLE_LABELS } from './labels';
import { fieldMessages, formMessage, type FieldMessages } from './messages';
import { saveNewSubscription, saveSubscriptionEdit } from './mutations';

/**
 * The add / edit subscription form.
 *
 * ── §28: A COMMON RECORD IN UNDER TWENTY SECONDS ───────────────────────────
 * That number is not met by making the form pretty. It is met by removing taps,
 * and every decision below is one:
 *
 *   FIELD ORDER follows a bank statement line, because that is what the user is
 *   reading from: what it is, how much, how often, when next. Category comes
 *   after those four because it is Keeply's question, not the statement's, and
 *   it is already answered by a default.
 *
 *   THE KEYBOARD IS RIGHT ON EVERY FIELD. The name gets word capitalisation and
 *   no autocorrect (`content="organization"` — "Netflix" must not become
 *   "Netflix's"); the amount gets the decimal keypad with a Done bar iOS will
 *   not add itself; the custom interval gets a number pad. Nobody has to switch
 *   keyboards to type a subscription.
 *
 *   EVERYTHING INFERABLE IS DEFAULTED. Monthly, because most subscriptions are.
 *   The renewal date is one cycle from today — always valid, always in the
 *   future — and it FOLLOWS the cycle for as long as the user has not set a
 *   date themselves, so choosing "Yearly" moves it to next year without a
 *   second interaction. The category is the last one used, learned from the
 *   user's own history rather than guessed.
 *
 *   THE COMMON CASE IS TWO ENTRIES: a name and an amount. Everything else is
 *   either defaulted or optional, and the optional fields are in their own
 *   section below the fold so they do not read as work to be done.
 *
 * ── NEVER LOSE WHAT WAS TYPED ──────────────────────────────────────────────
 * State lives in `@/stores/subscription-draft-store`, outside the React tree,
 * so a validation error, a re-mount, a trip to the date picker, or ten minutes
 * in the background all return to exactly what was on screen. A form that
 * clears is a defect, not a nuisance: the user does not retype it, they leave.
 *
 * ── MONEY NEVER STOPS BEING AN INTEGER ─────────────────────────────────────
 * `<AmountField/>` parses text into `MinorUnits` once, at the boundary. The
 * draft holds `MinorUnits | null`, the input handed to the data layer holds
 * `MinorUnits`, and no float or formatted string exists anywhere between the
 * keypad and the `amount_minor` column (§30).
 */

export interface SubscriptionFormProps {
  /** The record being edited, or `undefined` when adding. */
  record?: SubscriptionRecord;
  /** Where to go after a successful write. */
  onSaved: (record: SubscriptionRecord) => void;
  onCancel: () => void;
}

/* -------------------------------------------------------------------------- */
/* Draft shaping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One cycle from today.
 *
 * Deliberately not "today": a renewal date the user has to correct on every
 * single record is worse than no default at all. One cycle out is right often
 * enough to be worth offering, and wrong in a way that is obvious on the row.
 */
function defaultRenewalDate(cycle: BillingCycle, customCycleDays: number | null): string {
  const today = todayCalendarString();
  try {
    return nextOccurrence(today, cycle, customCycleDays);
  } catch {
    // A `custom` cycle with nothing typed in it yet. Today is a valid calendar
    // date and the user is about to choose one anyway.
    return today;
  }
}

function draftForNew(): SubscriptionDraft {
  const cycle: BillingCycle = 'monthly';
  return {
    name: '',
    amountMinor: null,
    billingCycle: cycle,
    customCycleDays: '',
    nextBillingDate: defaultRenewalDate(cycle, null),
    category: lastRememberedCategory() ?? 'other',
    paymentMethod: '',
    notes: '',
    isActive: true,
    dateTouched: false,
    // Nothing to go stale against — a new record has no stored version behind
    // it, so this draft always survives. That is the interrupted-entry case the
    // draft exists for.
    basedOnUpdatedAt: null,
  };
}

function draftForRecord(record: SubscriptionRecord): SubscriptionDraft {
  return {
    name: record.name,
    amountMinor: record.amountMinor,
    billingCycle: record.billingCycle,
    customCycleDays: record.customCycleDays === null ? '' : String(record.customCycleDays),
    nextBillingDate: record.nextBillingDate,
    category: record.category,
    paymentMethod: record.paymentMethod ?? '',
    notes: record.notes ?? '',
    isActive: record.isActive,
    // An existing record's date was chosen by somebody. Never re-derive it.
    dateTouched: true,
    basedOnUpdatedAt: record.updatedAt,
  };
}

/**
 * The four cycles a segmented control can hold at a legible width.
 *
 * `custom` is the fifth, and it is reached by a switch rather than by cramming
 * a fifth segment in: five labels on a 393pt screen truncate, and a control
 * that lies about its own tap targets is worse than one extra tap on the rare
 * option. (§6 lists all five; nothing here narrows the data model.)
 */
const CYCLE_SEGMENTS: readonly SegmentedOption<CalendarCycle>[] = [
  { value: 'weekly', label: CYCLE_LABELS.weekly },
  { value: 'monthly', label: CYCLE_LABELS.monthly },
  { value: 'quarterly', label: 'Quarter' },
  { value: 'yearly', label: CYCLE_LABELS.yearly },
];

type CalendarCycle = Exclude<BillingCycle, 'custom'>;

/** Digits only, and no leading zeros to confuse `Number()`. */
function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 4);
}

function parsedCustomDays(draft: SubscriptionDraft): number | null {
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

export function SubscriptionForm({ record, onSaved, onCancel }: SubscriptionFormProps) {
  const styles = useThemedStyles(makeStyles);
  const editing = record !== undefined;
  const draftKey = editing ? record.id : 'new';

  const initial = useMemo(
    () => (record === undefined ? draftForNew() : draftForRecord(record)),
    [record],
  );
  const stored = useSubscriptionDraftStore((state) => state.drafts[draftKey]);
  const write = useSubscriptionDraftStore((state) => state.write);
  const clear = useSubscriptionDraftStore((state) => state.clear);

  /**
   * A stored draft is used ONLY if it was derived from the record we now hold.
   *
   * `stored ?? initial` let an abandoned draft outrank the database forever.
   * Anything that moved the record since — a save from another screen, pausing
   * it from the detail view — leaves a draft describing a version that no
   * longer exists; and because the patch sends every field, saving would write
   * that whole stale picture back. When the record has moved on, the draft is
   * dropped and the form re-seeds from the record.
   */
  const picked = pickDraft(stored, initial);
  // An untouched renewal date is the app's suggestion, re-derived for TODAY on
  // every render. A 'new' draft resumed days after it was seeded used to keep
  // the date from that day and could save a renewal already in the past (T18).
  const draft = refreshUntouchedRenewal(
    picked,
    defaultRenewalDate(picked.billingCycle, parsedCustomDays(picked)),
  );

  const [errors, setErrors] = useState<FieldMessages>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = useCallback(
    (changes: Partial<SubscriptionDraft>) => {
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

  /**
   * Changing the cycle also moves the renewal date — but only while the user
   * has not chosen one. This is the inference that makes "Yearly" a single tap
   * instead of a tap plus a date picker.
   */
  const applyCycle = useCallback(
    (billingCycle: BillingCycle, customDays: number | null) => {
      patch({
        billingCycle,
        ...(draft.dateTouched
          ? {}
          : { nextBillingDate: defaultRenewalDate(billingCycle, customDays) }),
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

  /**
   * Switch between the calendar cycles and a custom interval.
   *
   * Turning it off returns to Monthly rather than to whatever was selected
   * before — the previous choice is not recoverable from the draft, and
   * silently restoring a half-remembered one is worse than the default.
   */
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
          : { nextBillingDate: defaultRenewalDate('custom', parsedCustomDays(next)) }),
      });
      clearError('customCycleDays');
    },
    [patch, draft, clearError],
  );

  const setDate = useCallback(
    (nextBillingDate: string | null) => {
      patch({ nextBillingDate, dateTouched: true });
      clearError('nextBillingDate');
    },
    [patch, clearError],
  );

  const setCategory = useCallback(
    (category: SubscriptionCategory) => {
      patch({ category });
      clearError('category');
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

  const setActiveFlag = useCallback((isActive: boolean) => patch({ isActive }), [patch]);

  const submit = useCallback(() => {
    if (saving) return;

    // Two guards, and only two, live here rather than in the validator: the
    // data layer's input type will not ACCEPT a missing amount or a missing
    // date, so there is nothing to hand it and nothing for it to report.
    // Everything else — an empty name, an out-of-range interval, a note that is
    // too long — goes to the validator and comes back attached to its field.
    const amountMinor = draft.amountMinor;
    const nextBillingDate = draft.nextBillingDate;
    if (amountMinor === null || nextBillingDate === null) {
      setErrors({
        ...(amountMinor === null
          ? { amountMinor: 'Enter an amount greater than zero.' }
          : {}),
        ...(nextBillingDate === null ? { nextBillingDate: 'Choose a renewal date.' } : {}),
      });
      setFormError(null);
      return;
    }

    const customCycleDays = parsedCustomDays(draft);

    setSaving(true);
    void (async () => {
      try {
        const write = editing
          ? saveSubscriptionEdit(record.id, {
              name: draft.name,
              category: draft.category,
              amountMinor,
              billingCycle: draft.billingCycle,
              customCycleDays,
              nextBillingDate,
              paymentMethod: draft.paymentMethod,
              notes: draft.notes,
              isActive: draft.isActive,
            } satisfies SubscriptionPatch)
          : saveNewSubscription({
              name: draft.name,
              category: draft.category,
              amountMinor,
              billingCycle: draft.billingCycle,
              customCycleDays,
              nextBillingDate,
              paymentMethod: draft.paymentMethod,
              notes: draft.notes,
              isActive: draft.isActive,
            } satisfies NewSubscriptionInput);
        // Held, not delayed: the row is written at once; "Saving…" stays up
        // long enough to be seen. See `BusyOverlay`.
        const result = await holdBusy(write);

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
        log.error('subscriptions: save failed', error);
        setFormError('Keeply could not save this. Try again.');
        setSaving(false);
      }
    })();
  }, [saving, draft, editing, record, clear, draftKey, onSaved]);

  /**
   * Cancel DISCARDS. Navigating away keeps.
   *
   * These are different acts and were being treated as one. Stepping out of a
   * form — backgrounding the app, following a link — is not a decision, and
   * coming back to find it empty is the same defect as a form that clears on a
   * validation error. But pressing Cancel IS a decision, and keeping the draft
   * through it meant the abandoned value came back on the next open looking like
   * the record, and then got written.
   *
   * So only this button clears, and only after confirming when there is
   * something to lose — a silent discard is the other half of the same
   * never-lose-user-input rule.
   */
  const cancel = useCallback(() => {
    const dirty = isDraftDirty(draft, initial);
    if (!dirty) {
      clear(draftKey);
      onCancel();
      return;
    }
    Alert.alert(
      'Discard changes?',
      editing
        ? 'This subscription goes back to how it was. Nothing is deleted.'
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
      testID="subscription-form"
      footer={
        <FormActions
          primaryLabel={editing ? 'Save changes' : 'Add subscription'}
          onPrimary={submit}
          primaryLoading={saving}
          secondaryLabel="Cancel"
          onSecondary={cancel}
          testID="subscription-form-actions"
        />
      }>
      <ScreenHeader
        title={editing ? 'Edit subscription' : 'New subscription'}
        subtitle={
          editing
            ? undefined
            : 'Name and amount are all Keeply needs — the rest is already filled in.'
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
          placeholder="Netflix"
          error={errors.name}
          required
          autoFocus={!editing}
          maxLength={NAME_MAX_LENGTH}
          clearable
          testID="subscription-name"
        />

        <AmountField
          label="Amount"
          value={draft.amountMinor}
          onChangeValue={setAmount}
          error={errors.amountMinor}
          required
          helper="What you are charged each time it renews."
          testID="subscription-amount"
        />

        {draft.billingCycle === 'custom' ? null : (
          <SegmentedField<CalendarCycle>
            label="Billing cycle"
            value={draft.billingCycle}
            onChangeValue={setCycle}
            options={CYCLE_SEGMENTS}
            error={errors.billingCycle}
            required
            testID="subscription-cycle"
          />
        )}

        <SwitchField
          label="Renews on a custom interval"
          value={draft.billingCycle === 'custom'}
          onChangeValue={setUsesCustomCycle}
          description="For anything that does not land on a week, month, quarter or year."
          testID="subscription-custom-toggle"
        />

        {draft.billingCycle === 'custom' ? (
          <TextField
            label="Days between charges"
            content="number"
            value={draft.customCycleDays}
            onChangeText={setCustomDays}
            placeholder="45"
            helper={`Between 1 and ${CUSTOM_CYCLE_DAYS_MAX} days.`}
            error={errors.customCycleDays}
            required
            maxLength={4}
            testID="subscription-custom-days"
          />
        ) : null}

        <DateField
          label="Next renewal"
          value={draft.nextBillingDate}
          onChangeValue={setDate}
          error={errors.nextBillingDate}
          required
          helper="Keeply counts forward from this date every cycle."
          testID="subscription-date"
        />

        <SelectField
          label="Category"
          value={draft.category}
          onChangeValue={setCategory}
          options={CATEGORY_OPTIONS}
          error={errors.category}
          helper="Groups this subscription in your totals and filters"
          accessibilityHint="Opens the list of categories"
          testID="subscription-category"
        />
      </FormSection>

      <FormSection
        title="Optional"
        description="Nothing below is needed to save, or to be reminded.">
        <TextField
          label="Payment method"
          content="organization"
          value={draft.paymentMethod}
          onChangeText={setPaymentMethod}
          placeholder="GCash"
          error={errors.paymentMethod}
          maxLength={PAYMENT_METHOD_MAX_LENGTH}
          testID="subscription-payment-method"
        />

        <TextField
          label="Notes"
          content="notes"
          value={draft.notes}
          onChangeText={setNotes}
          placeholder="Shared family plan"
          error={errors.notes}
          maxLength={NOTES_MAX_LENGTH}
          rows={3}
          testID="subscription-notes"
        />

        {editing ? (
          <SwitchField
            label="Active"
            value={draft.isActive}
            onChangeValue={setActiveFlag}
            description="A paused subscription leaves your monthly total and stops reminding you. It is not deleted."
            testID="subscription-active"
          />
        ) : null}
      </FormSection>
    </FormScreen>
  );
}
