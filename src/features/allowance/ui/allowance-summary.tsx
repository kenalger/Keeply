import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { AllowanceCard, allowanceCardState } from './allowance-card';
import { useAllowanceCadence, useAllowanceStatus } from './hooks';

/**
 * The allowance card, wired to its own data and its own route.
 *
 * Home and the Money tab both render THIS rather than each calling the hooks
 * and assembling a card: two call sites means two chances to pass a different
 * cadence, and a dashboard that says "₱10,409 left this month" on one screen
 * and "₱4,200 left this week" on the next — both true, both unlabelled — is
 * indistinguishable from a bug.
 *
 * It also exists because `HomeRowView` is a `switch` over row kinds, and a hook
 * cannot live inside one branch of a switch. The row renders a component; the
 * component reads.
 */
export function AllowanceSummary({ testID }: { testID?: string }) {
  const router = useRouter();
  const { cadence, ready } = useAllowanceCadence();
  const status = useAllowanceStatus(cadence);
  // The skeleton is for the FIRST read of the user's OWN cadence only. A
  // refresh after a write keeps the last figures on screen, because a local
  // read is a millisecond and a card that blinks on every save is worse than
  // one that is a frame stale (§25). The default cadence's figure, read before
  // the preference lands, is not stale — it is wrong; see `allowanceCardState`.
  const card = allowanceCardState(status, cadence, ready);

  const open = useCallback(() => router.push('/allowance'), [router]);

  return (
    <AllowanceCard
      status={card.status}
      loading={card.loading}
      error={status.error}
      onPress={open}
      onRetry={status.reload}
      onSetAllowance={open}
      testID={testID}
    />
  );
}
