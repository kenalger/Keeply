import { Image } from 'expo-image';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components/ui';
import { useThemedStyles, type Theme } from '@/theme';

import { isImageMimeType } from '../file-types';
import { documentFileExists } from './storage';

/**
 * The scan behind a document, or an honest account of why it is not here.
 *
 * ── A MISSING FILE IS A RENDERING STATE, NEVER A CRASH ─────────────────────
 * The cross-cutting invariant (§5 of `plan/phases.md`). The bytes can vanish
 * without the row noticing: an erase-all-data, a restore from a bundle that
 * carried metadata but not media, a crash between the two writes. Handing a
 * dead URI to `<Image/>` gives a grey rectangle that looks like a slow load
 * forever; this says what happened.
 *
 * ── A PDF IS NOT DRAWN ─────────────────────────────────────────────────────
 * `expo-image` cannot render one and nothing installed can. Rather than a
 * broken preview, a PDF gets its own mark and its name — which is the honest
 * amount of information available without a renderer, and enough for the user
 * to know their file is there.
 *
 * ── NO FILENAME IS LOGGED, AND NONE IS SHOWN ───────────────────────────────
 * §16: a path to a passport scan is sensitive. What is shown is the TYPE, not
 * the name the file has on disk — that name is a random id anyway, because
 * `storeDocumentFile` names the copy after an id and not after the original.
 */
export interface DocumentFileProps {
  uri: string | null;
  mimeType: string | null;
  /** Rendered at the document's own scale on a detail screen. */
  height?: number;
  testID?: string;
}

export function DocumentFile({ uri, mimeType, height = 420, testID }: DocumentFileProps) {
  const styles = useThemedStyles(makeStyles);

  // Checked once per render of a mounted screen rather than on every frame:
  // the answer only changes when the row does, and the row changing remounts
  // this through its `uri`.
  const exists = useMemo(() => documentFileExists(uri), [uri]);

  if (uri === null) return null;

  if (!exists) {
    return (
      <View style={[styles.placeholder, { height }]} testID={testID}>
        <Icon name="errorCircle" size={28} color="textTertiary" />
        <Text variant="body" color="textSecondary">
          File unavailable
        </Text>
        <Text variant="caption" color="textTertiary" align="center">
          The document’s details are safe. The scan itself is no longer on this device.
        </Text>
      </View>
    );
  }

  if (!isImageMimeType(mimeType)) {
    return (
      <View style={[styles.placeholder, { height: Math.min(height, 200) }]} testID={testID}>
        <Icon name="doc" size={28} color="textSecondary" />
        <Text variant="body">PDF attached</Text>
        <Text variant="caption" color="textTertiary" align="center">
          Kept on this device. Keeply does not open PDFs yet.
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={[styles.image, { height }]}
      contentFit="contain"
      // The scan is the only copy and it never changes in place, so caching it
      // by URI is safe and keeps a detail screen instant on the second visit.
      cachePolicy="memory-disk"
      accessibilityIgnoresInvertColors
      testID={testID}
    />
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    image: {
      width: '100%',
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surface,
    },
    placeholder: {
      width: '100%',
      borderRadius: t.radius.lg,
      backgroundColor: t.color.surface,
      borderWidth: t.hairline,
      borderColor: t.color.border,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.sm,
      padding: t.space.lg,
    },
  });
