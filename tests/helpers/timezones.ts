/**
 * Keeply — the timezone matrix.
 *
 * Calendar dates are the project's highest-risk invariant: a due date is a
 * `YYYY-MM-DD` string that must mean the same calendar day no matter where the
 * phone is. The classic failure is `new Date('2026-10-12')`, which is UTC
 * midnight — so at 23:59 local in Manila the app thinks it is already the 13th,
 * and at any time of day in Los Angeles it thinks it is still the 11th.
 *
 * These ten zones are chosen to break a naive implementation in a different way
 * each:
 *
 *  - `UTC`                  the only zone where the bug is invisible.
 *  - `Asia/Manila`          +08, the product's home market, no DST.
 *  - `Pacific/Kiritimati`   +14, the largest positive offset on Earth.
 *  - `Pacific/Pago_Pago`    -11, near the largest negative offset.
 *  - `Asia/Kathmandu`       +05:45, a quarter-hour offset.
 *  - `Pacific/Chatham`      +12:45 / +13:45, quarter-hour *and* DST.
 *  - `America/Los_Angeles`  -08/-07, US DST.
 *  - `America/New_York`     -05/-04, US DST, different wall clock.
 *  - `Europe/London`        +00/+01 — UTC for half the year, which is exactly
 *                           how a UTC bug survives a developer's testing.
 *  - `Australia/Sydney`     +10/+11, southern-hemisphere DST (inverted).
 */

/** Every zone the calendar-date suite runs against. */
export const TIME_ZONES = [
  'UTC',
  'Asia/Manila',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
] as const;

/** Zones whose offset is negative all year — where UTC midnight is "yesterday". */
export const BEHIND_UTC_ZONES = [
  'Pacific/Pago_Pago',
  'America/Los_Angeles',
  'America/New_York',
] as const;

/**
 * Run `fn` with the process timezone set to `zone`, then restore.
 *
 * Node re-reads `process.env.TZ` on assignment and notifies V8, so `Date`'s
 * local-time behaviour changes immediately. Keep `fn` synchronous: the setting
 * is process-global, and an `await` inside it would leak the zone into whatever
 * else the runner decides to interleave.
 */
export function inTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

/** Run `fn` once per zone in `TIME_ZONES`, passing the zone name through. */
export function forEachTimeZone(fn: (zone: string) => void): void {
  for (const zone of TIME_ZONES) inTimeZone(zone, () => fn(zone));
}

/** The UTC offset in minutes that `zone` is using at `instant`. */
export function offsetMinutes(zone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
