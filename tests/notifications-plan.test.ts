/**
 * Keeply — reminder planning: fire dates, the past-date skip, the rolling
 * window and §8's copy.
 *
 * A reminder is a date bug waiting to happen. "3 days before" has to mean three
 * calendar days on a phone in Manila, in Los Angeles across a spring-forward,
 * on Chatham Island at +12:45, and at 23:59 local — the hour of day when a
 * naive implementation quietly slips to the wrong day. So the arithmetic is run
 * through the same ten-zone matrix `format-dates.test.ts` uses, and the central
 * property is asserted directly: **the gap between the fire day and the event
 * day is exactly the lead time, always, everywhere.**
 *
 * The second half is the two things that are not arithmetic and still ship
 * bugs: never firing a reminder whose moment has passed, and deciding which 60
 * of a user's 400 reminders the OS is allowed to hold.
 *
 * Everything here is pure. No `expo-notifications`, no simulator — see
 * `notifications-service.test.ts` for the module-boundary half.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { MinorUnits } from '@/db';
import {
  MAX_SCHEDULED_REMINDERS,
  identifierBelongsTo,
  isReminderIdentifier,
  normalizeReminderHour,
  parseReminderIdentifier,
  planAllReminders,
  planRemindersFor,
  reminderBody,
  reminderCopy,
  reminderDefaultsFromSettings,
  reminderFireTime,
  reminderIdentifier,
  reminderTitle,
  resolveLeadTimes,
  selectReminderWindow,
  type ReminderDefaults,
  type ReminderEntity,
} from '@/lib/notifications-plan';
import { DEFAULT_SETTINGS, REMINDER_LEAD_DAYS } from '@/stores/settings-store';
import { daysBetween, toCalendarString } from '@/theme/format';

import { TIME_ZONES, forEachTimeZone, inTimeZone } from './helpers/timezones';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Amounts arrive branded from `*_amount_minor` columns; tests mint their own. */
const minor = (centavos: number): MinorUnits => centavos as MinorUnits;

/** A local wall-clock instant, built numerically — never from a string. */
function at(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function defaults(overrides: Partial<ReminderDefaults> = {}): ReminderDefaults {
  return {
    subscription: ['1-day'],
    bill: ['3-days', '1-day'],
    document: ['30-days', '7-days'],
    hour: 9,
    ...overrides,
  };
}

function subscription(overrides: Partial<ReminderEntity> = {}): ReminderEntity {
  return {
    id: 'sub-1',
    kind: 'subscription',
    title: 'Netflix',
    dateISO: '2026-10-12',
    amountMinor: minor(54_900),
    currency: 'PHP',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Settings projection                                                         */
/* -------------------------------------------------------------------------- */

describe('reminderDefaultsFromSettings', () => {
  test('maps each settings field onto its kind', () => {
    const projected = reminderDefaultsFromSettings(DEFAULT_SETTINGS);
    assert.deepEqual(projected, {
      subscription: DEFAULT_SETTINGS.subscriptionReminderLeadTimes,
      bill: DEFAULT_SETTINGS.billReminderLeadTimes,
      document: DEFAULT_SETTINGS.documentReminderLeadTimes,
      hour: DEFAULT_SETTINGS.reminderHour,
    });
  });

  test('the shipped defaults are the §8 set, not something invented here', () => {
    // If these change in the store, the change should be deliberate — a silent
    // drift to "no reminders by default" is a feature that quietly stops.
    assert.deepEqual([...DEFAULT_SETTINGS.subscriptionReminderLeadTimes], ['1-day']);
    assert.deepEqual([...DEFAULT_SETTINGS.billReminderLeadTimes], ['3-days', '1-day']);
    assert.deepEqual([...DEFAULT_SETTINGS.documentReminderLeadTimes], ['30-days', '7-days']);
  });
});

/* -------------------------------------------------------------------------- */
/* Lead times                                                                  */
/* -------------------------------------------------------------------------- */

describe('resolveLeadTimes', () => {
  test('falls back to the global default for the kind (§8)', () => {
    assert.deepEqual([...resolveLeadTimes(subscription(), defaults())], ['1-day']);
    assert.deepEqual(
      [...resolveLeadTimes(subscription({ kind: 'bill' }), defaults())],
      ['1-day', '3-days'],
    );
    assert.deepEqual(
      [...resolveLeadTimes(subscription({ kind: 'document' }), defaults())],
      ['7-days', '30-days'],
    );
  });

  test('a per-item override replaces the default entirely', () => {
    const entity = subscription({ leadTimes: ['30-days', 'same-day'] });
    assert.deepEqual([...resolveLeadTimes(entity, defaults())], ['same-day', '30-days']);
  });

  test('an explicit empty override means "no reminders", not "use the default"', () => {
    // The distinction that matters: `null` is "I never chose", `[]` is "I chose
    // none". Collapsing them silently re-enables reminders the user turned off.
    assert.deepEqual([...resolveLeadTimes(subscription({ leadTimes: [] }), defaults())], []);
    assert.deepEqual([...resolveLeadTimes(subscription({ leadTimes: null }), defaults())], [
      '1-day',
    ]);
  });

  test('normalises order and duplicates so the plan is stable', () => {
    const scrambled = subscription({ leadTimes: ['30-days', '1-day', '30-days', 'same-day'] });
    const tidy = subscription({ leadTimes: ['same-day', '1-day', '30-days'] });
    assert.deepEqual(
      [...resolveLeadTimes(scrambled, defaults())],
      [...resolveLeadTimes(tidy, defaults())],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Fire dates — the ten-zone matrix                                            */
/* -------------------------------------------------------------------------- */

describe('reminderFireTime', () => {
  test('the fire day is exactly `leadDays` calendar days before the event, in every zone', () => {
    // The whole feature in one assertion. Every zone, every lead time, a spread
    // of event dates including month ends, a leap day, and both US DST
    // transitions. A `new Date(iso) - days * 86_400_000` implementation fails
    // this on the DST rows.
    const eventDates = [
      '2026-01-01',
      '2026-01-31',
      '2026-03-01',
      '2026-03-08', // US spring forward
      '2026-03-09',
      '2026-04-01',
      '2026-04-05', // Sydney DST ends
      '2026-10-04', // Sydney DST starts
      '2026-11-01', // US fall back
      '2026-11-02',
      '2026-12-31',
      '2028-02-29', // leap day
      '2028-03-01',
    ];

    forEachTimeZone((zone) => {
      for (const eventDate of eventDates) {
        for (const [leadTime, leadDays] of Object.entries(REMINDER_LEAD_DAYS)) {
          const fire = reminderFireTime(eventDate, leadDays, 9);
          assert.notEqual(fire, null, `${zone} ${eventDate} ${leadTime}`);
          if (fire === null) continue;

          assert.equal(
            daysBetween(fire.fireDateISO, eventDate),
            leadDays,
            `${zone}: ${leadTime} before ${eventDate} landed on ${fire.fireDateISO}`,
          );
          // And the instant really is on that calendar day, locally.
          assert.equal(
            toCalendarString(fire.fireAt),
            fire.fireDateISO,
            `${zone}: instant for ${eventDate} ${leadTime} is not on its own fire day`,
          );
        }
      }
    });
  });

  test('fires at the configured local hour, not midnight', () => {
    forEachTimeZone((zone) => {
      for (const hour of [0, 6, 9, 13, 21, 23]) {
        const fire = reminderFireTime('2026-10-12', 3, hour);
        assert.notEqual(fire, null);
        if (fire === null) continue;
        assert.equal(fire.fireAt.getHours(), hour, `${zone} @ ${hour}`);
        assert.equal(fire.fireAt.getMinutes(), 0);
        assert.equal(fire.fireAt.getSeconds(), 0);
        assert.equal(fire.fireAt.getMilliseconds(), 0);
      }
    });
  });

  test('a spring-forward hour that does not exist rolls forward, never to the day before', () => {
    // 2026-03-08, America/Los_Angeles: 02:00–02:59 local does not happen.
    // A reminder set for 02:00 must still land ON the 8th. Rolling backwards
    // (to 01:00 on the 8th would be fine, to the 7th would not) is the failure
    // this pins.
    inTimeZone('America/Los_Angeles', () => {
      const fire = reminderFireTime('2026-03-11', 3, 2);
      assert.notEqual(fire, null);
      if (fire === null) return;
      assert.equal(fire.fireDateISO, '2026-03-08');
      assert.equal(toCalendarString(fire.fireAt), '2026-03-08');
      assert.equal(fire.fireAt.getHours(), 3, 'V8 rolls a nonexistent 02:00 forward to 03:00');
    });
  });

  test('a fall-back hour that happens twice still lands on the right day', () => {
    // 2026-11-01, America/Los_Angeles: 01:00–01:59 local happens twice. Either
    // instant is acceptable; the calendar day is not negotiable.
    inTimeZone('America/Los_Angeles', () => {
      const fire = reminderFireTime('2026-11-08', 7, 1);
      assert.notEqual(fire, null);
      if (fire === null) return;
      assert.equal(fire.fireDateISO, '2026-11-01');
      assert.equal(toCalendarString(fire.fireAt), '2026-11-01');
      assert.equal(fire.fireAt.getHours(), 1);
    });
  });

  test('a 30-day lead across a DST boundary is still 30 days', () => {
    // The classic: 30 * 86_400_000 milliseconds is not 30 calendar days in a
    // zone that changed offset in between. Southern-hemisphere DST is included
    // because it moves the other way.
    for (const [zone, eventDate] of [
      ['America/Los_Angeles', '2026-04-01'],
      ['America/New_York', '2026-11-25'],
      ['Australia/Sydney', '2026-10-30'],
      ['Pacific/Chatham', '2026-10-25'],
    ] as const) {
      inTimeZone(zone, () => {
        const fire = reminderFireTime(eventDate, 30, 9);
        assert.notEqual(fire, null);
        if (fire === null) return;
        assert.equal(daysBetween(fire.fireDateISO, eventDate), 30, zone);
        assert.equal(fire.fireAt.getHours(), 9, `${zone} lost or gained an hour`);
      });
    }
  });

  test('same-day means the event day itself', () => {
    const fire = reminderFireTime('2026-10-12', 0, 9);
    assert.equal(fire?.fireDateISO, '2026-10-12');
  });

  test('crosses month and year boundaries', () => {
    assert.equal(reminderFireTime('2026-01-05', 7, 9)?.fireDateISO, '2025-12-29');
    assert.equal(reminderFireTime('2026-03-01', 1, 9)?.fireDateISO, '2026-02-28');
    assert.equal(reminderFireTime('2028-03-01', 1, 9)?.fireDateISO, '2028-02-29');
    assert.equal(reminderFireTime('2026-04-01', 30, 9)?.fireDateISO, '2026-03-02');
  });

  test('returns null for anything that is not a real calendar date (§26)', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '', '10/12/2026']) {
      assert.equal(reminderFireTime(bad, 1, 9), null, bad);
    }
  });
});

describe('normalizeReminderHour', () => {
  test('folds any integer onto 0–23 and survives nonsense', () => {
    assert.equal(normalizeReminderHour(9), 9);
    assert.equal(normalizeReminderHour(0), 0);
    assert.equal(normalizeReminderHour(23), 23);
    assert.equal(normalizeReminderHour(24), 0);
    assert.equal(normalizeReminderHour(-1), 23);
    assert.equal(normalizeReminderHour(9.7), 9);
    assert.equal(normalizeReminderHour(Number.NaN), 9, 'falls back to the default hour');
  });
});

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

describe('reminder identifiers', () => {
  test('round-trip', () => {
    const id = reminderIdentifier('9f1c8b6e-1a2b-4c3d-8e4f-5a6b7c8d9e0f', '3-days');
    assert.equal(id, 'keeply:v1:9f1c8b6e-1a2b-4c3d-8e4f-5a6b7c8d9e0f:3-days');
    assert.ok(isReminderIdentifier(id));
    assert.deepEqual(parseReminderIdentifier(id), {
      entityId: '9f1c8b6e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      leadTime: '3-days',
    });
  });

  test('an id containing colons still parses — the lead time is the last segment', () => {
    const id = reminderIdentifier('weird:id:with:colons', '30-days');
    assert.deepEqual(parseReminderIdentifier(id), {
      entityId: 'weird:id:with:colons',
      leadTime: '30-days',
    });
  });

  test('a notification this app did not schedule is left strictly alone', () => {
    // Cancelling a foreign notification would be a bug with no error message.
    for (const foreign of ['some-other-app', 'keeply', 'keeply:v1:', 'keeply:v1:abc:9-days', '']) {
      assert.equal(parseReminderIdentifier(foreign), null, foreign);
    }
    assert.equal(isReminderIdentifier('some-other-app'), false);
  });

  test('identifierBelongsTo matches the record and nothing else', () => {
    const id = reminderIdentifier('sub-1', '1-day');
    assert.ok(identifierBelongsTo(id, 'sub-1'));
    assert.equal(identifierBelongsTo(id, 'sub-11'), false);
    assert.equal(identifierBelongsTo(id, 'sub'), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Copy (§8)                                                                   */
/* -------------------------------------------------------------------------- */

describe('reminder copy', () => {
  test("reproduces §8's examples exactly", () => {
    assert.equal(
      reminderBody(subscription({ title: 'Netflix', amountMinor: minor(54_900) }), 1),
      'Netflix renews tomorrow — ₱549',
    );
    assert.equal(
      reminderBody(
        subscription({ kind: 'bill', title: 'Internet bill', amountMinor: minor(189_900) }),
        3,
      ),
      'Internet bill is due in 3 days — ₱1,899',
    );
    assert.equal(
      reminderBody(
        { id: 'doc-1', kind: 'document', title: "driver's license", dateISO: '2026-10-12' },
        30,
      ),
      'Your driver\'s license expires in 30 days.',
    );
  });

  test('today / tomorrow / in N days', () => {
    const sub = subscription();
    assert.equal(reminderBody(sub, 0), 'Netflix renews today — ₱549');
    assert.equal(reminderBody(sub, 1), 'Netflix renews tomorrow — ₱549');
    assert.equal(reminderBody(sub, 7), 'Netflix renews in 7 days — ₱549');

    const bill = subscription({ kind: 'bill', title: 'Meralco', amountMinor: minor(320_050) });
    assert.equal(reminderBody(bill, 0), 'Meralco is due today — ₱3,200.50');
    assert.equal(reminderBody(bill, 1), 'Meralco is due tomorrow — ₱3,200.50');

    const doc: ReminderEntity = {
      id: 'doc-1',
      kind: 'document',
      title: 'passport',
      dateISO: '2026-10-12',
    };
    assert.equal(reminderBody(doc, 0), 'Your passport expires today.');
    assert.equal(reminderBody(doc, 1), 'Your passport expires tomorrow.');
    assert.equal(reminderBody(doc, 7), 'Your passport expires in 7 days.');
  });

  test('centavos survive; whole pesos are not padded with .00', () => {
    // The amount is formatted through `formatMoney` from integer minor units.
    // A hand-built "₱" + (minor / 100) is what this rules out.
    assert.equal(reminderBody(subscription({ amountMinor: minor(54_950) }), 1),
      'Netflix renews tomorrow — ₱549.50');
    assert.equal(reminderBody(subscription({ amountMinor: minor(100) }), 1),
      'Netflix renews tomorrow — ₱1');
    assert.equal(reminderBody(subscription({ amountMinor: minor(1_234_567) }), 1),
      'Netflix renews tomorrow — ₱12,345.67');
  });

  test('a record with no amount simply has no amount clause', () => {
    assert.equal(
      reminderBody(subscription({ amountMinor: null }), 1),
      'Netflix renews tomorrow',
    );
    assert.equal(
      reminderBody(subscription({ amountMinor: undefined }), 1),
      'Netflix renews tomorrow',
    );
  });

  test('the title says which kind of deadline it is', () => {
    assert.equal(reminderTitle('subscription'), 'Subscription renewal');
    assert.equal(reminderTitle('bill'), 'Bill due');
    assert.equal(reminderTitle('document'), 'Document expiring');
    assert.deepEqual(reminderCopy(subscription(), 1), {
      title: 'Subscription renewal',
      body: 'Netflix renews tomorrow — ₱549',
    });
  });

  test('copy is timezone-independent', () => {
    // Nothing in the copy path may consult the clock: the sentence is built
    // from the lead time, which is already a whole number of days.
    const rendered = new Set(TIME_ZONES.map((zone) => inTimeZone(zone, () => reminderBody(subscription(), 3))));
    assert.equal(rendered.size, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* planRemindersFor — the past-date skip                                       */
/* -------------------------------------------------------------------------- */

describe('planRemindersFor', () => {
  test('plans one notification per lead time, soonest first', () => {
    const entity = subscription({ leadTimes: ['same-day', '1-day', '7-days'] });
    const plan = planRemindersFor(entity, {
      defaults: defaults(),
      now: at(2026, 1, 1, 12),
    });

    assert.equal(plan.reminders.length, 3);
    assert.deepEqual(
      plan.reminders.map((r) => r.fireDateISO),
      ['2026-10-05', '2026-10-11', '2026-10-12'],
    );
    assert.deepEqual(
      plan.reminders.map((r) => r.leadTime),
      ['7-days', '1-day', 'same-day'],
    );
    assert.deepEqual(
      plan.reminders.map((r) => r.body),
      [
        'Netflix renews in 7 days — ₱549',
        'Netflix renews tomorrow — ₱549',
        'Netflix renews today — ₱549',
      ],
    );
    assert.equal(plan.skippedPast, 0);
  });

  test('a lead time whose moment has passed is SKIPPED, never fired immediately', () => {
    // Adding a bill on the 11th, with a "3 days before" default, must not throw
    // a notification at the user the instant they hit Save.
    const entity = subscription({ dateISO: '2026-10-12', leadTimes: ['3-days', '1-day'] });
    const plan = planRemindersFor(entity, {
      defaults: defaults(),
      // 08:00 on the 11th: the 3-days-before moment (Oct 9, 09:00) is long
      // gone, but today's own 09:00 has not arrived yet.
      now: at(2026, 10, 11, 8),
    });

    assert.equal(plan.skippedPast, 1);
    assert.deepEqual(plan.reminders.map((r) => r.leadTime), ['1-day']);
    assert.equal(plan.reminders[0].fireDateISO, '2026-10-11');
  });

  test('the boundary is exclusive: exactly-now does not fire', () => {
    const entity = subscription({ leadTimes: ['same-day'] });
    const exactly = at(2026, 10, 12, 9);

    assert.equal(planRemindersFor(entity, { defaults: defaults(), now: exactly }).skippedPast, 1);
    const oneMsEarlier = new Date(exactly.getTime() - 1);
    assert.equal(
      planRemindersFor(entity, { defaults: defaults(), now: oneMsEarlier }).reminders.length,
      1,
    );
  });

  test('late in the evening, tomorrow is still tomorrow — in every zone', () => {
    // 23:59 local is where a UTC-midnight implementation flips a day. A
    // reminder for 09:00 tomorrow must still be in the future at 23:59 today.
    forEachTimeZone((zone) => {
      const plan = planRemindersFor(subscription({ leadTimes: ['same-day'] }), {
        defaults: defaults(),
        now: at(2026, 10, 11, 23, 59, 59),
      });
      assert.equal(plan.reminders.length, 1, zone);
      assert.equal(plan.reminders[0].fireDateISO, '2026-10-12', zone);
    });
  });

  test('an entirely past record yields nothing at all', () => {
    const plan = planRemindersFor(subscription({ leadTimes: ['same-day', '1-day', '30-days'] }), {
      defaults: defaults(),
      now: at(2027, 1, 1, 9),
    });
    assert.deepEqual(plan.reminders, []);
    assert.equal(plan.skippedPast, 3);
  });

  test('a paused record schedules nothing (and is not counted as skipped)', () => {
    const plan = planRemindersFor(subscription({ active: false }), {
      defaults: defaults(),
      now: at(2026, 1, 1),
    });
    assert.deepEqual(plan.reminders, []);
    assert.equal(plan.skippedPast, 0);
  });

  test('a corrupt date yields no reminders instead of throwing (§26)', () => {
    const plan = planRemindersFor(subscription({ dateISO: '2026-02-30' }), {
      defaults: defaults(),
      now: at(2026, 1, 1),
    });
    assert.deepEqual(plan.reminders, []);
    assert.equal(plan.skippedPast, 0);
  });

  test('the delivery hour comes from settings', () => {
    const plan = planRemindersFor(subscription(), {
      defaults: defaults({ hour: 20 }),
      now: at(2026, 1, 1),
    });
    assert.equal(plan.reminders[0].fireAt.getHours(), 20);
  });

  test('identifiers are stable across two identical plans', () => {
    const entity = subscription({ leadTimes: ['30-days', 'same-day'] });
    const options = { defaults: defaults(), now: at(2026, 1, 1) };
    assert.deepEqual(
      planRemindersFor(entity, options).reminders.map((r) => r.identifier),
      planRemindersFor(entity, options).reminders.map((r) => r.identifier),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The rolling window                                                          */
/* -------------------------------------------------------------------------- */

describe('selectReminderWindow', () => {
  const slot = (identifier: string, fireAtMs: number) => ({ identifier, fireAtMs });

  test('keeps the soonest `limit` and defers the rest', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => slot(`id-${i}`, 1_000 + i));
    const window = selectReminderWindow(candidates, 4);

    assert.deepEqual(window.scheduled.map((s) => s.identifier), ['id-0', 'id-1', 'id-2', 'id-3']);
    assert.equal(window.deferred.length, 6);
  });

  test('every scheduled reminder fires no later than every deferred one', () => {
    // The invariant that makes the window *correct* rather than merely capped:
    // what falls off the end is always the furthest-out, never an arbitrary
    // 65th. Input order is deliberately shuffled.
    const candidates = Array.from({ length: 200 }, (_, i) =>
      slot(`id-${String(i).padStart(3, '0')}`, 5_000_000 - i * 37),
    );
    const window = selectReminderWindow(candidates, MAX_SCHEDULED_REMINDERS);

    assert.equal(window.scheduled.length, MAX_SCHEDULED_REMINDERS);
    assert.equal(window.deferred.length, 140);
    const lastScheduled = Math.max(...window.scheduled.map((s) => s.fireAtMs));
    const firstDeferred = Math.min(...window.deferred.map((s) => s.fireAtMs));
    assert.ok(lastScheduled <= firstDeferred);
  });

  test('a duplicate identifier consumes one slot, keeping the earlier instant', () => {
    const window = selectReminderWindow(
      [slot('dup', 9_000), slot('dup', 3_000), slot('other', 5_000)],
      10,
    );
    assert.equal(window.scheduled.length, 2);
    assert.equal(window.scheduled[0].identifier, 'dup');
    assert.equal(window.scheduled[0].fireAtMs, 3_000);
  });

  test('ties break deterministically, so rescheduling does not churn the queue', () => {
    const tied = [slot('b', 100), slot('a', 100), slot('c', 100)];
    assert.deepEqual(
      selectReminderWindow(tied, 2).scheduled.map((s) => s.identifier),
      ['a', 'b'],
    );
    assert.deepEqual(
      selectReminderWindow([...tied].reverse(), 2).scheduled.map((s) => s.identifier),
      ['a', 'b'],
    );
  });

  test('a zero or nonsense limit schedules nothing rather than everything', () => {
    const candidates = [slot('a', 1), slot('b', 2)];
    assert.equal(selectReminderWindow(candidates, 0).scheduled.length, 0);
    assert.equal(selectReminderWindow(candidates, 0).deferred.length, 2);
    assert.equal(selectReminderWindow(candidates, Number.NaN).scheduled.length, 0);
  });

  test('the cap leaves headroom under the iOS limit of 64', () => {
    assert.ok(MAX_SCHEDULED_REMINDERS < 64);
    assert.ok(MAX_SCHEDULED_REMINDERS >= 32, 'too small to be useful');
  });
});

/* -------------------------------------------------------------------------- */
/* planAllReminders                                                            */
/* -------------------------------------------------------------------------- */

describe('planAllReminders', () => {
  /** `count` subscriptions renewing on consecutive days from 2026-02-01. */
  function manySubscriptions(count: number): ReminderEntity[] {
    return Array.from({ length: count }, (_, i) => {
      const day = 1 + (i % 28);
      const month = 2 + Math.floor(i / 28);
      return subscription({
        id: `sub-${String(i).padStart(3, '0')}`,
        title: `Service ${i}`,
        dateISO: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        leadTimes: ['7-days', '1-day'],
      });
    });
  }

  test('200 records × 2 lead times overflows the window and says so', () => {
    // The scenario the brief calls out. 400 candidates, 60 slots: nothing is
    // dropped silently — the overflow is counted and the horizon is reported.
    const plan = planAllReminders(manySubscriptions(200), {
      defaults: defaults(),
      now: at(2026, 1, 1, 9),
    });

    assert.equal(plan.candidates, 400);
    assert.equal(plan.scheduled.length, MAX_SCHEDULED_REMINDERS);
    assert.equal(plan.deferred.length, 400 - MAX_SCHEDULED_REMINDERS);
    assert.equal(plan.skippedPast, 0);

    const lastScheduled = plan.scheduled.at(-1);
    assert.ok(lastScheduled !== undefined);
    assert.equal(plan.horizonISO, lastScheduled.fireDateISO);
    for (const deferred of plan.deferred) {
      assert.ok(deferred.fireAtMs >= lastScheduled.fireAtMs);
    }
  });

  test('under the cap, everything is scheduled and nothing is deferred', () => {
    const plan = planAllReminders(manySubscriptions(5), {
      defaults: defaults(),
      now: at(2026, 1, 1, 9),
    });
    assert.equal(plan.scheduled.length, 10);
    assert.deepEqual(plan.deferred, []);
  });

  test('mixes kinds and aggregates the skipped count', () => {
    const plan = planAllReminders(
      [
        subscription({ id: 'a', dateISO: '2026-10-12', leadTimes: ['1-day'] }),
        subscription({ id: 'b', kind: 'bill', title: 'Meralco', dateISO: '2020-01-01' }),
        {
          id: 'c',
          kind: 'document',
          title: "Driver's license",
          dateISO: '2026-11-30',
          leadTimes: ['30-days'],
        },
        subscription({ id: 'd', active: false }),
      ],
      { defaults: defaults(), now: at(2026, 1, 1, 9) },
    );

    // Chronological, not input order: 'a' fires 2026-10-11, 'c' fires
    // 2026-10-31 (30 days before its 2026-11-30 expiry).
    assert.deepEqual(plan.scheduled.map((r) => r.entityId), ['a', 'c']);
    assert.equal(plan.skippedPast, 2, 'the 2020 bill had both its lead times elapse');
  });

  test('an empty world is an empty plan, not a crash', () => {
    const plan = planAllReminders([], { defaults: defaults(), now: at(2026, 1, 1) });
    assert.deepEqual(plan.scheduled, []);
    assert.equal(plan.horizonISO, null);
    assert.equal(plan.candidates, 0);
  });

  test('the same plan comes out of the same input, in every zone', () => {
    // Not "the same instants" — a 09:00 local reminder is a different UTC
    // instant in each zone, correctly. The *calendar days* must not move.
    const entities = manySubscriptions(20);
    const days = TIME_ZONES.map((zone) =>
      inTimeZone(zone, () =>
        planAllReminders(entities, { defaults: defaults(), now: at(2026, 1, 1, 9) })
          .scheduled.map((r) => `${r.identifier}@${r.fireDateISO}`)
          .join('|'),
      ),
    );
    assert.equal(new Set(days).size, 1, 'the queue differs between timezones');
  });
});
