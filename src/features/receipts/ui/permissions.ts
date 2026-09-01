/**
 * Keeply — the camera and photo-library permission states, and what to say in
 * each one (§26, §32).
 *
 * ---------------------------------------------------------------------------
 * A DENIAL IS NEVER A DEAD END
 * ---------------------------------------------------------------------------
 * §26 lists "camera permission denied" and "photo library permission denied"
 * among the things the app must handle gracefully, and §28's flow starts at
 * the camera — so the obvious failure is a capture screen that has nothing to
 * offer a user who said no. It must not be built that way: a receipt is
 * metadata with an OPTIONAL photo attached, so every refusal falls back to the
 * same form, fully usable, with a route to Settings for the user who changes
 * their mind. Nothing in this feature requires a camera.
 *
 * ---------------------------------------------------------------------------
 * THE MATRIX, AS THE OS ACTUALLY REPORTS IT
 * ---------------------------------------------------------------------------
 * `PermissionResponse` carries `status` and `canAskAgain`, and those two make
 * four states — plus `accessPrivileges` on the library, which makes a fifth:
 *
 *   undetermined  never asked. The OS dialog is still available.
 *   granted       full access.
 *   limited       LIBRARY ONLY. iOS 14+/Android 34+ "selected photos". Usable:
 *                 the picker shows the chosen set, and the user can widen it.
 *   denied        refused, but askable again. ANDROID ONLY, in practice.
 *   blocked       refused and not askable. Settings is the only way back.
 *
 * `restricted` — parental controls, Screen Time, an MDM policy — is NOT a
 * separate state at this layer, and pretending otherwise would be inventing a
 * distinction the platform does not hand us. iOS collapses it into `denied`
 * before it ever reaches JavaScript:
 *
 *   expo-camera/ios/.../CameraPermissionRequester   `case .restricted, .denied: EXPermissionStatusDenied`
 *   expo-image-picker/ios/ImagePickerPermissionRequesters.swift:104  same line for PHAuthorizationStatus
 *
 * and `canAskAgain` on iOS is simply `status != denied`
 * (expo-modules-core/ios/.../EXPermissionsService.m:130), so a restriction is
 * indistinguishable from a permanent refusal. What that costs the user is one
 * sentence, and {@link permissionCopy} pays it: the blocked copy says the
 * control may be greyed out in Settings because the device restricts it, so
 * somebody on a managed phone is not sent to hunt for a switch that is not
 * theirs to flip.
 *
 * Nothing here renders. The copy lives beside the state machine because the
 * five states each need different words, and a `switch` split across three
 * screens is how a state ends up with no message at all.
 */
import type { PermissionResponse } from 'expo-camera';
import type { MediaLibraryPermissionResponse } from 'expo-image-picker';
import * as Linking from 'expo-linking';

import { log } from '@/lib/log';

/** See the header. `unknown` is "the hook has not answered yet", not a state of the OS. */
export type MediaPermission =
  | 'unknown'
  | 'undetermined'
  | 'granted'
  | 'limited'
  | 'denied'
  | 'blocked';

export type MediaPermissionKind = 'camera' | 'library';

/** Whether this state lets the user actually capture or pick right now. */
export function permissionAllows(state: MediaPermission): boolean {
  return state === 'granted' || state === 'limited';
}

/** Whether asking the OS again can still produce a dialog. */
export function permissionCanAsk(state: MediaPermission): boolean {
  return state === 'undetermined' || state === 'denied';
}

/** Whether the only way forward is the Settings app. */
export function permissionNeedsSettings(state: MediaPermission): boolean {
  return state === 'blocked';
}

/* -------------------------------------------------------------------------- */
/* Reading a response                                                          */
/* -------------------------------------------------------------------------- */

/** The camera's five-way state from `useCameraPermissions()`'s response. */
export function describeCameraPermission(
  response: PermissionResponse | null | undefined,
): MediaPermission {
  if (response === null || response === undefined) return 'unknown';
  if (response.granted) return 'granted';
  if (response.status === 'undetermined') return 'undetermined';
  return response.canAskAgain ? 'denied' : 'blocked';
}

/**
 * The library's state, which has one more answer than the camera's.
 *
 * `accessPrivileges === 'limited'` arrives with `status: 'granted'` (the Swift
 * cited in the header maps `.limited` to granted with scope `limited`), so it
 * has to be read BEFORE the granted branch or the note explaining that Keeply
 * can only see the selected photos would never appear.
 */
export function describeLibraryPermission(
  response: MediaLibraryPermissionResponse | null | undefined,
): MediaPermission {
  if (response === null || response === undefined) return 'unknown';
  if (response.granted) {
    return response.accessPrivileges === 'limited' ? 'limited' : 'granted';
  }
  if (response.status === 'undetermined') return 'undetermined';
  return response.canAskAgain ? 'denied' : 'blocked';
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

export interface PermissionCopy {
  title: string;
  body: string;
  /** Label for the one action that can change the situation, or `null`. */
  action: string | null;
}

/**
 * What to tell the user in each state, per kind.
 *
 * Every message names the fallback out loud — the form works without a photo —
 * because the thing that makes a permission refusal feel like a broken app is
 * being shown a wall instead of the thing you came to do.
 */
export function permissionCopy(
  kind: MediaPermissionKind,
  state: MediaPermission,
): PermissionCopy | null {
  const noun = kind === 'camera' ? 'camera' : 'photo library';

  switch (state) {
    case 'unknown':
    case 'granted':
      return null;

    case 'limited':
      return {
        title: 'Keeply can see only the photos you picked',
        body: 'That is enough to attach a receipt. To reach the rest of your library, change Keeply to Full Access in Settings.',
        action: 'Open Settings',
      };

    case 'undetermined':
      return {
        title: kind === 'camera' ? 'Photograph a receipt' : 'Attach a photo you already took',
        body:
          kind === 'camera'
            ? 'Keeply needs the camera to take the picture. The photo is written straight into Keeply on this device — it is never uploaded.'
            : 'Keeply needs your photo library to read the one image you pick. It copies that image into Keeply on this device and never uploads it.',
        action: kind === 'camera' ? 'Allow the camera' : 'Allow photos',
      };

    case 'denied':
      return {
        title: `Keeply cannot use the ${noun}`,
        body: `You can allow it and carry on, or skip the photo — a receipt saves perfectly well without one.`,
        action: 'Ask again',
      };

    case 'blocked':
      return {
        title: `Keeply cannot use the ${noun}`,
        body: `iOS will not ask twice, so this can only change in Settings — and if this device is managed or restricted by Screen Time, the switch there may be greyed out. Either way you can still add the receipt and type its details.`,
        action: 'Open Settings',
      };
  }
}

/* -------------------------------------------------------------------------- */
/* The way back                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Open Keeply's page in the OS settings.
 *
 * Returns `false` rather than throwing when the OS refuses — the caller is
 * already in a degraded state, and a crash on the way out of one is the worst
 * possible answer. Modelled on `openNotificationSettings()` in
 * `src/lib/notifications.ts`.
 */
export async function openAppSettings(): Promise<boolean> {
  try {
    await Linking.openSettings();
    return true;
  } catch (error) {
    log.error('receipts: could not open settings', error);
    return false;
  }
}
