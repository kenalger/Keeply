import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import {
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
  type ListRenderItem,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/theme';

import { SkeletonList } from './skeleton';
import { Text } from './text';

/**
 * The virtualized list primitive.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `data.map(...)` inside a `<ScrollView>` mounts every row at once. It ships
 * fine with ten rows and becomes a memory and scroll-jank bug at a thousand —
 * which is exactly what a receipt journal or a bill history becomes after a
 * year of use (§33: "use pagination or virtualization for large lists"). Every
 * list in Keeply goes through here so nobody has to remember that.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────
 *  - `renderItem` and `keyExtractor` must be STABLE references (module scope,
 *    or `useCallback`). A new function identity on every render defeats the
 *    row memoization this component's performance depends on.
 *  - The component `renderItem` returns should itself be `memo`-ised, and must
 *    not build style objects inline — pass `StyleSheet` entries.
 *  - `keyExtractor` must return a STABLE, unique id (the row's UUID), never the
 *    array index. An index key re-uses the wrong row on insert or delete.
 *  - NEVER put a `<List/>` inside a `<Screen scroll>` (or any other ScrollView)
 *    on the same axis. Two nested scrollers on one axis disable virtualization
 *    entirely — the inner list renders every row, which is the bug this
 *    component exists to prevent. A screen that needs several sections is ONE
 *    list whose data is the flattened rows; see `src/app/(tabs)/index.tsx`.
 *
 * All four render states are handled here rather than at each call site:
 * loading (skeleton), error, empty, populated.
 */

/** Where a row sits inside a run of rows that should read as one card. */
export type GroupPosition = 'only' | 'first' | 'middle' | 'last';

export interface ListProps<ItemT> {
  /** The rows. `null`/`undefined` is treated as empty, not as an error. */
  data: readonly ItemT[] | null | undefined;
  /** Stable reference — see the rules above. */
  renderItem: ListRenderItem<ItemT>;
  /** Stable, unique row id. Never the index. */
  keyExtractor: (item: ItemT, index: number) => string;

  /**
   * Fixed row height in points. Supplying it enables `getItemLayout`, which
   * removes per-row measurement and makes `scrollToIndex` exact. Only pass it
   * when every row really is this tall — a wrong value mis-positions the list.
   */
  itemHeight?: number;

  /** Hairline between rows. Defaults to `hairline`. */
  separator?: 'none' | 'hairline';
  /**
   * Symmetric inset of the separator, overriding `theme.layout.separatorInset`.
   * `0` is full-bleed.
   */
  separatorInset?: number;

  /** Card chrome (surface, hairline border, radius) around the whole list. */
  surface?: 'plain' | 'card';

  /**
   * Fill the parent's main axis. Defaults to `true`, which is right for a list
   * that owns a screen.
   *
   * Turn it OFF inside a parent that has no height of its own and sizes to its
   * content — a `<Sheet/>` is the case in this app. A filling list resolves to a
   * flex basis of 0 there, lays out at ZERO height, and the sheet opens as a
   * title with nothing under it. With `fill={false}` the list sizes to its
   * content, the parent's own `maxHeight` clamps it, and it scrolls inside that.
   *
   * ── WHY THIS IS A PROP AND NOT A STYLE OVERRIDE ──────────────────────────
   * Because the override is not guessable and was already gotten wrong once.
   * `fill` resolves to `flex: 0` — and it has to be `flex` itself. Passing
   * `style={{ flexGrow: 0, flexShrink: 1, flexBasis: 'auto' }}` looks like it
   * resets the shorthand and does NOT: Yoga derives the basis from `flex`
   * whenever the longhand is absent *or* `auto` (`Node::processFlexBasis`,
   * ReactCommon/yoga):
   *
   *     if (!flexBasis.isAuto() && !flexBasis.isUndefined()) return flexBasis;
   *     if (flex.isDefined() && flex.unwrap() > 0.0f) return points(0);
   *     return ofAuto();
   *
   * So `flexBasis: 'auto'` takes the same branch as unset, falls through to
   * `flex > 0`, and still yields a basis of 0 (RN does not enable Yoga's web
   * defaults). Only a concrete length short-circuits, and only overriding `flex`
   * disarms the fallthrough. One prop here beats that paragraph at every call
   * site.
   */
  fill?: boolean;

  /** Show the skeleton instead of rows. Wins over `empty`. */
  loading?: boolean;
  /** Skeleton rows to draw while loading. Defaults to 4. */
  skeletonCount?: number;
  /** Reserve skeleton space for a leading icon/avatar. Defaults to `true`. */
  skeletonLeading?: boolean;

  /** Shown instead of rows when something went wrong. Wins over everything. */
  error?: ReactNode;
  /** Shown when there are no rows and nothing is loading. Design it. */
  empty?: ReactNode;

  header?: ReactNode;
  footer?: ReactNode;

  refreshing?: boolean;
  onRefresh?: () => void;
  onEndReached?: () => void;

  /**
   * Anything `renderItem` closes over that is not part of `data`. Treat it as
   * immutable — it is FlatList's re-render marker.
   */
  extraData?: unknown;

  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    /* `fill={false}` — see the prop. `flex: 0` is load-bearing; `flexShrink: 1`
       is what lets the parent's `maxHeight` clamp the list so it scrolls. */
    sizeToContent: { flex: 0, flexShrink: 1 },
    card: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.lg,
      overflow: 'hidden',
    },
    separator: {
      height: t.hairline,
      backgroundColor: t.color.border,
      marginHorizontal: t.layout.separatorInset,
    },
    stateBox: { paddingVertical: t.space.md },

    /* Grouped-row chrome — see `ListGroup`. */
    group: {
      // The group owns the fill; rows are transparent and sit on it.
      backgroundColor: t.color.surface,
      // A pressed row paints opaquely, which would square off the rounded
      // corners of the first and last row without this.
      overflow: 'hidden',
    },
    groupTop: { borderTopLeftRadius: t.radius.lg, borderTopRightRadius: t.radius.lg },
    groupBottom: { borderBottomLeftRadius: t.radius.lg, borderBottomRightRadius: t.radius.lg },
    // The ONLY line in a group, and it earns its place: it divides two rows
    // that share one fill, which nothing else in the layout can express.
    //
    // Inset SYMMETRICALLY — see `ThemeLayout.separatorInset` for why it is no
    // longer inset on the left to the text column and flush to the right edge.
    groupSeparator: {
      height: t.hairline,
      marginHorizontal: t.layout.separatorInset,
      backgroundColor: t.color.border,
    },

    /* Furniture for a flattened, section-per-run list — see `ListSectionHeader`. */
    /* Every one of these owns the gap ABOVE itself and none owns the gap
       below, so two adjacent blocks contribute one gap. See `ThemeLayout`. */
    sectionTitle: { textTransform: 'uppercase' },
    sectionHeader: { paddingTop: t.layout.section, paddingBottom: t.layout.heading },
    note: { paddingTop: t.layout.caption },
    blockSection: { paddingTop: t.layout.section },
    blockBlock: { paddingTop: t.layout.block },
    blockCaption: { paddingTop: t.layout.caption },
  });

/**
 * `removeClippedSubviews` is a genuine win on Android and has a long tail of
 * blank-cell bugs on iOS, so it is enabled per platform rather than globally.
 */
const REMOVE_CLIPPED = Platform.OS === 'android';

export function List<ItemT>({
  data,
  renderItem,
  keyExtractor,
  itemHeight,
  separator = 'hairline',
  separatorInset,
  surface = 'plain',
  fill = true,
  loading = false,
  skeletonCount = 4,
  skeletonLeading = true,
  error,
  empty,
  header,
  footer,
  refreshing,
  onRefresh,
  onEndReached,
  extraData,
  contentContainerStyle,
  style,
  accessibilityLabel,
  testID,
}: ListProps<ItemT>): ReactElement {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  const separatorStyle = useMemo<StyleProp<ViewStyle>>(
    () =>
      separatorInset === undefined
        ? styles.separator
        : [styles.separator, { marginHorizontal: separatorInset }],
    [separatorInset, styles.separator],
  );

  const Separator = useCallback(
    () => <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={separatorStyle} />,
    [separatorStyle],
  );

  // Separator height is part of the pitch, or `scrollToIndex` drifts by a
  // hairline per row.
  const rowPitch = itemHeight === undefined ? undefined : itemHeight + (separator === 'hairline' ? theme.hairline : 0);

  const getItemLayout = useMemo(
    () =>
      rowPitch === undefined
        ? undefined
        : (_data: ArrayLike<ItemT> | null | undefined, index: number) => ({
            length: rowPitch,
            offset: rowPitch * index,
            index,
          }),
    [rowPitch],
  );

  // Precedence: an error is the whole truth, then loading, then emptiness.
  // The skeleton reserves its space at once and paints 150ms later (see
  // `Skeleton`), so a read that lands inside a frame or two never shows one.
  const emptyComponent = useMemo(() => {
    if (error !== undefined && error !== null) return <View style={styles.stateBox}>{error}</View>;
    if (loading) {
      return (
        <View style={styles.stateBox}>
          <SkeletonList count={skeletonCount} leading={skeletonLeading} />
        </View>
      );
    }
    if (empty !== undefined && empty !== null) return <View style={styles.stateBox}>{empty}</View>;
    return null;
  }, [error, loading, empty, skeletonCount, skeletonLeading, styles.stateBox]);

  const refreshControl =
    onRefresh === undefined ? undefined : (
      <RefreshControl
        refreshing={refreshing ?? false}
        onRefresh={onRefresh}
        tintColor={theme.color.textSecondary}
        colors={[theme.color.accent]}
        progressBackgroundColor={theme.color.surface}
      />
    );

  // While loading or erroring, the rows are not the truth — render none.
  const rows = error !== undefined && error !== null ? [] : loading ? [] : (data ?? []);

  return (
    <FlatList<ItemT>
      data={rows as ArrayLike<ItemT>}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={extraData}
      getItemLayout={getItemLayout}
      ItemSeparatorComponent={separator === 'none' ? undefined : Separator}
      ListEmptyComponent={emptyComponent}
      ListHeaderComponent={header === undefined ? undefined : <>{header}</>}
      ListFooterComponent={footer === undefined ? undefined : <>{footer}</>}
      refreshControl={refreshControl}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      updateCellsBatchingPeriod={50}
      windowSize={11}
      removeClippedSubviews={REMOVE_CLIPPED}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      contentInsetAdjustmentBehavior="never"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[
        fill ? styles.flex : styles.sizeToContent,
        surface === 'card' ? styles.card : null,
        style,
      ]}
      contentContainerStyle={contentContainerStyle}
    />
  );
}

export interface ListGroupProps {
  /** Where this row sits in the run. `only` is a one-row card. */
  position: GroupPosition;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Card chrome for a *run* of rows inside one flat list.
 *
 * A heterogeneous screen (the Home dashboard) is a single virtualized list, so
 * it cannot wrap groups in a `<Card>` — the card would have to be a row. This
 * paints the surface, the outline and the correct corner radii per row instead,
 * so a run of rows reads as one card while staying individually virtualized.
 *
 * ── ONE SEPARATION DEVICE ──────────────────────────────────────────────────
 * The run has a fill and rounded ends, and that is all. It used to add a
 * hairline outline around the whole group on top of the fill, which is the
 * same boundary drawn twice. What survives is the separator BETWEEN rows,
 * inset to the text column — that line marks a boundary nothing else in the
 * layout marks, so it is the one that earns its place.
 *
 * Still no shadow: a shadow per row would stack into a seam, and the canvas
 * already sits a step below the surface in both themes.
 */
export function ListGroup({ position, children, style, testID }: ListGroupProps): ReactElement {
  const styles = useThemedStyles(makeStyles);
  const first = position === 'first' || position === 'only';
  const last = position === 'last' || position === 'only';

  return (
    <View
      style={[styles.group, first ? styles.groupTop : null, last ? styles.groupBottom : null, style]}
      testID={testID}>
      {first ? null : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.groupSeparator}
        />
      )}
      {children}
    </View>
  );
}

/**
 * Assign a `GroupPosition` to each index of a run of `length` rows.
 * Keeps the arithmetic out of every screen that flattens sections into rows.
 */
export function groupPosition(index: number, length: number): GroupPosition {
  if (length <= 1) return 'only';
  if (index === 0) return 'first';
  if (index === length - 1) return 'last';
  return 'middle';
}

/** Which named gap a `<ListBlock/>` puts above itself. */
export type ListGap = 'section' | 'block' | 'caption' | 'none';

export interface ListBlockProps {
  /** Defaults to `section` — a standalone block starting a new thing. */
  gap?: ListGap;
  children: ReactNode;
  testID?: string;
}

/**
 * Vertical rhythm for a standalone block inside a flattened list.
 *
 * A screen built from one virtualized list has no column to put a `gap` on:
 * every row is butted against its neighbours and each row type has to bring
 * its own spacing. That is exactly the condition under which spacing gets
 * decided per screen — so the choice is named rather than typed. A screen says
 * *what kind of gap this is*; `ThemeLayout` says how many points that is.
 */
export function ListBlock({ gap = 'section', children, testID }: ListBlockProps): ReactElement {
  const styles = useThemedStyles(makeStyles);
  // `none` adds no view at all: this wraps rows of a virtualized list, and an
  // extra host view per row for a style that is empty is not free.
  if (gap === 'none') return <>{children}</>;
  const style =
    gap === 'section'
      ? styles.blockSection
      : gap === 'block'
        ? styles.blockBlock
        : styles.blockCaption;
  return (
    <View style={style} testID={testID}>
      {children}
    </View>
  );
}

/**
 * A section heading *inside* a flattened list.
 *
 * `<Section/>` is the `ScrollView` equivalent and owns its children; this one
 * is a row, because a screen built from one virtualized list cannot nest its
 * sections. Same type ramp, same header role, so the two read identically.
 */
export function ListSectionHeader({ title, testID }: ListSectionHeaderProps): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sectionHeader} testID={testID}>
      {/* An eyebrow, matching `FormSection`'s. A list screen and a form screen
          sitting one tap apart must label their sections the same way, or the
          app reads as two apps — and the reason it is quiet is the same in
          both: a signpost has to be quieter than what it points at. */}
      <Text
        variant="label"
        color="textTertiary"
        accessibilityRole="header"
        style={styles.sectionTitle}>
        {title}
      </Text>
    </View>
  );
}

export interface ListSectionHeaderProps {
  title: string;
  testID?: string;
}

/**
 * One quiet line UNDER a card: "+3 more items", "1 paused subscription is left
 * out of both figures", a section footnote. This is also what an empty section
 * collapses TO — the cheapest possible way to say "nothing", and the reason no
 * screen needs to stack full-height placeholders.
 *
 * It is a caption, not a divider, so it carries a small gap above and none
 * below: a note that sits equidistant between two cards belongs to neither,
 * which is how "1 paused subscription…" ended up floating in the middle of the
 * subscription list explaining nothing in particular.
 */
export function ListNote({ children, testID }: ListNoteProps): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.note} testID={testID}>
      <Text variant="caption" color="textSecondary">
        {children}
      </Text>
    </View>
  );
}

export interface ListNoteProps {
  children: string;
  testID?: string;
}
