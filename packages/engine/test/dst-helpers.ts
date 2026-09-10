/**
 * Discovery of DST transitions straight from the IANA database, so the time zone suite never
 * hard-codes a date: the dates come from the zone, and a tzdata update changes the test data
 * instead of breaking the test.
 */
import { Temporal } from '@js-temporal/polyfill';

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export interface DstTransition {
  /** Instant of the change, epoch milliseconds. */
  readonly at: number;
  /** UTC offset in milliseconds just before the change. */
  readonly offsetBeforeMs: number;
  /** UTC offset in milliseconds from the change on. */
  readonly offsetAfterMs: number;
  /** Positive on a spring-forward (short day), negative on a fall-back (long day). */
  readonly deltaMs: number;
  /** `gap` = an hour disappears; `overlap` = an hour happens twice. */
  readonly kind: 'gap' | 'overlap';
  /** Local calendar day that is short or long, `YYYY-MM-DD`. */
  readonly localDay: string;
}

/** UTC offset of a zone at an instant, in milliseconds. */
export function offsetMsAt(timezone: string, epochMs: number): number {
  return (
    Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timezone).offsetNanoseconds /
    1_000_000
  );
}

/** Local calendar day of an instant, `YYYY-MM-DD`. */
export function localDayOf(timezone: string, epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}

/** Local wall-clock time of an instant, `HH:MM`. */
export function localTimeOf(timezone: string, epochMs: number): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timezone);
  return `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;
}

/** Epoch milliseconds of a local wall-clock time, with Temporal's `compatible` disambiguation. */
export function instantOfLocal(timezone: string, day: string, time: string): number {
  return Temporal.PlainDate.from(day)
    .toPlainDateTime(Temporal.PlainTime.from(time))
    .toZonedDateTime(timezone, { disambiguation: 'compatible' }).epochMilliseconds;
}

/** The day before a local calendar day. */
export function previousDay(day: string): string {
  return Temporal.PlainDate.from(day).subtract({ days: 1 }).toString();
}

/** The day after a local calendar day. */
export function nextDay(day: string): string {
  return Temporal.PlainDate.from(day).add({ days: 1 }).toString();
}

/** `HH:00` for an hour number, wrapping around the clock. */
export function hourLabel(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

/** `HH:MM` for a number of minutes since local midnight, wrapping around the clock. */
export function wallLabel(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** Minutes since local midnight of an instant. */
export function localMinutesOf(timezone: string, epochMs: number): number {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timezone);
  return zoned.hour * 60 + zoned.minute;
}

/**
 * Every offset change of a zone inside `[from, to)`, found by scanning day by day and then
 * bisecting to the millisecond. Day granularity is enough: no zone has ever had two
 * transitions within the same day.
 */
export function findTransitions(timezone: string, from: number, to: number): DstTransition[] {
  const transitions: DstTransition[] = [];
  const step = 24 * HOUR_MS;
  let previousInstant = from;
  let previousOffset = offsetMsAt(timezone, from);

  for (let at = from + step; at < to + step; at += step) {
    const bounded = Math.min(at, to);
    const offset = offsetMsAt(timezone, bounded);
    if (offset !== previousOffset) {
      const exact = bisect(timezone, previousInstant, bounded, previousOffset);
      const offsetAfterMs = offsetMsAt(timezone, exact);
      transitions.push({
        at: exact,
        offsetBeforeMs: previousOffset,
        offsetAfterMs,
        deltaMs: offsetAfterMs - previousOffset,
        kind: offsetAfterMs > previousOffset ? 'gap' : 'overlap',
        localDay: localDayOf(timezone, exact),
      });
      previousOffset = offsetAfterMs;
    }
    previousInstant = bounded;
    if (bounded === to) break;
  }
  return transitions;
}

function bisect(timezone: string, low: number, high: number, offsetAtLow: number): number {
  let lo = low;
  let hi = high;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMsAt(timezone, mid) === offsetAtLow) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The first spring-forward and the first fall-back of each of the given years. */
export function transitionsPerYear(
  timezone: string,
  startYear: number,
  years: number,
): { year: number; gap?: DstTransition; overlap?: DstTransition }[] {
  const out: { year: number; gap?: DstTransition; overlap?: DstTransition }[] = [];
  for (let i = 0; i < years; i += 1) {
    const year = startYear + i;
    const from = Date.UTC(year, 0, 1);
    const to = Date.UTC(year + 1, 0, 1);
    const found = findTransitions(timezone, from, to);
    out.push({
      year,
      gap: found.find((t) => t.kind === 'gap'),
      overlap: found.find((t) => t.kind === 'overlap'),
    });
  }
  return out;
}
