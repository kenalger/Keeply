import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { ReminderPrePrompt } from '@/components/reminder-permission';
import { SubscriptionForm } from '@/features/subscriptions/ui';
import type { SubscriptionRecord } from '@/features/subscriptions';
import { useNotificationStore } from '@/stores/notification-store';

/**
 * Add a subscription (§28).
 *
 * ── WHERE IT GOES AFTERWARDS ───────────────────────────────────────────────
 * `replace`, not `push`, and to the LIST rather than back to wherever the user
 * came from. Replace, because Back out of a saved record should not return to
 * the form that created it. The list, because the point of the twenty-second
 * bar is the payoff at the end of it: the row, the new monthly total and the
 * renewal countdown are all on that screen, so the user sees what their typing
 * bought immediately (`plan/onboarding.md` step 4).
 *
 * ── AND WHY THE NOTIFICATION PROMPT IS HERE ────────────────────────────────
 * This is the first moment in the app where "remind me before this renews" is
 * a sentence about the user's own data. On iOS the OS prompt happens once ever
 * and a refusal is permanent (F4), so it is spent here rather than at launch —
 * and only after Keeply has explained itself first, and only if the OS will
 * still show a dialog at all. Declining costs nothing: the record is already
 * saved by the time this appears.
 */
export default function NewSubscriptionScreen() {
  const router = useRouter();
  const [prePrompt, setPrePrompt] = useState(false);
  const [saved, setSaved] = useState<SubscriptionRecord | null>(null);

  const leave = useCallback(() => {
    router.replace('/subscriptions');
  }, [router]);

  const onSaved = useCallback(
    (record: SubscriptionRecord) => {
      const { canPrompt, prePromptSeen } = useNotificationStore.getState();
      if (canPrompt && !prePromptSeen) {
        // Stay on this screen for the ask — navigating first would put the
        // sheet on top of a screen that is still transitioning.
        setSaved(record);
        setPrePrompt(true);
        return;
      }
      leave();
    },
    [leave],
  );

  // Never a dead end: opened from the add sheet there is a stack to pop, but a
  // deep link straight into the form has none.
  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/subscriptions');
  }, [router]);

  return (
    <>
      <SubscriptionForm onSaved={onSaved} onCancel={cancel} />
      <ReminderPrePrompt
        visible={prePrompt}
        onClose={() => {
          setPrePrompt(false);
          // Whatever the answer, the record exists and the list is where it is.
          if (saved !== null) leave();
        }}
      />
    </>
  );
}
