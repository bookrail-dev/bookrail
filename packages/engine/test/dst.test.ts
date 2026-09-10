/**
 * Time zone suite: every daylight saving edge case, on the zones the engine is tested against.
 *
 * No date in this file is written by hand: every transition is discovered from the IANA
 * database for the next three years and every expectation is derived from the offset change
 * the zone actually performs. A tzdata update therefore changes the data the suite runs on,
 * not the suite.
 */
import { describe, expect, it } from 'vitest';

import { localDayRange, materializeSchedule, type ScheduleRule } from '../src/schedule/index.js';
import { discretize, erode, type Timeline } from '../src/timeline/index.js';
import {
  HOUR_MS,
  MINUTE_MS,
  findTransitions,
  hourLabel,
  instantOfLocal,
  localDayOf,
  localMinutesOf,
  localTimeOf,
  nextDay,
  previousDay,
  wallLabel,
} from './dst-helpers.js';

const ZONES = [
  'Europe/Rome',
  'America/New_York',
  'America/Santiago', // southern hemisphere, and its clocks change at local midnight.
  'Australia/Sydney',
  'Asia/Kolkata', // control: no daylight saving, ever.
  'Pacific/Auckland',
];

const now = new Date();
const WINDOW_FROM = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const WINDOW_TO = Date.UTC(now.getUTCFullYear() + 3, now.getUTCMonth(), now.getUTCDate());

const everyDay = [0, 1, 2, 3, 4, 5, 6];

function rule(startTime: string, endTime: string): ScheduleRule {
  return { daysOfWeek: everyDay, startTime, endTime };
}

/** Materializes one rule over exactly one local day and returns the resulting timeline. */
function dayTimeline(timezone: string, day: string, rules: ScheduleRule[]): Timeline {
  const range = localDayRange(timezone, day);
  return materializeSchedule({
    timezone,
    rules,
    capacity: 1,
    from: range.start,
    to: range.end,
  });
}

function totalMs(timeline: Timeline): number {
  return timeline.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
}

function localHour(timezone: string, at: number): number {
  return Number(localTimeOf(timezone, at).slice(0, 2));
}

describe.each(ZONES)('daylight saving in %s', (timezone) => {
  const transitions = findTransitions(timezone, WINDOW_FROM, WINDOW_TO);

  it('reports transitions that are ordered, inside the window and real offset changes', () => {
    let previous = WINDOW_FROM;
    for (const transition of transitions) {
      expect(transition.at).toBeGreaterThan(previous);
      expect(transition.at).toBeLessThan(WINDOW_TO);
      expect(transition.deltaMs).not.toBe(0);
      expect(Math.abs(transition.deltaMs)).toBeLessThanOrEqual(2 * HOUR_MS);
      expect(transition.offsetAfterMs - transition.offsetBeforeMs).toBe(transition.deltaMs);
      previous = transition.at;
    }
  });

  if (transitions.length === 0) {
    it('has 24 hour local days and an unchanged 09:00-19:00 schedule all year', () => {
      // The control case: a zone without daylight saving must behave trivially.
      for (let offset = 0; offset < 366; offset += 29) {
        const day = localDayOf(timezone, WINDOW_FROM + offset * 24 * HOUR_MS);
        const range = localDayRange(timezone, day);
        expect(range.end - range.start).toBe(24 * HOUR_MS);
        expect(totalMs(dayTimeline(timezone, day, [rule('09:00', '19:00')]))).toBe(10 * HOUR_MS);
      }
    });
    return;
  }

  describe.each(transitions)('$kind on $localDay', (transition) => {
    const day = transition.localDay;
    const delta = transition.deltaMs;

    it(`makes the local day ${String(24 - delta / HOUR_MS)} hours long`, () => {
      const range = localDayRange(timezone, day);
      expect(range.end - range.start).toBe(24 * HOUR_MS - delta);
    });

    it('keeps a 09:00-19:00 schedule at ten real hours', () => {
      // Every zone under test changes its clocks at night; if that ever stopped being true
      // the expectation below would have to account for the offset change.
      const hourBefore = localHour(timezone, transition.at - 1);
      const hourAfter = localHour(timezone, transition.at);
      expect(hourBefore < 9 || hourBefore >= 19).toBe(true);
      expect(hourAfter < 9 || hourAfter >= 19).toBe(true);

      const timeline = dayTimeline(timezone, day, [rule('09:00', '19:00')]);
      expect(timeline).toHaveLength(1);
      expect(totalMs(timeline)).toBe(10 * HOUR_MS);
    });

    it('turns a 01:00-04:00 rule into three hours minus the offset change it contains', () => {
      const timeline = dayTimeline(timezone, day, [rule('01:00', '04:00')]);
      expect(timeline).toHaveLength(1);
      const segment = timeline[0]!;
      const inside = transition.at > segment.start && transition.at < segment.end;
      expect(segment.end - segment.start).toBe(3 * HOUR_MS - (inside ? delta : 0));
      if (inside) {
        // The 2 hours / 4 hours of the specification, for the zones that move their clocks inside
        // the band. America/Santiago changes at local midnight, so for it the band is
        // untouched and stays three hours.
        if (delta === HOUR_MS) expect(segment.end - segment.start).toBe(2 * HOUR_MS);
        if (delta === -HOUR_MS) expect(segment.end - segment.start).toBe(4 * HOUR_MS);
      } else {
        expect(segment.end - segment.start).toBe(3 * HOUR_MS);
      }
    });

    it('carries a 22:00-02:00 band across midnight into the transition day', () => {
      const startDay = previousDay(day);
      const startRange = localDayRange(timezone, startDay);
      const endRange = localDayRange(timezone, day);
      const timeline = materializeSchedule({
        timezone,
        rules: [rule('22:00', '02:00')],
        capacity: 1,
        from: startRange.start,
        to: endRange.end,
      });

      // The one segment that straddles the local midnight of the transition day.
      const overnight = timeline.filter(
        (segment) => segment.start < endRange.start && segment.end > endRange.start,
      );
      expect(overnight).toHaveLength(1);
      const segment = overnight[0]!;
      expect(segment.start).toBe(instantOfLocal(timezone, startDay, '22:00'));

      const inside = transition.at > segment.start && transition.at < segment.end;
      expect(segment.end - segment.start).toBe(4 * HOUR_MS - (inside ? delta : 0));
    });

    if (transition.kind === 'gap') {
      it('moves a band that falls entirely inside the gap forward, keeping its length', () => {
        // Disambiguation `compatible`, seen through the engine: both ends of the band name
        // wall-clock times that never happen, so the whole band slides forward by the gap and
        // keeps its wall-clock duration. The expected instants come from the transition, not
        // from a second copy of the conversion.
        const gapStartMinute = localMinutesOf(timezone, transition.at) - delta / MINUTE_MS;
        expect(gapStartMinute).toBeGreaterThanOrEqual(0);
        const timeline = dayTimeline(timezone, day, [
          rule(wallLabel(gapStartMinute + 15), wallLabel(gapStartMinute + 45)),
        ]);
        expect(timeline).toEqual([
          {
            start: transition.at + 15 * MINUTE_MS,
            end: transition.at + 45 * MINUTE_MS,
            capacity: 1,
          },
        ]);
      });
    } else {
      it('resolves a repeated wall-clock time to its first occurrence', () => {
        // The band starts half an hour into the hour that happens twice. `compatible` takes
        // the first occurrence, so the band is `2 * |delta|` of real time long even though
        // the wall clock says `|delta| + 30 minutes`.
        const repeatStartMinute = localMinutesOf(timezone, transition.at);
        const repeatedMinutes = -delta / MINUTE_MS;
        const band = rule(
          wallLabel(repeatStartMinute + 30),
          wallLabel(repeatStartMinute + repeatedMinutes + 30),
        );
        const timeline = materializeSchedule({
          timezone,
          rules: [band],
          capacity: 1,
          from: localDayRange(timezone, day).start,
          to: localDayRange(timezone, nextDay(day)).end,
        });

        const firstOccurrence = transition.at + delta + 30 * MINUTE_MS;
        const secondOccurrence = transition.at + 30 * MINUTE_MS;
        expect(firstOccurrence).toBeLessThan(secondOccurrence);

        const covering = timeline.filter(
          (segment) => segment.start <= firstOccurrence && segment.end > firstOccurrence,
        );
        expect(covering).toEqual([
          { start: firstOccurrence, end: transition.at - delta + 30 * MINUTE_MS, capacity: 1 },
        ]);
        expect(covering[0]!.end - covering[0]!.start).toBe(-2 * delta);
      });
    }

    it('keeps eroded start instants 60 real minutes apart across the change', () => {
      // A four hour band centred on the change, wherever the zone puts it: one hour before
      // the last pre-change wall-clock hour, three after. It crosses midnight by itself when
      // the zone changes its clocks at midnight, as America/Santiago does.
      const ruleDay = localDayOf(timezone, transition.at - 1);
      const hourBefore = localHour(timezone, transition.at - 1);
      const band = rule(hourLabel(hourBefore - 1), hourLabel(hourBefore + 3));
      const timeline = materializeSchedule({
        timezone,
        rules: [band],
        capacity: 1,
        from: localDayRange(timezone, ruleDay).start,
        to: localDayRange(timezone, nextDay(ruleDay)).end,
      });

      const covering = timeline.filter((s) => s.start <= transition.at && s.end > transition.at);
      expect(covering).toHaveLength(1);

      const starts = discretize(erode(covering, 0, 60 * MINUTE_MS, 0), 60 * MINUTE_MS, {
        kind: 'segment_start',
      });
      expect(starts.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]!.at - starts[i - 1]!.at).toBe(60 * MINUTE_MS);
      }
      // The wall clock and the real clock disagree over this window: it is four wall-clock
      // hours long and 4h - delta of real time.
      expect(covering[0]!.end - covering[0]!.start).toBe(4 * HOUR_MS - delta);
    });
  });
});

describe('daylight saving, cross-zone facts', () => {
  it('finds no transition at all in the control zone', () => {
    expect(findTransitions('Asia/Kolkata', WINDOW_FROM, WINDOW_TO)).toEqual([]);
  });

  it('changes the clocks at local midnight in America/Santiago', () => {
    // The reason Santiago is in the list: it is the only zone here whose change falls
    // outside a 01:00-04:00 band, which is what makes that band's expectation conditional.
    const transitions = findTransitions('America/Santiago', WINDOW_FROM, WINDOW_TO);
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      expect(localTimeOf('America/Santiago', transition.at - 1)).toBe('23:59');
    }
  });

  it('finds a spring-forward and a fall-back every year in the four zones that observe them', () => {
    for (const timezone of [
      'Europe/Rome',
      'America/New_York',
      'Australia/Sydney',
      'Pacific/Auckland',
    ]) {
      const transitions = findTransitions(timezone, WINDOW_FROM, WINDOW_TO);
      expect(transitions.filter((t) => t.kind === 'gap').length).toBeGreaterThanOrEqual(3);
      expect(transitions.filter((t) => t.kind === 'overlap').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('resolves a non-existent local time forward and a repeated one to its first occurrence', () => {
    // Kept as a check on the *helper* used by the rest of this file; the equivalent check on
    // the engine itself lives in the per-transition blocks above, where the expected instants
    // are derived from the transition instead of from a second call to the same conversion.
    const transitions = findTransitions('Europe/Rome', WINDOW_FROM, WINDOW_TO);
    const gap = transitions.find((t) => t.kind === 'gap');
    const overlap = transitions.find((t) => t.kind === 'overlap');
    expect(gap).toBeDefined();
    expect(overlap).toBeDefined();

    const skippedHour = Number(localTimeOf('Europe/Rome', gap!.at - 1).slice(0, 2));
    const nonExistent = `${String(skippedHour + 1).padStart(2, '0')}:30`;
    expect(instantOfLocal('Europe/Rome', gap!.localDay, nonExistent)).toBe(
      gap!.at + 30 * MINUTE_MS,
    );

    const repeatedHour = Number(localTimeOf('Europe/Rome', overlap!.at).slice(0, 2));
    const repeated = `${String(repeatedHour).padStart(2, '0')}:30`;
    expect(instantOfLocal('Europe/Rome', overlap!.localDay, repeated)).toBe(
      overlap!.at + 30 * MINUTE_MS + overlap!.deltaMs,
    );
  });
});
