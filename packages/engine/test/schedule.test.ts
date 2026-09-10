/**
 * Materialization of schedules: rules, exceptions, blocks, validity windows, and the local
 * weekday. This is the step that turns a resource's configuration into the intervals it is
 * open on, before any booking has been subtracted from them.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_DAYS,
  localDayRange,
  materializeSchedule,
  zoneOffsetMs,
  type ScheduleException,
  type ScheduleRule,
} from '../src/schedule/index.js';
import { discretize, erode } from '../src/timeline/index.js';

const HOUR = 3_600_000;
const ROME = 'Europe/Rome';

/** Epoch milliseconds of a UTC wall-clock time; the fixtures below are written in UTC. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

const weekdays = [1, 2, 3, 4, 5];
const allDays = [0, 1, 2, 3, 4, 5, 6];

/** 2026-06-01 is a Monday; June has no DST transition in Rome, so an hour is an hour. */
const JUNE_MONDAY = '2026-06-01';

function juneWeek(
  rules: ScheduleRule[],
  extra: Partial<Parameters<typeof materializeSchedule>[0]> = {},
) {
  return materializeSchedule({
    timezone: ROME,
    rules,
    capacity: 1,
    from: utc(2026, 6, 1),
    to: utc(2026, 6, 8),
    ...extra,
  });
}

describe('localDayRange', () => {
  it('is 24 hours on an ordinary day', () => {
    const range = localDayRange(ROME, JUNE_MONDAY);
    expect(range.start).toBe(utc(2026, 5, 31, 22));
    expect(range.end - range.start).toBe(24 * HOUR);
  });

  it('rejects an unknown zone and a malformed date', () => {
    expect(() => localDayRange('Nowhere/Nothing', JUNE_MONDAY)).toThrow(RangeError);
    expect(() => localDayRange(ROME, '2026-6-1')).toThrow(RangeError);
    expect(() => localDayRange(ROME, '2026-02-30')).toThrow(RangeError);
  });
});

describe('materializeSchedule, rules', () => {
  it('is empty without rules', () => {
    expect(juneWeek([])).toEqual([]);
  });

  it('is empty for an inverted or empty window', () => {
    expect(
      materializeSchedule({
        timezone: ROME,
        rules: [{ daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' }],
        capacity: 1,
        from: utc(2026, 6, 8),
        to: utc(2026, 6, 1),
      }),
    ).toEqual([]);
  });

  it('is empty for a resource without capacity', () => {
    expect(
      juneWeek([{ daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' }], { capacity: 0 }),
    ).toEqual([]);
  });

  it('opens one band per matching local day, carrying the resource capacity', () => {
    const timeline = juneWeek([{ daysOfWeek: weekdays, startTime: '09:00', endTime: '19:00' }], {
      capacity: 3,
    });
    expect(timeline).toHaveLength(5);
    expect(timeline[0]).toEqual({
      start: utc(2026, 6, 1, 7),
      end: utc(2026, 6, 1, 17),
      capacity: 3,
    });
    for (const segment of timeline) expect(segment.capacity).toBe(3);
  });

  it('accepts HH:MM:SS as written by the Postgres time columns', () => {
    const withSeconds = juneWeek([{ daysOfWeek: [1], startTime: '09:00:00', endTime: '19:00:00' }]);
    const withoutSeconds = juneWeek([{ daysOfWeek: [1], startTime: '09:00', endTime: '19:00' }]);
    expect(withSeconds).toEqual(withoutSeconds);
  });

  it('merges two overlapping rules instead of doubling the capacity', () => {
    const timeline = juneWeek(
      [
        { daysOfWeek: [1], startTime: '09:00', endTime: '13:00' },
        { daysOfWeek: [1], startTime: '12:00', endTime: '19:00' },
      ],
      { capacity: 2 },
    );
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 7), end: utc(2026, 6, 1, 17), capacity: 2 },
    ]);
  });

  it('keeps two disjoint bands of the same day apart', () => {
    const timeline = juneWeek([
      { daysOfWeek: [1], startTime: '09:00', endTime: '13:00' },
      { daysOfWeek: [1], startTime: '14:00', endTime: '19:00' },
    ]);
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 7), end: utc(2026, 6, 1, 11), capacity: 1 },
      { start: utc(2026, 6, 1, 12), end: utc(2026, 6, 1, 17), capacity: 1 },
    ]);
  });

  it('crosses midnight when the end is not after the start', () => {
    const timeline = juneWeek([{ daysOfWeek: [1], startTime: '22:00', endTime: '02:00' }]);
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 20), end: utc(2026, 6, 2, 0), capacity: 1 },
    ]);
  });

  it('treats an equal start and end as the whole day', () => {
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [{ daysOfWeek: [1], startTime: '00:00', endTime: '00:00' }],
      capacity: 1,
      from: utc(2026, 5, 30),
      to: utc(2026, 6, 3),
    });
    expect(timeline).toEqual([
      { start: utc(2026, 5, 31, 22), end: utc(2026, 6, 1, 22), capacity: 1 },
    ]);
  });

  it('includes a band that started on the local day before the window', () => {
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [{ daysOfWeek: [1], startTime: '22:00', endTime: '02:00' }],
      capacity: 1,
      // Window starts after the band already opened on Monday evening.
      from: utc(2026, 6, 1, 21),
      to: utc(2026, 6, 2, 12),
    });
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 21), end: utc(2026, 6, 2, 0), capacity: 1 },
    ]);
  });

  it('honours validFrom and validUntil inclusively, on local days', () => {
    const timeline = juneWeek([
      {
        daysOfWeek: allDays,
        startTime: '09:00',
        endTime: '10:00',
        validFrom: '2026-06-03',
        validUntil: '2026-06-05',
      },
    ]);
    expect(timeline.map((s) => s.start)).toEqual([
      utc(2026, 6, 3, 7),
      utc(2026, 6, 4, 7),
      utc(2026, 6, 5, 7),
    ]);
  });

  it('is empty for a rule that can never match', () => {
    expect(juneWeek([{ daysOfWeek: [], startTime: '09:00', endTime: '19:00' }])).toEqual([]);
    expect(
      juneWeek([
        {
          daysOfWeek: allDays,
          startTime: '09:00',
          endTime: '19:00',
          validFrom: '2026-06-05',
          validUntil: '2026-06-03',
        },
      ]),
    ).toEqual([]);
  });

  it('lets the last valid day of an overnight rule spill past validUntil', () => {
    // `validUntil` bounds the days a rule *starts* on, not the instants it produces.
    const timeline = juneWeek([
      {
        daysOfWeek: allDays,
        startTime: '22:00',
        endTime: '02:00',
        validUntil: '2026-06-03',
      },
    ]);
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 20), end: utc(2026, 6, 2, 0), capacity: 1 },
      { start: utc(2026, 6, 2, 20), end: utc(2026, 6, 3, 0), capacity: 1 },
      // Starts on 3 June, the last valid day, and runs into the small hours of 4 June.
      { start: utc(2026, 6, 3, 20), end: utc(2026, 6, 4, 0), capacity: 1 },
    ]);
  });

  it('rejects a malformed rule', () => {
    expect(() => juneWeek([{ daysOfWeek: [7], startTime: '09:00', endTime: '10:00' }])).toThrow(
      RangeError,
    );
    expect(() => juneWeek([{ daysOfWeek: [1], startTime: '9:00', endTime: '10:00' }])).toThrow(
      RangeError,
    );
    expect(() => juneWeek([{ daysOfWeek: [1], startTime: '24:00', endTime: '10:00' }])).toThrow(
      RangeError,
    );
    expect(() =>
      juneWeek([{ daysOfWeek: [1], startTime: '09:00', endTime: '10:00', validFrom: 'yesterday' }]),
    ).toThrow(RangeError);
  });
});

describe('materializeSchedule, the local weekday', () => {
  it('counts the weekday in the location zone, not in UTC', () => {
    // Monday 09:00 in Auckland (UTC+12 in June) is Sunday 21:00 UTC.
    const timeline = materializeSchedule({
      timezone: 'Pacific/Auckland',
      rules: [{ daysOfWeek: [1], startTime: '09:00', endTime: '17:00' }],
      capacity: 1,
      from: utc(2026, 6, 2),
      to: utc(2026, 6, 16),
    });
    expect(timeline).toEqual([
      { start: utc(2026, 6, 7, 21), end: utc(2026, 6, 8, 5), capacity: 1 },
      { start: utc(2026, 6, 14, 21), end: utc(2026, 6, 15, 5), capacity: 1 },
    ]);
    // Both bands start on a Sunday in UTC and on a Monday in Auckland.
    for (const segment of timeline) expect(new Date(segment.start).getUTCDay()).toBe(0);
  });

  it('maps Sunday to 0, matching the schedule_rules column', () => {
    // 2026-06-07 is a Sunday.
    const timeline = juneWeek([{ daysOfWeek: [0], startTime: '10:00', endTime: '12:00' }]);
    expect(timeline).toEqual([
      { start: utc(2026, 6, 7, 8), end: utc(2026, 6, 7, 10), capacity: 1 },
    ]);
  });
});

describe('materializeSchedule, exceptions', () => {
  const openWeekdays: ScheduleRule[] = [
    { daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' },
  ];

  it('closes a whole day', () => {
    const exceptions: ScheduleException[] = [{ date: '2026-06-03', type: 'closed' }];
    const timeline = juneWeek(openWeekdays, { exceptions });
    expect(timeline.map((s) => s.start)).toEqual([
      utc(2026, 6, 1, 7),
      utc(2026, 6, 2, 7),
      utc(2026, 6, 4, 7),
      utc(2026, 6, 5, 7),
      utc(2026, 6, 6, 7),
      utc(2026, 6, 7, 7),
    ]);
  });

  it('closes a band inside a day, splitting it in two', () => {
    const exceptions: ScheduleException[] = [
      { date: '2026-06-03', type: 'closed', startTime: '12:00', endTime: '14:00' },
    ];
    const timeline = juneWeek(openWeekdays, { exceptions }).filter(
      (s) => s.start >= utc(2026, 6, 3) && s.start < utc(2026, 6, 4),
    );
    expect(timeline).toEqual([
      { start: utc(2026, 6, 3, 7), end: utc(2026, 6, 3, 10), capacity: 1 },
      { start: utc(2026, 6, 3, 12), end: utc(2026, 6, 3, 17), capacity: 1 },
    ]);
  });

  it('opens a band on a day the rules leave closed', () => {
    const exceptions: ScheduleException[] = [
      { date: '2026-06-03', type: 'open', startTime: '20:00', endTime: '22:00' },
    ];
    const timeline = juneWeek([], { exceptions });
    expect(timeline).toEqual([
      { start: utc(2026, 6, 3, 18), end: utc(2026, 6, 3, 20), capacity: 1 },
    ]);
  });

  it('adds an open band to the bands the rules already produce', () => {
    const exceptions: ScheduleException[] = [
      { date: '2026-06-03', type: 'open', startTime: '19:00', endTime: '22:00' },
    ];
    const timeline = juneWeek(openWeekdays, { exceptions }).filter(
      (s) => s.start >= utc(2026, 6, 3) && s.start < utc(2026, 6, 4),
    );
    // 09:00-19:00 and 19:00-22:00 fuse into one band of the same capacity.
    expect(timeline).toEqual([
      { start: utc(2026, 6, 3, 7), end: utc(2026, 6, 3, 20), capacity: 1 },
    ]);
  });

  it('does not cut the tail of an overnight band that started the day before', () => {
    // The product rule: a full-day `closed` says "this day's calendar
    // does not open", it is not a calendar interval to subtract. The bar open Tuesday
    // 22:00-02:00 and closed on Wednesday still serves until 2 a.m. on Tuesday night.
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [{ daysOfWeek: allDays, startTime: '22:00', endTime: '02:00' }],
      exceptions: [{ date: '2026-06-03', type: 'closed' }],
      capacity: 1,
      from: utc(2026, 6, 1),
      to: utc(2026, 6, 6),
    });
    expect(timeline).toEqual([
      // Monday night, untouched.
      { start: utc(2026, 6, 1, 20), end: utc(2026, 6, 2, 0), capacity: 1 },
      // Tuesday night, whole, including the two hours that fall on the closed Wednesday.
      { start: utc(2026, 6, 2, 20), end: utc(2026, 6, 3, 0), capacity: 1 },
      // Wednesday night is gone; Thursday and Friday nights are back.
      { start: utc(2026, 6, 4, 20), end: utc(2026, 6, 5, 0), capacity: 1 },
      { start: utc(2026, 6, 5, 20), end: utc(2026, 6, 6, 0), capacity: 1 },
    ]);
  });

  it('suppresses the overnight band that starts on the closed day, tail included', () => {
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [{ daysOfWeek: allDays, startTime: '22:00', endTime: '02:00' }],
      exceptions: [{ date: '2026-06-03', type: 'closed' }],
      capacity: 1,
      from: utc(2026, 6, 1),
      to: utc(2026, 6, 6),
    });
    // Nothing on Wednesday evening, and nothing in the small hours of Thursday either.
    const wednesdayNight = timeline.filter(
      (segment) => segment.end > utc(2026, 6, 3, 12) && segment.start < utc(2026, 6, 4, 12),
    );
    expect(wednesdayNight).toEqual([]);
  });

  it('suppresses the open exceptions of a fully closed day, whole day ones included', () => {
    const exceptions: ScheduleException[] = [
      { date: '2026-06-03', type: 'open', startTime: '20:00', endTime: '22:00' },
      { date: '2026-06-03', type: 'open' },
      { date: '2026-06-03', type: 'closed' },
    ];
    const timeline = juneWeek(openWeekdays, { exceptions }).filter(
      (s) => s.start >= utc(2026, 6, 2, 22) && s.start < utc(2026, 6, 3, 22),
    );
    expect(timeline).toEqual([]);
  });

  it('still subtracts a timed closure that reaches past the midnight of a closed day', () => {
    // A `closed` with times stays a calendar interval, so it can reach into a day that opens.
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [{ daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' }],
      exceptions: [
        { date: '2026-06-03', type: 'closed' },
        { date: '2026-06-03', type: 'closed', startTime: '23:00', endTime: '10:00' },
      ],
      capacity: 1,
      from: utc(2026, 6, 3),
      to: utc(2026, 6, 5),
    });
    // 3 June is suppressed entirely; 4 June opens at 10:00 local instead of 09:00.
    expect(timeline).toEqual([
      { start: utc(2026, 6, 4, 8), end: utc(2026, 6, 4, 17), capacity: 1 },
    ]);
  });

  it('opens the whole local day for an open exception without times', () => {
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: [],
      exceptions: [{ date: '2026-06-03', type: 'open' }],
      capacity: 1,
      from: utc(2026, 6, 1),
      to: utc(2026, 6, 6),
    });
    expect(timeline).toEqual([
      { start: utc(2026, 6, 2, 22), end: utc(2026, 6, 3, 22), capacity: 1 },
    ]);
  });

  it('lets a full day closure win over an open exception on the same day', () => {
    const exceptions: ScheduleException[] = [
      { date: '2026-06-03', type: 'open', startTime: '20:00', endTime: '22:00' },
      { date: '2026-06-03', type: 'closed' },
    ];
    const timeline = juneWeek(openWeekdays, { exceptions }).filter(
      (s) => s.start >= utc(2026, 6, 3) && s.start < utc(2026, 6, 4),
    );
    expect(timeline).toEqual([]);
  });

  it('rejects an exception with only one of the two times', () => {
    expect(() =>
      juneWeek(openWeekdays, {
        exceptions: [{ date: '2026-06-03', type: 'closed', startTime: '12:00' }],
      }),
    ).toThrow(RangeError);
  });

  it('rejects an exception with an unknown type or a malformed date', () => {
    expect(() =>
      juneWeek(openWeekdays, {
        exceptions: [{ date: '2026-06-03', type: 'maybe' } as unknown as ScheduleException],
      }),
    ).toThrow(RangeError);
    expect(() =>
      juneWeek(openWeekdays, { exceptions: [{ date: '03-06-2026', type: 'closed' }] }),
    ).toThrow(RangeError);
  });
});

describe('materializeSchedule, blocks', () => {
  const openWeekdays: ScheduleRule[] = [
    { daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' },
  ];

  it('erodes a segment where a block falls inside it', () => {
    const timeline = juneWeek(openWeekdays, {
      capacity: 4,
      blocks: [{ start: utc(2026, 6, 3, 12), end: utc(2026, 6, 3, 13) }],
    }).filter((s) => s.start >= utc(2026, 6, 3) && s.start < utc(2026, 6, 4));
    expect(timeline).toEqual([
      { start: utc(2026, 6, 3, 7), end: utc(2026, 6, 3, 12), capacity: 4 },
      { start: utc(2026, 6, 3, 13), end: utc(2026, 6, 3, 17), capacity: 4 },
    ]);
  });

  it('removes the whole day when the block covers it, whatever the capacity', () => {
    const timeline = juneWeek(openWeekdays, {
      capacity: 50,
      blocks: [{ start: utc(2026, 6, 3), end: utc(2026, 6, 4) }],
    }).filter((s) => s.start >= utc(2026, 6, 3) && s.start < utc(2026, 6, 4));
    expect(timeline).toEqual([]);
  });

  it('ignores a block that falls outside every open band', () => {
    const withBlock = juneWeek(openWeekdays, {
      blocks: [{ start: utc(2026, 6, 3, 2), end: utc(2026, 6, 3, 4) }],
    });
    expect(withBlock).toEqual(juneWeek(openWeekdays));
  });

  it('truncates the edges and removes the middle of a multi-day block', () => {
    const timeline = juneWeek(openWeekdays, {
      blocks: [{ start: utc(2026, 6, 2, 12), end: utc(2026, 6, 4, 12) }],
    }).filter((s) => s.start >= utc(2026, 6, 2) && s.start < utc(2026, 6, 5));
    expect(timeline).toEqual([
      // 2 June: open 09:00-19:00 local (07:00-17:00Z), blocked from 12:00Z.
      { start: utc(2026, 6, 2, 7), end: utc(2026, 6, 2, 12), capacity: 1 },
      // 3 June: entirely inside the block.
      // 4 June: blocked until 12:00Z, then open to 17:00Z.
      { start: utc(2026, 6, 4, 12), end: utc(2026, 6, 4, 17), capacity: 1 },
    ]);
  });

  it('rejects a malformed block', () => {
    expect(() =>
      juneWeek(openWeekdays, { blocks: [{ start: 0.5, end: utc(2026, 6, 4) }] }),
    ).toThrow(RangeError);
  });
});

describe('materializeSchedule, slots on a real schedule', () => {
  it('gives a 09:00-19:00 Monday ten hourly starts, the last at 18:00 local', () => {
    // The canonical case: 10 slots of 60 minutes, not 9. The last admissible start is itself
    // a legal start, because a booking beginning at 18:00 ends exactly when the day closes.
    const timeline = juneWeek([{ daysOfWeek: [1], startTime: '09:00', endTime: '19:00' }]);
    const starts = discretize(erode(timeline, 0, 60 * 60_000, 0), 60 * 60_000, { kind: 'epoch' });
    expect(starts).toHaveLength(10);
    expect(starts[0]!.at).toBe(utc(2026, 6, 1, 7)); // 09:00 in Rome
    expect(starts[9]!.at).toBe(utc(2026, 6, 1, 16)); // 18:00 in Rome
    expect(starts[9]!.at + 60 * 60_000).toBe(utc(2026, 6, 1, 17)); // ends exactly at 19:00
  });

  it('gives nine starts when a 30 minute buffer follows the service', () => {
    const timeline = juneWeek([{ daysOfWeek: [1], startTime: '09:00', endTime: '19:00' }]);
    const starts = discretize(erode(timeline, 0, 60 * 60_000, 30 * 60_000), 60 * 60_000, {
      kind: 'epoch',
    });
    expect(starts).toHaveLength(9);
    expect(starts[8]!.at).toBe(utc(2026, 6, 1, 15)); // 17:00 in Rome, ends 18:00 + 30' buffer
  });
});

describe('materializeSchedule, local alignment of the slot grid', () => {
  // I1 of the independent review: `Alignment.kind: 'epoch'` counts from the Unix epoch,
  // which is on the hour in UTC and *not* on the local hour in a zone whose offset is not a
  // whole number of hours.
  const nineToOne: ScheduleRule[] = [{ daysOfWeek: allDays, startTime: '09:00', endTime: '13:00' }];

  function hourlyStarts(timezone: string, day: string, offsetMs: number): number[] {
    const range = localDayRange(timezone, day);
    const timeline = materializeSchedule({
      timezone,
      rules: nineToOne,
      capacity: 1,
      from: range.start,
      to: range.end,
    });
    return discretize(erode(timeline, 0, 60 * 60_000, 0), 60 * 60_000, {
      kind: 'epoch',
      offsetMs,
    }).map((instant) => instant.at);
  }

  it('reports the zone offset in milliseconds', () => {
    const noon = utc(2026, 6, 1, 12);
    expect(zoneOffsetMs('Asia/Kolkata', noon)).toBe(5.5 * 60 * 60_000);
    expect(zoneOffsetMs('Asia/Kathmandu', noon)).toBe(5.75 * 60 * 60_000);
    expect(zoneOffsetMs('UTC', noon)).toBe(0);
    // It follows the daylight saving of the zone, which is why it takes an instant.
    expect(zoneOffsetMs(ROME, utc(2026, 1, 15, 12))).toBe(60 * 60_000);
    expect(zoneOffsetMs(ROME, noon)).toBe(2 * 60 * 60_000);
    expect(() => zoneOffsetMs('Nowhere/Nothing', noon)).toThrow(RangeError);
    expect(() => zoneOffsetMs(ROME, 1.5)).toThrow(RangeError);
  });

  it('lands on the local hour in Asia/Kolkata when given the zone offset', () => {
    const day = '2026-06-01';
    const offset = -zoneOffsetMs('Asia/Kolkata', localDayRange('Asia/Kolkata', day).start);
    // 09:00, 10:00, 11:00 and 12:00 IST: four starts, the last ending exactly at 13:00.
    expect(hourlyStarts('Asia/Kolkata', day, offset)).toEqual([
      utc(2026, 6, 1, 3, 30),
      utc(2026, 6, 1, 4, 30),
      utc(2026, 6, 1, 5, 30),
      utc(2026, 6, 1, 6, 30),
    ]);
  });

  it('lands on the local hour in Asia/Kathmandu, where the sign of the offset matters', () => {
    const day = '2026-06-01';
    const offset = -zoneOffsetMs('Asia/Kathmandu', localDayRange('Asia/Kathmandu', day).start);
    expect(hourlyStarts('Asia/Kathmandu', day, offset)).toEqual([
      utc(2026, 6, 1, 3, 15),
      utc(2026, 6, 1, 4, 15),
      utc(2026, 6, 1, 5, 15),
      utc(2026, 6, 1, 6, 15),
    ]);
    // +05:45 is the case that catches a sign error: unlike +05:30, it is not its own
    // negation modulo an hour, so the positive offset lands half an hour off.
    expect(hourlyStarts('Asia/Kathmandu', day, -offset)).toEqual([
      utc(2026, 6, 1, 3, 45),
      utc(2026, 6, 1, 4, 45),
      utc(2026, 6, 1, 5, 45),
    ]);
  });

  it('drifts to the half hour without the zone offset, which is why the helper exists', () => {
    // Documents the trap: offsetMs = 0 gives 09:30, 10:30, 11:30 IST (wrong hour and one
    // slot fewer). The offset is what puts the grid back on the local clock.
    expect(hourlyStarts('Asia/Kolkata', '2026-06-01', 0)).toEqual([
      utc(2026, 6, 1, 4),
      utc(2026, 6, 1, 5),
      utc(2026, 6, 1, 6),
    ]);
  });

  it('needs no offset in a zone whose offset is a whole number of hours', () => {
    const day = '2026-06-01';
    const withOffset = hourlyStarts(ROME, day, -zoneOffsetMs(ROME, localDayRange(ROME, day).start));
    expect(hourlyStarts(ROME, day, 0)).toEqual(withOffset);
    expect(withOffset).toHaveLength(4);
    expect(withOffset[0]).toBe(utc(2026, 6, 1, 7));
  });
});

describe('materializeSchedule, the window ceiling', () => {
  const openEveryDay: ScheduleRule[] = [
    { daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' },
  ];

  function span(days: number, maxDays?: number) {
    return materializeSchedule({
      timezone: ROME,
      rules: openEveryDay,
      capacity: 1,
      from: utc(2026, 1, 1),
      to: utc(2026, 1, 1) + days * 24 * 3_600_000,
      ...(maxDays === undefined ? {} : { maxDays }),
    });
  }

  it('defaults to one leap year of local days', () => {
    expect(DEFAULT_MAX_DAYS).toBe(366);
    expect(span(365).length).toBeGreaterThan(0);
    expect(() => span(400)).toThrow(RangeError);
  });

  it('honours an explicit ceiling', () => {
    expect(span(7, 8).length).toBeGreaterThan(0);
    expect(() => span(7, 7)).toThrow(/8 local days, over the 7 day ceiling/);
  });

  it('refuses an absurd window instead of looping over it', () => {
    // Before the ceiling this was ~10^11 iterations, accepted and never returning.
    expect(() =>
      materializeSchedule({
        timezone: ROME,
        rules: openEveryDay,
        capacity: 1,
        from: 0,
        to: 8_640_000_000_000_000,
      }),
    ).toThrow(RangeError);
  });

  it('rejects a malformed ceiling', () => {
    expect(() => span(1, 0)).toThrow(RangeError);
    expect(() => span(1, -1)).toThrow(RangeError);
    expect(() => span(1, 1.5)).toThrow(RangeError);
  });
});

describe('materializeSchedule, window and normal form', () => {
  const openWeekdays: ScheduleRule[] = [
    { daysOfWeek: allDays, startTime: '09:00', endTime: '19:00' },
  ];

  it('clips to the requested window', () => {
    const timeline = materializeSchedule({
      timezone: ROME,
      rules: openWeekdays,
      capacity: 1,
      from: utc(2026, 6, 1, 9),
      to: utc(2026, 6, 2, 9),
    });
    expect(timeline).toEqual([
      { start: utc(2026, 6, 1, 9), end: utc(2026, 6, 1, 17), capacity: 1 },
      { start: utc(2026, 6, 2, 7), end: utc(2026, 6, 2, 9), capacity: 1 },
    ]);
  });

  it('returns segments that are sorted, disjoint and never zero capacity', () => {
    const timeline = juneWeek(openWeekdays, {
      capacity: 2,
      exceptions: [{ date: '2026-06-03', type: 'closed', startTime: '12:00', endTime: '14:00' }],
      blocks: [{ start: utc(2026, 6, 4, 8), end: utc(2026, 6, 4, 9) }],
    });
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const segment of timeline) {
      expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
      expect(segment.end).toBeGreaterThan(segment.start);
      expect(segment.capacity).toBe(2);
      previousEnd = segment.end;
    }
  });

  it('rejects an unknown time zone', () => {
    expect(() =>
      materializeSchedule({
        timezone: 'Mars/Olympus',
        rules: openWeekdays,
        capacity: 1,
        from: utc(2026, 6, 1),
        to: utc(2026, 6, 2),
      }),
    ).toThrow(RangeError);
  });
});
