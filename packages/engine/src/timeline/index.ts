/**
 * Segment timelines: the representation every availability computation is built on.
 *
 * A timeline is an ordered list of half-open intervals `[start, end)` in absolute epoch
 * milliseconds, each carrying an available capacity. Everything here is pure: no I/O, no clock,
 * no time zone. Wall-clock reasoning happens once, in `../schedule/index.js`, and produces
 * absolute instants; from that point on the engine only ever adds and subtracts milliseconds.
 *
 * ## Normal form
 *
 * A `Timeline` is always **normalized**:
 * - sorted by `start`;
 * - no two segments overlap;
 * - no two adjacent segments share the same capacity (they are fused);
 * - no segment has capacity `0` (they are dropped: "no capacity" and "no segment" are the
 *   same statement) and none has negative capacity (that is an error, not a state).
 *
 * Every operation in this module accepts arbitrary input (even overlapping or unsorted)
 * and returns a normalized timeline, so the normal form is an invariant of the module and
 * not a precondition callers have to remember.
 *
 * ## Units and domain
 *
 * Instants are safe integers of epoch milliseconds; capacities are non-negative safe integers
 * (`resources.capacity` is an integer column). The integer domain is what makes fusing adjacent
 * segments exact.
 */
import { parameterInvalid, rangeTooLarge } from '../errors.js';

/** A half-open interval `[start, end)` in epoch milliseconds with an available capacity. */
export interface Segment {
  /** Inclusive lower bound, epoch milliseconds UTC. */
  readonly start: number;
  /** Exclusive upper bound, epoch milliseconds UTC. Always `> start`. */
  readonly end: number;
  /** Units of capacity available across the whole interval. Always `> 0` once normalized. */
  readonly capacity: number;
}

/** An ordered, non-overlapping, fused list of segments. See the module docs for the normal form. */
export type Timeline = readonly Segment[];

/** How `discretize` places candidate instants inside a segment. */
export interface Alignment {
  /**
   * `epoch`: instants congruent to `offsetMs` modulo the interval, counted from the Unix
   * epoch.
   *
   * **`offsetMs = 0` is not the local clock.** The Unix epoch falls on the hour in UTC, so a
   * bare epoch alignment reproduces a service's `align_to: 'hour'` only
   * in zones whose UTC offset is a whole number of hours, and `align_to: 'half_hour'` only
   * where it is a whole number of half hours. In `Asia/Kolkata` (+05:30) a 60 minute grid
   * with `offsetMs = 0` puts the starts of a 09:00-13:00 schedule at 09:30, 10:30 and 11:30:
   * wrong hour *and* one slot fewer. Same for `Asia/Kathmandu` and `Pacific/Chatham`
   * (+05:45, +12:45), Iran, Myanmar, Newfoundland, Adelaide and Eucla.
   *
   * To align to the **local wall clock**, pass `offsetMs = -zoneOffsetMs(timezone, at)` from
   * `../schedule/index.js`. Note the **minus**: a local wall time `w` happens at `w - offset`,
   * so the instants on a local hour are those congruent to `-offset` modulo the interval.
   * Evaluate it at an instant inside the day being discretized, since the offset changes
   * across a DST transition. This is a requirement on the caller (the layer that maps
   * `align_to` to an `Alignment`), not something this function can infer: a timeline carries
   * no zone.
   *
   * `segment_start`: instants counted from each segment's own start, which is what
   * `align_to: 'schedule_start'` means. It needs no zone and no offset.
   */
  readonly kind: 'epoch' | 'segment_start';
  /**
   * Offset added to the alignment origin, in milliseconds. Defaults to `0`.
   *
   * The two alignments treat it differently, on purpose:
   * - `epoch` reduces it **modulo the interval**: it names a phase on an infinite grid, so
   *   `offsetMs` and `offsetMs + interval` are the same alignment;
   * - `segment_start` uses it **whole**: it names a delay from the segment start, so an
   *   `offsetMs` of 250 with a 100 ms interval really starts at `start + 250`. Only a value
   *   that would land before the segment start is clamped forward into it.
   */
  readonly offsetMs?: number;
}

/** One candidate start instant produced by `discretize`. */
export interface DiscreteInstant {
  /** Epoch milliseconds UTC. */
  readonly at: number;
  /** Capacity of the segment the instant was taken from. */
  readonly capacity: number;
}

const MS = 'epoch milliseconds';

function assertInstant(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw parameterInvalid(`${what} must be a safe integer of ${MS}, received ${String(value)}.`);
  }
}

function assertCapacity(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw parameterInvalid(`Segment capacity must be a safe integer, received ${String(value)}.`);
  }
  if (value < 0) {
    throw parameterInvalid(`Segment capacity must not be negative, received ${String(value)}.`);
  }
}

function assertSegment(segment: Segment): void {
  assertInstant(segment.start, 'Segment start');
  assertInstant(segment.end, 'Segment end');
  if (segment.start >= segment.end) {
    throw parameterInvalid(
      `Segment start must be strictly before its end, received [${String(segment.start)}, ${String(segment.end)}).`,
    );
  }
  assertCapacity(segment.capacity);
}

function assertNonNegativeDuration(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw parameterInvalid(
      `${what} must be a safe integer of milliseconds, received ${String(value)}.`,
    );
  }
  if (value < 0) {
    throw parameterInvalid(`${what} must not be negative, received ${String(value)}.`);
  }
}

/**
 * Accumulates segments into normal form: drops empty ones and fuses the ones that touch
 * with the same capacity. Callers must push in ascending, non-overlapping order.
 */
class TimelineBuilder {
  private readonly segments: Segment[] = [];

  push(start: number, end: number, capacity: number): void {
    if (end <= start || capacity <= 0) return;
    const last = this.segments[this.segments.length - 1];
    if (last !== undefined && last.end === start && last.capacity === capacity) {
      this.segments[this.segments.length - 1] = { start: last.start, end, capacity };
      return;
    }
    this.segments.push({ start, end, capacity });
  }

  /**
   * Pushes a segment whose start may fall *inside* the previous one; where they overlap the
   * higher capacity wins. Only `erode` needs this: its closed end makes two segments that
   * merely touched in the input overlap by exactly one millisecond, and at that instant both
   * capacities are legitimately on offer: the larger of the two is the answer.
   */
  pushResolvingOverlap(start: number, end: number, capacity: number): void {
    let from = start;
    while (this.segments.length > 0) {
      const last = this.segments[this.segments.length - 1]!;
      if (last.end <= from) break;
      if (capacity >= last.capacity) {
        if (last.start >= from) {
          this.segments.pop();
          continue;
        }
        this.segments[this.segments.length - 1] = {
          start: last.start,
          end: from,
          capacity: last.capacity,
        };
        break;
      }
      from = Math.min(last.end, end);
      break;
    }
    this.push(from, end, capacity);
  }

  build(): Timeline {
    return this.segments;
  }
}

/**
 * Turns arbitrary segments into a normalized timeline, **summing** capacities where they
 * overlap. This is the canonical entry point: `union` is literally `normalize` over the
 * concatenation of its operands.
 *
 * Throws `RangeError` on a segment with `start >= end`, a non-integer bound, or a negative
 * capacity. Segments with capacity `0` are ignored rather than rejected.
 *
 * Cost: `O(n log n)` for the sort, then linear.
 */
export function normalize(segments: Iterable<Segment>): Timeline {
  const boundaries: { at: number; delta: number }[] = [];
  for (const segment of segments) {
    assertSegment(segment);
    if (segment.capacity === 0) continue;
    boundaries.push({ at: segment.start, delta: segment.capacity });
    boundaries.push({ at: segment.end, delta: -segment.capacity });
  }
  if (boundaries.length === 0) return [];
  boundaries.sort((a, b) => a.at - b.at);

  const out = new TimelineBuilder();
  let running = 0;
  let cursor = boundaries[0]!.at;
  for (let i = 0; i < boundaries.length;) {
    const at = boundaries[i]!.at;
    if (at > cursor) {
      out.push(cursor, at, running);
      cursor = at;
    }
    while (i < boundaries.length && boundaries[i]!.at === at) {
      running += boundaries[i]!.delta;
      i += 1;
    }
  }
  return out.build();
}

/** True when `timeline` is already in normal form. Useful in tests and assertions. */
export function isNormalized(timeline: Timeline): boolean {
  let previous: Segment | undefined;
  for (const segment of timeline) {
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)) return false;
    if (segment.start >= segment.end) return false;
    if (!Number.isSafeInteger(segment.capacity) || segment.capacity <= 0) return false;
    if (previous !== undefined) {
      if (segment.start < previous.end) return false;
      if (segment.start === previous.end && segment.capacity === previous.capacity) return false;
    }
    previous = segment;
  }
  return true;
}

/**
 * Union with capacity **addition**: where `a` and `b` overlap the result carries the sum.
 * Two rooms of ten seats each, open at the same time, are twenty seats.
 */
export function union(a: Timeline, b: Timeline): Timeline {
  return normalize([...a, ...b]);
}

/**
 * Intersection: present only where both operands are, with the **minimum** capacity. This is
 * the "all requirements satisfied at once" operator: a service is available at an instant only
 * where every requirement it has can be met there, and the quantity it can serve is the
 * smallest any one of them offers.
 */
export function intersect(a: Timeline, b: Timeline): Timeline {
  const left = normalize(a);
  const right = normalize(b);
  const out = new TimelineBuilder();
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (start < end) out.push(start, end, Math.min(x.capacity, y.capacity));
    if (x.end < y.end) i += 1;
    else j += 1;
  }
  return out.build();
}

/**
 * Subtraction with capacity floor: the capacity of `a` minus the capacity of `b` where they
 * overlap, never below zero (a segment that reaches zero simply disappears). This is how
 * occupancies, blocks and closures are removed from an open timeline.
 */
export function subtract(a: Timeline, b: Timeline): Timeline {
  const left = normalize(a);
  const right = normalize(b);
  const out = new TimelineBuilder();
  let head = 0;
  for (const segment of left) {
    while (head < right.length && right[head]!.end <= segment.start) head += 1;
    let cursor = segment.start;
    for (let k = head; k < right.length; k += 1) {
      const hole = right[k]!;
      if (hole.start >= segment.end) break;
      const overlapStart = Math.max(cursor, hole.start);
      const overlapEnd = Math.min(segment.end, hole.end);
      if (overlapEnd <= cursor) continue;
      if (overlapStart > cursor) out.push(cursor, overlapStart, segment.capacity);
      out.push(overlapStart, overlapEnd, segment.capacity - hole.capacity);
      cursor = overlapEnd;
      if (cursor >= segment.end) break;
    }
    if (cursor < segment.end) out.push(cursor, segment.end, segment.capacity);
  }
  return out.build();
}

/**
 * Intervals where **at least `k`** of the given timelines have capacity `>= minCapacity`.
 * The resulting capacity is the *number of timelines* that clear the threshold, not a sum
 * of capacities: this answers "one resource out of this group", and the count is what a
 * requirement of quantity `n` is compared against.
 *
 * `k` and `minCapacity` must be integers `>= 1`. `k` greater than the number of timelines
 * yields an empty result.
 */
export function kOfN(timelines: readonly Timeline[], k: number, minCapacity: number): Timeline {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw parameterInvalid(`kOfN requires an integer k >= 1, received ${String(k)}.`);
  }
  if (!Number.isSafeInteger(minCapacity) || minCapacity < 1) {
    throw parameterInvalid(
      `kOfN requires an integer minCapacity >= 1, received ${String(minCapacity)}.`,
    );
  }
  if (k > timelines.length) return [];

  const boundaries: { at: number; delta: number }[] = [];
  for (const timeline of timelines) {
    for (const segment of normalize(timeline)) {
      if (segment.capacity < minCapacity) continue;
      boundaries.push({ at: segment.start, delta: 1 });
      boundaries.push({ at: segment.end, delta: -1 });
    }
  }
  if (boundaries.length === 0) return [];
  boundaries.sort((a, b) => a.at - b.at);

  const out = new TimelineBuilder();
  let count = 0;
  let cursor = boundaries[0]!.at;
  for (let i = 0; i < boundaries.length;) {
    const at = boundaries[i]!.at;
    if (at > cursor) {
      if (count >= k) out.push(cursor, at, count);
      cursor = at;
    }
    while (i < boundaries.length && boundaries[i]!.at === at) {
      count += boundaries[i]!.delta;
      i += 1;
    }
  }
  return out.build();
}

/**
 * Shrinks every segment `[a, b)` into the admissible **start** instants of a booking that
 * needs `before` milliseconds of buffer, `duration` milliseconds of service and `after`
 * milliseconds of buffer. Capacity is preserved; segments that admit no start disappear.
 *
 * The set of admissible starts is the **closed** interval `[a + before, b - duration - after]`, and
 * its upper bound is itself a legal start, because a booking beginning there ends exactly at `b`.
 * Since the engine's domain is integer milliseconds, that closed set is represented exactly by the
 * half-open segment `[a + before, b - duration - after + 1)`, which is what this function returns.
 * A 60 minute service on a 09:00-19:00 schedule therefore keeps its 18:00 start.
 *
 * Consequence of the closed end: `erode(t, 0, 0, 0)` is **not** the identity; it widens
 * every segment by one millisecond, because with no duration and no buffers `b` itself is a
 * legal (degenerate) start. Two segments that merely touched then overlap by that one
 * millisecond, and the higher capacity wins inside the overlap. This is the only way two
 * eroded segments can ever overlap: for any other parameters the gap between consecutive
 * eroded segments is `before + duration + after - 1 >= 0`.
 */
export function erode(
  timeline: Timeline,
  before: number,
  duration: number,
  after: number,
): Timeline {
  assertNonNegativeDuration(before, 'erode before');
  assertNonNegativeDuration(duration, 'erode duration');
  assertNonNegativeDuration(after, 'erode after');
  const out = new TimelineBuilder();
  for (const segment of normalize(timeline)) {
    const start = segment.start + before;
    const end = segment.end - duration - after + 1;
    // The closed end pushes one millisecond past the input, which can leave the safe integer
    // range for a segment that ends at the very top of it. The normal form is an invariant,
    // not an invariant-almost-always, so this is an error rather than a silent violation.
    assertInstant(start, 'Eroded segment start');
    assertInstant(end, 'Eroded segment end');
    out.pushResolvingOverlap(start, end, segment.capacity);
  }
  return out.build();
}

/**
 * Candidate start instants inside a timeline, spaced `intervalMs` apart and aligned as
 * requested. Instants are strictly inside their segment (`start <= at < end`), so this is
 * meant to be applied to an already eroded timeline.
 *
 * Consecutive instants coming from the same segment are always exactly `intervalMs` apart
 * in **absolute** milliseconds, which is the engine's clock rule: a 60 minute cadence stays 60
 * real minutes across a DST transition, even when the wall clock disagrees.
 *
 * `maxInstants`, when given, is a hard ceiling: a wide window with a small interval throws
 * `RangeError` instead of quietly allocating millions of instants. Callers that expose this
 * to the outside world should always set it. The default is no ceiling.
 */
export function discretize(
  timeline: Timeline,
  intervalMs: number,
  alignment: Alignment,
  maxInstants?: number,
): DiscreteInstant[] {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw parameterInvalid(
      `discretize requires an integer interval > 0 milliseconds, received ${String(intervalMs)}.`,
    );
  }
  const offset = alignment.offsetMs ?? 0;
  if (!Number.isSafeInteger(offset)) {
    throw parameterInvalid(
      `Alignment offsetMs must be a safe integer, received ${String(offset)}.`,
    );
  }
  if (maxInstants !== undefined && (!Number.isSafeInteger(maxInstants) || maxInstants < 0)) {
    throw parameterInvalid(
      `discretize requires maxInstants to be a non-negative integer, received ${String(maxInstants)}.`,
    );
  }

  const out: DiscreteInstant[] = [];
  for (const segment of normalize(timeline)) {
    let first: number;
    if (alignment.kind === 'epoch') {
      // Both operands are reduced before the subtraction: `offsetMs` and `segment.start` are
      // each safe integers, but their difference need not be, and an unreduced subtraction
      // silently misaligns the grid for very large offsets.
      const phase = offset % intervalMs;
      const base = segment.start % intervalMs;
      const shift = (((phase - base) % intervalMs) + intervalMs) % intervalMs;
      first = segment.start + shift;
    } else {
      first = segment.start + offset;
      if (first < segment.start) {
        const steps = Math.ceil((segment.start - first) / intervalMs);
        first += steps * intervalMs;
      }
    }
    for (let at = first; at < segment.end; at += intervalMs) {
      if (maxInstants !== undefined && out.length >= maxInstants) {
        throw rangeTooLarge(
          `discretize produced more than ${String(maxInstants)} instants; narrow the window or widen the interval.`,
        );
      }
      out.push({ at, capacity: segment.capacity });
    }
  }
  return out;
}

/** Restricts a timeline to `[from, to)`. An empty or inverted window yields an empty timeline. */
export function clip(timeline: Timeline, from: number, to: number): Timeline {
  assertInstant(from, 'clip from');
  assertInstant(to, 'clip to');
  if (to <= from) return [];
  const out = new TimelineBuilder();
  for (const segment of normalize(timeline)) {
    out.push(Math.max(segment.start, from), Math.min(segment.end, to), segment.capacity);
  }
  return out.build();
}
