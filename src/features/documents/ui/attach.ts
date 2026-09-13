/**
 * Attaching a file to a document (§16).
 *
 * Three ways in, because a document arrives three ways: photographed on the
 * spot, already in the camera roll, or a PDF a provider emailed. The receipts
 * feature needs only the first two — a receipt is never a PDF — which is why
 * this is its own hook rather than a widened `useImageCapture`.
 *
 * ── THE FILES PICKER NEEDS NO PERMISSION AND NO DEPENDENCY ─────────────────
 * `File.pickFileAsync` is static on `File` in expo-file-system 57. It presents
 * the iOS Files sheet, needs no Info.plist entry and no permission prompt
 * (the user picking a file IS the grant), and hands back a temporary COPY —
 * which is exactly what an attach wants: the user's own file is never opened
 * or locked, and the copy is the OS's to clean up.
 *
 * ⚠ `.keeply` greys out when filtering by MIME type because iOS has no UTI for
 * it; that is a backup-restore concern, not this one, but it is the same API
 * and the same footgun. Here the filter is genuine MIME types, which do work.
 *
 * ── PERMISSION FAILURE IS A STATE, NOT AN EXCEPTION (§26) ──────────────────
 * Every path returns `null` on refusal or cancellation and reports the reason
 * through `error`, because a document must remain addable WITHOUT a file. The
 * §14 fields are the record; the scan is a convenience.
 */
import { useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';

import { log } from '@/lib/log';

import {
  describeCameraPermission,
  describeLibraryPermission,
  openAppSettings,
  permissionAllows,
  permissionCopy,
  permissionNeedsSettings,
  type MediaPermission,
} from '@/features/receipts/ui/permissions';
import { ACCEPTED_MIME_TYPES, resolveDocumentMimeType } from '../file-types';
import { storeDocumentFile, type StoredDocumentFile } from './storage';

/**
 * No recompression.
 *
 * `1`, for a stronger reason than the receipts module has: a document scan is
 * evidence. A licence number re-encoded at quality 0.8 can become unreadable,
 * and unlike a receipt photo there is no second copy anywhere — §16 says this
 * one never leaves the device.
 */
const PICKER_QUALITY = 1;

export interface DocumentAttach {
  /** The camera's state, as `receipts/ui/permissions.ts` describes it. */
  camera: MediaPermission;
  /** The photo library's state. `'limited'` is usable. */
  library: MediaPermission;
  /** A pick, a capture or a permission round-trip is in flight. */
  busy: boolean;
  /** Set only by a real failure. Cleared by the next attempt. */
  error: string | null;
  /**
   * The refusal can only be undone in Settings.
   *
   * Distinct from `error`, because the two call for different UI: an error is a
   * sentence, this is a sentence AND a button. iOS shows no dialog at all once
   * a permission is blocked, so without a route out the screen is a wall.
   */
  needsSettings: boolean;
  /** Take the user to Keeply's page in the system Settings app. */
  openSettings: () => Promise<boolean>;

  requestCamera: () => Promise<boolean>;
  /** Ask for the library if needed, open the picker, store what comes back. */
  pickFromLibrary: () => Promise<StoredDocumentFile | null>;
  /** Open the Files sheet and store what comes back. No permission needed. */
  pickFile: () => Promise<StoredDocumentFile | null>;
  /** Copy an already-captured temporary file into the sandbox. */
  store: (sourceUri: string, mimeType: string | null) => Promise<StoredDocumentFile | null>;
}

export function useDocumentAttach(): DocumentAttach {
  const [cameraResponse, requestCameraPermission] = useCameraPermissions();
  const [libraryResponse, requestLibraryPermission] = ImagePicker.useMediaLibraryPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSettings, setNeedsSettings] = useState(false);

  const camera = describeCameraPermission(cameraResponse);
  const library = describeLibraryPermission(libraryResponse);

  const requestCamera = useCallback(async () => {
    setBusy(true);
    try {
      const next = await requestCameraPermission();
      return permissionAllows(describeCameraPermission(next));
    } catch (permissionError) {
      log.error('documents: camera permission request failed', permissionError);
      return false;
    } finally {
      setBusy(false);
    }
  }, [requestCameraPermission]);

  const store = useCallback(async (sourceUri: string, mimeType: string | null) => {
    setBusy(true);
    setError(null);
    setNeedsSettings(false);
    try {
      return await storeDocumentFile(sourceUri, mimeType);
    } catch (writeError) {
      // No path and no filename in the message, ever (§10, §16). The user is
      // told the outcome and the way round it; the reason is for the log.
      log.error('documents: could not store an attachment', writeError);
      setError('Keeply could not save that file. You can still add the document without it.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const pickFromLibrary = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNeedsSettings(false);
    try {
      if (!permissionAllows(describeLibraryPermission(libraryResponse))) {
        const next = await requestLibraryPermission();
        const state = describeLibraryPermission(next);
        if (!permissionAllows(state)) {
          // A BLOCKED permission never shows a dialog: iOS resolves the request
          // immediately with the same refusal, so the button appeared to do
          // nothing — forever, with no message and no route to Settings. §26
          // says a denial is never a dead end, and `permissionCopy` has had the
          // exact sentence for this the whole time, unused. Found by audit.
          const copy = permissionCopy('library', state);
          setError(
            copy === null
              ? 'Keeply cannot reach your photos. You can still add the document without one.'
              : `${copy.body} You can still add the document without a photo.`,
          );
          setNeedsSettings(permissionNeedsSettings(state));
          return null;
        }
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: PICKER_QUALITY,
        exif: false,
      });
      if (picked.canceled) return null;

      const asset = picked.assets[0];
      if (asset === undefined) return null;
      return await storeDocumentFile(asset.uri, asset.mimeType ?? null);
    } catch (pickError) {
      log.error('documents: picking from the library failed', pickError);
      setError('Keeply could not read that photo. You can still add the document without it.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [libraryResponse, requestLibraryPermission]);

  const pickFile = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNeedsSettings(false);
    try {
      // Filtering by the allowlist rather than `*/*`: a picker that offers
      // types this app refuses is a picker that ends in an error message the
      // user could not have predicted.
      const picked = await File.pickFileAsync({ mimeTypes: [...ACCEPTED_MIME_TYPES] });
      if (picked.canceled) return null;

      // `pickFileAsync` resolves to `{ result: File, canceled }` and `File`
      // carries a `name` and a `uri` but NO MIME type — so the type has to come
      // from the name. The temporary copy's URI is not guaranteed to keep the
      // extension, which is why the NAME is what gets resolved and not the URI.
      const file = picked.result;
      const mimeType = resolveDocumentMimeType(null, file.name);
      return await storeDocumentFile(file.uri, mimeType);
    } catch (pickError) {
      log.error('documents: picking a file failed', pickError);
      setError('Keeply could not read that file. You can still add the document without it.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    camera,
    library,
    busy,
    error,
    needsSettings,
    openSettings: openAppSettings,
    requestCamera,
    pickFromLibrary,
    pickFile,
    store,
  };
}
