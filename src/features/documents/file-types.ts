/**
 * Keeply — what a document file may be, and what to call the copy (§16).
 *
 * Pure: no filesystem, no Expo, no `@/db`. Extracted from `ui/storage.ts` so
 * `node --test` can reach it, because this is where the interesting mistakes
 * are — a PDF stored under a `.jpg` name renders as a broken image on the one
 * screen the user opened to look at their passport, and an unknown type
 * defaulted to `image/jpeg` does the same thing more quietly.
 */

/**
 * The types §16 contemplates: a scan, a photo, or a PDF.
 *
 * An ALLOWLIST rather than a blocklist. The file is copied into the app's
 * private directory and later handed to a renderer; accepting whatever the
 * picker returned would mean rendering arbitrary types, and "it is only a
 * document" is exactly the assumption that makes that interesting.
 */
export const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
] as const;

export type DocumentMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

export function isAcceptedMimeType(value: string | null | undefined): value is DocumentMimeType {
  return (
    typeof value === 'string' &&
    (ACCEPTED_MIME_TYPES as readonly string[]).includes(value.toLowerCase())
  );
}

/** Whether a stored file should be drawn, or represented by an icon. */
export function isImageMimeType(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('image/');
}

const EXTENSION_BY_MIME: Readonly<Record<DocumentMimeType, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/**
 * Spellings a picker returns that mean a type the table above already holds.
 *
 * `.jpeg` is the common one — a Files pick on iOS returns it more often than
 * `.jpg` — and `.htm`-style variants are deliberately absent: this map exists
 * to normalise, never to widen the allowlist.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, DocumentMimeType>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * The extension of a URI, lower-cased, or `null`.
 *
 * A query string is stripped first — `a.pdf?v=2` is a PDF.
 *
 * A dot in a DIRECTORY name is not an extension, and the character class is
 * what rules that out: `file:///my.folder/passport` slices to `.folder/passport`,
 * which contains a `/` and so does not match. An explicit `lastDot > lastSlash`
 * guard stood here too and was removed — a mutation proved no input could tell
 * the two apart, and an untested branch that looks load-bearing is worse than
 * one line of explanation.
 */
export function extensionOfUri(sourceUri: string): string | null {
  const withoutQuery = sourceUri.split(/[?#]/)[0] ?? '';
  const lastDot = withoutQuery.lastIndexOf('.');
  if (lastDot === -1) return null;
  const candidate = withoutQuery.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(candidate) ? candidate : null;
}

/**
 * The type to store a file as, or `null` if this app will not take it.
 *
 * ── THE ORDER, AND WHY IT IS THAT WAY ──────────────────────────────────────
 * A type the picker REPORTED wins, if it is on the allowlist. A type it
 * reported that is NOT on the allowlist is a refusal — not a fallback to the
 * extension, because `report: application/msword` with a name ending `.pdf` is
 * either a mistake or an attempt, and neither should be stored as a PDF.
 *
 * Only when the picker reported NOTHING — common on an iOS Files pick — is the
 * extension consulted. And there is no default: a file of unknown type stored
 * as `image/jpeg` is a detail screen trying to draw a Word document.
 */
export function resolveDocumentMimeType(
  reported: string | null | undefined,
  sourceUri: string,
): DocumentMimeType | null {
  if (isAcceptedMimeType(reported)) {
    return reported.toLowerCase() as DocumentMimeType;
  }
  // Reported something, and it is not on the list. Refuse rather than look
  // further — see the note above.
  if (reported !== null && reported !== undefined && reported.trim() !== '') return null;

  const extension = extensionOfUri(sourceUri);
  if (extension === null) return null;
  return MIME_BY_EXTENSION[extension] ?? null;
}

/**
 * The extension the sandbox copy gets.
 *
 * From the MIME type, because that is what the row records and what the detail
 * screen branches on. `.bin` is the last resort: an extension this app never
 * special-cases beats guessing one it does.
 */
export function extensionForMimeType(
  mimeType: DocumentMimeType | null,
  sourceUri: string,
): string {
  if (mimeType !== null) return EXTENSION_BY_MIME[mimeType];
  return extensionOfUri(sourceUri) ?? '.bin';
}
