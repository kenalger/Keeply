/**
 * "Take a photo of the receipt" — step one of §9's workflow and of §28's
 * twenty seconds.
 *
 * ── IT IS A STEP, NOT A GATE ───────────────────────────────────────────────
 * Every path off this screen reaches the same form. Shutter, library, "Skip
 * the photo", a refused permission, a device with no camera at all: all five
 * end at `/receipts/new` with the metadata form ready to type into. A receipt
 * is metadata with an OPTIONAL photo attached — nothing in this feature needs a
 * camera — so there is no state of this screen where the user is stuck (§26).
 *
 * ── WHY THE PREVIEW IS FRAMED AND NOT FULL-BLEED ───────────────────────────
 * A full-screen viewfinder is what a camera app does, because the photo IS the
 * product. Here the photo is one field of a record, and the screen has to say
 * so: the framed preview sits under the same large title, in the same gutter,
 * above the same stacked buttons as every other screen in Keeply, so "skip
 * this" is visibly as available as "take it". It also gives the permission and
 * no-camera states somewhere to render that is not a black rectangle.
 *
 * ── THE SIMULATOR, AND EVERY DEVICE WITH A BROKEN CAMERA ───────────────────
 * `onMountError` is a real state, not a development convenience: the iOS
 * Simulator has no camera, and neither does a device whose camera is in use by
 * another app or has failed. It is handled the same way a refusal is — say what
 * happened, offer the library and the form.
 */
import { CameraView } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, EmptyState, Icon, Screen, ScreenHeader, Text } from '@/components/ui';
import { log } from '@/lib/log';
import { useThemedStyles, type Theme } from '@/theme';

import { useImageCapture } from './capture';
import {
  openAppSettings,
  permissionAllows,
  permissionCanAsk,
  permissionCopy,
} from './permissions';
import type { StoredReceiptImage } from './storage';

export interface CameraCaptureProps {
  /**
   * A photo is in the sandbox. The caller attaches it to the draft and moves
   * on — this screen never writes a draft or navigates by itself.
   */
  onCaptured: (image: StoredReceiptImage) => void;
  /** "Skip the photo": go to the form with nothing attached. */
  onSkip: () => void;
  /** Back out of the flow entirely. */
  onCancel: () => void;
  /** `false` while the screen is not focused, so the camera releases the sensor. */
  active?: boolean;
}

export function CameraCapture({
  onCaptured,
  onSkip,
  onCancel,
  active = true,
}: CameraCaptureProps) {
  const styles = useThemedStyles(makeStyles);
  const capture = useImageCapture();
  const cameraRef = useRef<CameraView | null>(null);

  const [ready, setReady] = useState(false);
  const [mountFailed, setMountFailed] = useState(false);
  const [shooting, setShooting] = useState(false);

  const cameraUsable = permissionAllows(capture.camera) && !mountFailed;
  const cameraNote = permissionCopy('camera', capture.camera);

  const askForCamera = useCallback(() => {
    if (permissionCanAsk(capture.camera)) {
      void capture.requestCamera();
      return;
    }
    void openAppSettings();
  }, [capture]);

  const takePhoto = useCallback(() => {
    const camera = cameraRef.current;
    if (camera === null || shooting || !ready) return;

    setShooting(true);
    void (async () => {
      try {
        // Not `pictureRef: true`: a `PictureRef` lives in memory and would have
        // to be saved to a file anyway, and `savePictureAsync` writes to the
        // cache directory exactly as this does. One temporary file either way,
        // and this way the failure surface is a URI rather than a native handle.
        const photo = await camera.takePictureAsync({ quality: 1, exif: false });
        if (photo === undefined) {
          setShooting(false);
          return;
        }
        const stored = await capture.store(photo.uri);
        setShooting(false);
        if (stored !== null) onCaptured(stored);
      } catch (error) {
        log.error('receipts: the camera failed to take a picture', error);
        setShooting(false);
      }
    })();
  }, [capture, onCaptured, ready, shooting]);

  const chooseFromLibrary = useCallback(() => {
    void (async () => {
      const stored = await capture.pickFromLibrary();
      if (stored !== null) onCaptured(stored);
    })();
  }, [capture, onCaptured]);

  return (
    <Screen edges={['top', 'bottom']} keyboardAvoiding={false}>
      <ScreenHeader
        title="Photograph the receipt"
        subtitle="It is saved inside Keeply on this device — never uploaded."
        onBack={onCancel}
        backLabel="Back"
      />

      <View style={styles.frame}>
        {cameraUsable ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            // A paused preview keeps the sensor open behind another screen and
            // takes a picture of the last frame if the shutter is somehow hit.
            active={active}
            onCameraReady={() => setReady(true)}
            onMountError={(event) => {
              log.warn('receipts: the camera could not be mounted', {
                reason: String(event.message ?? 'unknown'),
              });
              setMountFailed(true);
            }}
            testID="receipt-camera"
          />
        ) : (
          <View style={styles.frameFallback} testID="receipt-camera-unavailable">
            <Icon name="camera" size={28} color="textTertiary" />
            <Text variant="body" align="center">
              {mountFailed
                ? 'No camera available'
                : (cameraNote?.title ?? 'Getting the camera ready')}
            </Text>
            <Text variant="caption" color="textSecondary" align="center">
              {mountFailed
                ? 'This device did not give Keeply a working camera. You can attach a photo you already have, or type the receipt in.'
                : (cameraNote?.body ??
                  'One moment — Keeply is checking whether it may use the camera.')}
            </Text>
          </View>
        )}
      </View>

      {capture.error === null ? null : (
        <View style={styles.error}>
          <Text variant="caption" color="danger">
            {capture.error}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        {cameraUsable ? (
          <Button
            title={shooting ? 'Saving the photo' : 'Take the photo'}
            icon="camera"
            size="lg"
            fullWidth
            loading={shooting}
            // `ready` is the camera's own signal that the preview is running.
            // Firing the shutter before it lands returns nothing on iOS.
            disabled={!ready || shooting || capture.busy}
            onPress={takePhoto}
            accessibilityHint="Takes the picture and opens the receipt form"
            testID="receipt-camera-shutter"
          />
        ) : mountFailed ? null : (
          <Button
            title={cameraNote?.action ?? 'Allow the camera'}
            // The glyph follows the DESTINATION, not the feature: a camera icon
            // on a button that opens Settings promises a viewfinder.
            icon={permissionCanAsk(capture.camera) ? 'camera' : 'gear'}
            size="lg"
            fullWidth
            disabled={capture.busy || capture.camera === 'unknown'}
            onPress={askForCamera}
            accessibilityHint={
              permissionCanAsk(capture.camera)
                ? 'Asks iOS for permission to use the camera'
                : 'Opens Keeply in Settings'
            }
            testID="receipt-camera-permission"
          />
        )}

        <Button
          title="Choose from library"
          variant="secondary"
          icon="photo"
          fullWidth
          disabled={capture.busy}
          onPress={chooseFromLibrary}
          accessibilityHint="Opens your photos so you can attach one you already took"
          testID="receipt-camera-library"
        />

        <Button
          title="Skip the photo"
          variant="ghost"
          fullWidth
          disabled={capture.busy}
          onPress={onSkip}
          accessibilityHint="Opens the receipt form with no photo attached"
          testID="receipt-camera-skip"
        />
      </View>

      {capture.library === 'blocked' || capture.library === 'limited' ? (
        <LibraryNote limited={capture.library === 'limited'} />
      ) : null}
    </Screen>
  );
}

/**
 * A footnote about the library, only in the two states where the library
 * button will not behave the way the label implies.
 *
 * Not an alert and not a blocker: the camera above may still work, and skipping
 * always does. It exists so a tap that opens a picker with three photos in it,
 * or one that appears to do nothing, is explained BEFORE it happens.
 *
 * The copy is its own, shorter than `permissionCopy('library', …)`: this sits
 * under a camera message that has already said the long version about Settings
 * and Screen Time, and repeating the same paragraph twice on one screen makes
 * both of them read as noise.
 */
function LibraryNote({ limited }: { limited: boolean }) {
  return (
    <EmptyState
      variant="compact"
      icon="photo"
      title={limited ? 'Only your selected photos' : 'The photo library is off too'}
      description={
        limited
          ? 'Keeply can see the photos you shared with it. Change it to Full Access in Settings to reach the rest.'
          : 'Choosing a photo will not work until it is allowed in Settings.'
      }
      actionLabel="Open Settings"
      actionIcon="gear"
      onAction={() => void openAppSettings()}
      actionHint="Opens Keeply in Settings"
      testID="receipt-library-note"
    />
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    frame: {
      flex: 1,
      marginTop: t.layout.section,
      borderRadius: t.radius.lg,
      overflow: 'hidden',
      backgroundColor: t.color.surfaceAlt,
      borderWidth: t.hairline,
      borderColor: t.color.border,
    },
    frameFallback: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.sm,
      paddingHorizontal: t.space.xl,
    },
    error: {
      marginTop: t.layout.block,
      padding: t.space.md,
      borderRadius: t.radius.md,
      backgroundColor: t.color.dangerBg,
    },
    actions: { marginTop: t.layout.section, gap: t.space.sm },
  });
