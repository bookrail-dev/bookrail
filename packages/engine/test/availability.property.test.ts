/**
 * Property suite for the availability computation.
 *
 * Two invariants, checked on random schedules, random occupancies and random services:
 * **never outside the schedule** and **never over capacity**, both over the whole booking
 * footprint `[t - before, t + duration + after)`, with and without `allow_split`.
 *
 * The oracle does not call a single function of the engine. It rebuilds the opening bands
 * from the rules with `Temporal` (the tzdata conversion is the ground truth and there is no
 * way around it) and then works with plain interval arithmetic: no timeline algebra, no
 * `materializeSchedule`, no union, no subtraction, no erosion. An earlier version of this
 * file called `materializeSchedule` on both sides, which made half the property tautological:
 * an oracle that shares an implementation with what it checks can only agree with it.
 *
 * Plus a minimal **completeness** property (a free, open resource must produce slots, so an
 * engine that returned nothing could not pass) and the identities that have to hold: the
 * order statistic `computeAvailability` uses is `kOfN` on its support, its `allow_split`
 * branch is the union of the group's timelines, and `erodeCapacity` erodes a mask where
 * `erode` does.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  computeAvailability,
  requirementCapacity,
  type AvailabilityData,
  type OccupancyData,
  type ResourceData,
} from '../src/index.js';
import { Temporal } from '@js-temporal/polyfill';

import type { ScheduleRule } from '../src/schedule/index.js';
import {
  erode,
  kOfN,
  normalize,
  union,
  type Segment,
  type Timeline,
} from '../src/timeline/index.js';
import { erodeCapacity } from '../src/index.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 5, 1);
const TO = Date.UTC(2026, 5, 2);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const RUNS = { numRuns: 300 };

function hh(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

const arbRules = fc
  .array(
    fc
      .tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 8 }))
      .map(([start, length]) => ({ start, end: Math.min(23, start + length) }))
      .filter((band) => band.end > band.start),
    { minLength: 1, maxLength: 2 },
  )
  .map((bands): ScheduleRule[] =>
    bands.map((band) => ({
      daysOfWeek: EVERY_DAY,
      startTime: hh(band.start),
      endTime: hh(band.end),
    })),
  );

const arbTimezone = fc.constantFrom('UTC', 'Europe/Rome', 'Asia/Kolkata');

function arbResource(index: number): fc.Arbitrary<ResourceData> {
  return fc
    .tuple(
      arbRules,
      fc.integer({ min: 1, max: 4 }),
      arbTimezone,
      fc.array(
        fc.tuple(
          fc.integer({ min: 0, max: 22 }),
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 1, max: 4 }),
        ),
        { maxLength: 3 },
      ),
    )
    .map(([rules, capacity, timezone, occupancies]): ResourceData => {
      const id = `res-${String(index)}`;
      return {
        id,
        name: id,
        capacity,
        timezone,
        rules,
        exceptions: [],
        occupancies: occupancies.map((raw, k): OccupancyData => {
          const [startHour, lengthHours, used] = raw;
          return {
            id: `${id}-occ-${String(k)}`,
            resourceId: id,
            start: FROM + startHour * HOUR,
            end: FROM + (startHour + lengthHours) * HOUR,
            capacityUsed: Math.min(used, capacity),
            kind: 'booking',
            refId: `${id}-ref-${String(k)}`,
            // The oracle below takes the occupancies bare and widens only the *new* booking's
            // footprint, so the generated rows carry no buffers of their own.
            bufferBeforeMs: 0,
            bufferAfterMs: 0,
          };
        }),
      };
    });
}

const arbService = fc
  .tuple(
    fc.constantFrom(15, 30, 60, 90),
    fc.constantFrom(0, 15, 30),
    fc.constantFrom(0, 15, 30),
    fc.constantFrom(15, 30, 60),
    fc.constantFrom<'hour' | 'half_hour' | 'schedule_start' | null>(
      'hour',
      'half_hour',
      'schedule_start',
      null,
    ),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([duration, before, after, interval, alignTo, bufferSharing, allowSplit]) => ({
    id: 'svc',
    durationMinutes: duration,
    durationOptions: null,
    durationMinMinutes: null,
    durationMaxMinutes: null,
    capacityPerBooking: 1,
    bufferBeforeMinutes: before,
    bufferAfterMinutes: after,
    slotIntervalMinutes: interval,
    alignTo,
    priceAmount: null,
    priceCurrency: null,
    pricingRules: [],
    bookingWindow: null,
    bufferSharing,
    allowSplit,
  }));

const arbScenario = fc
  .tuple(
    fc
      .integer({ min: 1, max: 3 })
      .chain((count) =>
        fc.tuple(...Array.from({ length: count }, (_, index) => arbResource(index))),
      ),
    arbService,
    fc.integer({ min: 1, max: 3 }),
  )
  .chain(([resources, service, quantity]) =>
    fc.integer({ min: 1, max: resources.length }).map((required) => ({
      resources,
      service,
      quantity,
      required,
    })),
  );

/**
 * The opening bands of one resource, rebuilt from the rules without touching the engine.
 *
 * The generators only ever produce bands on the hour that do not cross midnight, so a band
 * is one `[start, end)` per local day. `Temporal` converts the wall clock to an instant
 * (that is tzdata, not the system under test) and nothing else here comes from `src/`.
 */
function oracleBands(resource: ResourceData, from: number, to: number): [number, number][] {
  const zone = resource.timezone;
  const at = (date: Temporal.PlainDate, hour: number): number =>
    date
      .toPlainDateTime(new Temporal.PlainTime(hour, 0, 0, 0))
      .toZonedDateTime(zone, { disambiguation: 'compatible' }).epochMilliseconds;

  const first = Temporal.Instant.fromEpochMilliseconds(from)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .subtract({ days: 1 });
  const last = Temporal.Instant.fromEpochMilliseconds(to)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .add({ days: 1 });

  const bands: [number, number][] = [];
  for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    for (const rule of resource.rules) {
      const start = at(day, Number(rule.startTime.slice(0, 2)));
      const end = at(day, Number(rule.endTime.slice(0, 2)));
      if (end > start) bands.push([start, end]);
    }
  }
  // Two rules that overlap or merely touch open the resource once, not twice: 06:00-07:00
  // followed by 07:00-08:00 is one opening of two hours, and a booking may sit across the seam.
  bands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last !== undefined && band[0] <= last[1]) last[1] = Math.max(last[1], band[1]);
    else merged.push([band[0], band[1]]);
  }
  return merged;
}

/** True when `[from, to)` sits entirely inside one single opening. */
function insideABand(bands: readonly [number, number][], from: number, to: number): boolean {
  return bands.some(([start, end]) => start <= from && end >= to);
}

/**
 * The largest number of capacity units taken at any instant of `[from, to)`, from the raw
 * occupancy list: no timeline algebra, only interval arithmetic on the event points.
 */
function peakUsage(occupancies: readonly OccupancyData[], from: number, to: number): number {
  const points = new Set<number>([from]);
  for (const occupancy of occupancies) {
    if (occupancy.start > from && occupancy.start < to) points.add(occupancy.start);
    if (occupancy.end > from && occupancy.end < to) points.add(occupancy.end);
  }
  let peak = 0;
  for (const point of points) {
    let used = 0;
    for (const occupancy of occupancies) {
      if (occupancy.start <= point && occupancy.end > point) used += occupancy.capacityUsed;
    }
    if (used > peak) peak = used;
  }
  return peak;
}

describe('availability properties', () => {
  it('never returns a slot outside the schedule or over capacity', () => {
    fc.assert(
      fc.property(arbScenario, ({ resources, service, quantity, required }) => {
        const data: AvailabilityData = {
          service,
          requirements: [
            {
              id: 'req',
              quantity: required,
              consumes: 'per_unit',
              role: null,
              resourceGroupId: 'group',
              allocationStrategy: 'first_available',
              resourceIds: resources.map((resource) => resource.id),
            },
          ],
          resources,
          policy: null,
          customerActiveBookings: null,
          ignoredPricingRules: [],
          timezone: resources[0]!.timezone,
        };
        const result = computeAvailability({
          data,
          from: FROM,
          to: TO,
          quantity,
          now: FROM - HOUR,
        });

        const beforeMs = service.bufferBeforeMinutes * MINUTE;
        const afterMs = service.bufferAfterMinutes * MINUTE;

        for (const slot of result.slots) {
          expect(slot.start).toBeGreaterThanOrEqual(FROM);
          expect(slot.start).toBeLessThan(TO);
          expect(slot.end - slot.start).toBe(service.durationMinutes * MINUTE);

          // The whole footprint, buffers included: that is what the engine claims is free.
          const from = slot.start - beforeMs;
          const to = slot.end + afterMs;

          // What each resource could really give over that footprint, from the fixtures.
          let servers = 0;
          let pooled = 0;
          for (const resource of resources) {
            const bands = oracleBands(resource, from, to);
            if (!insideABand(bands, from, to)) continue;
            const left = resource.capacity - peakUsage(resource.occupancies, from, to);
            if (left <= 0) continue;
            pooled += left;
            if (service.allowSplit ? left > 0 : left >= quantity) servers += 1;
          }
          expect(servers).toBeGreaterThanOrEqual(required);
          if (service.allowSplit) expect(pooled).toBeGreaterThanOrEqual(quantity);
          expect(slot.availableCapacity).toBeGreaterThanOrEqual(quantity);
          // An offered slot always comes with at least one way of staffing it.
          expect(slot.resourceOptions.length).toBeGreaterThan(0);
        }
        expect(result.nextAvailable).toBe(result.slots[0]?.start ?? null);
      }),
      RUNS,
    );
  });

  /**
   * Minimal completeness. The property above only forbids offering too much, so an engine
   * that returned nothing at all would sail through it. This one forbids offering too
   * little in the one case where the answer is not in doubt: a single resource, wide open,
   * nothing booked, and a service that comfortably fits inside the band.
   */
  it('always finds a slot on an open resource with nothing booked', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 8 }),
        fc.integer({ min: 0, max: 23 }),
        arbTimezone,
        fc.constantFrom(15, 30, 60),
        fc.constantFrom(0, 15, 30),
        fc.constantFrom(15, 30, 60),
        fc.constantFrom<'hour' | 'half_hour' | 'schedule_start' | null>(
          'hour',
          'half_hour',
          'schedule_start',
          null,
        ),
        fc.integer({ min: 1, max: 4 }),
        (length, rawStart, timezone, duration, buffer, interval, alignTo, capacity) => {
          // Kept inside the day: `hh(24)` is not a time of day.
          const startHour = Math.max(0, Math.min(rawStart, 23 - length));
          const resource: ResourceData = {
            id: 'only',
            name: 'only',
            capacity,
            timezone,
            rules: [
              { daysOfWeek: EVERY_DAY, startTime: hh(startHour), endTime: hh(startHour + length) },
            ],
            exceptions: [],
            occupancies: [],
          };
          const result = computeAvailability({
            data: {
              service: {
                id: 'svc',
                durationMinutes: duration,
                durationOptions: null,
                durationMinMinutes: null,
                durationMaxMinutes: null,
                capacityPerBooking: 1,
                bufferBeforeMinutes: buffer,
                bufferAfterMinutes: buffer,
                slotIntervalMinutes: interval,
                alignTo,
                priceAmount: null,
                priceCurrency: null,
                pricingRules: [],
                bookingWindow: null,
                bufferSharing: false,
                allowSplit: false,
              },
              requirements: [
                {
                  id: 'req',
                  quantity: 1,
                  consumes: 'per_unit',
                  role: null,
                  resourceGroupId: null,
                  allocationStrategy: 'first_available',
                  resourceIds: ['only'],
                },
              ],
              resources: [resource],
              policy: null,
              customerActiveBookings: null,
              ignoredPricingRules: [],
              timezone,
            },
            from: FROM,
            to: TO,
            quantity: capacity,
            now: FROM - HOUR,
          });
          // The band is at least four hours and the booking at most two, so the admissible
          // window is wider than any interval the generator can pick.
          expect(result.slots.length).toBeGreaterThan(0);
          expect(result.nextAvailable).toBe(result.slots[0]!.start);
        },
      ),
      RUNS,
    );
  });

  const rawSegment = fc
    .tuple(
      fc.integer({ min: -40, max: 40 }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 0, max: 4 }),
    )
    .map(([start, length, capacity]): Segment => ({ start, end: start + length, capacity }));
  const arbTimeline = fc.array(rawSegment, { maxLength: 6 }).map(normalize);

  function support(timeline: Timeline): [number, number][] {
    const out: [number, number][] = [];
    for (const segment of normalize(timeline.map((s) => ({ ...s, capacity: 1 })))) {
      out.push([segment.start, segment.end]);
    }
    return out;
  }

  it('agrees with kOfN on which instants a requirement can serve', () => {
    fc.assert(
      fc.property(
        fc.array(arbTimeline, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        (timelines, k, minCapacity) => {
          const mine = requirementCapacity(timelines, k, false).filter(
            (segment) => segment.capacity >= minCapacity,
          );
          expect(support(mine)).toEqual(support(kOfN(timelines, k, minCapacity)));
        },
      ),
      RUNS,
    );
  });

  it('erodes a mask exactly where erode does', () => {
    fc.assert(
      fc.property(
        arbTimeline,
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (timeline, before, duration, after) => {
          const flat = normalize(timeline.map((s) => ({ ...s, capacity: 1 })));
          expect(support(erodeCapacity(flat, before, duration, after))).toEqual(
            support(erode(flat, before, duration, after)),
          );
        },
      ),
      RUNS,
    );
  });

  it('never reports more capacity than the window really holds', () => {
    fc.assert(
      fc.property(
        arbTimeline,
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        (timeline, before, duration, after) => {
          for (const segment of erodeCapacity(timeline, before, duration, after)) {
            for (const start of [segment.start, segment.end - 1]) {
              // Brute force: the smallest capacity anywhere under the footprint.
              let smallest = Number.POSITIVE_INFINITY;
              for (let t = start - before; t < start + duration + after; t += 1) {
                const covering = timeline.find((s) => s.start <= t && s.end > t);
                smallest = Math.min(smallest, covering?.capacity ?? 0);
              }
              expect(segment.capacity).toBe(smallest);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it('sums the group the way union does when allow_split is on', () => {
    fc.assert(
      fc.property(fc.array(arbTimeline, { minLength: 1, maxLength: 4 }), (timelines) => {
        const summed = requirementCapacity(timelines, 1, true);
        const folded = timelines.reduce<Timeline>((acc, next) => union(acc, next), []);
        expect(summed).toEqual(folded);
      }),
      RUNS,
    );
  });
});
