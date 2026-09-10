/**
 * Materialization of a schedule into an absolute (UTC) timeline.
 *
 * This is the only place in the engine where wall-clock time exists. Schedule rules are
 * written in the local time of the location ("9:00-19:00"); this module turns them into
 * instants day by day using the IANA database, so a day with a DST transition really has
 * 23 or 25 hours and "9:00-19:00" is ten real hours on both of them. Everything downstream
 * (erosion, discretization, subtraction of occupancies) works in absolute milliseconds.
 *
 * The IANA calculations use `Temporal` through `@js-temporal/polyfill`: it is the standard
 * (Node 20 has no native implementation), it exposes explicit DST disambiguation instead of
 * hiding it, and it makes "the local day" a first-class object rather than an offset
 * arithmetic exercise.
 *
 * The input types mirror the columns of `packages/db/src/schema/catalog.ts`
 * (`schedule_rules`, `schedule_exceptions`, `resource_blocks`) but are plain objects: the
 * engine never imports the database layer.
 */
import { Temporal } from '@js-temporal/polyfill';
import { parameterInvalid, rangeTooLarge } from '../errors.js';

import { clip, normalize, subtract, type Segment, type Timeline } from '../timeline/index.js';

/** A calendar date in the location's zone, `YYYY-MM-DD`. Matches the `date` columns. */
export type LocalDate = string;

/** A time of day in the location's zone, `HH:MM` or `HH:MM:SS`. Matches the `time` columns. */
export type LocalTime = string;

/** One recurring opening rule, mirroring a `schedule_rules` row. */
export interface ScheduleRule {
  /** Days of the week the rule applies to, **in local time**: 0 = Sunday .. 6 = Saturday. */
  readonly daysOfWeek: readonly number[];
  readonly startTime: LocalTime;
  /**
   * End of the band. A value that is not strictly after `startTime` means the band crosses
   * midnight and ends on the following local day: `22:00-02:00` is four hours, and
   * `00:00-00:00` is the whole day.
   */
  readonly endTime: LocalTime;
  /** First local day the rule is in force, inclusive. */
  readonly validFrom?: LocalDate | null;
  /** Last local day the rule is in force, inclusive. */
  readonly validUntil?: LocalDate | null;
}

/** A one-off closure or opening, mirroring a `schedule_exceptions` row. */
export interface ScheduleException {
  readonly date: LocalDate;
  readonly type: 'closed' | 'open';
  /** Both times, or neither. Neither means "the whole local day". */
  readonly startTime?: LocalTime | null;
  readonly endTime?: LocalTime | null;
}

/** An absolute unavailability, mirroring the `period` of a `resource_blocks` row. */
export interface Block {
  /** Epoch milliseconds UTC, inclusive. */
  readonly start: number;
  /** Epoch milliseconds UTC, exclusive. */
  readonly end: number;
}

export interface MaterializeScheduleInput {
  /** IANA identifier of the location's zone, e.g. `Europe/Rome`. */
  readonly timezone: string;
  readonly rules: readonly ScheduleRule[];
  readonly exceptions?: readonly ScheduleException[];
  readonly blocks?: readonly Block[];
  /** Capacity of the resource: the units it can serve at once, applied to every open segment. */
  readonly capacity: number;
  /** Window of interest, epoch milliseconds UTC, half-open. */
  readonly from: number;
  readonly to: number;
  /**
   * Ceiling on the number of local days `[from, to)` may span; beyond it, `RangeError`.
   * Defaults to `DEFAULT_MAX_DAYS`. The day loop is linear in the width of the window, so an
   * unbounded window is an unbounded computation (the same door `discretize`'s
   * `maxInstants` closes). Callers with a narrower contract should say so: the HTTP API caps
   * availability requests at 90 days.
   */
  readonly maxDays?: number;
}

/** Default ceiling of `materializeSchedule`: one leap year of local days. */
export const DEFAULT_MAX_DAYS = 366;

/** `[start, end)` in epoch milliseconds UTC. */
export interface InstantRange {
  readonly start: number;
  readonly end: number;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?$/;

interface ParsedTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  /** Milliseconds since local midnight, used only to order two times of the same day. */
  readonly msOfDay: number;
}

function parseTime(value: string, what: string): ParsedTime {
  const match = TIME_OF_DAY.exec(value);
  if (match === null) {
    throw parameterInvalid(
      `${what} must be a time of day such as 09:00 or 09:00:00, received "${value}".`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const millisecond = match[4] === undefined ? 0 : Number(match[4].padEnd(3, '0').slice(0, 3));
  return {
    hour,
    minute,
    second,
    millisecond,
    msOfDay: ((hour * 60 + minute) * 60 + second) * 1000 + millisecond,
  };
}

function toPlainTime(time: ParsedTime): Temporal.PlainTime {
  return new Temporal.PlainTime(time.hour, time.minute, time.second, time.millisecond);
}

function parseDate(value: string, what: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw parameterInvalid(
      `${what} must be a calendar date such as 2026-09-08, received "${value}".`,
    );
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    throw parameterInvalid(`${what} is not a real calendar date, received "${value}".`);
  }
}

/**
 * The instant a local wall-clock time occurs at, resolving DST ambiguity with Temporal's
 * `compatible` disambiguation, which is the rule the engine holds to everywhere:
 *
 * - a time that **does not exist** (02:30 on the spring-forward night) is pushed forward by
 *   the length of the gap, so 02:30 becomes 03:30 and the band keeps its wall-clock shape;
 * - a time that happens **twice** (02:30 on the fall-back night) resolves to the **first**
 *   occurrence, so a band that starts there is as long as possible and a band that ends
 *   there is as short as possible.
 */
function instantAt(date: Temporal.PlainDate, time: Temporal.PlainTime, timezone: string): number {
  return date.toPlainDateTime(time).toZonedDateTime(timezone, { disambiguation: 'compatible' })
    .epochMilliseconds;
}

/**
 * Refuses an identifier the IANA database does not know, before any day loop runs.
 *
 * The check itself is Temporal's, and Temporal throws a **native** `RangeError`. That used to
 * be good enough, because the availability route caught every `RangeError` and guessed a code
 * from the message; the code now travels with the error, so the native one is
 * translated here into the engine's own. Nothing else in the engine may leave a bare
 * `RangeError` on the availability path: a bare one reaching the route is now a 500, which is
 * exactly the pressure that keeps this honest.
 */
function assertTimezone(timezone: string): void {
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone);
  } catch (error) {
    throw parameterInvalid(
      `Unknown IANA time zone "${timezone}": ${error instanceof Error ? error.message : String(error)}`,
      'timezone',
    );
  }
}

/**
 * `[start, end)` in UTC of one local calendar day. Its length is 23, 24 or 25 hours (or any
 * other value the zone's history dictates): the caller never has to assume 86 400 000 ms.
 */
export function localDayRange(timezone: string, date: LocalDate): InstantRange {
  assertTimezone(timezone);
  const day = parseDate(date, 'localDayRange date');
  const midnight = new Temporal.PlainTime(0, 0, 0, 0);
  return {
    start: instantAt(day, midnight, timezone),
    end: instantAt(day.add({ days: 1 }), midnight, timezone),
  };
}

/**
 * The local calendar days a UTC window touches, in order, `YYYY-MM-DD`.
 *
 * This is the key space of the availability cache: every cached value is keyed by (resource, local
 * day), and a request has to know which days it spans in the resource's own zone before it can ask
 * for them. The last day is the one containing `to - 1`, because the window is half-open: a window
 * ending exactly at local midnight does not touch the day that starts there.
 *
 * The ceiling mirrors `materializeSchedule`'s: enumerating days is linear in the width of
 * the window, so an unbounded window is an unbounded computation.
 */
export function localDaysBetween(
  timezone: string,
  from: number,
  to: number,
  maxDays: number = DEFAULT_MAX_DAYS,
): LocalDate[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw parameterInvalid(
      'localDaysBetween requires from/to as safe integers of epoch milliseconds.',
    );
  }
  assertTimezone(timezone);
  if (to <= from) return [];
  const first = Temporal.Instant.fromEpochMilliseconds(from)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const last = Temporal.Instant.fromEpochMilliseconds(to - 1)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const spanned = first.until(last, { largestUnit: 'day' }).days + 1;
  if (spanned > maxDays) {
    throw rangeTooLarge(
      `localDaysBetween window spans ${String(spanned)} local days, over the ${String(maxDays)} day ceiling.`,
    );
  }
  const days: LocalDate[] = [];
  for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    days.push(day.toString());
  }
  return days;
}

/**
 * UTC offset of a zone at an instant, in milliseconds. Positive east of Greenwich.
 *
 * This exists for `discretize`: an `Alignment` of kind `epoch` counts from the Unix epoch,
 * which sits on the hour in **UTC**, not on the local clock. To align a slot grid to the
 * local wall clock (what `align_to: 'hour'` and `align_to: 'half_hour'` mean), pass the
 * **negation** of this value as the alignment offset:
 *
 * ```ts
 * discretize(eroded, intervalMs, { kind: 'epoch', offsetMs: -zoneOffsetMs(timezone, at) });
 * ```
 *
 * The sign is not decoration. A local wall time `w` happens at the instant `w - offset`, so
 * the instants that fall on a local hour are the ones congruent to `-offset` modulo the
 * interval. In `Asia/Kolkata` (+05:30) the two signs coincide by luck (30 minutes is its
 * own negation modulo an hour), but in `Asia/Kathmandu` (+05:45) they do not, and the wrong
 * sign puts every start half an hour off.
 *
 * Without any offset the affected zones are all those whose UTC offset is not a whole number
 * of hours: India and Sri Lanka (+05:30), Nepal (+05:45), Iran, Myanmar, Newfoundland,
 * Adelaide, the Marquesas, `Pacific/Chatham`, `Australia/Eucla`. They get starts at 09:30 or
 * 09:45 instead of 09:00, and one slot fewer.
 *
 * Evaluate it inside the day being discretized: the offset changes across a DST transition,
 * so a day is the right granularity (the same granularity the availability cache uses).
 */
export function zoneOffsetMs(timezone: string, at: number): number {
  if (!Number.isSafeInteger(at)) {
    throw parameterInvalid(
      `zoneOffsetMs requires an instant as a safe integer of epoch milliseconds, received ${String(at)}.`,
    );
  }
  assertTimezone(timezone);
  return (
    Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timezone).offsetNanoseconds /
    1_000_000
  );
}

interface CompiledRule {
  readonly days: ReadonlySet<number>;
  readonly startTime: Temporal.PlainTime;
  readonly endTime: Temporal.PlainTime;
  readonly crossesMidnight: boolean;
  readonly validFrom: Temporal.PlainDate | null;
  readonly validUntil: Temporal.PlainDate | null;
}

function compileRule(rule: ScheduleRule, index: number): CompiledRule {
  const days = new Set<number>();
  for (const day of rule.daysOfWeek) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw parameterInvalid(
        `Rule ${String(index)}: daysOfWeek must contain integers 0 (Sunday) to 6 (Saturday), received ${String(day)}.`,
      );
    }
    days.add(day);
  }
  const start = parseTime(rule.startTime, `Rule ${String(index)} startTime`);
  const end = parseTime(rule.endTime, `Rule ${String(index)} endTime`);
  return {
    days,
    startTime: toPlainTime(start),
    endTime: toPlainTime(end),
    crossesMidnight: end.msOfDay <= start.msOfDay,
    validFrom:
      rule.validFrom == null ? null : parseDate(rule.validFrom, `Rule ${String(index)} validFrom`),
    validUntil:
      rule.validUntil == null
        ? null
        : parseDate(rule.validUntil, `Rule ${String(index)} validUntil`),
  };
}

interface CompiledException {
  readonly type: 'closed' | 'open';
  /** `null` means the whole local day. */
  readonly band: {
    readonly startTime: Temporal.PlainTime;
    readonly endTime: Temporal.PlainTime;
    readonly crossesMidnight: boolean;
  } | null;
}

function compileException(exception: ScheduleException, index: number): CompiledException {
  if (exception.type !== 'closed' && exception.type !== 'open') {
    throw parameterInvalid(
      `Exception ${String(index)}: type must be "closed" or "open", received "${String(exception.type)}".`,
    );
  }
  const rawStart = exception.startTime ?? null;
  const rawEnd = exception.endTime ?? null;
  if ((rawStart === null) !== (rawEnd === null)) {
    throw parameterInvalid(
      `Exception ${String(index)} on ${exception.date}: startTime and endTime must be given together or not at all.`,
    );
  }
  if (rawStart === null || rawEnd === null) return { type: exception.type, band: null };
  const start = parseTime(rawStart, `Exception ${String(index)} startTime`);
  const end = parseTime(rawEnd, `Exception ${String(index)} endTime`);
  return {
    type: exception.type,
    band: {
      startTime: toPlainTime(start),
      endTime: toPlainTime(end),
      crossesMidnight: end.msOfDay <= start.msOfDay,
    },
  };
}

/**
 * Turns rules, exceptions and blocks into the open timeline of one resource over
 * `[from, to)`, in UTC.
 *
 * The pipeline, per local day. This is the step that turns a resource's configuration into the
 * intervals it is open on, before any booking has been subtracted from them:
 *
 * 1. a `closed` exception **without times** means "this day's calendar does not open". It is
 *    a predicate on generation, not an interval to subtract: steps 2 and 3 are skipped for
 *    that local day, so the bands its rules would have produced never exist, including the
 *    part of an overnight band that reaches past its midnight. It does **not** touch the
 *    tail of a band that started the day before: a bar open Tuesday 22:00-02:00 and closed
 *    on Wednesday still serves until 2 a.m. on Tuesday night;
 * 2. every rule whose `daysOfWeek` contains the **local** weekday and whose
 *    `validFrom`/`validUntil` window (inclusive) contains the day contributes its band;
 * 3. every `open` exception on that day contributes its band too, in addition to the
 *    rules, or on its own if the day has none. A full-day `open` opens the whole local day;
 * 4. every `closed` exception **with times** subtracts its band as a calendar interval, and
 *    does so even on a day suppressed by step 1, because it may reach past midnight into a
 *    day that does open. Closures are applied after openings: an `open` exception never
 *    reopens what a `closed` band covers;
 * 5. blocks (already absolute) are subtracted whole: capacity drops to 0 inside a block;
 * 6. every surviving segment carries the resource `capacity`;
 * 7. the result is normalized and clipped to `[from, to)`.
 *
 * Opening bands are merged as a boolean union first, so two overlapping rules (9-13 and
 * 12-19) open the resource once, not twice: capacity comes from the resource, never from
 * how many rules happen to cover an instant.
 *
 * Days are scanned from one local day before `from` (an overnight band such as
 * `22:00-02:00` belongs to the day it starts on but reaches into the next) through the
 * local day of `to`, and the span is capped by `maxDays`.
 */
export function materializeSchedule(input: MaterializeScheduleInput): Timeline {
  const { timezone, capacity, from, to } = input;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw parameterInvalid(
      'materializeSchedule requires from/to as safe integers of epoch milliseconds.',
    );
  }
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw parameterInvalid(
      `materializeSchedule requires a non-negative integer capacity, received ${String(capacity)}.`,
    );
  }
  assertTimezone(timezone);
  if (to <= from || capacity === 0) return [];

  const rules = input.rules.map(compileRule);
  const exceptionsByDate = new Map<string, CompiledException[]>();
  (input.exceptions ?? []).forEach((exception, index) => {
    const date = parseDate(exception.date, `Exception ${String(index)} date`).toString();
    const compiled = compileException(exception, index);
    const bucket = exceptionsByDate.get(date);
    if (bucket === undefined) exceptionsByDate.set(date, [compiled]);
    else bucket.push(compiled);
  });

  const maxDays = input.maxDays ?? DEFAULT_MAX_DAYS;
  if (!Number.isSafeInteger(maxDays) || maxDays < 1) {
    throw parameterInvalid(
      `materializeSchedule requires maxDays to be an integer >= 1, received ${String(maxDays)}.`,
    );
  }

  const startDay = Temporal.Instant.fromEpochMilliseconds(from)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const lastDay = Temporal.Instant.fromEpochMilliseconds(to - 1)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const spannedDays = startDay.until(lastDay, { largestUnit: 'day' }).days + 1;
  if (spannedDays > maxDays) {
    throw rangeTooLarge(
      `materializeSchedule window spans ${String(spannedDays)} local days, over the ${String(maxDays)} day ceiling; narrow the window or raise maxDays.`,
    );
  }
  const firstDay = startDay.subtract({ days: 1 });

  const openRanges: InstantRange[] = [];
  const closedRanges: InstantRange[] = [];

  for (
    let day = firstDay;
    Temporal.PlainDate.compare(day, lastDay) <= 0;
    day = day.add({ days: 1 })
  ) {
    const dayKey = day.toString();
    // Temporal counts 1 = Monday .. 7 = Sunday; the data model counts 0 = Sunday .. 6 = Saturday.
    const weekday = day.dayOfWeek % 7;
    const exceptions = exceptionsByDate.get(dayKey);
    // A `closed` exception without times means "this day's calendar does not open". It is a
    // predicate on generation, not an interval to subtract: it suppresses the bands the rules
    // (and the `open` exceptions) would produce *for this local day*, tail past midnight
    // included, and leaves alone the tail of a band that started the day before.
    const dayIsClosed =
      exceptions !== undefined &&
      exceptions.some((exception) => exception.type === 'closed' && exception.band === null);

    if (!dayIsClosed) {
      for (const rule of rules) {
        if (!rule.days.has(weekday)) continue;
        if (rule.validFrom !== null && Temporal.PlainDate.compare(day, rule.validFrom) < 0)
          continue;
        if (rule.validUntil !== null && Temporal.PlainDate.compare(day, rule.validUntil) > 0)
          continue;
        pushBand(openRanges, timezone, day, rule.startTime, rule.endTime, rule.crossesMidnight);
      }
    }

    if (exceptions === undefined) continue;
    for (const exception of exceptions) {
      if (exception.band === null) {
        // A full-day `closed` was already applied as suppression above; a full-day `open`
        // opens the whole local day, unless the day is suppressed (closures win).
        if (exception.type === 'open' && !dayIsClosed) {
          const wholeDay = localDayRange(timezone, dayKey);
          if (wholeDay.end > wholeDay.start) openRanges.push(wholeDay);
        }
        continue;
      }
      // A `closed` with times stays a calendar interval and is subtracted even on a
      // suppressed day: it may reach past midnight into a day that does open.
      if (exception.type === 'closed') {
        pushBand(
          closedRanges,
          timezone,
          day,
          exception.band.startTime,
          exception.band.endTime,
          exception.band.crossesMidnight,
        );
      } else if (!dayIsClosed) {
        pushBand(
          openRanges,
          timezone,
          day,
          exception.band.startTime,
          exception.band.endTime,
          exception.band.crossesMidnight,
        );
      }
    }
  }

  const open = withCapacity(mergeRanges(openRanges), capacity);
  const closed = withCapacity(mergeRanges(closedRanges), capacity);
  const blocked = normalize(
    (input.blocks ?? []).map((block): Segment => {
      if (!Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end)) {
        throw parameterInvalid('Block bounds must be safe integers of epoch milliseconds.');
      }
      return { start: block.start, end: block.end, capacity };
    }),
  );

  return clip(subtract(subtract(open, closed), blocked), from, to);
}

function pushBand(
  target: InstantRange[],
  timezone: string,
  day: Temporal.PlainDate,
  startTime: Temporal.PlainTime,
  endTime: Temporal.PlainTime,
  crossesMidnight: boolean,
): void {
  const start = instantAt(day, startTime, timezone);
  const endDay = crossesMidnight ? day.add({ days: 1 }) : day;
  const end = instantAt(endDay, endTime, timezone);
  if (end > start) target.push({ start, end });
}

/** Boolean union of absolute ranges: overlapping or touching ranges become one. */
function mergeRanges(ranges: readonly InstantRange[]): InstantRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InstantRange[] = [];
  let current = sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]!;
    if (next.start <= current.end) {
      if (next.end > current.end) current = { start: current.start, end: next.end };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function withCapacity(ranges: readonly InstantRange[], capacity: number): Timeline {
  return normalize(ranges.map((range): Segment => ({ ...range, capacity })));
}
