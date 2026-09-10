/**
 * The availability engine against a real Postgres.
 *
 * Every scenario writes its fixtures straight into the tables (including occupancies of all
 * three kinds), reads them back through `loadAvailabilityData` with row level security in
 * the middle, and asserts the slots `computeAvailability` produces. Expected values are
 * written by hand: none of them was copied out of a run.
 *
 * Rome is on CEST (+02:00) for every June date used here, so 09:00 local is 07:00Z.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@bookrail/db';

import { createHarness, utc, DAY, HOUR, MINUTE, type Harness } from './availability-harness.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

// Monday 1 June 2026, the reference day of the whole suite.
const MONDAY = utc(2026, 6, 1);
const TUESDAY = utc(2026, 6, 2);

function starts(result: { slots: readonly { start: number }[] }): number[] {
  return result.slots.map((slot) => slot.start);
}

describe('availability on real data', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Availability');
  });

  afterAll(async () => {
    await h.close();
  });

  /** A location, a weekday 09:00-19:00 schedule and one resource, all in Rome. */
  async function romeResource(capacity = 1, name = 'Court'): Promise<string> {
    const location = await h.location('Europe/Rome', `Rome ${name}`);
    const schedule = await h.schedule({
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '19:00' }],
    });
    return h.resource({ name, capacity, scheduleId: schedule, locationId: location });
  }

  describe('the baseline day', () => {
    it('turns a 09:00-19:00 Monday into ten hourly slots, the last at 18:00 local', async () => {
      const resource = await romeResource();
      const service = await h.service({
        durationMinutes: 60,
        price: { amount: 2500, currency: 'EUR' },
      });
      await h.requirement({ serviceId: service, resourceId: resource });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );

      expect(starts(result)).toEqual([
        MONDAY + 7 * HOUR,
        MONDAY + 8 * HOUR,
        MONDAY + 9 * HOUR,
        MONDAY + 10 * HOUR,
        MONDAY + 11 * HOUR,
        MONDAY + 12 * HOUR,
        MONDAY + 13 * HOUR,
        MONDAY + 14 * HOUR,
        MONDAY + 15 * HOUR,
        MONDAY + 16 * HOUR,
      ]);
      expect(result.nextAvailable).toBe(MONDAY + 7 * HOUR);
      expect(result.slots[0]).toMatchObject({
        end: MONDAY + 8 * HOUR,
        durationMinutes: 60,
        availableCapacity: 1,
        price: { amount: 2500, currency: 'EUR' },
      });
      expect(result.slots[0]!.resourceOptions).toEqual([
        { resources: [{ resourceId: resource, role: null, capacityUsed: 1 }] },
      ]);
      expect(result.explain).toBeUndefined();
    });

    it('leaves the price null when the service has none', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(result.slots[0]!.price).toBeNull();
    });

    it('404s on a service that does not exist, and on one that was soft deleted', async () => {
      await expect(
        h.load({ serviceId: '00000000-0000-7000-8000-000000000000', from: MONDAY, to: TUESDAY }),
      ).rejects.toMatchObject({ type: 'not_found' });

      const service = await h.service({ durationMinutes: 60 });
      await h.softDeleteService(service);
      await expect(h.load({ serviceId: service, from: MONDAY, to: TUESDAY })).rejects.toMatchObject(
        { type: 'not_found', code: 'resource_missing' },
      );
    });
  });

  /**
   * The grid is anchored to the **opening band**, never to what is left of it. This is the
   * blocking defect of the first delivery: with `align_to` absent (the default of the column
   * and of the API) the grid used to start at the first bookable instant, so a booking or a
   * `min_notice` moved every slot of the day.
   */
  describe('the slot grid', () => {
    async function hourlyService(bookingWindow?: {
      min_notice_minutes?: number;
    }): Promise<{ resource: string; service: string }> {
      const resource = await romeResource(1, `Grid ${String(Math.random()).slice(2, 8)}`);
      const service = await h.service({
        durationMinutes: 60,
        slotInterval: 60,
        ...(bookingWindow === undefined ? {} : { bookingWindow }),
      });
      await h.requirement({ serviceId: service, resourceId: resource });
      return { resource, service };
    }

    it('does not let a fifteen minute booking move the rest of the day', async () => {
      const { resource, service } = await hourlyService();
      // 09:00-09:15 local: it takes the 09:00 slot away and touches nothing else.
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 7 * HOUR,
        to: MONDAY + 7 * HOUR + 15 * MINUTE,
      });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(result)).toEqual([
        MONDAY + 8 * HOUR,
        MONDAY + 9 * HOUR,
        MONDAY + 10 * HOUR,
        MONDAY + 11 * HOUR,
        MONDAY + 12 * HOUR,
        MONDAY + 13 * HOUR,
        MONDAY + 14 * HOUR,
        MONDAY + 15 * HOUR,
        MONDAY + 16 * HOUR,
      ]);
      // Every start is still on the hour: nothing drifted to :15.
      for (const at of starts(result)) expect((at - MONDAY) % HOUR).toBe(0);
    });

    it('lets min_notice cut the grid, never shift it', async () => {
      const { service } = await hourlyService({ min_notice_minutes: 90 });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY + 6 * HOUR }, // 08:00 local, so the first bookable instant is 09:30
      );
      expect(starts(result)).toEqual([
        MONDAY + 8 * HOUR,
        MONDAY + 9 * HOUR,
        MONDAY + 10 * HOUR,
        MONDAY + 11 * HOUR,
        MONDAY + 12 * HOUR,
        MONDAY + 13 * HOUR,
        MONDAY + 14 * HOUR,
        MONDAY + 15 * HOUR,
        MONDAY + 16 * HOUR,
      ]);
      for (const at of starts(result)) expect((at - MONDAY) % HOUR).toBe(0);
    });

    it('answers the same thing whatever minute the question is asked', async () => {
      const { service } = await hourlyService({ min_notice_minutes: 90 });
      const early = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY + 6 * HOUR },
      );
      const aMinuteLater = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY + 6 * HOUR + MINUTE },
      );
      expect(starts(aMinuteLater)).toEqual(starts(early));
    });

    /** The ceiling is spent over every duration option, not once per option. */
    it('spends one instant ceiling across all the duration options', async () => {
      const resource = await romeResource(1, 'Ceiling');
      const service = await h.service({ durationOptions: [30, 60] });
      await h.requirement({ serviceId: service, resourceId: resource });
      const query = { serviceId: service, from: MONDAY, to: TUESDAY };

      // 20 starts of 30 minutes and 19 of 60: 39 instants in all.
      const whole = await h.compute(query, { now: MONDAY - DAY, maxInstants: 39 });
      expect(whole.slots).toHaveLength(39);

      await expect(h.compute(query, { now: MONDAY - DAY, maxInstants: 25 })).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe('occupancies', () => {
    it('takes capacity away for the hour a booking covers', async () => {
      const resource = await romeResource(4, 'Studio');
      const service = await h.service({ durationMinutes: 60, capacityPerBooking: 1 });
      await h.requirement({ serviceId: service, resourceId: resource });
      // 12:00-13:00 local, three of the four units taken.
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
        capacityUsed: 3,
      });

      const one = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(one)).toHaveLength(10);
      expect(one.slots.find((slot) => slot.start === MONDAY + 10 * HOUR)?.availableCapacity).toBe(
        1,
      );
      expect(one.slots.find((slot) => slot.start === MONDAY + 9 * HOUR)?.availableCapacity).toBe(4);

      const two = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, quantity: 2 },
      );
      expect(starts(two)).not.toContain(MONDAY + 10 * HOUR);
      expect(starts(two)).toHaveLength(9);
    });

    it('ignores a hold that has already expired and honours one that has not', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
        kind: 'hold',
        expiresAt: Date.now() - 60 * MINUTE,
      });
      const expired = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(expired)).toHaveLength(10);

      const live = await romeResource(1, 'Court live hold');
      const liveService = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: liveService, resourceId: live });
      await h.occupancy({
        resourceId: live,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
        kind: 'hold',
        expiresAt: Date.now() + 3600_000,
      });
      const held = await h.compute(
        { serviceId: liveService, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(held)).toHaveLength(9);
      expect(starts(held)).not.toContain(MONDAY + 10 * HOUR);
    });

    it('ignores an occupancy that was deactivated', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
        active: false,
      });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(result)).toHaveLength(10);
    });

    /** A slot only partly covered by a block is not offered at all: the block erodes it away. */
    it('erodes the slot a block only partially covers', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      // 14:30-15:00 local: only the 14:00 slot can no longer fit.
      await h.block({
        resourceId: resource,
        from: MONDAY + 12 * HOUR + 30 * MINUTE,
        to: MONDAY + 13 * HOUR,
      });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(result)).toHaveLength(9);
      expect(starts(result)).not.toContain(MONDAY + 12 * HOUR);
      expect(starts(result)).toContain(MONDAY + 11 * HOUR);
      expect(starts(result)).toContain(MONDAY + 13 * HOUR);
    });

    /**
     * The source of truth for blocks is `occupancies`, not `resource_blocks`. A catalogue row on
     * its own blocks nothing: the API writes both, and it is the occupancy the engine subtracts.
     * The test above proves the other half: a block written the way the API writes it removes
     * exactly the same slots it removed when the engine read `resource_blocks` as well.
     */
    it('does not see a block that exists only in resource_blocks', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      await h.admin.execute(sql`
        INSERT INTO resource_blocks (id, project_id, environment, resource_id, period)
        VALUES (gen_random_uuid(), ${h.projectId}, ${h.environment}, ${resource},
                tstzrange(${new Date(MONDAY + 12 * HOUR).toISOString()},
                          ${new Date(MONDAY + 13 * HOUR).toISOString()}, '[)'))
      `);

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(result)).toHaveLength(10);
      expect(starts(result)).toContain(MONDAY + 12 * HOUR);
    });
  });

  describe('buffers', () => {
    /**
     * Overlapping buffers between two adjacent bookings. Duration 60, buffers of 15 on both
     * sides, a 15 minute grid on the local hour, and one booking at 12:00-13:00 local.
     *
     * Without sharing the two footprints must be disjoint, so the gap either side of the
     * booking is `before + after = 30`: the last start before it is 10:30 local and the
     * first after it 13:30. With sharing the gap is `max(before, after) = 15`, which adds
     * exactly one start on each side: 10:45 and 13:15.
     */
    async function bufferScenario(bufferSharing: boolean): Promise<number[]> {
      const resource = await romeResource(1, `Buffered ${String(bufferSharing)}`);
      const service = await h.service({
        durationMinutes: 60,
        bufferBefore: 15,
        bufferAfter: 15,
        slotInterval: 15,
        alignTo: 'hour',
        bufferSharing,
      });
      await h.requirement({ serviceId: service, resourceId: resource });
      // The neighbour was made by this same service, so it carries the same buffers: since
      // migration 0009 the footprint of an occupancy is the one its own service gave it.
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
        bufferBeforeMs: 15 * MINUTE,
        bufferAfterMs: 15 * MINUTE,
      });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      return starts(result);
    }

    it('keeps two bookings a full buffer apart by default', async () => {
      const found = await bufferScenario(false);
      // 09:15 through 10:30 local, then 13:30 through 17:45.
      expect(found[0]).toBe(MONDAY + 7 * HOUR + 15 * MINUTE);
      expect(found).toContain(MONDAY + 8 * HOUR + 30 * MINUTE); // 10:30 local
      expect(found).not.toContain(MONDAY + 8 * HOUR + 45 * MINUTE); // 10:45 local
      expect(found).not.toContain(MONDAY + 11 * HOUR + 15 * MINUTE); // 13:15 local
      expect(found).toContain(MONDAY + 11 * HOUR + 30 * MINUTE); // 13:30 local
      expect(found).toHaveLength(24);
    });

    it('lets the two buffers overlap when buffer_sharing is on', async () => {
      const found = await bufferScenario(true);
      expect(found).toContain(MONDAY + 8 * HOUR + 45 * MINUTE); // 10:45 local
      expect(found).toContain(MONDAY + 11 * HOUR + 15 * MINUTE); // 13:15 local
      // A shared buffer still never reaches into the other booking's core.
      expect(found).not.toContain(MONDAY + 9 * HOUR); // 11:00 local, would end at 12:00
      expect(found).toHaveLength(26);
    });
  });

  describe('groups', () => {
    async function group(
      capacities: number[],
      strategy: 'least_busy' | 'round_robin' | 'first_available' | 'priority' = 'first_available',
    ): Promise<{ groupId: string; resourceIds: string[] }> {
      const location = await h.location('Europe/Rome');
      const schedule = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '19:00' }],
      });
      const resourceIds: string[] = [];
      for (const [index, capacity] of capacities.entries()) {
        resourceIds.push(
          await h.resource({
            name: `Member ${String(index)}`,
            capacity,
            scheduleId: schedule,
            locationId: location,
          }),
        );
      }
      const groupId = await h.group({
        strategy,
        members: resourceIds.map((resourceId, index) => ({ resourceId, priority: index })),
      });
      return { groupId, resourceIds };
    }

    it('offers the slot while at least k of n resources are free', async () => {
      const { groupId, resourceIds } = await group([1, 1, 1]);
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, groupId, quantity: 2 });

      const free = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(free)).toHaveLength(10);

      // Two of the three taken at 12:00-13:00 local leaves one, which is below k = 2.
      await h.occupancy({
        resourceId: resourceIds[0]!,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
      });
      await h.occupancy({
        resourceId: resourceIds[1]!,
        from: MONDAY + 10 * HOUR,
        to: MONDAY + 11 * HOUR,
      });
      const scarce = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(scarce)).toHaveLength(9);
      expect(starts(scarce)).not.toContain(MONDAY + 10 * HOUR);
      expect(scarce.slots[0]!.resourceOptions[0]!.resources).toHaveLength(2);
    });

    /** Eight people over two tables of four, which needs `allow_split`. */
    it('sums the capacity of several resources only when allow_split is on', async () => {
      const { groupId } = await group([4, 4]);
      const together = await h.service({ durationMinutes: 90, allowSplit: true });
      await h.requirement({ serviceId: together, groupId });
      const apart = await h.service({ durationMinutes: 90, allowSplit: false });
      await h.requirement({ serviceId: apart, groupId });

      const split = await h.compute(
        { serviceId: together, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, quantity: 8 },
      );
      expect(split.slots.length).toBeGreaterThan(0);
      expect(split.slots[0]!.availableCapacity).toBe(8);
      expect(split.slots[0]!.resourceOptions[0]!.resources.map((r) => r.capacityUsed)).toEqual([
        4, 4,
      ]);

      const whole = await h.compute(
        { serviceId: apart, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, quantity: 8 },
      );
      expect(whole.slots).toEqual([]);
      expect(whole.nextAvailable).toBeNull();

      // Four still fit on a single table, with or without the flag.
      const four = await h.compute(
        { serviceId: apart, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, quantity: 4 },
      );
      expect(four.slots.length).toBeGreaterThan(0);
    });

    /**
     * The regression the property suite found: combining the group and *then* eroding lets a
     * slot start on one resource and finish on another. Erosion has to happen per resource.
     */
    it('never lets a booking straddle two resources of the group', async () => {
      const location = await h.location('Europe/Rome');
      const early = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '10:00' }],
      });
      const late = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '10:00', endTime: '11:00' }],
      });
      const first = await h.resource({ name: 'Early', scheduleId: early, locationId: location });
      const second = await h.resource({ name: 'Late', scheduleId: late, locationId: location });
      const groupId = await h.group({
        members: [{ resourceId: first }, { resourceId: second }],
      });

      const long = await h.service({ durationMinutes: 90, slotInterval: 60, alignTo: 'hour' });
      await h.requirement({ serviceId: long, groupId });
      const ninety = await h.compute(
        { serviceId: long, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      // Two contiguous hours, but no single resource is open for more than one of them.
      expect(ninety.slots).toEqual([]);

      const short = await h.service({ durationMinutes: 45, slotInterval: 60, alignTo: 'hour' });
      await h.requirement({ serviceId: short, groupId });
      const fortyFive = await h.compute(
        { serviceId: short, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(starts(fortyFive)).toEqual([MONDAY + 7 * HOUR, MONDAY + 8 * HOUR]);
    });

    it('keeps the ranges of two adjacent resources apart', async () => {
      const location = await h.location('Europe/Rome');
      const early = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '10:00' }],
      });
      const late = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '10:00', endTime: '11:00' }],
      });
      const first = await h.resource({ name: 'R1', scheduleId: early, locationId: location });
      const second = await h.resource({ name: 'R2', scheduleId: late, locationId: location });
      const groupId = await h.group({ members: [{ resourceId: first }, { resourceId: second }] });
      const service = await h.service({ durationRange: { min: 30, max: 240 } });
      await h.requirement({ serviceId: service, groupId });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, granularity: 'ranges' },
      );
      expect(result.slots.map((slot) => [slot.start, slot.end])).toEqual([
        [MONDAY + 7 * HOUR, MONDAY + 8 * HOUR],
        [MONDAY + 8 * HOUR, MONDAY + 9 * HOUR],
      ]);
      expect(result.slots[0]!.maxDurationMinutes).toBe(60);
    });

    /**
     * Two requirements whose only candidate is the same resource: the capacity intersection
     * says yes (the resource is free for both), but no assignment exists, because one
     * resource cannot fill two roles at once. The engine is conservative and offers nothing
     * rather than a slot the booking transaction would reject with `slot_unavailable`.
     */
    it('offers nothing when two requirements fight over the same resource', async () => {
      const location = await h.location('Europe/Rome');
      const schedule = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '13:00' }],
      });
      const shared = await h.resource({
        name: 'Multi',
        scheduleId: schedule,
        locationId: location,
      });
      const doctors = await h.group({ name: 'doctors', members: [{ resourceId: shared }] });
      const nurses = await h.group({ name: 'nurses', members: [{ resourceId: shared }] });
      const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
      await h.requirement({ serviceId: service, groupId: doctors, position: 0, role: 'doctor' });
      await h.requirement({ serviceId: service, groupId: nurses, position: 1, role: 'nurse' });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      expect(result.slots).toEqual([]);
      expect(result.nextAvailable).toBeNull();

      // A second resource in the nurses group and the same request is satisfiable again.
      const second = await h.resource({
        name: 'Nurse',
        scheduleId: schedule,
        locationId: location,
      });
      await h.addGroupMember(nurses, second, 1);
      const fixed = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      // 09:00-13:00 local with a one hour service: four hourly starts, the last at 12:00.
      expect(starts(fixed)).toEqual([
        MONDAY + 7 * HOUR,
        MONDAY + 8 * HOUR,
        MONDAY + 9 * HOUR,
        MONDAY + 10 * HOUR,
      ]);
      expect(fixed.slots[0]!.resourceOptions[0]!.resources).toEqual([
        { resourceId: shared, role: 'doctor', capacityUsed: 1 },
        { resourceId: second, role: 'nurse', capacityUsed: 1 },
      ]);
    });

    /**
     * `allow_split` with a requirement that also asks for **two** resources: a greedy
     * split gives the first table everything and leaves the second one nothing to do, so the
     * assignment used to come out empty on a slot the capacity said was feasible.
     */
    it('splits a party across the number of resources the requirement asks for', async () => {
      const { groupId } = await group([4, 4]);
      const service = await h.service({ durationMinutes: 60, allowSplit: true });
      await h.requirement({ serviceId: service, groupId, quantity: 2 });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, quantity: 4 },
      );
      expect(result.slots.length).toBeGreaterThan(0);
      const first = result.slots[0]!;
      expect(first.availableCapacity).toBe(8);
      expect(first.resourceOptions.length).toBeGreaterThan(0);
      const resources = first.resourceOptions[0]!.resources;
      expect(resources).toHaveLength(2);
      expect(resources.reduce((sum, one) => sum + one.capacityUsed, 0)).toBe(4);
    });

    it('never offers a resource that is inactive or soft deleted', async () => {
      const location = await h.location('Europe/Rome');
      const schedule = await h.schedule({
        rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '19:00' }],
      });
      const good = await h.resource({ name: 'Good', scheduleId: schedule, locationId: location });
      const gone = await h.resource({
        name: 'Gone',
        scheduleId: schedule,
        locationId: location,
        deleted: true,
      });
      const off = await h.resource({
        name: 'Off',
        scheduleId: schedule,
        locationId: location,
        status: 'inactive',
      });
      const groupId = await h.group({
        members: [{ resourceId: good }, { resourceId: gone }, { resourceId: off }],
      });
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, groupId });

      const data = await h.load({ serviceId: service, from: MONDAY, to: TUESDAY });
      expect(data.resources.map((r) => r.id)).toEqual([good]);
      expect(data.requirements[0]!.resourceIds).toEqual([good]);
    });

    it('honours an explicit resource_ids filter', async () => {
      const { groupId, resourceIds } = await group([1, 1]);
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, groupId });
      const data = await h.load({
        serviceId: service,
        from: MONDAY,
        to: TUESDAY,
        resourceIds: [resourceIds[1]!],
      });
      expect(data.requirements[0]!.resourceIds).toEqual([resourceIds[1]!]);
    });
  });

  it('intersects two requirements', async () => {
    const location = await h.location('Europe/Rome');
    const morning = await h.schedule({
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '09:00', endTime: '13:00' }],
    });
    const afternoon = await h.schedule({
      rules: [{ daysOfWeek: WEEKDAYS, startTime: '11:00', endTime: '19:00' }],
    });
    const therapist = await h.resource({
      name: 'Therapist',
      scheduleId: morning,
      locationId: location,
    });
    const cabin = await h.resource({ name: 'Cabin', scheduleId: afternoon, locationId: location });
    const service = await h.service({ durationMinutes: 60 });
    await h.requirement({
      serviceId: service,
      resourceId: therapist,
      role: 'operator',
      position: 0,
    });
    await h.requirement({ serviceId: service, resourceId: cabin, role: 'cabin', position: 1 });

    const result = await h.compute(
      { serviceId: service, from: MONDAY, to: TUESDAY },
      { now: MONDAY - DAY },
    );
    // Both open only between 11:00 and 13:00 local, which is 09:00Z and 11:00Z.
    expect(starts(result)).toEqual([MONDAY + 9 * HOUR, MONDAY + 10 * HOUR]);
    expect(result.slots[0]!.resourceOptions[0]!.resources).toEqual([
      { resourceId: therapist, role: 'operator', capacityUsed: 1 },
      { resourceId: cabin, role: 'cabin', capacityUsed: 1 },
    ]);
  });

  describe('the booking window', () => {
    it('trims the window with min_notice and max_advance', async () => {
      const resource = await romeResource();
      const service = await h.service({
        durationMinutes: 60,
        bookingWindow: { min_notice_minutes: 120, max_advance_days: 1 },
      });
      await h.requirement({ serviceId: service, resourceId: resource });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: utc(2026, 6, 3) },
        { now: MONDAY + 6 * HOUR },
      );
      // Two hours of notice push the first start to 08:00Z (10:00 local); the horizon of one
      // day ends at Tuesday 06:00Z, before Tuesday opens at 07:00Z.
      expect(starts(result)).toEqual([
        MONDAY + 8 * HOUR,
        MONDAY + 9 * HOUR,
        MONDAY + 10 * HOUR,
        MONDAY + 11 * HOUR,
        MONDAY + 12 * HOUR,
        MONDAY + 13 * HOUR,
        MONDAY + 14 * HOUR,
        MONDAY + 15 * HOUR,
        MONDAY + 16 * HOUR,
      ]);
    });

    /** A request wider than 90 days is refused, not silently narrowed. */
    it('refuses a window wider than ninety days', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      await expect(
        h.compute(
          { serviceId: service, from: MONDAY, to: MONDAY + 91 * DAY },
          { now: MONDAY - DAY },
        ),
      ).rejects.toMatchObject({ type: 'invalid_request', code: 'range_too_large' });

      // Ninety days exactly is fine.
      const ninety = await h.compute(
        { serviceId: service, from: MONDAY, to: MONDAY + 90 * DAY },
        { now: MONDAY - DAY },
      );
      expect(ninety.slots.length).toBeGreaterThan(600);
    });
  });

  describe('the customer', () => {
    it('returns no slots and a reason when the customer is at the policy limit', async () => {
      const resource = await romeResource();
      const policy = await h.policy({ maxActiveBookingsPerCustomer: 1 });
      const service = await h.service({ durationMinutes: 60, policyId: policy });
      await h.requirement({ serviceId: service, resourceId: resource });
      const customer = await h.customer();
      await h.booking({
        serviceId: service,
        customerId: customer,
        from: Date.now() + 30 * DAY,
        to: Date.now() + 30 * DAY + HOUR,
        status: 'confirmed',
      });

      const blocked = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY, customerId: customer },
        { now: MONDAY - DAY },
      );
      expect(blocked.slots).toEqual([]);
      expect(blocked.reason?.code).toBe('customer_limit_reached');

      // Another customer is unaffected, and so is an anonymous request.
      const other = await h.customer();
      const free = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY, customerId: other },
        { now: MONDAY - DAY },
      );
      expect(free.slots).toHaveLength(10);
      expect(free.reason).toBeUndefined();
    });

    it('does not count a cancelled booking against the limit', async () => {
      const resource = await romeResource();
      const policy = await h.policy({ maxActiveBookingsPerCustomer: 1 });
      const service = await h.service({ durationMinutes: 60, policyId: policy });
      await h.requirement({ serviceId: service, resourceId: resource });
      const customer = await h.customer();
      await h.booking({
        serviceId: service,
        customerId: customer,
        from: Date.now() + 30 * DAY,
        to: Date.now() + 30 * DAY + HOUR,
        status: 'cancelled',
      });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY, customerId: customer },
        { now: MONDAY - DAY },
      );
      expect(result.slots).toHaveLength(10);
    });

    /**
     * A `confirmed` booking that nobody ever moved to `completed` must not block the customer
     * for the rest of time: only the bookings whose end is still in the future count towards
     * `max_active_bookings_per_customer`.
     */
    it('does not count a booking that is already over', async () => {
      const resource = await romeResource();
      const policy = await h.policy({ maxActiveBookingsPerCustomer: 1 });
      const service = await h.service({ durationMinutes: 60, policyId: policy });
      await h.requirement({ serviceId: service, resourceId: resource });
      const customer = await h.customer();
      await h.booking({
        serviceId: service,
        customerId: customer,
        from: utc(2020, 1, 6, 10),
        to: utc(2020, 1, 6, 11),
        status: 'confirmed',
      });

      const data = await h.load({
        serviceId: service,
        from: MONDAY,
        to: TUESDAY,
        customerId: customer,
      });
      expect(data.customerActiveBookings).toBe(0);

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY, customerId: customer },
        { now: MONDAY - DAY },
      );
      expect(result.slots).toHaveLength(10);
      expect(result.reason).toBeUndefined();
    });

    /**
     * The customer's own time zone is presentation only. The engine never reads it, so passing
     * a customer who lives in Tokyo cannot move a single slot.
     */
    it('computes on the resource, never on the customer time zone', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      const customer = await h.customer();
      await h.setCustomerTimezone(customer, 'Asia/Tokyo');

      const anonymous = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      const identified = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY, customerId: customer },
        { now: MONDAY - DAY },
      );
      expect(starts(identified)).toEqual(starts(anonymous));
    });
  });

  describe('durations', () => {
    it('offers every duration option, sorted by start and then by length', async () => {
      const resource = await romeResource();
      const service = await h.service({ durationOptions: [30, 60] });
      await h.requirement({ serviceId: service, resourceId: resource });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      // Interval defaults to the shortest option: 20 starts of 30 minutes (09:00 to 18:30)
      // and 19 of 60 (09:00 to 18:00).
      expect(result.slots.filter((slot) => slot.durationMinutes === 30)).toHaveLength(20);
      expect(result.slots.filter((slot) => slot.durationMinutes === 60)).toHaveLength(19);
      expect(result.slots.slice(0, 2).map((slot) => slot.durationMinutes)).toEqual([30, 60]);
      expect(result.slots[0]!.start).toBe(MONDAY + 7 * HOUR);
      expect(result.slots[0]!.end).toBe(MONDAY + 7 * HOUR + 30 * MINUTE);
    });

    it('returns continuous ranges for a duration range', async () => {
      const resource = await romeResource();
      const service = await h.service({
        durationRange: { min: 60, max: 480 },
        bufferAfter: 30,
      });
      await h.requirement({ serviceId: service, resourceId: resource });

      const empty = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, granularity: 'ranges' },
      );
      // The whole 09:00-19:00 band minus the half hour of cleaning at the end.
      expect(empty.slots).toHaveLength(1);
      expect(empty.slots[0]).toMatchObject({
        start: MONDAY + 7 * HOUR,
        end: MONDAY + 16 * HOUR + 30 * MINUTE,
        durationMinutes: null,
        minDurationMinutes: 60,
        maxDurationMinutes: 480,
      });

      // A booking in the middle cuts the day in two ranges. It was made by this same service,
      // so it carries this service's half hour of cleaning after it (migration 0009).
      await h.occupancy({
        resourceId: resource,
        from: MONDAY + 11 * HOUR,
        to: MONDAY + 12 * HOUR,
        bufferAfterMs: 30 * MINUTE,
      });
      const split = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, granularity: 'ranges' },
      );
      expect(split.slots.map((slot) => [slot.start, slot.end])).toEqual([
        [MONDAY + 7 * HOUR, MONDAY + 10 * HOUR + 30 * MINUTE],
        [MONDAY + 12 * HOUR + 30 * MINUTE, MONDAY + 16 * HOUR + 30 * MINUTE],
      ]);
      expect(split.slots[0]!.maxDurationMinutes).toBe(210);
    });

    /**
     * An interval is a family of bookings, and the price shown is the price of the **shortest
     * booking that starts at the start of the interval**. The two rules below pin both halves
     * of that sentence: the one on the noon band would match in the middle of the interval and
     * must not fire, the one on `duration_min` matches only at the minimum length and must.
     * Swapping `min` for `max`, or `start` for the middle, changes the answer here and nowhere
     * else in the suite.
     */
    it('prices a continuous range at its start and at the shortest bookable length', async () => {
      const resource = await romeResource();
      const service = await h.service({
        durationRange: { min: 60, max: 480 },
        price: { amount: 3000, currency: 'EUR' },
        pricingRules: [
          { when: { time_from: '12:00', time_to: '13:00' }, price: 9900, label: 'Noon' },
          { when: { duration_min: 60 }, price_add: 500, label: 'Shortest' },
        ],
      });
      await h.requirement({ serviceId: service, resourceId: resource });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY, granularity: 'ranges' },
      );

      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]).toMatchObject({
        start: MONDAY + 7 * HOUR,
        durationMinutes: null,
        minDurationMinutes: 60,
        price: { amount: 3500, currency: 'EUR' },
        priceRule: { index: 1, label: 'Shortest' },
      });
    });
  });

  describe('time zones', () => {
    async function nineToOne(timezone: string): Promise<number[]> {
      const schedule = await h.schedule({
        timezone,
        rules: [{ daysOfWeek: EVERY_DAY, startTime: '09:00', endTime: '13:00' }],
      });
      const resource = await h.resource({ name: timezone, scheduleId: schedule });
      const service = await h.service({
        durationMinutes: 60,
        slotInterval: 60,
        alignTo: 'hour',
      });
      await h.requirement({ serviceId: service, resourceId: resource });
      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      return starts(result);
    }

    /**
     * The trap the zone offset exists to avoid: an `epoch` alignment without it puts the starts
     * of an Indian 09:00-13:00 schedule at 09:30, and a Nepalese one at 09:45.
     */
    it('aligns the grid to the local hour in Asia/Kolkata (+05:30)', async () => {
      const found = await nineToOne('Asia/Kolkata');
      const nine = MONDAY + 3 * HOUR + 30 * MINUTE; // 09:00 IST
      expect(found).toEqual([nine, nine + HOUR, nine + 2 * HOUR, nine + 3 * HOUR]);
    });

    it('aligns the grid to the local hour in Asia/Kathmandu (+05:45)', async () => {
      const found = await nineToOne('Asia/Kathmandu');
      const nine = MONDAY + 3 * HOUR + 15 * MINUTE; // 09:00 NPT
      expect(found).toEqual([nine, nine + HOUR, nine + 2 * HOUR, nine + 3 * HOUR]);
    });

    /**
     * The whole point of cutting the timeline at every offset change: a grid aligned to the
     * local hour has to stay on the local hour across a DST transition, and the day of the
     * change is 23 hours long. Rome springs forward on 29 March 2026 at 02:00 local.
     */
    it('keeps the grid on the local hour across a DST transition', async () => {
      const schedule = await h.schedule({
        timezone: 'Europe/Rome',
        rules: [{ daysOfWeek: EVERY_DAY, startTime: '09:00', endTime: '13:00' }],
      });
      const resource = await h.resource({ name: 'Spring forward', scheduleId: schedule });
      const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
      await h.requirement({ serviceId: service, resourceId: resource });

      const from = utc(2026, 3, 28);
      const result = await h.compute(
        { serviceId: service, from, to: utc(2026, 3, 31) },
        { now: from - DAY },
      );
      // 28 March is CET (+01:00): 09:00 local is 08:00Z. 29 and 30 March are CEST (+02:00):
      // 09:00 local is 07:00Z. Four hourly starts on each of the three days.
      expect(starts(result)).toEqual([
        from + 8 * HOUR,
        from + 9 * HOUR,
        from + 10 * HOUR,
        from + 11 * HOUR,
        utc(2026, 3, 29) + 7 * HOUR,
        utc(2026, 3, 29) + 8 * HOUR,
        utc(2026, 3, 29) + 9 * HOUR,
        utc(2026, 3, 29) + 10 * HOUR,
        utc(2026, 3, 30) + 7 * HOUR,
        utc(2026, 3, 30) + 8 * HOUR,
        utc(2026, 3, 30) + 9 * HOUR,
        utc(2026, 3, 30) + 10 * HOUR,
      ]);
    });

    it('falls back to the location time zone and refuses a resource that has neither', async () => {
      const location = await h.location('America/New_York', 'NYC');
      const schedule = await h.schedule({
        rules: [{ daysOfWeek: EVERY_DAY, startTime: '09:00', endTime: '13:00' }],
      });
      const resource = await h.resource({ scheduleId: schedule, locationId: location });
      const service = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: service, resourceId: resource });
      const data = await h.load({ serviceId: service, from: MONDAY, to: TUESDAY });
      expect(data.resources[0]!.timezone).toBe('America/New_York');
      expect(data.timezone).toBe('America/New_York');

      const orphan = await h.resource({ name: 'Orphan', scheduleId: schedule });
      const lost = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: lost, resourceId: orphan });
      await expect(h.load({ serviceId: lost, from: MONDAY, to: TUESDAY })).rejects.toMatchObject({
        type: 'invalid_request',
        code: 'timezone_missing',
      });

      // And a resource with no schedule *and* no location is refused too, rather than being
      // given a silent UTC that would then decide the grid of everybody else.
      const nowhere = await h.resource({ name: 'Nowhere' });
      const homeless = await h.service({ durationMinutes: 60 });
      await h.requirement({ serviceId: homeless, resourceId: nowhere });
      await expect(
        h.load({ serviceId: homeless, from: MONDAY, to: TUESDAY }),
      ).rejects.toMatchObject({ type: 'invalid_request', code: 'timezone_missing' });
    });

    /**
     * The band migration 0008 made storable. `22:00-02:00` is four hours across midnight,
     * and the API could not save it before migration 0008.
     */
    it('materializes a band that crosses midnight', async () => {
      const schedule = await h.schedule({
        timezone: 'Europe/Rome',
        rules: [{ daysOfWeek: EVERY_DAY, startTime: '22:00', endTime: '02:00' }],
      });
      const resource = await h.resource({ name: 'Night bar', scheduleId: schedule });
      const service = await h.service({ durationMinutes: 60, slotInterval: 60, alignTo: 'hour' });
      await h.requirement({ serviceId: service, resourceId: resource });

      const result = await h.compute(
        { serviceId: service, from: MONDAY, to: TUESDAY },
        { now: MONDAY - DAY },
      );
      // Monday's band runs from 22:00 local (20:00Z) to 02:00 on Tuesday (Tuesday 00:00Z),
      // so the last hourly start is 01:00 local.
      expect(starts(result)).toEqual([
        MONDAY + 20 * HOUR, // 22:00 local
        MONDAY + 21 * HOUR, // 23:00 local
        MONDAY + 22 * HOUR, // 00:00 local, the day after
        MONDAY + 23 * HOUR, // 01:00 local, ends exactly at 02:00
      ]);
    });
  });
});
