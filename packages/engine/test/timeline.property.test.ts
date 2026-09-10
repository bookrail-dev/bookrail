/**
 * Property suite for the segment algebra.
 *
 * Every generator produces small, densely overlapping timelines on purpose: the interesting
 * failures live on shared boundaries, not on wide random ranges.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  clip,
  discretize,
  erode,
  intersect,
  isNormalized,
  kOfN,
  normalize,
  subtract,
  union,
  type Segment,
  type Timeline,
} from '../src/timeline/index.js';

const rawSegment = fc
  .tuple(
    fc.integer({ min: -60, max: 60 }),
    fc.integer({ min: 1, max: 25 }),
    fc.integer({ min: 0, max: 4 }),
  )
  .map(([start, length, capacity]): Segment => ({ start, end: start + length, capacity }));

const rawSegments = fc.array(rawSegment, { maxLength: 8 });
const timeline = rawSegments.map(normalize);
/** A timeline with exactly one segment: the case where `erode` has no overlap to resolve. */
const oneSegment = rawSegment
  .filter((segment) => segment.capacity > 0)
  .map((segment): Timeline => [segment]);

/** The instants a timeline covers, ignoring capacity. */
function footprint(t: Timeline): [number, number][] {
  const out: [number, number][] = [];
  for (const segment of t) {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === segment.start) last[1] = segment.end;
    else out.push([segment.start, segment.end]);
  }
  return out;
}

const RUNS = { numRuns: 500 };

describe('timeline properties', () => {
  it('normalize always produces the normal form', () => {
    fc.assert(
      fc.property(rawSegments, (segments) => {
        expect(isNormalized(normalize(segments))).toBe(true);
      }),
      RUNS,
    );
  });

  it('normalize is idempotent', () => {
    fc.assert(
      fc.property(rawSegments, (segments) => {
        const once = normalize(segments);
        expect(normalize(once)).toEqual(once);
      }),
      RUNS,
    );
  });

  it('every operation returns a normalized timeline, even from unnormalized input', () => {
    fc.assert(
      fc.property(rawSegments, rawSegments, (rawA, rawB) => {
        const a = normalize(rawA);
        const b = normalize(rawB);
        for (const result of [
          union(rawA, rawB),
          intersect(rawA, rawB),
          subtract(rawA, rawB),
          kOfN([a, b], 1, 1),
          kOfN([a, b], 2, 1),
          erode(rawA, 1, 2, 3),
          erode(rawA, 0, 0, 0), // the only case where eroded segments overlap
          clip(rawA, -10, 40),
        ]) {
          expect(isNormalized(result)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('capacity is never negative', () => {
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        for (const result of [union(a, b), intersect(a, b), subtract(a, b), erode(a, 0, 3, 0)]) {
          for (const segment of result) expect(segment.capacity).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it('erode never invents a capacity the timeline did not already offer', () => {
    // Guards the overlap resolution of the zero-parameter case: inside the one millisecond
    // where two eroded segments meet, the answer is the larger of the two capacities, never
    // their sum and never something new.
    fc.assert(
      fc.property(
        timeline,
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (a, before, duration, after) => {
          const capacities = new Set(a.map((segment) => segment.capacity));
          for (const segment of erode(a, before, duration, after)) {
            expect(capacities.has(segment.capacity)).toBe(true);
          }
        },
      ),
      RUNS,
    );
  });

  it('union is commutative', () => {
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        expect(union(a, b)).toEqual(union(b, a));
      }),
      RUNS,
    );
  });

  it('union is associative', () => {
    fc.assert(
      fc.property(timeline, timeline, timeline, (a, b, c) => {
        expect(union(union(a, b), c)).toEqual(union(a, union(b, c)));
      }),
      RUNS,
    );
  });

  it('union has the empty timeline as its neutral element', () => {
    fc.assert(
      fc.property(timeline, (a) => {
        expect(union(a, [])).toEqual(a);
      }),
      RUNS,
    );
  });

  it('intersect(a, a) = a', () => {
    fc.assert(
      fc.property(timeline, (a) => {
        expect(intersect(a, a)).toEqual(a);
      }),
      RUNS,
    );
  });

  it('intersect is commutative and never exceeds either operand', () => {
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        const result = intersect(a, b);
        expect(result).toEqual(intersect(b, a));
        for (const segment of result) {
          expect(capacityAt(a, segment.start)).toBeGreaterThanOrEqual(segment.capacity);
          expect(capacityAt(b, segment.start)).toBeGreaterThanOrEqual(segment.capacity);
        }
      }),
      RUNS,
    );
  });

  it('subtract(a, a) = []', () => {
    fc.assert(
      fc.property(timeline, (a) => {
        expect(subtract(a, a)).toEqual([]);
      }),
      RUNS,
    );
  });

  it('subtract(a, []) = a and subtract([], b) = []', () => {
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        expect(subtract(a, [])).toEqual(a);
        expect(subtract([], b)).toEqual([]);
      }),
      RUNS,
    );
  });

  it('subtract(union(a, b), b) = a', () => {
    // Holds for any pair, not only for b included in a: union adds b's capacity and
    // subtract takes exactly it back, and the floor at zero never bites because a >= 0.
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        expect(subtract(union(a, b), b)).toEqual(a);
      }),
      RUNS,
    );
  });

  it('subtract never raises the capacity of the minuend', () => {
    fc.assert(
      fc.property(timeline, timeline, (a, b) => {
        for (const segment of subtract(a, b)) {
          expect(capacityAt(a, segment.start)).toBeGreaterThanOrEqual(segment.capacity);
        }
      }),
      RUNS,
    );
  });

  it('kOfN with k = 1 covers the same instants as the boolean union', () => {
    fc.assert(
      fc.property(fc.array(timeline, { minLength: 1, maxLength: 4 }), (timelines) => {
        const booleanUnion = timelines.reduce<Timeline>((acc, t) => union(acc, t), []);
        expect(footprint(kOfN(timelines, 1, 1))).toEqual(footprint(booleanUnion));
      }),
      RUNS,
    );
  });

  it('kOfN with k = n covers the same instants as the boolean intersection', () => {
    fc.assert(
      fc.property(fc.array(timeline, { minLength: 1, maxLength: 4 }), (timelines) => {
        const first = timelines[0] ?? [];
        const booleanIntersection = timelines
          .slice(1)
          .reduce<Timeline>((acc, t) => intersect(acc, t), first);
        expect(footprint(kOfN(timelines, timelines.length, 1))).toEqual(
          footprint(booleanIntersection),
        );
      }),
      RUNS,
    );
  });

  it('kOfN is monotone in k: a higher k never covers more', () => {
    fc.assert(
      fc.property(fc.array(timeline, { minLength: 2, maxLength: 4 }), (timelines) => {
        for (let k = 2; k <= timelines.length; k += 1) {
          const wider = kOfN(timelines, k - 1, 1);
          for (const segment of kOfN(timelines, k, 1)) {
            expect(capacityAt(wider, segment.start)).toBeGreaterThanOrEqual(segment.capacity);
          }
        }
      }),
      RUNS,
    );
  });

  it('kOfN never reports more matches than there are timelines', () => {
    fc.assert(
      fc.property(fc.array(timeline, { minLength: 1, maxLength: 4 }), (timelines) => {
        for (const segment of kOfN(timelines, 1, 1)) {
          expect(segment.capacity).toBeLessThanOrEqual(timelines.length);
        }
      }),
      RUNS,
    );
  });

  it('erode matches a dense oracle on multi-segment timelines', () => {
    // The independent oracle for `erode`, including the overlap resolution of
    // `pushResolvingOverlap`, which the single-segment properties below cannot reach: an
    // instant `t` is an admissible start iff some segment [a, b) satisfies
    // `a + before <= t <= b - duration - after`, and its capacity is the largest such
    // segment's. Built millisecond by millisecond, with no reference to the implementation.
    fc.assert(
      fc.property(
        timeline,
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        (a, before, duration, after) => {
          expect(erode(a, before, duration, after)).toEqual(denseErode(a, before, duration, after));
        },
      ),
      RUNS,
    );
  });

  it('erode returns the closed set of admissible starts', () => {
    // On a single segment there is no overlap to resolve, so the closed set
    // [a + before, b - duration - after] is exactly [a + before, b - duration - after + 1).
    fc.assert(
      fc.property(
        oneSegment,
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (a, before, duration, after) => {
          const source = a[0]!;
          const start = source.start + before;
          const end = source.end - duration - after + 1;
          expect(erode(a, before, duration, after)).toEqual(
            start < end ? [{ start, end, capacity: source.capacity }] : [],
          );
        },
      ),
      RUNS,
    );
  });

  it('erode with zero parameters widens every segment by exactly one millisecond', () => {
    fc.assert(
      fc.property(oneSegment, (a) => {
        const source = a[0]!;
        expect(erode(a, 0, 0, 0)).toEqual([
          { start: source.start, end: source.end + 1, capacity: source.capacity },
        ]);
      }),
      RUNS,
    );
  });

  it('every eroded instant is a legal start of the whole booking window', () => {
    fc.assert(
      fc.property(
        timeline,
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (a, before, duration, after) => {
          for (const segment of erode(a, before, duration, after)) {
            // The first and the last admissible start of the eroded segment both keep their
            // whole [t - before, t + duration + after) window inside one original segment of
            // at least the same capacity. `duration >= 1` keeps that window non-empty.
            for (const at of [segment.start, segment.end - 1]) {
              expect(capacityAt(a, at - before)).toBeGreaterThanOrEqual(segment.capacity);
              expect(capacityAt(a, at + duration + after - 1)).toBeGreaterThanOrEqual(
                segment.capacity,
              );
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('discretize counts floor((b - a - duration) / interval) + 1 starts on a single segment', () => {
    // The counting rule the discretizer has to satisfy exactly.
    fc.assert(
      fc.property(
        oneSegment,
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 7 }),
        (a, duration, interval) => {
          const { start, end } = a[0]!;
          const span = end - start;
          const starts = discretize(erode(a, 0, duration, 0), interval, {
            kind: 'segment_start',
          });
          expect(starts).toHaveLength(
            span >= duration ? Math.floor((span - duration) / interval) + 1 : 0,
          );
          if (starts.length > 0) {
            expect(starts[0]!.at).toBe(start);
            expect(starts[starts.length - 1]!.at + duration).toBeLessThanOrEqual(end);
          }
        },
      ),
      RUNS,
    );
  });

  it('discretize honours maxInstants', () => {
    fc.assert(
      fc.property(timeline, fc.integer({ min: 1, max: 7 }), (a, interval) => {
        const all = discretize(a, interval, { kind: 'epoch' });
        expect(discretize(a, interval, { kind: 'epoch' }, all.length)).toEqual(all);
        if (all.length > 0) {
          expect(() => discretize(a, interval, { kind: 'epoch' }, all.length - 1)).toThrow(
            RangeError,
          );
        }
      }),
      RUNS,
    );
  });

  it('discretize yields aligned instants inside the eroded timeline, spaced by the interval', () => {
    fc.assert(
      fc.property(
        timeline,
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: -20, max: 20 }),
        fc.constantFrom<'epoch' | 'segment_start'>('epoch', 'segment_start'),
        (a, before, duration, interval, offsetMs, kind) => {
          const eroded = erode(a, before, duration, 0);
          const instants = discretize(eroded, interval, { kind, offsetMs });
          for (const instant of instants) {
            expect(capacityAt(eroded, instant.at)).toBe(instant.capacity);
            if (kind === 'epoch') {
              expect((((instant.at - offsetMs) % interval) + interval) % interval).toBe(0);
            }
          }
          // Consecutive instants taken from the same segment are exactly `interval` apart.
          for (let i = 1; i < instants.length; i += 1) {
            const previous = instants[i - 1]!;
            const current = instants[i]!;
            expect(current.at).toBeGreaterThan(previous.at);
            if (sameSegment(eroded, previous.at, current.at)) {
              expect(current.at - previous.at).toBe(interval);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('clip keeps exactly the capacity the timeline had inside the window', () => {
    fc.assert(
      fc.property(
        timeline,
        fc.integer({ min: -80, max: 80 }),
        fc.integer({ min: -80, max: 80 }),
        (a, x, y) => {
          const from = Math.min(x, y);
          const to = Math.max(x, y);
          const clipped = clip(a, from, to);
          for (const segment of clipped) {
            expect(segment.start).toBeGreaterThanOrEqual(from);
            expect(segment.end).toBeLessThanOrEqual(to);
            expect(capacityAt(a, segment.start)).toBe(segment.capacity);
          }
          expect(clip(clipped, from, to)).toEqual(clipped);
        },
      ),
      RUNS,
    );
  });
});

/**
 * Reference implementation of `erode`, written densely: one capacity per millisecond over a
 * window that provably contains every result of the generators above (starts in [-60, 60],
 * lengths up to 25, buffers up to 6).
 */
function denseErode(t: Timeline, before: number, duration: number, after: number): Timeline {
  const LOW = -120;
  const HIGH = 160;
  const capacities = new Array<number>(HIGH - LOW).fill(0);
  for (const segment of t) {
    const first = segment.start + before;
    const last = segment.end - duration - after; // inclusive: a start here ends exactly at `end`
    for (let at = Math.max(first, LOW); at <= Math.min(last, HIGH - 1); at += 1) {
      const index = at - LOW;
      if (segment.capacity > capacities[index]!) capacities[index] = segment.capacity;
    }
  }
  const out: Segment[] = [];
  let i = 0;
  while (i < capacities.length) {
    const capacity = capacities[i]!;
    if (capacity === 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < capacities.length && capacities[j] === capacity) j += 1;
    out.push({ start: LOW + i, end: LOW + j, capacity });
    i = j;
  }
  return out;
}

/** Capacity of the timeline at one instant, `0` outside every segment. */
function capacityAt(t: Timeline, at: number): number {
  for (const segment of t) {
    if (at >= segment.start && at < segment.end) return segment.capacity;
  }
  return 0;
}

/** True when both instants fall in the same segment of the timeline. */
function sameSegment(t: Timeline, a: number, b: number): boolean {
  for (const segment of t) {
    if (a >= segment.start && a < segment.end) return b >= segment.start && b < segment.end;
  }
  return false;
}
