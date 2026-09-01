/**
 * Getting an image into the sandbox, from either source, with every permission
 * state handled (§9's workflow, §26, §28).
 *
 * ── ONE HOOK, TWO SOURCES ──────────────────────────────────────────────────
 * The camera and the photo library are different permissions with different
 * state machines, and the screens need both at once: a capture screen whose
 * camera is blocked must still offer the library, and a form must offer both
 * without knowing anything about either. So this hook owns the pair, and
 * `./permissions.ts` owns what each state means.
 *
 * ── THE FILE IS WRITTEN HERE, THE ROW LATER ────────────────────────────────
 * Both paths end in `storeReceiptImage()`, which copies into the sandbox and
 * derives the thumbnail. That is the inbound half of the ordering contract:
 * bytes first, row second (`./mutations.ts`). A user who takes a photo and then
 * abandons the form leaves a file behind and no row — the recoverable
 * direction, chosen on purpose.
 *
 * ── EVERY REFUSAL RETURNS `null`, NOT AN ERROR ─────────────────────────────
 * Cancelling the picker, declining the prompt, a blocked permission: none of
 * those is a failure, they are the user saying "not this way". They resolve to
 * `null` and the caller carries on with a form that never needed a photo. Only
 * a genuine write failure sets `error`, and even that leaves the receipt
 * savable without an image.
 */
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';
import { useCameraPermissions } from 'expo-camera';

import { log } from '@/lib/log';

import {
  describeCameraPermission,
  describeLibraryPermission,
  permissionAllows,
  type MediaPermission,
} from './permissions';
import { storeReceiptImage, type StoredReceiptImage } from './storage';

export interface ImageCapture {
  /** The camera's state, as `./permissions.ts` describes it. */
  camera: MediaPermission;
  /** The photo library's state. `'limited'` is usable. */
  library: MediaPermission;
  /** A capture or a permission round-trip is in flight. */
  busy: boolean;
  /** Set only by a real failure to write the file. Cleared by the next attempt. */
  error: string | null;

  /** Ask the OS for the camera. Returns whether it may now be used. */
  requestCamera: () => Promise<boolean>;
  /** Ask the OS for the photo library. Returns whether it may now be used. */
  requestLibrary: () => Promise<boolean>;
  /**
   * Ask for the library if needed, open the picker, and store what comes back.
   * `null` when the user cancelled, refused, or the write failed.
   */
  pickFromLibrary: () => Promise<StoredReceiptImage | null>;
  /** Copy an already-captured temporary file into the sandbox. */
  store: (sourceUri: string) => Promise<StoredReceiptImage | null>;
}

/**
 * How much the picker is allowed to recompress a library image.
 *
 * `1` — no recompression at all. The full-size copy is the archival one, it is
 * the only copy that will ever exist, and re-encoding a photo the user already
 * has in order to save a few hundred kilobytes is a lossy edit nobody asked
 * for. The size problem §33 is actually worried about is a LIST holding these
 * in memory, and that is solved by the thumbnail rather than by degrading the
 * original.
 */
const LIBRARY_QUALITY = 1;

export function useImageCapture(): ImageCapture {
  const [cameraResponse, requestCameraPermission] = useCameraPermissions();
  const [libraryResponse, requestLibraryPermission] = ImagePicker.useMediaLibraryPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const camera = describeCameraPermission(cameraResponse);
  const library = describeLibraryPermission(libraryResponse);

  const requestCamera = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestCameraPermission();
      return permissionAllows(describeCameraPermission(next));
    } catch (permissionError) {
      log.error('receipts: camera permission request failed', permissionError);
      return false;
    } finally {
      setBusy(false);
    }
  }, [requestCameraPermission]);

  const requestLibrary = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestLibraryPermission();
      return permissionAllows(describeLibraryPermission(next));
    } catch (permissionError) {
      log.error('receipts: photo library permission request failed', permissionError);
      return false;
    } finally {
      setBusy(false);
    }
  }, [requestLibraryPermission]);

  const store = useCallback(async (sourceUri: string) => {
    setBusy(true);
    setError(null);
    try {
      return await storeReceiptImage(sourceUri);
    } catch (writeError) {
      // No path in the message, ever (§10). The user is told the outcome and
      // the way round it; the reason code is for the developer log.
      log.error('receipts: could not store a captured image', writeError);
      setError('Keeply could not save that image. You can still add the receipt without it.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const pickFromLibrary = useCallback(async () => {
    // `limited` counts as allowed: the picker shows the photos the user chose
    // to share, which is exactly enough to attach one receipt.
    if (!permissionAllows(describeLibraryPermission(libraryResponse))) {
      const allowed = await requestLibrary();
      if (!allowed) return null;
    }

    setBusy(true);
    setError(null);
    let picked: ImagePicker.ImagePickerResult;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        quality: LIBRARY_QUALITY,
        // No EXIF: a receipt photo's GPS tags and camera serial are more
        // personal data than the receipt itself, and nothing in Keeply reads
        // them (§10, §19).
        exif: false,
        base64: false,
      });
    } catch (pickerError) {
      log.error('receipts: the photo picker failed to open', pickerError);
      setError('Keeply could not open your photo library.');
      setBusy(false);
      return null;
    } finally {
      setBusy(false);
    }

    // Cancelling is an answer, not a failure.
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return null;

    return store(asset.uri);
  }, [libraryResponse, requestLibrary, store]);

  return {
    camera,
    library,
    busy,
    error,
    requestCamera,
    requestLibrary,
    pickFromLibrary,
    store,
  };
}
