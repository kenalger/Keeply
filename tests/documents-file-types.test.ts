/**
 * Keeply — what a document file may be, and what the copy is called (§16).
 *
 * This is small and it is where the interesting mistakes are. A PDF stored
 * under a `.jpg` name renders as a broken image on the one screen a user opened
 * to look at their passport; an unknown type defaulted to `image/jpeg` does the
 * same thing more quietly; and an allowlist that quietly widens is a renderer
 * being handed whatever a picker returned.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTED_MIME_TYPES,
  extensionForMimeType,
  extensionOfUri,
  isAcceptedMimeType,
  isImageMimeType,
  resolveDocumentMimeType,
} from '@/features/documents/file-types';

describe('the allowlist', () => {
  test('is exactly what §16 contemplates: photos, scans, PDFs', () => {
    assert.deepEqual([...ACCEPTED_MIME_TYPES], [
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/heif',
      'image/webp',
      'application/pdf',
    ]);
  });

  test('accepts its members case-insensitively and nothing else', () => {
    for (const mime of ACCEPTED_MIME_TYPES) {
      assert.ok(isAcceptedMimeType(mime), mime);
      assert.ok(isAcceptedMimeType(mime.toUpperCase()), mime);
    }
    for (const rejected of [
      'application/msword',
      'text/html',
      'application/octet-stream',
      'image/svg+xml',
      'video/mp4',
      '',
      null,
      undefined,
    ]) {
      assert.equal(isAcceptedMimeType(rejected), false, String(rejected));
    }
  });

  test('an SVG is not an image as far as this app is concerned', () => {
    // `image/svg+xml` starts with `image/`, so `isImageMimeType` says yes —
    // and the allowlist says no, which is the one that gates storage. Worth
    // pinning: SVG is a document format that can carry script, and the reason
    // it is absent from the allowlist is not obvious from the prefix test.
    assert.equal(isImageMimeType('image/svg+xml'), true);
    assert.equal(isAcceptedMimeType('image/svg+xml'), false);
  });
});

describe('what the detail screen draws', () => {
  test('images are drawn, PDFs are not', () => {
    assert.equal(isImageMimeType('image/jpeg'), true);
    assert.equal(isImageMimeType('IMAGE/PNG'), true);
    assert.equal(isImageMimeType('application/pdf'), false);
    assert.equal(isImageMimeType(null), false);
  });
});

describe('resolving the type to store as', () => {
  test('a reported type on the list wins', () => {
    assert.equal(resolveDocumentMimeType('application/pdf', 'file:///x/a.jpg'), 'application/pdf');
    assert.equal(resolveDocumentMimeType('IMAGE/JPEG', 'file:///x/a.pdf'), 'image/jpeg');
  });

  test('a reported type OFF the list is refused, not second-guessed', () => {
    // `application/msword` named `.pdf` is either a mistake or an attempt, and
    // neither should be stored as a PDF. Falling through to the extension here
    // would turn the allowlist into a suggestion.
    assert.equal(resolveDocumentMimeType('application/msword', 'file:///x/a.pdf'), null);
    assert.equal(resolveDocumentMimeType('text/html', 'file:///x/a.png'), null);
  });

  test('nothing reported falls back to the extension', () => {
    // An iOS Files pick frequently reports no type at all.
    assert.equal(resolveDocumentMimeType(null, 'file:///x/passport.pdf'), 'application/pdf');
    assert.equal(resolveDocumentMimeType(undefined, 'file:///x/scan.PNG'), 'image/png');
    assert.equal(resolveDocumentMimeType('', 'file:///x/photo.heic'), 'image/heic');
  });

  test('`.jpeg` resolves — it is the spelling a Files pick returns', () => {
    assert.equal(resolveDocumentMimeType(null, 'file:///x/a.jpeg'), 'image/jpeg');
  });

  test('an unknown extension is refused, never defaulted', () => {
    // Storing an unknown file as `image/jpeg` is a detail screen trying to draw
    // a Word document.
    assert.equal(resolveDocumentMimeType(null, 'file:///x/a.docx'), null);
    assert.equal(resolveDocumentMimeType(null, 'file:///x/noextension'), null);
    assert.equal(resolveDocumentMimeType(null, 'file:///x/.hidden'), null);
  });
});

describe('extensions', () => {
  test('come from the MIME type, not the source name', () => {
    // The row records the type and the screen branches on it, so the name on
    // disk has to agree with the type or nothing else will.
    assert.equal(extensionForMimeType('application/pdf', 'file:///x/a.jpg'), '.pdf');
    assert.equal(extensionForMimeType('image/jpeg', 'file:///x/a.pdf'), '.jpg');
    assert.equal(extensionForMimeType('image/heic', 'file:///x/a'), '.heic');
  });

  test('every accepted type has one', () => {
    // Derived from the allowlist, so adding a type without an extension is a
    // failure here rather than a `.bin` on someone's passport scan.
    for (const mime of ACCEPTED_MIME_TYPES) {
      const extension = extensionForMimeType(mime, 'file:///x/a');
      assert.match(extension, /^\.[a-z0-9]+$/, mime);
      assert.notEqual(extension, '.bin', mime);
    }
  });

  test('an unresolvable type falls back to `.bin`, never to a guess', () => {
    assert.equal(extensionForMimeType(null, 'file:///x/a'), '.bin');
    // An extension this app never special-cases beats one it does.
    assert.equal(extensionForMimeType(null, 'file:///x/a.docx'), '.docx');
  });

  test('a query string is not part of the extension', () => {
    assert.equal(extensionOfUri('file:///x/a.pdf?v=2'), '.pdf');
    assert.equal(extensionOfUri('file:///x/a.pdf#page=3'), '.pdf');
  });

  test('a dot in a directory name is not an extension', () => {
    assert.equal(extensionOfUri('file:///my.folder/passport'), null);
    assert.equal(extensionOfUri('file:///my.folder/passport.jpg'), '.jpg');
  });
});
