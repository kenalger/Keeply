/**
 * Rendering a receipt photo — including the case where there is no longer one.
 *
 * ---------------------------------------------------------------------------
 * A MISSING FILE IS A RENDER STATE, NOT A CRASH
 * ---------------------------------------------------------------------------
 * §26 and CLAUDE.md are explicit: "Never crash because a locally referenced
 * image was deleted. Show `Image unavailable` instead." This is not a defensive
 * flourish — it is the NORMAL state of an app that stores media outside its
 * database. iOS evicts files under storage pressure, a user can delete the
 * original from Photos and Keeply's copy from Files, a §20 restore brings back
 * a database whose bytes did not travel with it. The row is still perfectly
 * good: merchant, amount, date, category, notes are all in SQLCipher and all
 * still true. Only the picture is gone.
 *
 * So the missing case renders a labelled placeholder in the same footprint and
 * changes nothing else on the screen. Both components below are checked two
 * ways, because one is not enough:
 *
 *   1. `imageFileExists()` up front — a synchronous `stat`. Catches the common
 *      case before a decode is attempted, so nothing flashes.
 *   2. `onError` from `expo-image` — catches the file that exists but is
 *      truncated, is not an image, or became unreadable between the two.
 *
 * ---------------------------------------------------------------------------
 * §33: A LIST NEVER LOADS A FULL-SIZE IMAGE
 * ---------------------------------------------------------------------------
 * `<ReceiptThumbnail/>` renders `localThumbnailUri` and NOTHING ELSE. When
 * there is no thumbnail — generation is best effort, see `./storage.ts` — it
 * falls back to the category glyph, never to `localImageUri`. That fallback is
 * the entire point: a journal of four hundred receipts scrolling four-megabyte
 * JPEGs is the biggest memory risk in this app, and the way that regression
 * would arrive is somebody "fixing" a blank thumbnail by pointing it at the
 * full-size file.
 */
import { Image } from 'expo-image';
import { memo, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, Text, type IconName } from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

import { imageFileExists } from './storage';

/* -------------------------------------------------------------------------- */
/* Thumbnail                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReceiptThumbnailProps {
  /** `localThumbnailUri`. Never the full-size URI — see the header. */
  uri: string | null;
  /** Drawn when there is no thumbnail, or its bytes are gone. */
  fallbackIcon: IconName;
  /** Edge length in points. Defaults to 44, the minimum touch target. */
  size?: number;
  testID?: string;
}

/**
 * The leading square on a list row.
 *
 * Deliberately silent about a missing file: a row is not the place to explain
 * one, and forty rows each saying "Image unavailable" would drown the receipts
 * themselves. The category glyph is a truthful, quiet fallback, and the detail
 * screen — where there is room to say it — says it.
 */
export const ReceiptThumbnail = memo(function ReceiptThumbnail({
  uri,
  fallbackIcon,
  size = 44,
  testID,
}: ReceiptThumbnailProps) {
  const styles = useThemedStyles(makeStyles);
  // Checked once per uri rather than on every render: the answer only changes
  // when the row does, and a `stat` per frame in a scrolling list is not free.
  const present = useMemo(() => imageFileExists(uri), [uri]);
  const [failed, setFailed] = useState(false);

  const box = { width: size, height: size };

  if (uri === null || !present || failed) {
    return (
      <View style={[styles.thumbFallback, box]} testID={testID}>
        <Icon name={fallbackIcon} size={Math.round(size * 0.5)} color="textSecondary" />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={[styles.thumb, box]}
      contentFit="cover"
      // Local bytes: there is nothing to fetch and nothing to cache to disk.
      // `memory` keeps the DECODED thumbnail around for a scroll back up
      // without writing a second copy of the file anywhere.
      cachePolicy="memory"
      // A recycled row must not show the previous receipt's photo for a frame.
      recyclingKey={uri}
      transition={0}
      onError={() => setFailed(true)}
      accessible={false}
      testID={testID}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Full-size                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReceiptImageProps {
  /** `localImageUri`, or `null` when the receipt was saved without a photo. */
  uri: string | null;
  /** Height of the frame in points. The image is fitted inside it. */
  height?: number;
  /** What to say when there was never a photo, as opposed to one that is gone. */
  emptyLabel?: string;
  testID?: string;
}

/**
 * The photo on the detail screen, in the three states it really has.
 *
 * "No photo" and "Image unavailable" are different facts and get different
 * words: the first is a choice the user made, the second is a loss they should
 * know about — and conflating them would tell somebody their receipt never had
 * a photo when in fact the file was evicted last week.
 */
export function ReceiptImage({
  uri,
  height = 260,
  emptyLabel = 'No photo attached',
  testID,
}: ReceiptImageProps) {
  const styles = useThemedStyles(makeStyles);
  const present = useMemo(() => imageFileExists(uri), [uri]);
  const [failed, setFailed] = useState(false);

  if (uri === null) {
    return (
      <View style={[styles.frame, { height }]} testID={testID}>
        <Icon name="photo" size={28} color="textTertiary" />
        <Text variant="caption" color="textSecondary" align="center">
          {emptyLabel}
        </Text>
      </View>
    );
  }

  if (!present || failed) {
    return (
      <View style={[styles.frame, { height }]} testID={`${testID ?? 'receipt-image'}-missing`}>
        <Icon name="eyeSlash" size={28} color="textTertiary" />
        <Text variant="body" color="text" align="center">
          Image unavailable
        </Text>
        <Text variant="caption" color="textSecondary" align="center" style={styles.frameNote}>
          The photo is no longer on this device. Everything else about this
          receipt is unchanged — you can still edit it, and you can attach a new
          photo.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.frame, styles.framePlain, { height }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        // `contain`: a receipt is a tall strip of text and cropping it to fill
        // a rectangle removes the total, which is the one line that matters.
        contentFit="contain"
        cachePolicy="memory"
        recyclingKey={uri}
        transition={120}
        onError={() => setFailed(true)}
        accessibilityLabel="Photo of this receipt"
        testID={testID}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    thumb: {
      borderRadius: t.radius.sm,
      backgroundColor: t.color.surfaceAlt,
    },
    thumbFallback: {
      borderRadius: t.radius.sm,
      backgroundColor: t.color.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    frame: {
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surfaceAlt,
      borderWidth: t.hairline,
      borderColor: t.color.border,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.sm,
      paddingHorizontal: t.space.xl,
      overflow: 'hidden',
    },
    framePlain: { paddingHorizontal: 0, gap: 0 },
    frameNote: { maxWidth: 320 },
  });
