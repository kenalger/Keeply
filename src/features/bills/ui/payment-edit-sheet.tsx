/**
 * Keeply — correct a payment that is already in the ledger (§7).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `saveBillPaymentEdit()` has been written, tested and exported since Phase 3
 * with no caller. The ledger on the bill detail screen rendered each settled
 * period as a flat, untappable row — so a payment entered with the wrong amount
 * or the wrong date could only be undone and re-entered, and `undoBillPayment`
 * only reaches the MOST RECENT one. Anything older than that was simply wrong
 * forever.
 *
 * ── WHAT IS EDITABLE, AND HOW ──────────────────────────────────────────────
 * The three things a person actually gets wrong: what they paid, when they paid
 * it, and how. Those are the fields.
 *
 * WHICH PERIOD the payment settles (`dueDate`) is editable too, but behind a
 * second, deliberate step rather than as a fourth field. Moving a payment can
 * re-anchor the recurrence: the oldest live payment IS the anchor every later
 * due date is computed from, so re-dating THAT row changes when the whole
 * series falls due from then on. The step says so when it applies
 * (`anchorDate`) and says the narrower truth when it does not. The data layer
 * refuses a move onto a period the ledger already covers (`already-paid`) —
 * the double count `payBill()` guards against, arriving through the other
 * door — and the refusal is shown here, in the sheet, not behind it.
 *
 * `status` is not here: unpaying is `undoBillPayment`, which also rewinds the
 * due date, and a status toggle that did not would leave the bill rolled
 * forward with a hole in its history.
 *
 * ── REMOVING A PAYMENT ─────────────────────────────────────────────────────
 * `deleteBillPayment()` had no caller either: a period recorded against the
 * wrong bill could be zeroed but never removed. The button here is the caller.
 * The data layer refuses the one removal that would silently re-date the
 * series (`anchor-row`, the oldest live row with others behind it), and
 * `messages.ts` has the sentence for it: move the row instead, which is the
 * operation that means "the series started somewhere else" and says so.
 *
 * ── CLEARING THE AMOUNT IS A REAL ANSWER ───────────────────────────────────
 * `null` means "I paid it but I do not know what it cost" — a variable bill
 * settled before the invoice arrived (§7). The field allows it, and the ledger
 * already renders an em dash for it.
 */
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountField, Button, DateField, Sheet, Text, TextField } from '@/components/ui';
import type { MinorUnits } from '@/db';
import { useThemedStyles, type Theme } from '@/theme';

import type { BillPaymentPatch, BillPaymentRecord } from '../types';

export interface PaymentEditSheetProps {
  visible: boolean;
  /** `null` while closed, so the fields do not have to be reset by the caller. */
  payment: BillPaymentRecord | null;
  /**
   * The bill's recurrence anchor — the oldest live payment's period. The move
   * step warns differently when the payment being moved IS the anchor.
   */
  anchorDate: string | null;
  saving?: boolean;
  /** The last write's failure, shown inside the sheet while it is open. */
  error?: string | null;
  onSave: (paymentId: string, patch: BillPaymentPatch) => void;
  /** Asks the screen to confirm and remove this payment. */
  onDelete: (paymentId: string) => void;
  onClose: () => void;
  testID?: string;
}

export function PaymentEditSheet({
  visible,
  payment,
  anchorDate,
  saving = false,
  error = null,
  onSave,
  onDelete,
  onClose,
  testID,
}: PaymentEditSheetProps) {
  return (
    <Sheet
      visible={visible && payment !== null}
      onClose={onClose}
      busy={saving ? 'Saving…' : null}
      title="Correct this payment"
      subtitle="What was actually paid, and when."
      testID={testID}
    >
      {payment === null ? null : (
        // ── KEYED, NOT SYNCED ────────────────────────────────────────────────
        // The fields start from the row that was opened. An effect copying the
        // record into state would be a setState inside an effect — which this
        // project's lint config treats as an error, and rightly: it renders
        // once with the wrong values and again with the right ones.
        //
        // Mounting the form with the payment's id as its key gets the same
        // result from React's own machinery. A different row is a different
        // component instance with its own initial state; the SAME row reopened
        // keeps what was typed.
        <PaymentEditForm
          key={payment.id}
          payment={payment}
          anchorDate={anchorDate}
          saving={saving}
          error={error}
          onSave={onSave}
          onDelete={onDelete}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function PaymentEditForm({
  payment,
  anchorDate,
  saving,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  payment: BillPaymentRecord;
  anchorDate: string | null;
  saving: boolean;
  error: string | null;
  onSave: (paymentId: string, patch: BillPaymentPatch) => void;
  onDelete: (paymentId: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  const [amount, setAmount] = useState<MinorUnits | null>(payment.amountMinor);
  const [paidDate, setPaidDate] = useState<string | null>(payment.paidDate);
  const [method, setMethod] = useState(payment.paymentMethod ?? '');

  // The second step. Nothing about the period is sent unless the step was
  // opened AND the date actually changed — reopening it and saving is a no-op.
  const [moving, setMoving] = useState(false);
  const [dueDate, setDueDate] = useState<string | null>(payment.dueDate);
  const isAnchor = anchorDate !== null && payment.dueDate === anchorDate;
  const moved = moving && dueDate !== null && dueDate !== payment.dueDate;

  const save = useCallback(() => {
    if (saving) return;
    onSave(payment.id, {
      amountMinor: amount,
      paidDate,
      // An empty box means "no method recorded", not an empty string.
      paymentMethod: method.trim() === '' ? null : method.trim(),
      ...(moved && dueDate !== null ? { dueDate } : {}),
    });
  }, [payment.id, saving, onSave, amount, paidDate, method, moved, dueDate]);

  return (
    <>
      <View style={styles.body}>
        <AmountField
          label="Amount paid"
          value={amount}
          onChangeValue={setAmount}
          currency={payment.currency}
          helper="Leave it empty if you do not know what it cost."
          testID="payment-edit-amount"
        />
        <DateField
          label="Paid on"
          value={paidDate}
          onChangeValue={setPaidDate}
          clearable
          testID="payment-edit-paid-date"
        />
        <TextField
          label="How you paid"
          content="organization"
          value={method}
          onChangeText={setMethod}
          placeholder="GCash, bank transfer, cash"
          testID="payment-edit-method"
        />

        {moving ? (
          <DateField
            label="Period due on"
            value={dueDate}
            onChangeValue={setDueDate}
            presets={[]}
            helper={
              isAnchor
                ? 'This is the oldest payment on record — the date every later period is counted from. Moving it changes when the whole series falls due from now on.'
                : 'Only this payment moves. The bill’s own dates do not change.'
            }
            testID="payment-edit-due-date"
          />
        ) : (
          <Button
            title="Move to a different period"
            variant="ghost"
            onPress={() => setMoving(true)}
            accessibilityHint="Shows a date, to record this payment against a different period"
            testID="payment-edit-move"
          />
        )}

        {error === null ? null : (
          <Text variant="caption" color="danger" testID="payment-edit-error">
            {error}
          </Text>
        )}
      </View>
      <View style={styles.footer}>
        <Button
          title="Remove"
          variant="dangerGhost"
          icon="trash"
          disabled={saving}
          onPress={() => onDelete(payment.id)}
          accessibilityLabel="Remove this payment"
          accessibilityHint="Asks you to confirm before removing it from the history"
          testID="payment-edit-delete"
        />
        <View style={styles.spacer} />
        <Button title="Cancel" variant="secondary" onPress={onClose} />
        <Button title="Save" onPress={save} loading={saving} testID="payment-edit-save" />
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    body: { gap: theme.space.md },
    footer: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
    // Remove sits on the left, away from Save — the same separation
    // `FormActions` keeps between the affirmative and the destructive action.
    spacer: { flex: 1 },
  });
