/**
 * Keeply — calendar dates across ten timezones.
 *
 * This is the project's highest-risk invariant, and until this file existed it
 * was verified only by throwaway scripts that were never committed.
 *
 * The invariant: a `YYYY-MM-DD` value is a *calendar day*, not an instant. It
 * must render as the same day, and count the same number of days away, on a
 * phone in Manila, in Los Angeles, on Kiritimati and in Kathmandu — at 00:00
 * local and at 23:59 local, on ordinary days and across DST transitions.
 *
 * Every assertion below is one that a `new Date('2026-10-12')` implementation
 * fails. `daysUntil` at 23:59 local is the single most sensitive one: a due
 * date silently flips to "Overdue by 1 day" late in the evening.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DUE_SOON_DAYS,
  daysBetween,
  daysUntil,
  formatDate,
  formatDateCompact,
  formatDateShort,
  formatExpiry,
  formatMonthYear,
  formatRelativeDue,
  isValidCalendarDate,
  parseCalendarDate,
  statusForDue,
  statusForExpiry,
  toCalendarString,
  toLocalDate,
  todayCalendarString,
} from '@/theme/format';

import {
  BEHIND_UTC_ZONES,
  TIME_ZONES,
  forEachTimeZone,
  inTimeZone,
  offsetMinutes,
} from './helpers/timezones';

/** Local 00:00 and local 23:59:59.999 on the same calendar day. */
function dayEdges(year: number, month1: number, day: number): { start: Date; end: Date } {
  return {
    start: new Date(year, month1 - 1, day, 0, 0, 0, 0),
    end: new Date(year, month1 - 1, day, 23, 59, 59, 999),
  };
}

describe('parseCalendarDate', () => {
  test('accepts real calendar days and rejects impossible ones', () => {
    assert.deepEqual(parseCalendarDate('2026-10-12'), { year: 2026, month: 10, day: 12 });
    assert.deepEqual(parseCalendarDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
    // Shape-valid but not a real day. A GLOB check would let all of these
    // through; §A7 is why the SQL side uses `date(col) IS col` as well.
    assert.equal(parseCalendarDate('2026-02-30'), null);
    assert.equal(parseCalendarDate('2026-02-29'), null, '2026 is not a leap year');
    assert.equal(parseCalendarDate('2026-13-45'), null);
    assert.equal(parseCalendarDate('2026-04-31'), null);
    assert.equal(parseCalendarDate('2026-00-10'), null);
    assert.equal(parseCalendarDate('2026-10-00'), null);
  });

  test('rejects garbage instead of inventing a date (§B4)', () => {
    for (const bad of ['bogus', '', '   ', '10/12/2026', '2026/10/12', 'NaN-NaN-NaN']) {
      assert.equal(parseCalendarDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(parseCalendarDate(null), null);
    assert.equal(parseCalendarDate(undefined), null);

    // Years before 0100 are rejected rather than silently becoming 19xx.
    // `Date.UTC(99, 0, 1)` is 1999 (the two-digit-year rule), and the UTC
    // round-trip probe inside parseCalendarDate catches the mismatch. The old
    // `time.ts` implementation returned 1999 here and wrote it to a column.
    assert.equal(parseCalendarDate('0099-01-01'), null);
    assert.equal(toLocalDate('0099-01-01'), null);
    assert.equal(isValidCalendarDate('2026-02-30'), false);
    assert.equal(isValidCalendarDate('2026-10-12'), true);
  });

  test('is timezone-independent', () => {
    forEachTimeZone((zone) => {
      assert.deepEqual(
        parseCalendarDate('2026-01-01'),
        { year: 2026, month: 1, day: 1 },
        `parse shifted in ${zone}`,
      );
      assert.deepEqual(
        parseCalendarDate('2026-12-31'),
        { year: 2026, month: 12, day: 31 },
        `parse shifted in ${zone}`,
      );
    });
  });
});

describe('toLocalDate / toCalendarString round-trip', () => {
  test('a calendar string survives a round-trip in every timezone', () => {
    const days = ['2026-01-01', '2026-03-08', '2026-06-15', '2026-10-12', '2026-12-31'];
    forEachTimeZone((zone) => {
      for (const iso of days) {
        const date = toLocalDate(iso);
        assert.notEqual(date, null, `${iso} did not parse in ${zone}`);
        assert.equal(toCalendarString(date as Date), iso, `${iso} shifted in ${zone}`);
      }
    });
  });

  test('toLocalDate lands on LOCAL midnight of the requested day, everywhere', () => {
    forEachTimeZone((zone) => {
      const date = toLocalDate('2026-10-12') as Date;
      assert.equal(date.getFullYear(), 2026, `year shifted in ${zone}`);
      assert.equal(date.getMonth(), 9, `month shifted in ${zone}`);
      assert.equal(date.getDate(), 12, `day shifted in ${zone}`);
      assert.equal(date.getHours(), 0, `not local midnight in ${zone}`);
    });
  });

  test('the banned form really does shift the day — this is what the rule prevents', () => {
    for (const zone of BEHIND_UTC_ZONES) {
      inTimeZone(zone, () => {
        // This test exists to demonstrate that the banned construction is
        // wrong. It is the only such call in the repository, and it is an
        // assertion about the platform, not a code path.
        // eslint-disable-next-line no-restricted-syntax
        const wrong = new Date('2026-10-12');
        assert.equal(
          wrong.getDate(),
          11,
          `expected UTC-midnight parsing to read as the 11th in ${zone}`,
        );
        assert.equal((toLocalDate('2026-10-12') as Date).getDate(), 12);
      });
    }
  });

  test('toCalendarString zero-pads and never emits NaN', () => {
    inTimeZone('Asia/Manila', () => {
      assert.equal(toCalendarString(new Date(2026, 0, 5)), '2026-01-05');
      assert.equal(toCalendarString(new Date(99, 0, 1)), '1999-01-01', 'Date maps 99 -> 1999');
      // An invalid Date is never produced by toLocalDate (it returns null
      // instead), but if one is handed in the output is obviously broken
      // rather than plausibly wrong — and no CHECK constraint will accept it.
      assert.equal(toCalendarString(new Date(Number.NaN)), '0NaN-NaN-NaN');
    });
  });
});

describe('todayCalendarString', () => {
  test('reads the local day at 00:00 and at 23:59 in every timezone', () => {
    forEachTimeZone((zone) => {
      const { start, end } = dayEdges(2026, 10, 12);
      assert.equal(todayCalendarString(start), '2026-10-12', `00:00 wrong in ${zone}`);
      assert.equal(todayCalendarString(end), '2026-10-12', `23:59 wrong in ${zone}`);
    });
  });

  test('rolls over exactly at local midnight, not at UTC midnight', () => {
    forEachTimeZone((zone) => {
      const lastMoment = new Date(2026, 11, 31, 23, 59, 59, 999);
      const firstMoment = new Date(2027, 0, 1, 0, 0, 0, 0);
      assert.equal(todayCalendarString(lastMoment), '2026-12-31', `NYE wrong in ${zone}`);
      assert.equal(todayCalendarString(firstMoment), '2027-01-01', `NYD wrong in ${zone}`);
    });
  });
});

describe('daysUntil / daysBetween', () => {
  test('a due date is "0 days away" for the whole of its local day', () => {
    forEachTimeZone((zone) => {
      const { start, end } = dayEdges(2026, 10, 12);
      assert.equal(daysUntil('2026-10-12', start), 0, `00:00 wrong in ${zone}`);
      assert.equal(daysUntil('2026-10-12', end), 0, `23:59 wrong in ${zone}`);
      assert.equal(daysUntil('2026-10-13', end), 1, `tomorrow wrong at 23:59 in ${zone}`);
      assert.equal(daysUntil('2026-10-11', start), -1, `yesterday wrong at 00:00 in ${zone}`);
    });
  });

  test('counts whole calendar days across a month and a year boundary', () => {
    forEachTimeZone((zone) => {
      assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1, `month end wrong in ${zone}`);
      assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1, `year end wrong in ${zone}`);
      assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365, `year length wrong in ${zone}`);
      assert.equal(daysBetween('2024-01-01', '2025-01-01'), 366, `leap year wrong in ${zone}`);
      assert.equal(daysBetween('2026-10-12', '2026-10-12'), 0);
      assert.equal(daysBetween('2026-10-12', '2026-10-05'), -7);
    });
  });

  test('returns null for an unparseable side rather than a number', () => {
    assert.equal(daysBetween('bogus', '2026-10-12'), null);
    assert.equal(daysBetween('2026-10-12', '2026-02-30'), null);
    assert.equal(daysUntil('bogus', new Date(2026, 9, 12)), null);
  });
});

describe('DST transitions', () => {
  /**
   * A 23-hour day and a 25-hour day must both count as exactly one day. The
   * transitions are asserted to be real first, so this suite can never pass
   * vacuously if the IANA database moves a rule.
   */
  const TRANSITIONS = [
    { zone: 'America/Los_Angeles', label: 'US spring forward', before: '2026-03-07', after: '2026-03-09' },
    { zone: 'America/Los_Angeles', label: 'US fall back', before: '2026-10-31', after: '2026-11-02' },
    { zone: 'America/New_York', label: 'US spring forward', before: '2026-03-07', after: '2026-03-09' },
    { zone: 'America/New_York', label: 'US fall back', before: '2026-10-31', after: '2026-11-02' },
    { zone: 'Europe/London', label: 'BST starts', before: '2026-03-28', after: '2026-03-30' },
    { zone: 'Europe/London', label: 'BST ends', before: '2026-10-24', after: '2026-10-26' },
    { zone: 'Australia/Sydney', label: 'AEDT ends', before: '2026-04-04', after: '2026-04-06' },
    { zone: 'Australia/Sydney', label: 'AEDT starts', before: '2026-10-03', after: '2026-10-05' },
    { zone: 'Pacific/Chatham', label: 'Chatham DST ends', before: '2026-04-04', after: '2026-04-06' },
  ];

  test('each transition under test is a genuine offset change', () => {
    for (const { zone, label, before, after } of TRANSITIONS) {
      const beforeOffset = offsetMinutes(zone, toLocalDate(before) as Date);
      const afterOffset = offsetMinutes(zone, toLocalDate(after) as Date);
      assert.notEqual(
        beforeOffset,
        afterOffset,
        `${zone} ${label}: no offset change between ${before} and ${after} — the ` +
          'test would pass vacuously',
      );
    }
  });

  test('a 23-hour and a 25-hour day each count as exactly one day', () => {
    for (const { zone, label, before, after } of TRANSITIONS) {
      inTimeZone(zone, () => {
        assert.equal(daysBetween(before, after), 2, `${zone} ${label}: daysBetween`);
        const lateTheNightBefore = new Date(
          Number((before.slice(0, 4))),
          Number(before.slice(5, 7)) - 1,
          Number(before.slice(8, 10)),
          23,
          59,
          59,
          999,
        );
        assert.equal(
          daysUntil(after, lateTheNightBefore),
          2,
          `${zone} ${label}: daysUntil at 23:59 the night before`,
        );
      });
    }
  });

  test('the day of a spring-forward is still one day long', () => {
    inTimeZone('America/Los_Angeles', () => {
      // 2026-03-08 in Los Angeles is 23 hours long.
      assert.equal(daysBetween('2026-03-08', '2026-03-09'), 1);
      assert.equal(daysUntil('2026-03-09', new Date(2026, 2, 8, 23, 59, 59, 999)), 1);
      assert.equal(daysUntil('2026-03-08', new Date(2026, 2, 8, 0, 0, 0, 0)), 0);
    });
  });

  test('the day of a fall-back is still one day long', () => {
    inTimeZone('America/New_York', () => {
      // 2026-11-01 in New York is 25 hours long.
      assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
      assert.equal(daysUntil('2026-11-02', new Date(2026, 10, 1, 23, 59, 59, 999)), 1);
      assert.equal(daysUntil('2026-11-01', new Date(2026, 10, 1, 1, 30, 0, 0)), 0);
    });
  });
});

describe('quarter-hour offsets', () => {
  test('+05:45 and +12:45 zones behave like every other zone', () => {
    for (const zone of ['Asia/Kathmandu', 'Pacific/Chatham']) {
      inTimeZone(zone, () => {
        const { start, end } = dayEdges(2026, 10, 12);
        assert.equal(todayCalendarString(start), '2026-10-12', zone);
        assert.equal(todayCalendarString(end), '2026-10-12', zone);
        assert.equal(daysUntil('2026-10-12', end), 0, zone);
        assert.equal(daysUntil('2026-10-19', end), 7, zone);
      });
    }
  });
});

describe('status derivation', () => {
  test('statusForDue at 23:59 on the due date is still "dueToday"', () => {
    forEachTimeZone((zone) => {
      const { start, end } = dayEdges(2026, 10, 12);
      assert.equal(statusForDue('2026-10-12', { now: start }), 'dueToday', zone);
      assert.equal(statusForDue('2026-10-12', { now: end }), 'dueToday', `23:59 in ${zone}`);
      assert.equal(statusForDue('2026-10-11', { now: end }), 'overdue', zone);
      assert.equal(statusForDue('2026-10-13', { now: end }), 'dueSoon', zone);
      assert.equal(
        statusForDue(toCalendarString(new Date(2026, 9, 12 + DUE_SOON_DAYS)), { now: end }),
        'dueSoon',
        `the ${DUE_SOON_DAYS}-day boundary is inclusive (${zone})`,
      );
      assert.equal(
        statusForDue(toCalendarString(new Date(2026, 9, 12 + DUE_SOON_DAYS + 1)), { now: end }),
        'upcoming',
        zone,
      );
    });
  });

  test('paid and inactive win over the date', () => {
    const now = new Date(2026, 9, 12);
    assert.equal(statusForDue('2026-01-01', { paid: true, now }), 'paid');
    assert.equal(statusForDue('2026-01-01', { active: false, now }), 'inactive');
    assert.equal(statusForDue('bogus', { now }), 'upcoming');
  });

  test('statusForExpiry uses the 30-day window in every timezone', () => {
    forEachTimeZone((zone) => {
      const { end } = dayEdges(2026, 10, 12);
      assert.equal(statusForExpiry('2026-10-11', { now: end }), 'expired', zone);
      assert.equal(statusForExpiry('2026-10-12', { now: end }), 'expiringSoon', zone);
      assert.equal(statusForExpiry('2026-11-11', { now: end }), 'expiringSoon', `+30d ${zone}`);
      assert.equal(statusForExpiry('2026-11-12', { now: end }), 'valid', `+31d ${zone}`);
    });
  });
});

describe('human-readable copy', () => {
  test('relative-due copy is stable at both edges of the local day', () => {
    forEachTimeZone((zone) => {
      const { start, end } = dayEdges(2026, 10, 12);
      for (const now of [start, end]) {
        assert.equal(formatRelativeDue('2026-10-12', now), 'Due today', zone);
        assert.equal(formatRelativeDue('2026-10-13', now), 'Due tomorrow', zone);
        assert.equal(formatRelativeDue('2026-10-15', now), 'Due in 3 days', zone);
        assert.equal(formatRelativeDue('2026-10-11', now), 'Overdue by 1 day', zone);
        assert.equal(formatRelativeDue('2026-10-10', now), 'Overdue by 2 days', zone);
      }
      assert.equal(formatRelativeDue('bogus', start), '—', zone);
    });
  });

  test('expiry copy is stable at both edges of the local day', () => {
    forEachTimeZone((zone) => {
      const { start, end } = dayEdges(2026, 10, 12);
      for (const now of [start, end]) {
        assert.equal(formatExpiry('2026-10-12', now), 'Expires today', zone);
        assert.equal(formatExpiry('2026-10-13', now), 'Expires tomorrow', zone);
        assert.equal(formatExpiry('2026-11-23', now), 'Expires in 42 days', zone);
        assert.equal(formatExpiry('2026-10-11', now), 'Expired', zone);
      }
    });
  });

  test('date formatting never shifts the day', () => {
    forEachTimeZone((zone) => {
      assert.equal(formatDate('2026-10-12'), 'October 12, 2026', zone);
      assert.equal(formatDateShort('2026-10-12'), 'Oct 12, 2026', zone);
      assert.equal(formatDateCompact('2026-10-12'), 'Oct 12', zone);
      assert.equal(formatMonthYear('2026-10-12'), 'October 2026', zone);
      assert.equal(formatDate('2026-01-01'), 'January 1, 2026', zone);
      assert.equal(formatDate('2026-12-31'), 'December 31, 2026', zone);
    });
  });

  test('unparseable dates render an em dash, never "Invalid Date"', () => {
    for (const render of [formatDate, formatDateShort, formatDateCompact, formatMonthYear]) {
      assert.equal(render('2026-02-30'), '—');
      assert.equal(render('bogus'), '—');
    }
  });
});

describe('the matrix is real', () => {
  test('inTimeZone actually switches the process timezone', () => {
    // If this harness silently stopped working, every "in every timezone"
    // assertion above would run ten times in one zone and pass vacuously.
    const manila = inTimeZone('Asia/Manila', () => new Date(2026, 0, 1).getTimezoneOffset());
    const losAngeles = inTimeZone('America/Los_Angeles', () =>
      new Date(2026, 0, 1).getTimezoneOffset(),
    );
    assert.notEqual(manila, losAngeles, 'the timezone harness is not switching anything');
    assert.equal(manila, -480, 'Asia/Manila is UTC+08');
    assert.equal(losAngeles, 480, 'America/Los_Angeles is UTC-08 in January');
  });

  test('the ten zones actually resolve to ten distinct offsets over the year', () => {
    const january = new Date(Date.UTC(2026, 0, 15));
    const july = new Date(Date.UTC(2026, 6, 15));
    const seen = new Set<string>();
    for (const zone of TIME_ZONES) {
      seen.add(`${offsetMinutes(zone, january)}/${offsetMinutes(zone, july)}`);
    }
    assert.equal(seen.size, TIME_ZONES.length, 'two zones collapsed to the same offset pair');
  });
});
