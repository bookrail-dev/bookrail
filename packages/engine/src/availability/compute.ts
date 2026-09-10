/**
 * The availability computation: pure, no I/O, no clock.
 *
 * `computeAvailability` is the second half of the engine. The first half,
 * `loadAvailabilityData` in `./load.js`, reads Postgres and hands over an
 * {@link AvailabilityData}; everything here is a function of that value and of the query,
 * which is what makes the whole computation reproducible from a fixture and testable
 * without a database.
 *
 * The pipeline, in order:
 *
 * 1. the window is trimmed by `now + min_notice` and `now + max_advance`, and a request
 *    wider than 90 days is refused with `range_too_large`, so a caller who wants a year
 *    paginates in time instead of asking for it in one call;
 * 2. every candidate resource is materialized into its open timeline (rules, exceptions,
 *    blocks, by `materializeSchedule`) and the occupancies are subtracted with
 *    their capacity, leaving the **residual capacity** timeline of that resource;
 * 3. each requirement is reduced to a timeline whose capacity is the largest quantity that
 *    requirement can serve at that instant;
 * 4. the requirements are intersected (`intersect` keeps the minimum, which is exactly the
 *    quantity the whole service can serve);
 * 5. the result is thresholded at the requested quantity, flattened to a mask and eroded by
 *    `buffer_before + duration + buffer_after`, giving the admissible **start** instants;
 * 6. the mask is discretized on the local clock, or, for `granularity: 'ranges'`, the
 *    timeline **before** the erosion is returned as continuous ranges (an eroded timeline is a
 *    set of admissible starts, not bookable time);
 * 7. the customer limit is applied;
 * 8. the price of the service is stamped on every slot;
 * 9. up to five concrete resource combinations are attached to each slot;
 * 10. with `explain`, every candidate instant that did **not** make it into the result is
 *     returned with structured reasons.
 *
 * Instants are epoch milliseconds throughout. Turning them into ISO strings is the API's
 * job, as is turning the `BookrailError`s thrown here into HTTP responses.
 */
import { errors, type PriceRuleRef, type PricingRule } from '@bookrail/shared';

import { priceForSlot, priceRuleOf, type SlotPrice } from './pricing.js';
import {
  materializeSchedule,
  zoneOffsetMs,
  type ScheduleException,
  type ScheduleRule,
} from '../schedule/index.js';
import {
  clip,
  discretize,
  erode,
  intersect,
  normalize,
  subtract,
  type DiscreteInstant,
  type Segment,
  type Timeline,
} from '../timeline/index.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Widest window a single availability request may cover; past it, a caller paginates in time. */
export const MAX_RANGE_DAYS = 90;

/** Default ceiling on the instants a single request may produce. */
export const DEFAULT_MAX_INSTANTS = 50_000;

/** Default ceiling on the number of discarded instants `explain` reports. */
export const DEFAULT_MAX_EXPLAIN_INSTANTS = 500;

// --- Input -------------------------------------------------------------------------------

export type Granularity = 'slots' | 'ranges';
export type AlignTo = 'hour' | 'half_hour' | 'schedule_start';
export type AllocationStrategy = 'least_busy' | 'round_robin' | 'first_available' | 'priority';
export type OccupancyKind = 'booking' | 'hold' | 'block';

/**
 * `service_requirements.consumes`, added by migration 0009.
 *
 * `per_unit` means the requirement takes `quantity` units of the resource: the room, the
 * table, the class. `whole` means it takes the resource entirely whatever the quantity is:
 * the instructor, the doctor, the ultrasound machine. A `whole` requirement is satisfied only by
 * a resource that is completely free, and it puts no ceiling of its own on the quantity.
 */
export type ConsumesMode = 'per_unit' | 'whole';

/**
 * The capacity a `whole` requirement contributes to the intersection.
 *
 * A `whole` requirement does not bound the quantity (it takes the resource entirely for one
 * unit as for fifteen), so it has to be neutral for `intersect`, which keeps the minimum.
 * A slot whose capacity is still this value after the intersection has no requirement
 * bounding it at all; {@link reportedCapacity} turns it back into a finite number.
 */
export const UNBOUNDED_CAPACITY = Number.MAX_SAFE_INTEGER;

/**
 * `services.booking_window`, in minutes and days.
 *
 * It was first designed as a pair of duration strings, `{min_notice: "2h", max_advance: "60d"}`;
 * the stored shape is two numbers, so that neither the engine nor the API has to parse a
 * duration string on the hot path.
 */
export interface BookingWindow {
  readonly minNoticeMinutes?: number | null;
  readonly maxAdvanceDays?: number | null;
}

export interface Price {
  readonly amount: number;
  readonly currency: string;
}

/** The bookable service, mirroring the columns of `services`. */
export interface ServiceData {
  readonly id: string;
  readonly durationMinutes: number | null;
  readonly durationOptions: readonly number[] | null;
  readonly durationMinMinutes: number | null;
  readonly durationMaxMinutes: number | null;
  /** Units of capacity a booking consumes when the caller does not pass a quantity. */
  readonly capacityPerBooking: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly slotIntervalMinutes: number | null;
  readonly alignTo: AlignTo | null;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  /**
   * `services.pricing_rules`, in order. Evaluated by {@link priceForSlot}: the first rule that
   * matches replaces the flat price, and the rules never compose. Empty on every service that has
   * never used them, which is the state of the whole estate. A `null` entry is a stored rule the
   * schema refuses: it is skipped, and it keeps its position so that the indices the API reports
   * stay the indices of the column (`load.ts`).
   */
  readonly pricingRules: readonly (PricingRule | null)[];
  readonly bookingWindow: BookingWindow | null;
  readonly bufferSharing: boolean;
  readonly allowSplit: boolean;
}

/**
 * One active `occupancies` row, already absolute.
 *
 * `start`/`end` are the **core** period, without buffers; the buffers the row carries are
 * `bufferBeforeMs`/`bufferAfterMs` (migration 0009) and belong to the service that created
 * the occupancy, not to the service currently asking. A `block` carries none: a closure is
 * not a booking. See {@link occupancyFootprint}.
 */
export interface OccupancyData {
  readonly id: string;
  readonly resourceId: string;
  readonly start: number;
  readonly end: number;
  readonly capacityUsed: number;
  readonly kind: OccupancyKind;
  /** The booking, hold or block the occupancy belongs to. */
  readonly refId: string;
  readonly bufferBeforeMs: number;
  readonly bufferAfterMs: number;
}

/** A candidate resource with everything needed to build its timeline. */
export interface ResourceData {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  /** `schedules.timezone`, else `locations.timezone`. Resolved by the loader. */
  readonly timezone: string;
  readonly rules: readonly ScheduleRule[];
  readonly exceptions: readonly ScheduleException[];
  /**
   * Every active occupancy of the resource, blocks included.
   *
   * Blocks are **not** read from `resource_blocks` any more: `occupancies` is the single
   * source of truth for what takes a resource away,
   * and `POST /v1/resources/{id}/block` already writes a `kind = 'block'` row for every
   * block. `resource_blocks` stays as the catalogue entry the block id points at.
   */
  readonly occupancies: readonly OccupancyData[];
}

/** One `service_requirements` row with its group already resolved into member resources. */
export interface RequirementData {
  readonly id: string;
  /** How many distinct resources of the group the service needs at once. */
  readonly quantity: number;
  /** Units of the chosen resource the requirement takes. See {@link ConsumesMode}. */
  readonly consumes: ConsumesMode;
  readonly role: string | null;
  readonly resourceGroupId: string | null;
  readonly allocationStrategy: AllocationStrategy;
  /** Candidate resource ids, already ordered by member priority and then by id. */
  readonly resourceIds: readonly string[];
}

export interface PolicyData {
  readonly id: string;
  readonly maxActiveBookingsPerCustomer: number | null;
}

/** Everything `loadAvailabilityData` reads, and everything `computeAvailability` needs. */
export interface AvailabilityData {
  readonly service: ServiceData;
  readonly requirements: readonly RequirementData[];
  readonly resources: readonly ResourceData[];
  readonly policy: PolicyData | null;
  /** Active bookings of the customer, `null` when the query carried no customer. */
  readonly customerActiveBookings: number | null;
  /**
   * Indices of the `services.pricing_rules` entries the strict schema refused, in column order.
   *
   * The loader skips them and keeps their position, so a price is still produced by the next
   * rule that matches; `explain` reports them as `pricing_rule_ignored` so that a rule which
   * silently stopped applying is visible to whoever asks why a slot costs what it costs.
   */
  readonly ignoredPricingRules: readonly number[];
  /**
   * Zone the slot grid is aligned to when `align_to` is `hour` or `half_hour`. The loader
   * takes it from the first candidate resource; it is a property of the offer, never of the
   * customer: availability is computed in the resource's zone, and only presented in whatever
   * zone the caller asks for.
   */
  readonly timezone: string;
}

export interface ComputeAvailabilityInput {
  readonly data: AvailabilityData;
  /** Requested window, epoch milliseconds, `[from, to)` over the **start** of the booking. */
  readonly from: number;
  readonly to: number;
  /** Units of capacity requested; defaults to the service's `capacity_per_booking`. */
  readonly quantity?: number | null;
  readonly granularity?: Granularity;
  readonly explain?: boolean;
  /** The instant the request is evaluated at. Explicit: the engine never reads the clock. */
  readonly now: number;
  readonly maxInstants?: number;
  readonly maxExplainInstants?: number;
  /** Passed through to `materializeSchedule`. */
  readonly maxDays?: number;
  /**
   * Open timelines already materialized for some resources, by resource id.
   *
   * This is the seam the cache plugs into: the three layers are a function of the resource,
   * the zone and the window alone (never of `now`, of the customer or of the occupancies),
   * so they can be assembled from per (resource, local day) cache entries and handed over
   * here. A resource absent from the map is materialized as usual. The caller is
   * responsible for the window: what it passes must cover
   * {@link materializationWindow} for this service and request, clipped to it.
   */
  readonly openTimelines?: ReadonlyMap<string, ResourceOpenTimelines>;
  /**
   * Explicit candidate instants, replacing the grid derived from the opening bands.
   *
   * `POST /v1/availability/check` asks about one instant that the caller already holds, and
   * it must get a structured answer even when that instant is not on the service's grid:
   * outside the schedule is precisely the interesting case. Supplying the candidates keeps
   * slots and `explain` reporting on the same set, which is the invariant the grid exists to
   * maintain. Instants outside `[from, to)` are ignored.
   */
  readonly candidates?: readonly number[];
}

// --- Output ------------------------------------------------------------------------------

export interface ResourceAllocation {
  readonly resourceId: string;
  readonly role: string | null;
  readonly capacityUsed: number;
}

/** One way of satisfying every requirement at a given instant. */
export interface ResourceOption {
  readonly resources: readonly ResourceAllocation[];
}

export interface AvailabilitySlot {
  readonly start: number;
  readonly end: number;
  /** Fixed duration of a discrete slot; `null` for a `ranges` entry. */
  readonly durationMinutes: number | null;
  /** `ranges` only: shortest bookable length inside `[start, end)`. */
  readonly minDurationMinutes?: number;
  /** `ranges` only: longest bookable length inside `[start, end)`. */
  readonly maxDurationMinutes?: number;
  readonly availableCapacity: number;
  readonly price: Price | null;
  /**
   * Which `pricing_rules` entry produced {@link price}, or `null` for the flat service price.
   *
   * It is on every slot, not only under `explain`: a caller that shows a surcharge has to be
   * able to name it, and a caller that does not can ignore the field.
   */
  readonly priceRule: PriceRuleRef | null;
  readonly resourceOptions: readonly ResourceOption[];
}

export type ExplainCode =
  | 'outside_schedule'
  | 'exception_closed'
  | 'blocked'
  | 'occupied'
  | 'buffer'
  | 'min_notice'
  | 'max_advance'
  | 'capacity'
  | 'customer_limit';

export interface ExplainReason {
  readonly code: ExplainCode;
  readonly resourceId?: string;
  /** The booking, hold, block or exception the reason points at, when there is one. */
  readonly refId?: string;
  readonly detail: string;
}

export interface ExplainEntry {
  readonly at: number;
  readonly reasons: readonly ExplainReason[];
}

/** Codes of an {@link ExplainNote}: about the data of the request, not about one instant. */
export type ExplainNoteCode = 'pricing_rule_ignored';

/**
 * Something `explain` has to say about the whole answer rather than about a rejected instant.
 *
 * An {@link ExplainEntry} answers "why is this instant not offered". A note answers "what did
 * the engine have to ignore to answer at all", which has no instant to hang on: a stored
 * pricing rule the schema refuses is skipped for every slot at once.
 */
export interface ExplainNote {
  readonly code: ExplainNoteCode;
  /** Position in `services.pricing_rules` of the rule the note is about. */
  readonly index: number;
  readonly detail: string;
}

export interface AvailabilityReason {
  readonly code: string;
  readonly detail: string;
}

export interface AvailabilityResult {
  readonly slots: readonly AvailabilitySlot[];
  readonly nextAvailable: number | null;
  readonly reason?: AvailabilityReason;
  readonly explain?: readonly ExplainEntry[];
  /** Present with `explain`, empty when there was nothing to report. */
  readonly explainNotes?: readonly ExplainNote[];
  /** True when `explain` hit its ceiling and some discarded instants are missing. */
  readonly truncated?: boolean;
}

// --- Timeline helpers --------------------------------------------------------------------

/**
 * Every segment at capacity 1.
 *
 * Erosion cannot see across a segment boundary, so a footprint that spans two segments of
 * different capacity would be thrown away even when both clear the threshold. Flattening
 * the capacity first lets `normalize` fuse the neighbours into one segment; the capacity a
 * slot really offers is recovered afterwards with {@link minCapacityOver}.
 *
 * The input is normalized before flattening, so overlapping input never adds up to 2.
 */
function mask(timeline: Timeline): Timeline {
  return normalize(
    normalize(timeline).map((segment) => ({
      start: segment.start,
      end: segment.end,
      capacity: 1,
    })),
  );
}

/** Keeps only the segments that can serve `quantity` units; capacities are preserved. */
function atLeast(timeline: Timeline, quantity: number): Timeline {
  return timeline.filter((s) => s.capacity >= quantity);
}

/**
 * The view a `whole` requirement has of a resource: only the stretches where **nothing** is
 * taken, at {@link UNBOUNDED_CAPACITY}.
 *
 * The input is a residual timeline (or an eroded one, in which case each segment already
 * carries the smallest capacity over the whole booking footprint), so a capacity equal to the
 * resource's own is exactly "completely free for the whole time".
 */
function wholeOnly(timeline: Timeline, capacity: number): Timeline {
  return normalize(
    timeline
      .filter((segment) => segment.capacity >= capacity)
      .map((segment) => ({
        start: segment.start,
        end: segment.end,
        capacity: UNBOUNDED_CAPACITY,
      })),
  );
}

/**
 * The capacity a slot reports.
 *
 * When every requirement of the service is `whole`, nothing bounds the quantity and the
 * intersection is still {@link UNBOUNDED_CAPACITY}; reporting that number would be true but
 * useless, so the slot reports the quantity that was asked for, which is, exactly, what it
 * can serve.
 */
function reportedCapacity(raw: number, quantity: number): number {
  return raw >= UNBOUNDED_CAPACITY ? quantity : raw;
}

/** Index of the first segment whose `end` is strictly after `at`. */
function indexAt(timeline: Timeline, at: number): number {
  let lo = 0;
  let hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid]!.end <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Smallest capacity offered across the whole of `[start, end)`, or `0` if any part of it is
 * not covered. This is the capacity a booking occupying that window would really find: a
 * segmented timeline can change capacity in the middle of a booking, and `erode` alone
 * cannot see across a segment boundary.
 */
export function minCapacityOver(timeline: Timeline, start: number, end: number): number {
  if (end <= start) {
    const segment = timeline[indexAt(timeline, start)];
    return segment !== undefined && segment.start <= start ? segment.capacity : 0;
  }
  let i = indexAt(timeline, start);
  let cursor = start;
  let smallest = Number.POSITIVE_INFINITY;
  while (cursor < end) {
    const segment = timeline[i];
    if (segment === undefined || segment.start > cursor) return 0;
    if (segment.capacity < smallest) smallest = segment.capacity;
    cursor = segment.end;
    i += 1;
  }
  return smallest === Number.POSITIVE_INFINITY ? 0 : smallest;
}

/**
 * The largest quantity a requirement can serve, instant by instant.
 *
 * Without `split` the answer is the `quantity`-th largest residual capacity among the
 * candidate resources: at least `quantity` of them must carry the whole booking on their
 * own. Thresholded at `Q` this is exactly `kOfN(timelines, quantity, Q)` restricted to its
 * support: `kOfN` returns the *count* of resources over the threshold, which is the right
 * answer to "is it feasible?" but throws away the capacity the slot should report, so the
 * engine computes the order statistic instead and the property suite checks the two agree.
 *
 * With `split` (eight people over two tables of four) the capacities are summed instead
 * (the union of the group's timelines), provided at least `quantity` resources are open at
 * all.
 */
export function requirementCapacity(
  timelines: readonly Timeline[],
  quantity: number,
  split: boolean,
): Timeline {
  if (timelines.length === 0 || quantity < 1) return [];
  const boundaries = new Set<number>();
  for (const timeline of timelines) {
    for (const segment of timeline) {
      boundaries.add(segment.start);
      boundaries.add(segment.end);
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const cursors = new Array<number>(timelines.length).fill(0);
  const out: Segment[] = [];

  for (let p = 0; p + 1 < points.length; p += 1) {
    const start = points[p]!;
    const end = points[p + 1]!;
    const capacities: number[] = [];
    let sum = 0;
    for (let k = 0; k < timelines.length; k += 1) {
      const timeline = timelines[k]!;
      let i = cursors[k]!;
      while (i < timeline.length && timeline[i]!.end <= start) i += 1;
      cursors[k] = i;
      const segment = timeline[i];
      const capacity = segment !== undefined && segment.start <= start ? segment.capacity : 0;
      if (capacity > 0) {
        capacities.push(capacity);
        sum += capacity;
      }
    }
    if (capacities.length < quantity) continue;
    let value: number;
    if (split) {
      value = sum;
    } else {
      capacities.sort((a, b) => b - a);
      value = capacities[quantity - 1]!;
    }
    if (value > 0) out.push({ start, end, capacity: value });
  }
  return normalize(out);
}

/**
 * The admissible **start** instants of one resource, carrying the capacity that resource
 * really offers across the whole booking window.
 *
 * This is `erode` with a memory. `erode` shrinks each segment on its own, so a footprint
 * that spans a capacity change is dropped even when both sides clear the threshold, and,
 * far worse, the combination of several resources must never be eroded as if it were one:
 * two resources open 02:00-03:00 and 03:00-04:00 do **not** let anyone book 02:00-03:30.
 * Erosion therefore happens **per resource, before** the group is combined, and what it
 * returns at instant `t` is the smallest capacity the resource offers anywhere in
 * `[t - before, t + duration + after)`.
 *
 * On a mask its support is exactly `erode`'s, closed upper end included; the property suite
 * checks that. The breakpoints are the instants at which a boundary of the input enters or
 * leaves the sliding window; a few extra ones cost nothing, because `normalize` fuses the
 * pieces back together.
 */
export function erodeCapacity(
  timeline: Timeline,
  before: number,
  duration: number,
  after: number,
): Timeline {
  if (timeline.length === 0) return [];
  const width = before + duration + after;
  const cuts = new Set<number>();
  for (const segment of timeline) {
    for (const point of [segment.start, segment.end]) {
      cuts.add(point - width);
      cuts.add(point - width + 1);
      cuts.add(point);
      cuts.add(point + 1);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const from = sorted[i]!;
    const capacity = minCapacityOver(timeline, from, from + width);
    if (capacity > 0) {
      out.push({ start: from + before, end: sorted[i + 1]! + before, capacity });
    }
  }
  return normalize(out);
}

/**
 * The maximal intervals a requirement can serve end to end, for `granularity: 'ranges'`.
 *
 * A range is not a pointwise property: an interval is bookable only if the **same** `k`
 * resources cover the whole of it. A maximal such interval starts where one of the covering
 * segments starts, and ends at the `k`-th largest of the ends of the segments covering that
 * start, which is what this walks, one candidate start at a time.
 *
 * With `split` the group may pool its capacity, so the end is the furthest instant at which
 * the resources still covering the interval add up to `quantity`.
 */
export function requirementRanges(
  timelines: readonly Timeline[],
  quantity: number,
  split: boolean,
  needed: number,
): Segment[] {
  const eligible = split ? timelines : timelines.map((t) => t.filter((s) => s.capacity >= needed));
  const starts = new Set<number>();
  for (const timeline of eligible) for (const segment of timeline) starts.add(segment.start);

  const found: Segment[] = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const covering: { end: number; capacity: number }[] = [];
    for (const timeline of eligible) {
      const segment = timeline[indexAt(timeline, start)];
      if (segment !== undefined && segment.start <= start) {
        covering.push({ end: segment.end, capacity: segment.capacity });
      }
    }
    if (covering.length < quantity) continue;
    covering.sort((a, b) => b.end - a.end);
    let end: number;
    let capacity: number;
    if (split) {
      let sum = 0;
      let index = -1;
      for (let i = 0; i < covering.length; i += 1) {
        sum += covering[i]!.capacity;
        if (sum >= needed && i + 1 >= quantity) {
          index = i;
          break;
        }
      }
      if (index === -1) continue;
      end = covering[index]!.end;
      capacity = sum;
    } else {
      end = covering[quantity - 1]!.end;
      capacity = covering
        .slice(0, quantity)
        .reduce((least, one) => Math.min(least, one.capacity), Number.POSITIVE_INFINITY);
    }
    if (end > start) found.push({ start, end, capacity });
  }
  // Drop the intervals another one already contains: only the maximal ones are ranges.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Segment[] = [];
  for (const candidate of found) {
    const last = out[out.length - 1];
    if (last !== undefined && last.start <= candidate.start && last.end >= candidate.end) continue;
    out.push(candidate);
  }
  return out;
}

/** Intersection of two range families: every overlap, with the smaller capacity. */
function intersectRanges(a: readonly Segment[], b: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (start < end) out.push({ start, end, capacity: Math.min(left.capacity, right.capacity) });
    }
  }
  out.sort((x, y) => x.start - y.start || y.end - x.end);
  const kept: Segment[] = [];
  for (const candidate of out) {
    const last = kept[kept.length - 1];
    if (last !== undefined && last.start <= candidate.start && last.end >= candidate.end) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * The instants inside `[from, to)` at which the zone's UTC offset changes.
 *
 * Sampled once a day and then bisected to the millisecond. One sample a day is enough
 * because no IANA zone has ever put two transitions inside twenty-four hours, and it keeps
 * the cost at roughly a hundred `Temporal` conversions for a ninety day window instead of
 * one per hour.
 */
export function offsetChangePoints(timezone: string, from: number, to: number): number[] {
  const points: number[] = [];
  const last = to - 1;
  if (last <= from) return points;
  let at = from;
  let offset = zoneOffsetMs(timezone, at);
  while (at < last) {
    const next = Math.min(at + DAY_MS, last);
    const nextOffset = zoneOffsetMs(timezone, next);
    if (nextOffset === offset) {
      at = next;
      continue;
    }
    let lo = at;
    let hi = next;
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (zoneOffsetMs(timezone, mid) === offset) lo = mid;
      else hi = mid;
    }
    points.push(hi);
    at = hi;
    offset = nextOffset;
  }
  return points;
}

/**
 * The instants a booking of `durationMs` could start at, if nothing were taken.
 *
 * The anchor is the union of the resources' opening bands (rules, and rules ⊕ exceptions),
 * never the residual timeline and never the window trimmed by `min_notice`: a closure cuts
 * the grid, it does not move it. Exported because the booking transaction revalidates it on the
 * **write** path: a start the offer would never show must not be bookable, and the only way
 * for the two to agree is for them to be the same function.
 */
export function candidateGrid(
  layers: Iterable<ResourceOpenTimelines>,
  options: {
    readonly service: ServiceData;
    readonly timezone: string;
    readonly durationMs: number;
    /**
     * Step of the grid. **Not** derived from `durationMs`: with `duration_options` the step is
     * the shortest option and the same grid serves every option, so a caller asking about the
     * 60 minute option must still pass the 30 minute step.
     */
    readonly intervalMs: number;
    readonly from: number;
    readonly to: number;
    readonly maxInstants: number;
  },
): number[] {
  const { service } = options;
  const bands: Segment[] = [];
  for (const entry of layers) {
    for (const segment of entry.rulesOnly) bands.push(segment);
    if (entry.withExceptions !== entry.rulesOnly) {
      for (const segment of entry.withExceptions) bands.push(segment);
    }
  }
  const beforeMs = service.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = service.bufferAfterMinutes * MINUTE_MS;
  const starts = clip(
    erode(mask(bands), beforeMs, options.durationMs, afterMs),
    options.from,
    options.to,
  );
  return localAlignedInstants(
    starts,
    options.intervalMs,
    service.alignTo,
    options.timezone,
    options.maxInstants,
  ).map((instant) => instant.at);
}

/**
 * Discretizes a mask of admissible starts, aligning the grid to the **local** clock.
 *
 * `align_to: 'hour'` and `align_to: 'half_hour'` mean "on the local clock", and
 * `discretize`'s `epoch` alignment counts from the Unix epoch, which is on the hour in UTC.
 * The bridge is `offsetMs: -zoneOffsetMs(timezone, at)`, with the minus sign, because a
 * local wall time `w` happens at `w - offset`. The offset changes at a DST transition, so the
 * timeline is cut at every such instant and each piece gets its own alignment.
 *
 * `align_to: 'schedule_start'`, and the absence of `align_to`, both mean "count from the
 * start of the opening band", which is `segment_start` and needs no zone.
 */
export function localAlignedInstants(
  timeline: Timeline,
  intervalMs: number,
  alignTo: AlignTo | null,
  timezone: string,
  maxInstants: number,
): DiscreteInstant[] {
  if (timeline.length === 0) return [];
  if (alignTo !== 'hour' && alignTo !== 'half_hour') {
    return discretize(timeline, intervalMs, { kind: 'segment_start' }, maxInstants);
  }
  const from = timeline[0]!.start;
  const to = timeline[timeline.length - 1]!.end;
  const cuts = [from, ...offsetChangePoints(timezone, from, to), to];
  const out: DiscreteInstant[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    if (end <= start) continue;
    const piece = clip(timeline, start, end);
    if (piece.length === 0) continue;
    const alignment = { kind: 'epoch' as const, offsetMs: -zoneOffsetMs(timezone, start) };
    for (const instant of discretize(piece, intervalMs, alignment, maxInstants - out.length)) {
      out.push(instant);
    }
  }
  return out;
}

// --- Service shape -----------------------------------------------------------------------

/**
 * The durations a request may be offered, ascending.
 *
 * Exported because the API has to know the shape of the grid *before* computing it: the route
 * refuses a window × interval combination that would blow past `maxInstants` with a 400
 * instead of letting `discretize` throw a `RangeError` the client would see as a 500.
 */
export function serviceDurations(service: ServiceData): number[] {
  return durationsOf(service);
}

function durationsOf(service: ServiceData): number[] {
  if (service.durationOptions !== null && service.durationOptions.length > 0) {
    return [...service.durationOptions].sort((a, b) => a - b);
  }
  if (service.durationMinutes !== null) return [service.durationMinutes];
  if (service.durationMinMinutes !== null) return [service.durationMinMinutes];
  throw errors.invalidRequest(
    `Service ${service.id} states no duration; one of duration, duration_options or duration_range is required.`,
    'service_id',
    'service_without_duration',
  );
}

/**
 * Step of the slot grid: `slot_interval`, or the **shortest** duration the service offers.
 * One step serves every duration option.
 */
export function gridIntervalMs(service: ServiceData): number {
  return (service.slotIntervalMinutes ?? durationsOf(service)[0]!) * MINUTE_MS;
}

function maxDurationOf(service: ServiceData): number {
  if (service.durationMaxMinutes !== null) return service.durationMaxMinutes;
  const durations = durationsOf(service);
  return durations[durations.length - 1]!;
}

/** What {@link pricerFor} hands the slot builders: the price of one candidate slot. */
type Pricer = (
  start: number,
  durationMinutes: number,
  options: readonly ResourceOption[],
) => SlotPrice | null;

/**
 * The function that prices a slot, built once per request.
 *
 * **A service with no rules gets a constant**, computed here and shared by every slot, which is
 * what every service in existence looks like today: without the shortcut each slot would build
 * a fresh `{amount, currency}` and walk an empty loop, where before the rules were evaluated the
 * price was one object hoisted out of the loop. The shortcut keeps that exactly.
 *
 * With rules, the resources a rule may look at are those of the **first** resource option,
 * which is the assignment the group's `allocation_strategy` prefers and therefore the one a
 * booking made right now would get. Availability quotes a price; the booking freezes the price
 * of the assignment it actually makes (`packages/engine/src/booking/create.ts`), and the two
 * agree whenever the allocator agrees with itself, which is whenever nothing has moved between
 * the two calls.
 */
function pricerFor(service: ServiceData, timezone: string): Pricer {
  if (service.pricingRules.length === 0) {
    const flat = priceForSlot(service, { startUtc: 0, durationMinutes: 0, resourceIds: [] }, 'UTC');
    return () => flat;
  }
  return (start, durationMinutes, options) =>
    priceForSlot(
      service,
      {
        startUtc: start,
        durationMinutes,
        resourceIds: (options[0]?.resources ?? []).map((allocation) => allocation.resourceId),
      },
      timezone,
    );
}

// --- Per-resource timelines --------------------------------------------------------------

/**
 * The three layers of "when is this resource open", in increasing strictness. They depend on
 * the resource and the window only (not on the service's occupancies, not on `now`, not on
 * the customer), which is why they can be cached per (resource, local day).
 */
export interface ResourceOpenTimelines {
  /** The rules alone: no exceptions. Anchors the slot grid and explains `outside_schedule`. */
  readonly rulesOnly: Timeline;
  /** Rules plus exceptions, at the resource capacity: tells `exception_closed` from `blocked`,
   *  and opens a day that exists only because of an `open` exception. */
  readonly withExceptions: Timeline;
}

/**
 * The layers of one resource, from "when does the calendar say it is open" down to "what is
 * actually left".
 *
 * The block layer is **not** part of {@link ResourceOpenTimelines} any more:
 * the engine reads blocks from `occupancies` (`kind = 'block'`), which live in the other
 * cache family, so `open` is derived here rather than materialized and cached with the
 * schedule.
 */
export interface ResourceTimelines extends ResourceOpenTimelines {
  readonly resource: ResourceData;
  /** Rules, exceptions and the block occupancies. */
  readonly open: Timeline;
  /** `open` minus the occupancies expanded by their own buffers. */
  readonly residual: Timeline;
  /** `open` minus the occupancies **not** expanded: only used to tell `buffer` from `occupied`. */
  readonly residualCore?: Timeline;
}

/**
 * The UTC window the resources have to be materialized over for a request of `[from, to)`.
 *
 * Wider than the request on both sides: a booking that starts just before `to` runs for
 * `duration + buffer_after` past it, and the `buffer_before` of a booking starting at `from`
 * reaches back. Exported because the cache has to fill exactly this window before handing
 * `openTimelines` over, and because a caller that wants to know how much calendar one
 * request really touches should not have to rederive it.
 */
export function materializationWindow(
  service: ServiceData,
  from: number,
  to: number,
): { from: number; to: number } {
  return {
    from: from - service.bufferBeforeMinutes * MINUTE_MS,
    to: to + maxDurationOf(service) * MINUTE_MS + service.bufferAfterMinutes * MINUTE_MS,
  };
}

/**
 * The two open layers of one resource over `[from, to)`.
 *
 * A resource with no exceptions has the same timeline with and without them: the common case
 * costs one materialization, not two, and the identity of the returned references says so to
 * the callers that check it.
 */
export function resourceOpenTimelines(
  resource: ResourceData,
  from: number,
  to: number,
  maxDays?: number,
): ResourceOpenTimelines {
  if (to <= from) return { rulesOnly: [], withExceptions: [] };
  const common = {
    timezone: resource.timezone,
    rules: resource.rules,
    capacity: resource.capacity,
    from,
    to,
    maxDays,
  };
  const rulesOnly = materializeSchedule({ ...common, exceptions: [], blocks: [] });
  const withExceptions =
    resource.exceptions.length === 0
      ? rulesOnly
      : materializeSchedule({ ...common, exceptions: resource.exceptions, blocks: [] });
  return { rulesOnly, withExceptions };
}

/**
 * The timeline the block occupancies of a resource take away.
 *
 * A block is subtracted as it is: it carries no buffer, because a closure is not a booking
 * and a closure has no cleaning time on either side. `POST /v1/resources/{id}/block` writes
 * `capacity_used` equal to the whole capacity of the resource, so subtracting it closes the
 * resource outright.
 */
export function blockTimeline(resource: ResourceData): Timeline {
  const segments: Segment[] = [];
  for (const occupancy of resource.occupancies) {
    if (occupancy.kind !== 'block') continue;
    if (occupancy.end <= occupancy.start) continue;
    segments.push({
      start: occupancy.start,
      end: occupancy.end,
      capacity: occupancy.capacityUsed,
    });
  }
  return normalize(segments);
}

/**
 * All the layers of one resource: the two open ones, the block layer, and the residual.
 *
 * Exported because the booking transaction revalidates exactly what the read
 * engine computed, and reimplementing this by hand there is how the two halves drift apart.
 */
export function resourceTimelines(
  resource: ResourceData,
  layers: ResourceOpenTimelines,
  service: ServiceData,
  options: { readonly withCore?: boolean } = {},
): ResourceTimelines {
  const beforeMs = service.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = service.bufferAfterMinutes * MINUTE_MS;
  const blocks = blockTimeline(resource);
  const open =
    blocks.length === 0 ? layers.withExceptions : subtract(layers.withExceptions, blocks);
  const occupied = occupancyTimeline(resource, beforeMs, afterMs, service.bufferSharing, true);
  return {
    resource,
    rulesOnly: layers.rulesOnly,
    withExceptions: layers.withExceptions,
    open,
    residual: subtract(open, occupied),
    ...(options.withCore === true
      ? {
          residualCore: subtract(
            open,
            occupancyTimeline(resource, beforeMs, afterMs, service.bufferSharing, false),
          ),
        }
      : {}),
  };
}

/**
 * The footprint an existing occupancy takes away from the starts of a new booking.
 *
 * The buffers of the two sides are **not** the same numbers any more (migration 0009): the
 * existing occupancy carries its own, from the service that created it, and `beforeMs` /
 * `afterMs` are those of the service now asking. `buffer_sharing` stays what it always was:
 * a property of the crossing, read from the querying service.
 *
 * Eroding by `[before_new, duration, after_new]` already forces the new booking's own buffers
 * to be free, so subtracting the bare occupancy would leave the two bookings *sharing* that
 * gap. That is exactly `buffer_sharing: true`, except that a shared gap must still never let
 * one booking's buffer eat into the other's core: on the right of the occupancy the gap has
 * to be `max(after_occ, before_new)`, and the erosion already provides `before_new`, so the
 * occupancy is widened by the difference where its own buffer is the longer one. Symmetrical
 * on the left with `max(before_occ, after_new)`.
 *
 * With `buffer_sharing: false` (the default) the two footprints must be disjoint, which means
 * a gap of `after_occ + before_new` on the right: the occupancy is widened by its own buffers
 * on both sides, and the erosion adds the new booking's on top.
 *
 * Blocks are not bookings and carry no buffers: they are subtracted as they are, and the
 * erosion alone keeps the new booking's buffers out of them.
 */
export function occupancyFootprint(
  occupancy: OccupancyData,
  beforeMs: number,
  afterMs: number,
  bufferSharing: boolean,
): { start: number; end: number } {
  if (occupancy.kind === 'block') return { start: occupancy.start, end: occupancy.end };
  if (bufferSharing) {
    return {
      start: occupancy.start - Math.max(0, occupancy.bufferBeforeMs - afterMs),
      end: occupancy.end + Math.max(0, occupancy.bufferAfterMs - beforeMs),
    };
  }
  return {
    start: occupancy.start - occupancy.bufferBeforeMs,
    end: occupancy.end + occupancy.bufferAfterMs,
  };
}

/**
 * The occupancies of a resource, as a timeline, blocks excluded.
 *
 * Blocks are left out because {@link resourceTimelines} has already subtracted them into the
 * `open` layer: counting them again would subtract the same units twice. `subtract` floors at
 * zero and the block route always writes `capacity_used = resources.capacity`, so the second
 * subtraction was invisible, until someone raised the capacity of a blocked resource, at
 * which point the read offered less than the write allowed.
 */
function occupancyTimeline(
  resource: ResourceData,
  beforeMs: number,
  afterMs: number,
  bufferSharing: boolean,
  expand: boolean,
): Timeline {
  const segments: Segment[] = [];
  for (const occupancy of resource.occupancies) {
    if (occupancy.kind === 'block') continue;
    const span = expand
      ? occupancyFootprint(occupancy, beforeMs, afterMs, bufferSharing)
      : { start: occupancy.start, end: occupancy.end };
    if (span.end <= span.start) continue;
    segments.push({ start: span.start, end: span.end, capacity: occupancy.capacityUsed });
  }
  return normalize(segments);
}

// --- The computation ---------------------------------------------------------------------

export function computeAvailability(input: ComputeAvailabilityInput): AvailabilityResult {
  const { data, now } = input;
  const service = data.service;
  const granularity = input.granularity ?? 'slots';
  const maxInstants = input.maxInstants ?? DEFAULT_MAX_INSTANTS;
  const maxExplain = input.maxExplainInstants ?? DEFAULT_MAX_EXPLAIN_INSTANTS;

  assertInstant(input.from, 'from');
  assertInstant(input.to, 'to');
  assertInstant(now, 'now');
  if (input.to <= input.from) {
    throw errors.invalidRequest('`to` must be after `from`.', 'to', 'invalid_range');
  }
  if (input.to - input.from > MAX_RANGE_DAYS * DAY_MS) {
    throw errors.invalidRequest(
      `An availability request may not span more than ${String(MAX_RANGE_DAYS)} days; page the window instead.`,
      'to',
      'range_too_large',
    );
  }

  const quantity = input.quantity ?? service.capacityPerBooking;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw errors.invalidRequest(
      `quantity must be a positive integer, received ${String(quantity)}.`,
      'quantity',
      'parameter_invalid',
    );
  }

  const beforeMs = service.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = service.bufferAfterMinutes * MINUTE_MS;
  const durations = durationsOf(service);

  // Step 1: the booking window.
  const minNotice = (service.bookingWindow?.minNoticeMinutes ?? 0) * MINUTE_MS;
  const maxAdvanceDays = service.bookingWindow?.maxAdvanceDays ?? null;
  const earliestStart = now + minNotice;
  // `max_advance` is inclusive on the last admissible start, so the exclusive bound is one
  // millisecond later.
  const horizonExclusive =
    maxAdvanceDays === null ? Number.POSITIVE_INFINITY : now + maxAdvanceDays * DAY_MS + 1;
  const windowFrom = Math.max(input.from, earliestStart);
  const windowTo = Math.min(input.to, horizonExclusive);

  const explainEntries: ExplainEntry[] = [];
  const explaining = input.explain === true;
  // Rules the loader had to skip. They are a property of the service, not of an instant, so
  // they are reported once.
  const explainNotes: ExplainNote[] = explaining
    ? data.ignoredPricingRules.map((index) => ({
        code: 'pricing_rule_ignored' as const,
        index,
        detail: `Rule ${String(index)} of pricing_rules does not match the rule schema and was skipped; the price comes from the next rule that matches, or from the flat price of the service.`,
      }))
    : [];

  // Step 7: nothing else can rescue a customer who is already at the limit. The reason is
  // decided here and returned below, once the grid `explain` reports on exists.
  const limit = data.policy?.maxActiveBookingsPerCustomer ?? null;
  const active = data.customerActiveBookings;
  const limitReason: AvailabilityReason | null =
    limit !== null && active !== null && active >= limit
      ? {
          code: 'customer_limit_reached',
          detail: `The customer already has ${String(active)} active bookings and the policy allows ${String(limit)}.`,
        }
      : null;

  // Step 2: the timeline of every candidate resource.
  //
  // The window materialized is the one the **caller asked for**, never the one trimmed by
  // `min_notice` / `max_advance`. That is what makes the answer a function of the data alone:
  // the slot grid is anchored to the opening bands (below), and an anchor that moved with
  // `now` would hand two identical requests a minute apart two different grids, and would
  // leave the cache nothing it can keep.
  const byId = new Map<string, ResourceTimelines>();
  const { from: matFrom, to: matTo } = materializationWindow(service, input.from, input.to);
  for (const resource of data.resources) {
    const layers =
      input.openTimelines?.get(resource.id) ??
      resourceOpenTimelines(resource, matFrom, matTo, input.maxDays);
    byId.set(resource.id, resourceTimelines(resource, layers, service, { withCore: explaining }));
  }

  /**
   * The candidate grid: the instants a booking of `durationMs` **could** start at if nothing
   * were taken, discretized on the opening bands of the service.
   *
   * The anchor is the union of the resources' rules and of their rules plus exceptions,
   * never the residual timeline, and never the trimmed window. `align_to: 'schedule_start'`
   * (and its absence, which is the default) means "count from the start of the opening
   * band"; anchoring on what is left after the occupancies would make a fifteen minute
   * booking shift every slot of the day by fifteen minutes, and `min_notice` shift them all
   * by the notice. Closed exceptions and blocks are deliberately *not* subtracted from the
   * anchor for the same reason: a closure cuts the grid, it does not move it. What they take
   * away is removed afterwards, by filtering the grid against `feasible`.
   *
   * It is also, by construction, the candidate set `explain` reports on: the two can no
   * longer disagree, so an accepted slot is always an instant of this grid.
   */
  const gridCache = new Map<number, number[]>();
  const supplied =
    input.candidates === undefined
      ? null
      : [...new Set(input.candidates)]
          .filter((at) => at >= input.from && at < input.to)
          .sort((a, b) => a - b);
  const gridFor = (durationMs: number, ceiling: number): number[] => {
    if (supplied !== null) return supplied;
    const cached = gridCache.get(durationMs);
    if (cached !== undefined) return cached;
    const instants = candidateGrid(byId.values(), {
      service,
      timezone: data.timezone,
      durationMs,
      intervalMs: gridIntervalMs(service),
      from: input.from,
      to: input.to,
      maxInstants: ceiling,
    });
    gridCache.set(durationMs, instants);
    return instants;
  };

  if (limitReason !== null) {
    const result: AvailabilityResult = { slots: [], nextAvailable: null, reason: limitReason };
    if (!explaining) return result;
    const candidates = truncate(gridFor(durations[0]! * MINUTE_MS, maxInstants), maxExplain);
    return {
      ...result,
      explain: candidates.instants.map((at) => ({
        at,
        reasons: [{ code: 'customer_limit' as const, detail: limitReason.detail }],
      })),
      explainNotes,
      truncated: candidates.truncated,
    };
  }

  /**
   * The residual timeline each candidate resource offers **to this requirement**.
   *
   * A `per_unit` requirement sees the residual as it is. A `whole` requirement sees only the
   * stretches where the resource is entirely free, and sees them at {@link UNBOUNDED_CAPACITY}:
   * taking the resource whole puts no ceiling on the quantity.
   */
  const residuals = (requirement: RequirementData): Timeline[] => {
    const out: Timeline[] = [];
    for (const id of requirement.resourceIds) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      out.push(
        requirement.consumes === 'whole'
          ? wholeOnly(entry.residual, entry.resource.capacity)
          : entry.residual,
      );
    }
    return out;
  };

  /**
   * Steps 3, 4 and 5 for one duration, in the only order that composes: **erode first, per
   * resource**, then ask the group how many of its members can host the whole booking, then
   * intersect the requirements. Combining before eroding would let a slot straddle two
   * resources (half on one, half on the other), which no single booking can do.
   *
   * The capacity that comes out is the largest quantity the whole service can serve if it
   * starts at that instant.
   */
  const startsFor = (durationMs: number): Timeline => {
    if (data.requirements.length === 0) return [];
    let combined: Timeline | null = null;
    for (const requirement of data.requirements) {
      const whole = requirement.consumes === 'whole';
      const perResource: Timeline[] = [];
      for (const id of requirement.resourceIds) {
        const entry = byId.get(id);
        if (entry === undefined) continue;
        const eroded = erodeCapacity(entry.residual, beforeMs, durationMs, afterMs);
        perResource.push(whole ? wholeOnly(eroded, entry.resource.capacity) : eroded);
      }
      const capacity = requirementCapacity(
        perResource,
        requirement.quantity,
        service.allowSplit && !whole,
      );
      combined = combined === null ? capacity : intersect(combined, capacity);
      if (combined.length === 0) break;
    }
    return atLeast(combined ?? [], quantity);
  };

  const priceFor = pricerFor(service, data.timezone);
  const slots: AvailabilitySlot[] =
    granularity === 'ranges'
      ? continuousRanges(service, residuals, beforeMs, afterMs, windowFrom, windowTo, priceFor, {
          data,
          byId,
          quantity,
        })
      : discreteSlots({
          service,
          startsFor,
          gridFor,
          durations,
          beforeMs,
          afterMs,
          windowFrom,
          windowTo,
          maxInstants,
          priceFor,
          data,
          byId,
          quantity,
        });

  const result: AvailabilityResult = {
    slots,
    nextAvailable: slots.length === 0 ? null : slots[0]!.start,
  };
  if (!explaining) return result;

  const candidates = truncate(gridFor(durations[0]! * MINUTE_MS, maxInstants), maxExplain);
  const accepted = new Set(slots.map((slot) => slot.start));
  for (const at of candidates.instants) {
    if (accepted.has(at)) continue;
    const reasons = explainInstant(at, {
      data,
      byId,
      quantity,
      durationMs: durations[0]! * MINUTE_MS,
      beforeMs,
      afterMs,
      earliestStart,
      horizonExclusive,
    });
    // An entry without a single reason says "not available" and nothing else, which is the
    // one thing `explain` exists not to do. It is skipped rather than emitted empty; with
    // the grid shared between slots and candidates the case is unreachable except for a slot
    // dropped because no concrete assignment of resources exists (see `resourceOptionsAt`).
    if (reasons.length === 0) continue;
    explainEntries.push({ at, reasons });
  }
  return { ...result, explain: explainEntries, explainNotes, truncated: candidates.truncated };
}

/** First `limit` instants, and whether anything was left out. */
function truncate(
  instants: readonly number[],
  limit: number,
): {
  instants: number[];
  truncated: boolean;
} {
  return instants.length > limit
    ? { instants: instants.slice(0, limit), truncated: true }
    : { instants: [...instants], truncated: false };
}

function assertInstant(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw errors.invalidRequest(
      `${what} must be an instant in epoch milliseconds, received ${String(value)}.`,
      what,
      'parameter_invalid',
    );
  }
}

// --- Discrete slots ----------------------------------------------------------------------

interface SlotContext {
  readonly data: AvailabilityData;
  readonly byId: Map<string, ResourceTimelines>;
  readonly quantity: number;
}

interface DiscreteSlotsInput extends SlotContext {
  readonly service: ServiceData;
  /** Admissible starts, with the servable quantity as capacity, for one duration. */
  readonly startsFor: (durationMs: number) => Timeline;
  /** The candidate grid for one duration, anchored to the opening bands. */
  readonly gridFor: (durationMs: number, ceiling: number) => readonly number[];
  readonly durations: readonly number[];
  readonly beforeMs: number;
  readonly afterMs: number;
  readonly windowFrom: number;
  readonly windowTo: number;
  readonly maxInstants: number;
  readonly priceFor: Pricer;
}

/**
 * The grid comes from the opening bands and is then **filtered** against what is actually
 * bookable: an occupancy or a `min_notice` removes instants from the offer, it never moves
 * them. See `gridFor` in `computeAvailability` for why.
 *
 * A slot for which no concrete assignment of resources exists is dropped rather than offered:
 * the question the engine answers is at which instants an assignment of resources *exists*,
 * and the capacity intersection alone cannot see that two requirements may be fighting over
 * the same resource.
 */
function discreteSlots(input: DiscreteSlotsInput): AvailabilitySlot[] {
  const { beforeMs, afterMs, windowFrom, windowTo } = input;
  if (windowTo <= windowFrom) return [];
  const slots: AvailabilitySlot[] = [];
  // The ceiling is spent across every duration option, not once per option.
  let budget = input.maxInstants;

  for (const duration of input.durations) {
    const durationMs = duration * MINUTE_MS;
    const feasible = clip(input.startsFor(durationMs), windowFrom, windowTo);
    if (feasible.length === 0) continue;
    const grid = input.gridFor(durationMs, budget);
    budget = Math.max(0, budget - grid.length);
    for (const at of grid) {
      const capacity = minCapacityOver(feasible, at, at);
      if (capacity === 0) continue;
      const resourceOptions = resourceOptionsAt(
        at,
        durationMs,
        beforeMs,
        afterMs,
        slots.length,
        input,
      );
      if (resourceOptions.length === 0) continue;
      const priced = input.priceFor(at, duration, resourceOptions);
      slots.push({
        start: at,
        end: at + durationMs,
        durationMinutes: duration,
        availableCapacity: reportedCapacity(capacity, input.quantity),
        price: priced?.price ?? null,
        priceRule: priceRuleOf(priced),
        resourceOptions,
      });
    }
  }
  slots.sort((a, b) => a.start - b.start || (a.durationMinutes ?? 0) - (b.durationMinutes ?? 0));
  return slots;
}

// --- Continuous ranges -------------------------------------------------------------------

/**
 * `granularity: 'ranges'` never touches an eroded timeline: erosion produces the set of
 * admissible *starts*, and its upper bound sits one millisecond past the last legal one, so
 * returning it would give ranges ending `duration + buffer_after - 1` ms too early.
 *
 * It works on the residual timelines instead, one resource at a time
 * ({@link requirementRanges}) for the same reason the slots do: a continuous range has to be
 * covered end to end by the *same* resources, and the union of a group is not.
 *
 * What comes out is the window a booking's **core** may live in: the maximal interval minus
 * the buffers on both sides. `max_duration` is capped by the length of the range itself, and
 * the range may reach past the requested `to`: a thirty day rental starting on the last day
 * of the window has to be able to run its course.
 */
function continuousRanges(
  service: ServiceData,
  residuals: (requirement: RequirementData) => Timeline[],
  beforeMs: number,
  afterMs: number,
  windowFrom: number,
  windowTo: number,
  priceFor: Pricer,
  context: SlotContext,
): AvailabilitySlot[] {
  if (windowTo <= windowFrom || context.data.requirements.length === 0) return [];
  const minDuration = service.durationMinMinutes ?? durationsOf(service)[0]!;
  const maxDuration = maxDurationOf(service);
  const minDurationMs = minDuration * MINUTE_MS;
  const out: AvailabilitySlot[] = [];

  let feasible: Segment[] | null = null;
  for (const requirement of context.data.requirements) {
    const ranges = requirementRanges(
      residuals(requirement),
      requirement.quantity,
      service.allowSplit && requirement.consumes !== 'whole',
      context.quantity,
    );
    feasible = feasible === null ? ranges : intersectRanges(feasible, ranges);
    if (feasible.length === 0) return [];
  }

  for (const segment of feasible ?? []) {
    const coreStart = Math.max(segment.start + beforeMs, windowFrom);
    const coreEnd = segment.end - afterMs;
    if (coreEnd - coreStart < minDurationMs) continue;
    if (coreStart >= windowTo) continue;
    const lengthMinutes = Math.floor((coreEnd - coreStart) / MINUTE_MS);
    const resourceOptions = resourceOptionsAt(
      coreStart,
      minDurationMs,
      beforeMs,
      afterMs,
      out.length,
      context,
    );
    // Same rule as the discrete slots: a range nobody can actually be assigned to is not a
    // range. See `resourceOptionsAt`.
    if (resourceOptions.length === 0) continue;
    // A range is a family of bookings, not one booking, and a rule can price its members
    // differently: `duration_min` alone splits it. The quoted price is the one of the
    // **shortest booking starting at the beginning of the range**, which is the cheapest
    // question with an unambiguous answer; `POST /v1/availability/check` prices an exact
    // instant and duration, and the booking freezes what it computes for itself.
    const priced = priceFor(coreStart, minDuration, resourceOptions);
    out.push({
      start: coreStart,
      end: coreEnd,
      durationMinutes: null,
      minDurationMinutes: minDuration,
      maxDurationMinutes: Math.min(maxDuration, lengthMinutes),
      availableCapacity: reportedCapacity(segment.capacity, context.quantity),
      price: priced?.price ?? null,
      priceRule: priceRuleOf(priced),
      resourceOptions,
    });
  }
  return out;
}

// --- Resource options --------------------------------------------------------------------

const MAX_RESOURCE_OPTIONS = 5;

/**
 * Ceiling on the nodes the assignment search may visit for one slot. It exists only so that
 * a pathological group (dozens of interchangeable resources, several requirements, every
 * combination failing) cannot turn one slot into a combinatorial explosion; a slot that hits
 * it keeps whatever assignments were found first.
 */
const MAX_SEARCH_STEPS = 50_000;

/**
 * Up to five concrete assignments of resources that satisfy every requirement at `at`.
 *
 * The search is a complete depth-first enumeration (every combination of
 * `requirement.quantity` distinct resources per requirement, in the order the group's
 * `allocation_strategy` dictates), cut off once five assignments are in hand.
 * `MAX_RESOURCE_OPTIONS` truncates the *output*: it never stops the search before the first
 * assignment is found, which is what lets `discreteSlots` treat an empty result as "no
 * assignment exists" and drop the slot.
 *
 * Order: `priority` and `first_available` follow the member priority the loader sorted on,
 * `least_busy` puts the resource with the most residual capacity first, and `round_robin`
 * rotates that same priority order by the index of the slot: the engine holds no state
 * between requests, so the rotation is a function of the slot position and nothing else.
 *
 * A resource is never used by two requirements of the same assignment: that is exactly the
 * contention the capacity intersection cannot see.
 */
function resourceOptionsAt(
  at: number,
  durationMs: number,
  beforeMs: number,
  afterMs: number,
  slotIndex: number,
  context: SlotContext,
): ResourceOption[] {
  const { data, byId, quantity } = context;
  const from = at - beforeMs;
  const to = at + durationMs + afterMs;

  const candidatesPerRequirement = data.requirements.map((requirement) => {
    const usable: Candidate[] = [];
    for (const id of requirement.resourceIds) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      const capacity = minCapacityOver(entry.residual, from, to);
      if (capacity <= 0) continue;
      usable.push({
        id,
        capacity,
        need: requirement.consumes === 'whole' ? entry.resource.capacity : quantity,
      });
    }
    return order(usable, requirement.allocationStrategy, slotIndex);
  });

  const options: ResourceOption[] = [];
  const chosen: ResourceAllocation[] = [];
  const used = new Set<string>();
  let steps = 0;

  const walk = (index: number): void => {
    if (options.length >= MAX_RESOURCE_OPTIONS || steps > MAX_SEARCH_STEPS) return;
    if (index === data.requirements.length) {
      if (chosen.length > 0) options.push({ resources: [...chosen] });
      return;
    }
    const requirement = data.requirements[index]!;
    const candidates = candidatesPerRequirement[index]!;
    const split = data.service.allowSplit && requirement.consumes !== 'whole';

    if (split) {
      for (let first = 0; first < candidates.length; first += 1) {
        steps += 1;
        const picked = pickSplit(candidates, first, requirement, used, quantity);
        if (picked === null) continue;
        for (const allocation of picked) {
          chosen.push({ ...allocation, role: requirement.role });
          used.add(allocation.resourceId);
        }
        walk(index + 1);
        for (const allocation of picked) used.delete(allocation.resourceId);
        chosen.length -= picked.length;
        if (options.length >= MAX_RESOURCE_OPTIONS || steps > MAX_SEARCH_STEPS) return;
      }
      return;
    }

    let taken = 0;
    const choose = (fromIndex: number): void => {
      if (options.length >= MAX_RESOURCE_OPTIONS || steps > MAX_SEARCH_STEPS) return;
      if (taken === requirement.quantity) {
        walk(index + 1);
        return;
      }
      for (let i = fromIndex; i < candidates.length; i += 1) {
        steps += 1;
        const candidate = candidates[i]!;
        if (used.has(candidate.id) || candidate.capacity < candidate.need) continue;
        chosen.push({
          resourceId: candidate.id,
          role: requirement.role,
          capacityUsed: candidate.need,
        });
        used.add(candidate.id);
        taken += 1;
        choose(i + 1);
        taken -= 1;
        used.delete(candidate.id);
        chosen.pop();
        if (options.length >= MAX_RESOURCE_OPTIONS || steps > MAX_SEARCH_STEPS) return;
      }
    };
    choose(0);
  };
  walk(0);
  return options;
}

/** A resource a requirement could use at one instant, with the units it would take. */
interface Candidate {
  readonly id: string;
  readonly capacity: number;
  readonly need: number;
}

function order(
  candidates: Candidate[],
  strategy: AllocationStrategy,
  slotIndex: number,
): Candidate[] {
  if (strategy === 'least_busy') {
    return [...candidates].sort((a, b) => b.capacity - a.capacity || (a.id < b.id ? -1 : 1));
  }
  if (strategy === 'round_robin' && candidates.length > 1) {
    const shift = slotIndex % candidates.length;
    return [...candidates.slice(shift), ...candidates.slice(0, shift)];
  }
  return candidates;
}

/**
 * One `allow_split` assignment for a single requirement, starting from `first`, or `null`.
 *
 * The share of each resource keeps **one unit in reserve for every resource the requirement
 * still has to name**. Without it the first table takes all four covers of a party of four,
 * `remaining` hits zero with only one table named, and a requirement asking for two
 * resources ends up with no assignment at all, while `requirementCapacity` calls the slot
 * feasible.
 */
function pickSplit(
  candidates: readonly Candidate[],
  first: number,
  requirement: RequirementData,
  used: ReadonlySet<string>,
  quantity: number,
): ResourceAllocation[] | null {
  const taken: ResourceAllocation[] = [];
  let remaining = quantity;
  for (let i = first; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (used.has(candidate.id)) continue;
    const stillToName = Math.max(0, requirement.quantity - taken.length - 1);
    const share = Math.min(candidate.capacity, remaining - stillToName);
    if (share <= 0) continue;
    taken.push({ resourceId: candidate.id, role: null, capacityUsed: share });
    remaining -= share;
    if (remaining === 0 && taken.length >= requirement.quantity) return taken;
  }
  return null;
}

// --- Explain -----------------------------------------------------------------------------

interface ExplainContext extends SlotContext {
  readonly durationMs: number;
  readonly beforeMs: number;
  readonly afterMs: number;
  readonly earliestStart: number;
  readonly horizonExclusive: number;
}

function explainInstant(at: number, context: ExplainContext): ExplainReason[] {
  const reasons: ExplainReason[] = [];
  if (at < context.earliestStart) {
    reasons.push({
      code: 'min_notice',
      detail: `Starts before the minimum notice, which ends at ${String(context.earliestStart)}.`,
    });
  }
  if (at >= context.horizonExclusive) {
    reasons.push({
      code: 'max_advance',
      detail: `Starts past the booking horizon, which ends at ${String(context.horizonExclusive - 1)}.`,
    });
  }
  if (reasons.length > 0) return reasons;

  const from = at - context.beforeMs;
  const to = at + context.durationMs + context.afterMs;
  for (const requirement of context.data.requirements) {
    const whole = requirement.consumes === 'whole';
    const split = context.data.service.allowSplit && !whole;
    // A requirement that is satisfied at this instant explains nothing: the instant was
    // discarded because of another one, and listing its idle resources would be noise.
    let served = 0;
    let sum = 0;
    for (const id of requirement.resourceIds) {
      const entry = context.byId.get(id);
      if (entry === undefined) continue;
      const capacity = minCapacityOver(entry.residual, from, to);
      const need = whole ? entry.resource.capacity : context.quantity;
      if (capacity > 0) sum += capacity;
      if (split ? capacity > 0 : capacity >= need) served += 1;
    }
    const satisfied = split
      ? served >= requirement.quantity && sum >= context.quantity
      : served >= requirement.quantity;
    if (satisfied) continue;
    for (const id of requirement.resourceIds) {
      const entry = context.byId.get(id);
      if (entry === undefined) continue;
      const need = whole ? entry.resource.capacity : context.quantity;
      const reason = explainResource(entry, from, to, need, context);
      if (reason !== null) reasons.push(reason);
    }
  }
  return reasons;
}

/** `needed` is the number of units the requirement takes: `quantity`, or the whole capacity. */
function explainResource(
  entry: ResourceTimelines,
  from: number,
  to: number,
  needed: number,
  context: ExplainContext,
): ExplainReason | null {
  const id = entry.resource.id;
  if (minCapacityOver(entry.rulesOnly, from, to) === 0) {
    return {
      code: 'outside_schedule',
      resourceId: id,
      detail: `${entry.resource.name} has no opening rule covering the whole booking window.`,
    };
  }
  if (minCapacityOver(entry.withExceptions, from, to) === 0) {
    return {
      code: 'exception_closed',
      resourceId: id,
      detail: `A schedule exception closes ${entry.resource.name} during the booking window.`,
    };
  }
  if (minCapacityOver(entry.open, from, to) === 0) {
    // The block is an occupancy, and its `ref_id` is the `resource_blocks`
    // row the caller knows: that is the identifier `explain` has always pointed at.
    const block = entry.resource.occupancies.find(
      (occupancy) => occupancy.kind === 'block' && occupancy.start < to && occupancy.end > from,
    );
    return {
      code: 'blocked',
      resourceId: id,
      ...(block === undefined ? {} : { refId: block.refId }),
      detail: `${entry.resource.name} is blocked during the booking window.`,
    };
  }
  const residual = minCapacityOver(entry.residual, from, to);
  if (residual === 0) {
    const core = entry.residualCore;
    const blockedByBufferOnly = core !== undefined && minCapacityOver(core, from, to) > 0;
    // The culprit is the occupancy whose *footprint* (its own span widened by the buffers,
    // exactly as it was subtracted) reaches into the window.
    const culprit = entry.resource.occupancies.find((occupancy) => {
      const span = occupancyFootprint(
        occupancy,
        context.beforeMs,
        context.afterMs,
        context.data.service.bufferSharing,
      );
      return span.start < to && span.end > from;
    });
    return {
      code: blockedByBufferOnly ? 'buffer' : 'occupied',
      resourceId: id,
      ...(culprit === undefined ? {} : { refId: culprit.refId }),
      detail: blockedByBufferOnly
        ? `The buffer of an adjacent booking reaches into the window on ${entry.resource.name}.`
        : `${entry.resource.name} is already taken during the booking window.`,
    };
  }
  if (residual < needed) {
    return {
      code: 'capacity',
      resourceId: id,
      detail: `${entry.resource.name} has ${String(residual)} units left and ${String(needed)} are needed.`,
    };
  }
  return null;
}
