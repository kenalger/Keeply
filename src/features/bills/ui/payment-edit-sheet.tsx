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
 * ── WHAT IS EDITABLE, AND WHAT DELIBERATELY IS NOT ─────────────────────────
 * The three things a person actually gets wrong: what they paid, when they paid
 * it, and how.
 *
 * `dueDate` is NOT here. Moving a payment to a different period re-anchors the
 * recurrence — the oldest live payment IS the anchor every later due date is
 * computed from — so it is a different operation with a different blast radius,
 * and it belongs behind its own deliberate flow rather than in a correction
 * sheet. `status` is not here either: unpaying is `undoBillPayment`, which also
 * rewinds the due date, and a status toggle that did not would leave the bill
 * rolled forward with a hole in its history.
 *
 * ── CLEARING THE AMOUNT IS A REAL ANSWER ───────────────────────────────────
 * `null` means "I paid it but I do not know what it cost" — a variable bill
 * settled before the invoice arrived (§7). The field allows it, and the ledger
 * already renders an em dash for it.
 */
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountField, Button, DateField, Sheet, TextField } from '@/components/ui';
import type { MinorUnits } from '@/db';
import { useThemedStyles, type Theme } from '@/theme';

import type { BillPaymentPatch, BillPaymentRecord } from '../types';

export interface PaymentEditSheetProps {
  visible: boolean;
  /** `null` while closed, so the fields do not have to be reset by the caller. */
  payment: BillPaymentRecord | null;
  saving?: boolean;
  onSave: (paymentId: string, patch: BillPaymentPatch) => void;
  onClose: () => void;
  testID?: string;
}

export function PaymentEditSheet({
  visible,
  payment,
  saving = false,
  onSave,
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
          saving={saving}
          onSave={onSave}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function PaymentEditForm({
  payment,
  saving,
  onSave,
  onClose,
}: {
  payment: BillPaymentRecord;
  saving: boolean;
  onSave: (paymentId: string, patch: BillPaymentPatch) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  const [amount, setAmount] = useState<MinorUnits | null>(payment.amountMinor);
  const [paidDate, setPaidDate] = useState<string | null>(payment.paidDate);
  const [method, setMethod] = useState(payment.paymentMethod ?? '');

  const save = useCallback(() => {
    if (saving) return;
    onSave(payment.id, {
      amountMinor: amount,
      paidDate,
      // An empty box means "no method recorded", not an empty string.
      paymentMethod: method.trim() === '' ? null : method.trim(),
    });
  }, [payment.id, saving, onSave, amount, paidDate, method]);

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
      </View>
      <View style={styles.footer}>
        <Button title="Cancel" variant="secondary" onPress={onClose} />
        <Button title="Save" onPress={save} loading={saving} testID="payment-edit-save" />
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    body: { gap: theme.space.md },
    footer: { flexDirection: 'row', gap: theme.space.sm, justifyContent: 'flex-end' },
  });
