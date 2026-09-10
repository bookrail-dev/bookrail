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

const HOUR = 3_600_000;

function seg(start: number, end: number, capacity: number): Segment {
  return { start, end, capacity };
}

/** The instants a timeline covers, ignoring capacity. */
function footprint(timeline: Timeline): [number, number][] {
  const out: [number, number][] = [];
  for (const segment of timeline) {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === segment.start) last[1] = segment.end;
    else out.push([segment.start, segment.end]);
  }
  return out;
}

describe('normalize', () => {
  it('returns an empty timeline for no input', () => {
    expect(normalize([])).toEqual([]);
  });

  it('sorts unsorted input', () => {
    expect(normalize([seg(20, 30, 1), seg(0, 10, 1)])).toEqual([seg(0, 10, 1), seg(20, 30, 1)]);
  });

  it('sums capacities where segments overlap', () => {
    expect(normalize([seg(0, 10, 2), seg(5, 15, 3)])).toEqual([
      seg(0, 5, 2),
      seg(5, 10, 5),
      seg(10, 15, 3),
    ]);
  });

  it('fuses adjacent segments with the same capacity', () => {
    expect(normalize([seg(0, 10, 2), seg(10, 20, 2)])).toEqual([seg(0, 20, 2)]);
  });

  it('keeps adjacent segments with different capacities apart', () => {
    expect(normalize([seg(0, 10, 2), seg(10, 20, 3)])).toEqual([seg(0, 10, 2), seg(10, 20, 3)]);
  });

  it('fuses segments that stack back to the same capacity', () => {
    // 0-10 at 1, 10-20 at 1 (two different sources) must come out as one segment.
    expect(normalize([seg(0, 20, 1), seg(0, 10, 1), seg(10, 20, 1)])).toEqual([seg(0, 20, 2)]);
  });

  it('drops zero-capacity segments', () => {
    expect(normalize([seg(0, 10, 0), seg(20, 30, 1)])).toEqual([seg(20, 30, 1)]);
  });

  it('is idempotent', () => {
    const once = normalize([seg(0, 10, 2), seg(5, 15, 3), seg(30, 40, 1)]);
    expect(normalize(once)).toEqual(once);
  });

  it('rejects a negative capacity', () => {
    expect(() => normalize([seg(0, 10, -1)])).toThrow(RangeError);
  });

  it('rejects an empty or inverted segment', () => {
    expect(() => normalize([seg(10, 10, 1)])).toThrow(RangeError);
    expect(() => normalize([seg(10, 5, 1)])).toThrow(RangeError);
  });

  it('rejects non-integer bounds and capacities', () => {
    expect(() => normalize([seg(0.5, 10, 1)])).toThrow(RangeError);
    expect(() => normalize([seg(0, 10, 1.5)])).toThrow(RangeError);
    expect(() => normalize([seg(0, Number.NaN, 1)])).toThrow(RangeError);
  });
});

describe('isNormalized', () => {
  it('accepts the normal form and rejects every violation of it', () => {
    expect(isNormalized([])).toBe(true);
    expect(isNormalized([seg(0, 10, 1), seg(20, 30, 2)])).toBe(true);
    expect(isNormalized([seg(20, 30, 1), seg(0, 10, 1)])).toBe(false); // unsorted
    expect(isNormalized([seg(0, 10, 1), seg(5, 30, 1)])).toBe(false); // overlapping
    expect(isNormalized([seg(0, 10, 1), seg(10, 30, 1)])).toBe(false); // fusable
    expect(isNormalized([seg(0, 10, 0)])).toBe(false); // empty capacity
    expect(isNormalized([seg(10, 10, 1)])).toBe(false); // empty interval
  });
});

describe('union', () => {
  it('is the empty timeline over two empty timelines', () => {
    expect(union([], [])).toEqual([]);
  });

  it('keeps disjoint segments apart', () => {
    expect(union([seg(0, 10, 1)], [seg(20, 30, 1)])).toEqual([seg(0, 10, 1), seg(20, 30, 1)]);
  });

  it('fuses touching segments of equal capacity', () => {
    expect(union([seg(0, 10, 1)], [seg(10, 20, 1)])).toEqual([seg(0, 20, 1)]);
  });

  it('adds capacity where the operands overlap', () => {
    expect(union([seg(0, 10, 1)], [seg(4, 6, 2)])).toEqual([
      seg(0, 4, 1),
      seg(4, 6, 3),
      seg(6, 10, 1),
    ]);
  });

  it('leaves the other operand untouched when one is empty', () => {
    const a: Timeline = [seg(0, 10, 3)];
    expect(union(a, [])).toEqual(a);
    expect(union([], a)).toEqual(a);
  });
});

describe('intersect', () => {
  it('is empty when the operands do not meet', () => {
    expect(intersect([seg(0, 10, 1)], [seg(10, 20, 1)])).toEqual([]);
    expect(intersect([seg(0, 10, 1)], [])).toEqual([]);
  });

  it('keeps the overlap with the minimum capacity', () => {
    expect(intersect([seg(0, 10, 5)], [seg(4, 20, 2)])).toEqual([seg(4, 10, 2)]);
  });

  it('handles a nested segment', () => {
    expect(intersect([seg(0, 100, 3)], [seg(10, 20, 9)])).toEqual([seg(10, 20, 3)]);
  });

  it('walks several segments on both sides', () => {
    const a: Timeline = [seg(0, 10, 2), seg(20, 30, 4)];
    const b: Timeline = [seg(5, 25, 3)];
    expect(intersect(a, b)).toEqual([seg(5, 10, 2), seg(20, 25, 3)]);
  });

  it('is idempotent on itself', () => {
    const a: Timeline = [seg(0, 10, 2), seg(20, 30, 4)];
    expect(intersect(a, a)).toEqual(a);
  });
});

describe('subtract', () => {
  it('leaves the minuend untouched when nothing overlaps', () => {
    expect(subtract([seg(0, 10, 2)], [seg(20, 30, 1)])).toEqual([seg(0, 10, 2)]);
    expect(subtract([seg(0, 10, 2)], [])).toEqual([seg(0, 10, 2)]);
  });

  it('lowers the capacity inside the overlap', () => {
    expect(subtract([seg(0, 10, 3)], [seg(4, 6, 1)])).toEqual([
      seg(0, 4, 3),
      seg(4, 6, 2),
      seg(6, 10, 3),
    ]);
  });

  it('floors at zero and drops the emptied piece', () => {
    expect(subtract([seg(0, 10, 1)], [seg(4, 6, 9)])).toEqual([seg(0, 4, 1), seg(6, 10, 1)]);
  });

  it('empties the timeline when subtracting itself', () => {
    const a: Timeline = [seg(0, 10, 2), seg(20, 30, 4)];
    expect(subtract(a, a)).toEqual([]);
  });

  it('applies several holes to one segment', () => {
    expect(subtract([seg(0, 100, 1)], [seg(10, 20, 1), seg(30, 40, 1), seg(90, 200, 1)])).toEqual([
      seg(0, 10, 1),
      seg(20, 30, 1),
      seg(40, 90, 1),
    ]);
  });

  it('handles a hole that starts before and ends after the segment', () => {
    expect(subtract([seg(10, 20, 2)], [seg(0, 100, 1)])).toEqual([seg(10, 20, 1)]);
  });

  it('handles touching, non-overlapping holes', () => {
    expect(subtract([seg(0, 10, 1)], [seg(10, 20, 1)])).toEqual([seg(0, 10, 1)]);
    expect(subtract([seg(10, 20, 1)], [seg(0, 10, 1)])).toEqual([seg(10, 20, 1)]);
  });
});

describe('kOfN', () => {
  const a: Timeline = [seg(0, 10, 1)];
  const b: Timeline = [seg(5, 15, 1)];
  const c: Timeline = [seg(8, 20, 1)];

  it('is empty without timelines or when k exceeds their number', () => {
    expect(kOfN([], 1, 1)).toEqual([]);
    expect(kOfN([a, b], 3, 1)).toEqual([]);
  });

  it('counts how many timelines clear the threshold', () => {
    expect(kOfN([a, b, c], 1, 1)).toEqual([
      seg(0, 5, 1),
      seg(5, 8, 2),
      seg(8, 10, 3),
      seg(10, 15, 2),
      seg(15, 20, 1),
    ]);
  });

  it('with k = 1 covers the same instants as the boolean union', () => {
    // The capacity (how many timelines match) still varies inside the covered range.
    expect(kOfN([a, b], 1, 1)).toEqual([seg(0, 5, 1), seg(5, 10, 2), seg(10, 15, 1)]);
    expect(footprint(kOfN([a, b], 1, 1))).toEqual([[0, 15]]);
  });

  it('with k = n covers the same instants as the boolean intersection', () => {
    expect(footprint(kOfN([a, b], 2, 1))).toEqual([[5, 10]]);
  });

  it('ignores timelines below minCapacity', () => {
    const thin: Timeline = [seg(0, 10, 1)];
    const thick: Timeline = [seg(0, 10, 4)];
    expect(kOfN([thin, thick], 1, 3)).toEqual([seg(0, 10, 1)]);
    expect(kOfN([thin, thick], 2, 3)).toEqual([]);
    expect(kOfN([thin, thick], 2, 1)).toEqual([seg(0, 10, 2)]);
  });

  it('rejects k or minCapacity below one', () => {
    expect(() => kOfN([a], 0, 1)).toThrow(RangeError);
    expect(() => kOfN([a], 1, 0)).toThrow(RangeError);
    expect(() => kOfN([a], 1.5, 1)).toThrow(RangeError);
  });
});

describe('erode', () => {
  it('widens every segment by one millisecond with zero parameters', () => {
    // With no duration and no buffers the end of a segment is itself a legal (degenerate)
    // start, so the closed set of admissible starts is one millisecond wider.
    expect(erode([seg(0, 10, 2), seg(20, 30, 1)], 0, 0, 0)).toEqual([
      seg(0, 11, 2),
      seg(20, 31, 1),
    ]);
    expect(erode([], 0, 0, 0)).toEqual([]);
  });

  it('cuts the buffer before from the start and the duration plus buffer after from the end', () => {
    expect(erode([seg(0, 100, 1)], 10, 30, 20)).toEqual([seg(10, 51, 1)]);
  });

  it('drops a segment that no longer fits', () => {
    expect(erode([seg(0, 10, 1), seg(20, 100, 1)], 0, 30, 0)).toEqual([seg(20, 71, 1)]);
  });

  it('preserves capacity', () => {
    expect(erode([seg(0, 100, 7)], 5, 5, 5)).toEqual([seg(5, 91, 7)]);
  });

  it('keeps the exact-fit start', () => {
    // A 60 minute service on a 60 millisecond-wide window: the single admissible start is
    // the beginning of the window, and it must survive, because a booking that starts there
    // ends exactly at the end of the window.
    expect(erode([seg(0, 60, 1)], 0, 60, 0)).toEqual([seg(0, 1, 1)]);
    expect(discretize(erode([seg(0, 60, 1)], 0, 60, 0), 60, { kind: 'segment_start' })).toEqual([
      { at: 0, capacity: 1 },
    ]);
  });

  it('drops a segment one millisecond too short for the booking', () => {
    expect(erode([seg(0, 59, 1)], 0, 60, 0)).toEqual([]);
  });

  it('gives a 09:00-19:00 schedule ten hourly starts, the last at 18:00', () => {
    // The canonical case: ten hourly starts, not nine, because 18:00 is itself a legal start.
    const nineToSeven: Timeline = [seg(9 * HOUR, 19 * HOUR, 1)];
    const starts = discretize(erode(nineToSeven, 0, HOUR, 0), HOUR, { kind: 'epoch' });
    expect(starts).toHaveLength(10);
    expect(starts[0]!.at).toBe(9 * HOUR);
    expect(starts[9]!.at).toBe(18 * HOUR);
  });

  it('resolves the one millisecond overlap of touching segments in favour of the higher capacity', () => {
    // [0,10) at 2 and [10,20) at 5 erode to [0,11) and [10,21): at instant 10 both are on
    // offer and 5 is the answer.
    expect(erode([seg(0, 10, 2), seg(10, 20, 5)], 0, 0, 0)).toEqual([
      seg(0, 10, 2),
      seg(10, 21, 5),
    ]);
    expect(erode([seg(0, 10, 5), seg(10, 20, 2)], 0, 0, 0)).toEqual([
      seg(0, 11, 5),
      seg(11, 21, 2),
    ]);
  });

  it('leaves no overlap as soon as the booking has any length at all', () => {
    expect(erode([seg(0, 10, 2), seg(10, 20, 5)], 0, 1, 0)).toEqual([
      seg(0, 10, 2),
      seg(10, 20, 5),
    ]);
  });

  it('resolves the overlap across three or more consecutive segments', () => {
    // Rising capacities: each segment wins the millisecond it shares with its predecessor.
    expect(erode([seg(0, 1, 3), seg(1, 2, 5), seg(2, 3, 1)], 0, 0, 0)).toEqual([
      seg(0, 1, 3),
      seg(1, 3, 5),
      seg(3, 4, 1),
    ]);
    // A one millisecond dip between two higher segments: the dip is squeezed out entirely
    // and the two neighbours fuse. This is the branch that drops an already pushed segment.
    expect(erode([seg(0, 1, 5), seg(1, 2, 1), seg(2, 3, 5)], 0, 0, 0)).toEqual([seg(0, 4, 5)]);
  });

  it('rejects an eroded end past the safe integer range', () => {
    // The closed end pushes one millisecond beyond the input; the normal form is an
    // invariant, so leaving the exact integer domain is an error, not a silent violation.
    expect(() => erode([seg(0, Number.MAX_SAFE_INTEGER, 1)], 0, 0, 0)).toThrow(RangeError);
  });

  it('rejects negative parameters', () => {
    expect(() => erode([seg(0, 10, 1)], -1, 0, 0)).toThrow(RangeError);
    expect(() => erode([seg(0, 10, 1)], 0, -1, 0)).toThrow(RangeError);
    expect(() => erode([seg(0, 10, 1)], 0, 0, -1)).toThrow(RangeError);
  });
});

describe('discretize', () => {
  it('returns nothing for an empty timeline', () => {
    expect(discretize([], 10, { kind: 'epoch' })).toEqual([]);
  });

  it('places instants on the epoch grid', () => {
    expect(discretize([seg(3, 25, 2)], 10, { kind: 'epoch' })).toEqual([
      { at: 10, capacity: 2 },
      { at: 20, capacity: 2 },
    ]);
  });

  it('honours an epoch offset', () => {
    expect(discretize([seg(0, 25, 1)], 10, { kind: 'epoch', offsetMs: 5 })).toEqual([
      { at: 5, capacity: 1 },
      { at: 15, capacity: 1 },
    ]);
  });

  it('places instants from each segment start', () => {
    expect(discretize([seg(3, 25, 1)], 10, { kind: 'segment_start' })).toEqual([
      { at: 3, capacity: 1 },
      { at: 13, capacity: 1 },
      { at: 23, capacity: 1 },
    ]);
  });

  it('clamps a negative segment_start offset back inside the segment', () => {
    expect(discretize([seg(0, 25, 1)], 10, { kind: 'segment_start', offsetMs: -15 })).toEqual([
      { at: 5, capacity: 1 },
      { at: 15, capacity: 1 },
    ]);
  });

  it('excludes the segment end', () => {
    expect(discretize([seg(0, 20, 1)], 10, { kind: 'epoch' })).toEqual([
      { at: 0, capacity: 1 },
      { at: 10, capacity: 1 },
    ]);
  });

  it('produces nothing for a segment shorter than the grid step', () => {
    expect(discretize([seg(1, 9, 1)], 10, { kind: 'epoch' })).toEqual([]);
  });

  it('rejects a non-positive interval', () => {
    expect(() => discretize([seg(0, 10, 1)], 0, { kind: 'epoch' })).toThrow(RangeError);
    expect(() => discretize([seg(0, 10, 1)], -5, { kind: 'epoch' })).toThrow(RangeError);
  });

  it('throws past maxInstants and stays silent below it', () => {
    const wide: Timeline = [seg(0, 1000, 1)];
    expect(discretize(wide, 10, { kind: 'epoch' }, 100)).toHaveLength(100);
    expect(() => discretize(wide, 10, { kind: 'epoch' }, 99)).toThrow(RangeError);
    expect(() => discretize(wide, 10, { kind: 'epoch' }, 0)).toThrow(RangeError);
    // Counted across every segment, not per segment.
    expect(() => discretize([seg(0, 20, 1), seg(100, 120, 1)], 10, { kind: 'epoch' }, 3)).toThrow(
      RangeError,
    );
  });

  it('stays aligned with an offset far outside the safe subtraction range', () => {
    // `offsetMs` and `segment.start` are each safe integers but their difference need not be:
    // both are reduced modulo the interval before subtracting.
    const instants = discretize([seg(-1000, 1000, 1)], 100, {
      kind: 'epoch',
      offsetMs: Number.MAX_SAFE_INTEGER,
    });
    const phase = ((Number.MAX_SAFE_INTEGER % 100) + 100) % 100;
    for (const instant of instants) {
      expect(((instant.at % 100) + 100) % 100).toBe(phase);
    }
    expect(instants.length).toBeGreaterThan(0);
  });

  it('uses offsetMs whole for segment_start and modulo the interval for epoch', () => {
    // Documented asymmetry: `epoch` names a phase on an infinite grid, `segment_start` names
    // a delay from the segment start.
    expect(discretize([seg(0, 1000, 1)], 100, { kind: 'epoch', offsetMs: 250 })).toEqual(
      discretize([seg(0, 1000, 1)], 100, { kind: 'epoch', offsetMs: 50 }),
    );
    expect(
      discretize([seg(0, 500, 1)], 100, { kind: 'segment_start', offsetMs: 250 }).map((i) => i.at),
    ).toEqual([250, 350, 450]);
    expect(
      discretize([seg(0, 500, 1)], 100, { kind: 'segment_start', offsetMs: -250 }).map((i) => i.at),
    ).toEqual([50, 150, 250, 350, 450]);
  });

  it('rejects a malformed maxInstants', () => {
    expect(() => discretize([seg(0, 10, 1)], 5, { kind: 'epoch' }, -1)).toThrow(RangeError);
    expect(() => discretize([seg(0, 10, 1)], 5, { kind: 'epoch' }, 1.5)).toThrow(RangeError);
  });
});

describe('clip', () => {
  const a: Timeline = [seg(0, 10, 1), seg(20, 30, 2)];

  it('keeps only what is inside the window', () => {
    expect(clip(a, 5, 25)).toEqual([seg(5, 10, 1), seg(20, 25, 2)]);
  });

  it('is the identity for a window that contains everything', () => {
    expect(clip(a, -100, 100)).toEqual(a);
  });

  it('is empty for a window that touches nothing', () => {
    expect(clip(a, 10, 20)).toEqual([]);
    expect(clip(a, 100, 200)).toEqual([]);
  });

  it('is empty for an empty or inverted window', () => {
    expect(clip(a, 10, 10)).toEqual([]);
    expect(clip(a, 20, 10)).toEqual([]);
  });
});
