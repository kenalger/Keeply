import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

import { Button } from './button';
import { Icon, type IconName } from './icon';
import { Text } from './text';

/**
 * How much of the screen the emptiness is allowed to claim.
 *
 *  - `hero`    — the centred, full-bleed treatment. Correct when emptiness IS
 *                the screen: a search with no results, a detail view of a
 *                record that has no children yet.
 *  - `compact` — a single ~90pt card in the flow of a screen. Correct when the
 *                screen has more to say than "nothing here", and *especially*
 *                when several sections are empty at once: four heroes stacked
 *                is a screen and a half of placeholder, which is how a new
 *                user's first impression became a scrolling wall of apology.
 *
 * If a screen renders more than one `EmptyState`, at most one of them may be
 * `hero`. In practice that means: don't. Collapse the rest.
 */
export type EmptyStateVariant = 'hero' | 'compact';

export interface EmptyStateProps {
  /** The symbol for whatever is missing — a receipt, a car, a document. */
  icon?: IconName;
  title: string;
  /** One or two sentences. Say what this screen will hold and how to fill it. */
  description?: string;
  /** Alias for {@link EmptyStateProps.description}. */
  body?: string;
  /** See {@link EmptyStateVariant}. Defaults to `hero`. */
  variant?: EmptyStateVariant;
  /** The single action that resolves the emptiness. */
  actionLabel?: string;
  onAction?: () => void;
  /** Leading symbol on the primary action. Defaults to `plus`. */
  actionIcon?: IconName;
  /** Spoken hint for the primary action — say where it goes. */
  actionHint?: string;
  /** A quieter escape hatch: "Learn about backups", "Import data". */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  secondaryActionHint?: string;
  /**
   * Fill the available space and centre vertically. `false` renders inline,
   * for an empty section inside an otherwise populated screen. Ignored by
   * `compact`, which is inline by definition.
   */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The glyph is drawn at size, on the page, with no disc behind it.
 *
 * The disc was a tinted circle around a symbol that already read perfectly
 * well on its own — a container whose only content was one icon, inside a card,
 * inside a section. Without hue it would have been a grey coin; with hue it was
 * still decoration. What communicates "nothing here" is the symbol, the
 * heading and the space around them.
 */
const HERO_ICON = 34;
const COMPACT_ICON = 22;

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.space.xl,
      paddingVertical: t.space.xxl,
    },
    fill: { flex: 1 },
    heroIcon: { marginBottom: t.space.lg },
    title: { marginBottom: t.space.sm },
    body: { maxWidth: 320 },
    actions: {
      marginTop: t.space.xl,
      alignSelf: 'stretch',
      alignItems: 'center',
      gap: t.space.sm,
      maxWidth: 340,
      width: '100%',
    },
    action: { alignSelf: 'stretch' },

    /* ---- compact ---- */
    compact: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.md,
      padding: t.space.lg,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.lg,
    },
    compactIcon: { paddingTop: 2 },
    compactBody: { flex: 1, gap: t.space.xs },
    compactActions: { marginTop: t.space.sm, gap: t.space.sm, alignSelf: 'flex-start' },
  });

/**
 * What a Keeply screen shows when it has nothing to list.
 *
 * ACCESSIBILITY. No `accessible` / `accessibilityLabel` on the container:
 * setting `accessible={false}` alongside a label made the label inert, and
 * grouping the whole block into one element would have swallowed the title's
 * header role and the button. The title, the body and the actions are each
 * their own element, which is what VoiceOver users expect to swipe through.
 */
export function EmptyState({
  icon,
  title,
  description,
  body,
  variant = 'hero',
  actionLabel,
  onAction,
  actionIcon = 'plus',
  actionHint,
  secondaryActionLabel,
  onSecondaryAction,
  secondaryActionHint,
  fill = true,
  style,
  testID,
}: EmptyStateProps) {
  const styles = useThemedStyles(makeStyles);
  const copy = description ?? body;
  const hasPrimary = actionLabel !== undefined && onAction !== undefined;
  const hasSecondary = secondaryActionLabel !== undefined && onSecondaryAction !== undefined;

  if (variant === 'compact') {
    return (
      <View style={[styles.compact, style]} testID={testID}>
        {icon === undefined ? null : (
          <View style={styles.compactIcon}>
            <Icon name={icon} size={COMPACT_ICON} color="textSecondary" />
          </View>
        )}
        <View style={styles.compactBody}>
          <Text variant="bodyStrong" accessibilityRole="header">
            {title}
          </Text>
          {copy === undefined ? null : (
            <Text variant="caption" color="textSecondary">
              {copy}
            </Text>
          )}
          {hasPrimary || hasSecondary ? (
            <View style={styles.compactActions}>
              {hasPrimary ? (
                <Button
                  title={actionLabel}
                  onPress={onAction}
                  icon={actionIcon}
                  accessibilityHint={actionHint}
                />
              ) : null}
              {hasSecondary ? (
                <Button
                  title={secondaryActionLabel}
                  onPress={onSecondaryAction}
                  variant="ghost"
                  accessibilityHint={secondaryActionHint}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, fill ? styles.fill : null, style]} testID={testID}>
      {icon === undefined ? null : (
        <Icon name={icon} size={HERO_ICON} color="textTertiary" style={styles.heroIcon} />
      )}

      <Text variant="heading" align="center" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>

      {copy === undefined ? null : (
        <Text variant="body" color="textSecondary" align="center" style={styles.body}>
          {copy}
        </Text>
      )}

      {hasPrimary || hasSecondary ? (
        <View style={styles.actions}>
          {hasPrimary ? (
            <Button
              title={actionLabel}
              onPress={onAction}
              size="lg"
              icon={actionIcon}
              accessibilityHint={actionHint}
              style={styles.action}
            />
          ) : null}
          {hasSecondary ? (
            <Button
              title={secondaryActionLabel}
              onPress={onSecondaryAction}
              variant="ghost"
              accessibilityHint={secondaryActionHint}
              style={styles.action}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
