import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/theme';

import { IconButton } from './icon-button';
import { Text } from './text';

export interface ScreenHeaderProps {
  title: string;
  /** One line of context under the title — a total, a count, a date range. */
  subtitle?: string;
  /** Right-hand control. Usually an `<IconButton />` or a small `<Button />`. */
  right?: ReactNode;
  /** Renders a back chevron on the left. */
  onBack?: () => void;
  /** Label announced for the back control. Defaults to "Back". */
  backLabel?: string;
  /** Anything that sits under the title: a search field, filter chips. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // The header owns NEITHER edge of its own band.
    //
    // Above: `layout.headerTop` is the single design gap between the
    // safe-area inset and the first header row, and it is zero — the inset is
    // hardware clearance, not spacing, and adding `space.md` on top of it was
    // a second gap chosen by a second component. Below: whatever comes next
    // owns the gap above itself, so a `paddingBottom` here would stack onto
    // it — which is what produced 40pt of nothing under every header.
    root: { paddingTop: t.layout.headerTop },
    /**
     * Every control the header has, on ONE row — and only where a row is
     * unavoidable.
     *
     * There used to be up to three y positions above a title: a `space.md`
     * band, the back chevron on a line of its own, and the screen's actions
     * pinned to the top-right of the title below it. Nothing was aligned to
     * anything.
     *
     * A pushed screen has to spend a row on the back control, so the screen's
     * actions join it and share its baseline. A TAB screen has no back
     * control, and reserving the row anyway — to make the two kinds of screen
     * put their titles at the same y — would buy that alignment with 44pt of
     * blank above five titles, which is precisely the "invisible open space"
     * this pass exists to remove. So a tab screen spends no row: its action
     * rides the title's own line, where it is still on one baseline with the
     * only other control on the screen.
     *
     * The negative horizontal margin pulls the buttons' own 12pt of padding
     * out of the gutter so the GLYPHS, not their tap targets, sit on the same
     * vertical line as the title and the cards below.
     */
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: t.layout.controlRow,
      marginHorizontal: -t.space.md,
    },
    navActions: { flexDirection: 'row', alignItems: 'center' },
    // Top-aligned, not centred: a two-line subtitle would otherwise drag the
    // action down beside the subtitle instead of beside the title it acts on.
    titleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: t.space.md,
    },
    titleText: { flex: 1 },
    subtitle: { marginTop: t.space.xs },
    // Same trick as `navRow`: the glyph lands on the gutter, not the target.
    titleActions: { flexDirection: 'row', alignItems: 'center', marginRight: -t.space.md },
    children: { marginTop: t.layout.section },
  });

/**
 * The large-title header. Kept as a plain component rather than a navigator
 * option so it composes with anything a screen wants to hang beneath it.
 *
 * ── THE VERTICAL ANATOMY, TOP TO BOTTOM ────────────────────────────────────
 *   safe-area inset   applied by `<Screen/>` / `<FormScreen/>`, once, and by
 *                     nothing else. Hardware clearance.
 *   headerTop         the single design gap above the header. Zero.
 *   control row       back on the left, the screen's actions on the right,
 *                     `controlRow` tall. Present only on a screen that has a
 *                     back control — see `navRow` for why it is not reserved
 *                     on the screens that do not.
 *   title / subtitle  with the actions on the title's line where there was no
 *                     control row for them to join.
 *   children          a search field, filter chips — `section` below the title.
 *
 * Nothing else contributes a top edge, and every band is either occupied or
 * absent. A title therefore sits at the inset, or at the inset plus one
 * control row, and never at some third position arrived at by addition.
 */
export function ScreenHeader({
  title,
  subtitle,
  right,
  onBack,
  backLabel = 'Back',
  children,
  style,
  testID,
}: ScreenHeaderProps) {
  const styles = useThemedStyles(makeStyles);
  const hasBack = onBack !== undefined;
  const hasRight = right !== undefined;

  return (
    <View style={[styles.root, style]} testID={testID}>
      {hasBack ? (
        <View style={styles.navRow}>
          <IconButton name="chevronLeft" accessibilityLabel={backLabel} onPress={onBack} />
          {hasRight ? <View style={styles.navActions}>{right}</View> : null}
        </View>
      ) : null}

      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          <Text variant="title" accessibilityRole="header" numberOfLines={2}>
            {title}
          </Text>
          {subtitle === undefined ? null : (
            <Text variant="body" color="textSecondary" style={styles.subtitle}>
              {subtitle}
            </Text>
          )}
        </View>
        {!hasBack && hasRight ? <View style={styles.titleActions}>{right}</View> : null}
      </View>

      {children === undefined ? null : <View style={styles.children}>{children}</View>}
    </View>
  );
}
