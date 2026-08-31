/**
 * Typed application errors and the single place that turns any thrown value
 * into copy a person can act on (§26).
 *
 * Rules for the copy in this file:
 *  - Plain language. No error codes, no class names, no stack traces.
 *  - Say what happened, then what the person can do about it.
 *  - Never blame the user, never imply data loss that has not happened.
 *  - Never mention the network. Keeply works offline; a failure is never
 *    "check your connection".
 */

/** Stable, machine-readable discriminator. Never shown to the user. */
export type AppErrorCode =
  | 'missing-local-file'
  | 'deleted-photo'
  | 'corrupted-backup'
  | 'invalid-date'
  | 'invalid-amount'
  | 'duplicate-record'
  | 'permission-denied'
  | 'biometrics-unavailable'
  | 'insufficient-storage'
  | 'database-key-unavailable'
  | 'database-init-failed'
  | 'unknown';

/** Which OS permission a `PermissionDeniedError` is about. */
export type PermissionSubject = 'notifications' | 'camera' | 'photo-library';

/** Structured, user-facing copy. The UI decides how to present it. */
export interface UserMessage {
  /** Short headline. Sentence case, no trailing period. */
  title: string;
  /** One or two calm sentences explaining what to do. */
  body: string;
  /** Label for the primary action, when one makes sense. */
  action?: string;
  /**
   * `true` when repeating the same operation is unlikely to help — the user
   * has to change something first (grant a permission, free up space, pick a
   * different file). The UI should not offer a bare "Try again".
   */
  retryIsFutile?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Hierarchy                                                                   */
/* -------------------------------------------------------------------------- */

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // The class name is the most useful thing in a redacted log line.
    this.name = new.target.name;
  }
}

/** A record points at a file that is no longer on the device (§26). */
export class MissingLocalFileError extends AppError {
  readonly code = 'missing-local-file' as const;
}

/** A receipt/document image was removed from the photo library (§26). */
export class DeletedPhotoError extends AppError {
  readonly code = 'deleted-photo' as const;
}

/** A backup file could not be read, decrypted or validated (§20, §26). */
export class CorruptedBackupError extends AppError {
  readonly code = 'corrupted-backup' as const;
}

/** A date failed validation (§29). */
export class InvalidDateError extends AppError {
  readonly code = 'invalid-date' as const;
  /** Which field, for inline form messaging. Never contains a value. */
  readonly field?: string;

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super(message, options);
    this.field = options?.field;
  }
}

/** An amount failed validation — not a number, or not greater than zero (§29). */
export class InvalidAmountError extends AppError {
  readonly code = 'invalid-amount' as const;
  readonly field?: string;

  constructor(message: string, options?: { field?: string; cause?: unknown }) {
    super(message, options);
    this.field = options?.field;
  }
}

/** The record already exists (unique constraint, or an app-level duplicate check). */
export class DuplicateRecordError extends AppError {
  readonly code = 'duplicate-record' as const;
  /** Human label for the kind of record, e.g. "subscription". Not user data. */
  readonly entity?: string;

  constructor(message: string, options?: { entity?: string; cause?: unknown }) {
    super(message, options);
    this.entity = options?.entity;
  }
}

/** The user declined, or the OS withheld, a permission the action needed (§26). */
export class PermissionDeniedError extends AppError {
  readonly code = 'permission-denied' as const;
  readonly subject: PermissionSubject;

  constructor(subject: PermissionSubject, options?: { cause?: unknown }) {
    super(`Permission denied: ${subject}`, options);
    this.subject = subject;
  }
}

/** No biometric hardware, none enrolled, or biometrics are locked out (§17, §26). */
export class BiometricsUnavailableError extends AppError {
  readonly code = 'biometrics-unavailable' as const;
  /** Distinguishes "no hardware" from "nothing enrolled" for better copy. */
  readonly reason: 'no-hardware' | 'not-enrolled' | 'locked-out' | 'unknown';

  constructor(
    reason: 'no-hardware' | 'not-enrolled' | 'locked-out' | 'unknown' = 'unknown',
    options?: { cause?: unknown }
  ) {
    super(`Biometrics unavailable: ${reason}`, options);
    this.reason = reason;
  }
}

/** The device ran out of room while writing a photo, backup or database page. */
export class InsufficientStorageError extends AppError {
  readonly code = 'insufficient-storage' as const;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

const UNKNOWN_MESSAGE: UserMessage = {
  title: 'Something went wrong',
  body: 'That action did not finish. Your saved data has not changed. Try again, and if it keeps happening, restart Keeply.',
  action: 'Try again',
};

function permissionMessage(subject: PermissionSubject): UserMessage {
  switch (subject) {
    case 'notifications':
      return {
        title: 'Reminders are turned off',
        body: 'Keeply can still track everything, but it cannot alert you before a bill or document is due. Turn on notifications for Keeply in your device settings to get reminders.',
        action: 'Open settings',
        retryIsFutile: true,
      };
    case 'camera':
      return {
        title: 'Camera access is off',
        body: 'Keeply needs the camera to photograph a receipt or document. Allow camera access in your device settings, or pick an existing photo instead.',
        action: 'Open settings',
        retryIsFutile: true,
      };
    case 'photo-library':
      return {
        title: 'Photo access is off',
        body: 'Keeply needs permission to open your photos. Allow photo access in your device settings, or take a new photo with the camera instead.',
        action: 'Open settings',
        retryIsFutile: true,
      };
  }
}

function biometricsMessage(reason: BiometricsUnavailableError['reason']): UserMessage {
  switch (reason) {
    case 'no-hardware':
      return {
        title: 'This device has no biometrics',
        body: 'Face or fingerprint unlock is not available here. You can still lock Keeply with your device passcode.',
        retryIsFutile: true,
      };
    case 'not-enrolled':
      return {
        title: 'No face or fingerprint set up',
        body: 'Add a face or fingerprint in your device settings first, then turn on the Keeply lock.',
        action: 'Open settings',
        retryIsFutile: true,
      };
    case 'locked-out':
      return {
        title: 'Biometric unlock is temporarily blocked',
        body: 'Too many failed attempts. Unlock your device with its passcode once, then try again.',
        action: 'Try again',
      };
    case 'unknown':
      return {
        title: 'Biometric unlock is unavailable',
        body: 'Keeply could not use face or fingerprint unlock right now. You can still open the app with your device passcode.',
        action: 'Try again',
      };
  }
}

/** Database errors originate in `@/db`; matched by name so this module stays dependency-free. */
function databaseMessage(name: string): UserMessage | null {
  if (name === 'DatabaseKeyUnavailableError') {
    return {
      title: 'Keeply cannot unlock your data',
      body: 'Your records are still on this device, but the key that unlocks them is not reachable. This usually happens after restoring a phone from a backup, or if the device passcode was removed. Unlock your device normally and reopen Keeply. If that does not help, restoring from a Keeply backup file will rebuild your data.',
      action: 'Try again',
      retryIsFutile: true,
    };
  }
  if (name === 'DatabaseInitError') {
    return {
      title: 'Keeply could not start',
      body: 'The app could not prepare its local storage. Closing Keeply completely and opening it again usually fixes this. Nothing has been deleted.',
      action: 'Try again',
    };
  }
  return null;
}

/**
 * Map any thrown value to calm, actionable copy.
 *
 * Accepts `unknown` on purpose: every catch site can call it without narrowing,
 * which is what keeps raw errors from reaching the screen.
 */
export function toUserMessage(error: unknown): UserMessage {
  if (error instanceof PermissionDeniedError) return permissionMessage(error.subject);
  if (error instanceof BiometricsUnavailableError) return biometricsMessage(error.reason);
  if (error instanceof DuplicateRecordError) {
    return {
      title: error.entity ? `You already have that ${error.entity}` : 'You already have that record',
      body: 'Nothing was added, so you will not see it twice. Open the existing one to edit it, or change the name to keep both.',
      retryIsFutile: true,
    };
  }

  if (error instanceof AppError) {
    switch (error.code) {
      case 'missing-local-file':
        return {
          title: 'That file is no longer on this device',
          body: 'The attachment was moved or deleted outside Keeply. The record itself is intact — you can attach a new photo or file to it.',
          action: 'Attach again',
          retryIsFutile: true,
        };
      case 'deleted-photo':
        return {
          title: 'Image unavailable',
          body: 'This photo was removed from your device. Everything else about this record is unchanged.',
          retryIsFutile: true,
        };
      case 'corrupted-backup':
        return {
          title: 'This backup file cannot be read',
          body: 'The file may be incomplete, from a different app, or opened with the wrong passphrase. Check the passphrase and pick the file again. Your current data has not been touched.',
          action: 'Choose another file',
          retryIsFutile: true,
        };
      case 'invalid-date':
        return {
          title: 'Check that date',
          body: 'Please enter a real calendar date. An expiry date also has to come after the issue date.',
        };
      case 'invalid-amount':
        return {
          title: 'Check that amount',
          body: 'Enter an amount greater than zero, using numbers only.',
        };
      case 'insufficient-storage':
        return {
          title: 'Not enough space on this device',
          body: 'Keeply could not save because storage is full. Free up some space — deleting a few large photos or videos is usually enough — then try again.',
          action: 'Try again',
          retryIsFutile: true,
        };
      default:
        return UNKNOWN_MESSAGE;
    }
  }

  if (error instanceof Error) {
    const fromDatabase = databaseMessage(error.name);
    if (fromDatabase) return fromDatabase;
  }

  return UNKNOWN_MESSAGE;
}

/** Best-effort code for logging and branching. Never render this. */
export function toErrorCode(error: unknown): AppErrorCode {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) {
    if (error.name === 'DatabaseKeyUnavailableError') return 'database-key-unavailable';
    if (error.name === 'DatabaseInitError') return 'database-init-failed';
  }
  return 'unknown';
}
