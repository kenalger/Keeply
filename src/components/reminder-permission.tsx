import { useCallback } from 'react';

import { Button, EmptyState, ListBlock, ListGroup, Row, Sheet, Text } from '@/components/ui';
import {
  notificationPrePrompt,
  useNotificationStore,
  useReminderPermissionView,
} from '@/stores/notification-store';

/**
 * Telling the truth about reminders, in two pieces.
 *
 * ── WHY THE APP ASKS HERE AND NOT AT LAUNCH ────────────────────────────────
 * On iOS the system prompt happens ONCE, ever, and a refusal is permanent
 * (`plan/onboarding.md` F4). Spending that one prompt on launch — before the
 * user has a single record — is a coin flip on the feature that is this app's
 * whole retention mechanism. So Keeply asks at the first moment the answer
 * means something concrete: immediately after the user's first subscription is
 * saved, when "remind me before Netflix renews" is a sentence about their own
 * data rather than a generic plea.
 *
 * Keeply's own explanation comes first (`notificationPrePrompt()`), and the OS
 * dialog only appears if the user says yes to that. A "not now" costs nothing —
 * the record is saved either way, and the note below stays available.
 *
 * ── AND WHEN THE ANSWER WAS NO ─────────────────────────────────────────────
 * `ReminderPermissionNote` states the situation without pretending the app is
 * broken, and offers the only action that can actually change it — a prompt
 * where one is still possible, the Settings app where it is not. Those are
 * different states (`denied` vs `blocked`) and conflating them produces a
 * button that does nothing.
 */

/* -------------------------------------------------------------------------- */
/* The pre-prompt                                                              */
/* -------------------------------------------------------------------------- */

export interface ReminderPrePromptProps {
  visible: boolean;
  onClose: () => void;
}

/** Keeply's own ask, shown before the OS dialog. Never shown twice a launch. */
export function ReminderPrePrompt({ visible, onClose }: ReminderPrePromptProps) {
  const copy = notificationPrePrompt();
  const busy = useNotificationStore((state) => state.busy);
  const prompt = useNotificationStore((state) => state.prompt);
  const markSeen = useNotificationStore((state) => state.markPrePromptSeen);

  const accept = useCallback(() => {
    void prompt().finally(onClose);
  }, [prompt, onClose]);

  const decline = useCallback(() => {
    // The OS was never asked, so the one prompt is still available later.
    markSeen();
    onClose();
  }, [markSeen, onClose]);

  return (
    <Sheet
      visible={visible}
      onClose={decline}
      title={copy.title}
      testID="reminder-pre-prompt"
      footer={
        <>
          <Button
            title={copy.action ?? 'Turn on reminders'}
            size="lg"
            fullWidth
            disabled={busy}
            onPress={accept}
            testID="reminder-pre-prompt-accept"
          />
          <Button title="Not now" variant="ghost" fullWidth onPress={decline} />
        </>
      }>
      <Text variant="body" color="textSecondary">
        {copy.body}
      </Text>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */
/* The standing note                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How much of the screen this notice is allowed to take.
 *
 *  - `card` — glyph, heading, two sentences and a button. ~165pt. Correct
 *    where the permission IS the subject: the onboarding step, a settings
 *    screen, the moment after a first record is saved.
 *  - `row`  — one grouped row: glyph, heading, one line, chevron. ~70pt.
 *    Correct on a screen the user came to for something else.
 *
 * The card was on the subscription list AND on every subscription detail
 * screen, where it outweighed the content it was a footnote to and repeated
 * the same two sentences on every record the user opened. Same message, same
 * one tap to resolve it, a third of the height.
 */
export type ReminderNoteDensity = 'card' | 'row';

export interface ReminderPermissionNoteProps {
  /** Defaults to `row` — the repeat placement, which is most of them. */
  density?: ReminderNoteDensity;
}

/**
 * A notice explaining why no reminder is coming, or `null` when one is.
 *
 * Never a hero: this is a footnote on a screen that has real content, and
 * `EmptyState`'s own rules say at most one hero per screen.
 */
export function ReminderPermissionNote({ density = 'row' }: ReminderPermissionNoteProps = {}) {
  const { message, canDeliver, canPrompt, mustUseSettings, busy } =
    useReminderPermissionView();
  const prompt = useNotificationStore((state) => state.prompt);
  const openSettings = useNotificationStore((state) => state.openSettings);

  const act = useCallback(() => {
    if (canPrompt) {
      void prompt();
      return;
    }
    void openSettings();
  }, [canPrompt, prompt, openSettings]);

  if (canDeliver || message === null) return null;

  const actionable = (canPrompt || mustUseSettings) && !busy;
  const hint = canPrompt
    ? 'Asks iOS for permission to send reminders'
    : 'Opens Keeply in Settings';

  // The block gap lives INSIDE the component, after the `null` guard above:
  // a caller that wrapped this in its own `<ListBlock/>` would leave 24pt of
  // empty gap behind on every screen where the permission is already granted
  // and this renders nothing.
  if (density === 'row') {
    return (
      <ListBlock>
        <ListGroup position="only">
        <Row
            icon="bell"
            title={message.title}
            // Short on purpose. The row states the situation and the tap; the
            // long-form explanation belongs to the `card` density, which is
            // shown where this notice is the point of the screen.
            subtitle={
              actionable
                ? (message.action ?? 'Turn on reminders')
                : 'Reminders cannot be scheduled on this device.'
            }
            onPress={actionable ? act : undefined}
            accessibilityLabel={`${message.title}. ${message.body}`}
            accessibilityHint={actionable ? hint : undefined}
            testID="reminder-permission-note"
          />
        </ListGroup>
      </ListBlock>
    );
  }

  return (
    <ListBlock>
      <EmptyState
        variant="compact"
        icon="bell"
        title={message.title}
        description={message.body}
        actionLabel={actionable ? (message.action ?? 'Turn on reminders') : undefined}
        onAction={actionable ? act : undefined}
        actionIcon="bell"
        actionHint={hint}
        testID="reminder-permission-note"
      />
    </ListBlock>
  );
}
