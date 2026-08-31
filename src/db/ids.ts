/**
 * Keeply — record identifiers.
 *
 * Every row's primary key is a UUIDv4 (invariant 4): stable, collision-free
 * without a server, and safe for a future sync queue to use as a global id.
 *
 * `expo-crypto` exposes `randomUUID()` in SDK 57 (verified in
 * node_modules/expo-crypto/build/Crypto.d.ts). The fallback below builds a
 * conformant v4 out of `getRandomBytes()` in case the native method is missing
 * on some platform build — it is never a `Math.random()` path.
 */
import * as Crypto from 'expo-crypto';

const HEX = '0123456789abcdef';

/** A new UUIDv4. */
export function newId(): string {
  const native = Crypto.randomUUID;
  if (typeof native === 'function') {
    return native();
  }
  return uuidV4FromRandomBytes();
}

function uuidV4FromRandomBytes(): string {
  const bytes = Crypto.getRandomBytes(16);

  // RFC 4122 §4.4: version 4, variant 10xx.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i];
    hex += HEX[(byte >> 4) & 0x0f] + HEX[byte & 0x0f];
  }

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
