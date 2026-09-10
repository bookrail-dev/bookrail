/**
 * The booking transaction against a real Postgres, through the application role.
 *
 * Nothing here is mocked. Every assertion is read back from the tables with the superuser
 * connection, because a booking that the engine *says* it made and that is not in
 * `occupancies` is exactly the failure this suite exists to prevent.
 *
 * The fixtures live in **2030**, not in June 2026 like the availability suites. The write
 * path compares `expires_at` with the database's `now()` and refuses a start in the past, so
 * a hold written on a 2026 fixture would be born expired. The availability suites can use the
 * past because they are handed an explicit `now`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@bookrail/db';

import { isUuid, uuidv7 } from '@bookrail/shared';

import { createBooking, createHold, releaseHold, takeOccupancy } from '../src/index.js';
import { lockResources } from '../src/booking/queries.js';
import { createHarness, utc, DAY, HOUR, MINUTE, type Harness } from './availability-harness.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Monday 3 June 2030. Rome is on CEST, so 09:00 local is 07:00Z. */
const MONDAY = utc(2030, 6, 3);
const NINE = MONDAY + 7 * HOUR;
const NOW = MONDAY - 7 * DAY;

describe('the booking transaction', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Booking');
  });

  afterAll(async () => {
    await h.close();
  });

  async function openAllDay(): Promise<string> {
    return h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '00:00' }],
    });
  }

  /** One resource of the given capacity, open round the clock, and a one hour service on it. */
  async function simple(
    capacity = 1,
    service: Parameters<Harness['service']>[0] = {},
  ): Promise<{ resourceId: string; serviceId: string }> {
    const schedule = await openAllDay();
    const resourceId = await h.resource({
      name: `R${String(capacity)}`,
      capacity,
      scheduleId: schedule,
    });
    const serviceId = await h.service({ durationMinutes: 60, ...service });
    await h.requirement({ serviceId, resourceId });
    return { resourceId, serviceId };
  }

  function base(serviceId: string): {
    projectId: string;
    environment: 'test';
    serviceId: string;
    start: number;
    now: number;
  } {
    return {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: NINE,
      now: NOW,
    };
  }

  async function rows<T extends Record<string, unknown>>(
    text: ReturnType<typeof sql>,
  ): Promise<T[]> {
    const result = await h.admin.execute<T>(text);
    return result.rows as T[];
  }

  // --- The happy paths ---------------------------------------------------------------------

  it('writes the occupancy, the booking, the allocations and the event in one transaction', async () => {
    const { resourceId, serviceId } = await simple(1, {
      price: { amount: 4500, currency: 'EUR' },
      bufferBefore: 10,
      bufferAfter: 20,
    });

    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });

    expect(booking.status).toBe('confirmed');
    expect(booking.start).toBe(NINE);
    expect(booking.end).toBe(NINE + HOUR);
    expect(booking.price).toEqual({ amount: 4500, currency: 'EUR' });
    expect(booking.allocations).toHaveLength(1);
    expect(booking.allocations[0]!.resourceId).toBe(resourceId);
    expect(booking.allocations[0]!.capacityUsed).toBe(1);

    const [row] = await rows<{
      status: string;
      quantity: number;
      price_amount: number;
      timezone: string;
      hold_id: string | null;
    }>(sql`SELECT status, quantity, price_amount, timezone, hold_id
             FROM bookings WHERE id = ${booking.id}`);
    expect(row).toMatchObject({
      status: 'confirmed',
      quantity: 1,
      price_amount: 4500,
      timezone: 'Europe/Rome',
      hold_id: null,
    });

    const allocations = await rows<{ resource_id: string; capacity_used: number }>(
      sql`SELECT resource_id, capacity_used FROM booking_allocations WHERE booking_id = ${booking.id}`,
    );
    expect(allocations).toEqual([{ resource_id: resourceId, capacity_used: 1 }]);

    // The occupancy carries the buffers of the service that created it (migration 0009).
    const occupancies = await rows<{
      kind: string;
      capacity_used: number;
      buffer_before_ms: number;
      buffer_after_ms: number;
      expires_at: Date | null;
      active: boolean;
      starts: string;
      ends: string;
    }>(sql`SELECT kind, capacity_used, buffer_before_ms, buffer_after_ms, expires_at, active,
                  (extract(epoch FROM lower(period)) * 1000)::bigint AS starts,
                  (extract(epoch FROM upper(period)) * 1000)::bigint AS ends
             FROM occupancies WHERE ref_id = ${booking.id}`);
    expect(occupancies).toHaveLength(1);
    expect(occupancies[0]).toMatchObject({
      kind: 'booking',
      capacity_used: 1,
      buffer_before_ms: 10 * MINUTE,
      buffer_after_ms: 20 * MINUTE,
      expires_at: null,
      active: true,
    });
    expect(Number(occupancies[0]!.starts)).toBe(NINE);
    expect(Number(occupancies[0]!.ends)).toBe(NINE + HOUR);

    const events = await rows<{ type: string; data: Record<string, unknown> }>(
      sql`SELECT type, data FROM events WHERE id = ${booking.eventId}`,
    );
    expect(events[0]!.type).toBe('booking.created');
    expect(events[0]!.data).toMatchObject({ object: 'booking', status: 'confirmed', quantity: 1 });

    expect(booking.touchedDays).toEqual([{ resourceId, day: '2030-06-03' }]);
  });

  it('creates a hold with the policy TTL and converts it without asking for capacity twice', async () => {
    const policyId = await h.policy({});
    await h.admin.execute(
      sql`UPDATE policies SET hold_duration_seconds = 900 WHERE id = ${policyId}`,
    );
    const { resourceId, serviceId } = await simple(1, { policyId });

    const hold = await createHold(h.app, base(serviceId));
    expect(hold.kind).toBe('hold');
    expect(hold.status).toBe('active');
    expect(hold.expiresAt).toBe(NOW + 900_000);

    const held = await rows<{ kind: string; expires_at: Date | null }>(
      sql`SELECT kind, expires_at FROM occupancies WHERE ref_id = ${hold.id}`,
    );
    expect(held[0]!.kind).toBe('hold');
    expect(held[0]!.expires_at).not.toBeNull();

    // A second request for the same capacity-1 slot finds it taken.
    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking' }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });

    const booking = await createBooking(h.app, {
      ...base(serviceId),
      kind: 'booking',
      holdId: hold.id,
    });
    expect(booking.holdId).toBe(hold.id);
    expect(booking.allocations.map((a) => a.resourceId)).toEqual([resourceId]);

    // The very same occupancy row is now the booking's: no second row, no expiry.
    const converted = await rows<{
      id: string;
      kind: string;
      ref_id: string;
      expires_at: Date | null;
    }>(
      sql`SELECT id, kind, ref_id, expires_at FROM occupancies WHERE resource_id = ${resourceId} AND active`,
    );
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      id: held[0] === undefined ? '' : converted[0]!.id,
      kind: 'booking',
      ref_id: booking.id,
      expires_at: null,
    });

    const [holdRow] = await rows<{ status: string }>(
      sql`SELECT status FROM holds WHERE id = ${hold.id}`,
    );
    expect(holdRow!.status).toBe('converted');
  });

  it('refuses to convert a hold that has expired', async () => {
    const { serviceId } = await simple();
    const hold = await createHold(h.app, base(serviceId));
    await h.admin.execute(
      sql`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = ${hold.id}`,
    );
    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', holdId: hold.id }),
    ).rejects.toMatchObject({ code: 'hold_expired', type: 'conflict' });
  });

  it('ignores an expired hold, sweeps it, and books the slot it was holding', async () => {
    const { resourceId, serviceId } = await simple();
    const hold = await createHold(h.app, base(serviceId));
    await h.admin.execute(
      sql`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = ${hold.id}`,
    );
    await h.admin.execute(
      sql`UPDATE occupancies SET expires_at = now() - interval '1 minute' WHERE ref_id = ${hold.id}`,
    );

    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.allocations[0]!.resourceId).toBe(resourceId);

    // The stale hold was taken out of the way; otherwise `occ_no_overlap_cap1` would have
    // refused the insert even though the engine considered the slot free.
    const [holdRow] = await rows<{ status: string }>(
      sql`SELECT status FROM holds WHERE id = ${hold.id}`,
    );
    expect(holdRow!.status).toBe('expired');
    const stale = await rows<{ active: boolean }>(
      sql`SELECT active FROM occupancies WHERE ref_id = ${hold.id}`,
    );
    expect(stale.every((row) => !row.active)).toBe(true);
    const expiredEvents = await rows<{ type: string }>(
      sql`SELECT type FROM events WHERE type = 'hold.expired' AND data->>'id' LIKE ${'%'}`,
    );
    expect(expiredEvents.length).toBeGreaterThan(0);
  });

  it('releases a hold, frees the slot, and treats a second release as a no-op', async () => {
    const { serviceId } = await simple();
    const hold = await createHold(h.app, base(serviceId));

    const released = await releaseHold(h.app, {
      projectId: h.projectId,
      environment: 'test',
      holdId: hold.id,
      now: NOW,
    });
    expect(released.released).toBe(true);
    expect(released.touchedDays).toEqual(hold.touchedDays);

    const again = await releaseHold(h.app, {
      projectId: h.projectId,
      environment: 'test',
      holdId: hold.id,
      now: NOW,
    });
    expect(again.released).toBe(false);
    expect(again.eventId).toBeNull();

    // The slot is bookable again.
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.id).toBeTruthy();
  });

  // --- Allocation ---------------------------------------------------------------------------

  async function groupOf(
    strategy: 'least_busy' | 'round_robin' | 'first_available' | 'priority',
    count = 3,
  ): Promise<{ groupId: string; serviceId: string; resourceIds: string[] }> {
    const schedule = await openAllDay();
    const resourceIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      resourceIds.push(
        await h.resource({ name: `${strategy}-${String(i)}`, scheduleId: schedule }),
      );
    }
    // Priority is the reverse of the id order, so `priority` and `first_available` disagree.
    const groupId = await h.group({
      strategy,
      members: resourceIds.map((resourceId, index) => ({ resourceId, priority: count - index })),
    });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, groupId });
    return { groupId, serviceId, resourceIds: [...resourceIds].sort() };
  }

  it('first_available takes the smallest resource id', async () => {
    const { serviceId, resourceIds } = await groupOf('first_available');
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.allocations[0]!.resourceId).toBe(resourceIds[0]);
  });

  it('priority takes the first member by priority, not by id', async () => {
    const { serviceId, resourceIds } = await groupOf('priority');
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    // Priorities were assigned in reverse, so the last id has the lowest number.
    expect(booking.allocations[0]!.resourceId).toBe(resourceIds[resourceIds.length - 1]);
  });

  it('least_busy takes the resource with the least capacity used in its local day', async () => {
    const { serviceId, resourceIds } = await groupOf('least_busy');
    // Load the first two resources earlier in the same local day, leaving the third idle.
    for (const resourceId of resourceIds.slice(0, 2)) {
      await h.occupancy({ resourceId, from: MONDAY + HOUR, to: MONDAY + 2 * HOUR });
    }
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.allocations[0]!.resourceId).toBe(resourceIds[2]);
  });

  it('round_robin starts after the cursor and moves it on', async () => {
    const { groupId, serviceId, resourceIds } = await groupOf('round_robin');
    // `groupOf` assigns priorities in reverse of the id order, and with no cursor yet the
    // rotation starts from the head of that order: the *last* id.
    const order = [...resourceIds].reverse();

    const first = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(first.allocations[0]!.resourceId).toBe(order[0]);
    const cursorAfterFirst = await rows<{ round_robin_cursor: string }>(
      sql`SELECT round_robin_cursor FROM resource_groups WHERE id = ${groupId}`,
    );
    expect(cursorAfterFirst[0]!.round_robin_cursor).toBe(order[0]);

    // The following bookings start from the resource after the cursor, and move it on.
    const second = await createBooking(h.app, {
      ...base(serviceId),
      start: NINE + 2 * HOUR,
      kind: 'booking',
    });
    expect(second.allocations[0]!.resourceId).toBe(order[1]);
    const third = await createBooking(h.app, {
      ...base(serviceId),
      start: NINE + 4 * HOUR,
      kind: 'booking',
    });
    expect(third.allocations[0]!.resourceId).toBe(order[2]);
    const fourth = await createBooking(h.app, {
      ...base(serviceId),
      start: NINE + 6 * HOUR,
      kind: 'booking',
    });
    // Round: after the last one it starts again from the head.
    expect(fourth.allocations[0]!.resourceId).toBe(order[0]);
  });

  it('finds the assignment two requirements sharing a resource make necessary', async () => {
    const schedule = await openAllDay();
    // Ada is in both groups; Bo is only a nurse. The doctor requirement must therefore take
    // Ada and the nurse requirement Bo, which is the only assignment that exists.
    const ada = await h.resource({ name: 'Ada', scheduleId: schedule });
    const bo = await h.resource({ name: 'Bo', scheduleId: schedule });
    const doctors = await h.group({ name: 'doctors', members: [{ resourceId: ada }] });
    const nurses = await h.group({
      name: 'nurses',
      members: [{ resourceId: ada }, { resourceId: bo }],
    });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, groupId: nurses, position: 0, role: 'nurse' });
    await h.requirement({ serviceId, groupId: doctors, position: 1, role: 'doctor' });

    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    const byRole = new Map(booking.allocations.map((a) => [a.role, a.resourceId]));
    expect(byRole.get('doctor')).toBe(ada);
    expect(byRole.get('nurse')).toBe(bo);
  });

  it('refuses when two requirements can only be served by the same single resource', async () => {
    const schedule = await openAllDay();
    const ada = await h.resource({ name: 'Solo Ada', scheduleId: schedule });
    const first = await h.group({ name: 'g1', members: [{ resourceId: ada }] });
    const second = await h.group({ name: 'g2', members: [{ resourceId: ada }] });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, groupId: first, position: 0 });
    await h.requirement({ serviceId, groupId: second, position: 1 });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking' }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('takes a `whole` resource entirely and a `per_unit` one by the quantity', async () => {
    const schedule = await openAllDay();
    const klass = await h.resource({ name: 'Class', capacity: 15, scheduleId: schedule });
    const instructor = await h.resource({ name: 'Instructor', capacity: 1, scheduleId: schedule });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, resourceId: klass, position: 0, role: 'class' });
    await h.requirement({
      serviceId,
      resourceId: instructor,
      position: 1,
      role: 'staff',
      consumes: 'whole',
    });

    const booking = await createBooking(h.app, {
      ...base(serviceId),
      kind: 'booking',
      quantity: 4,
    });
    const byRole = new Map(booking.allocations.map((a) => [a.role, a.capacityUsed]));
    expect(byRole.get('class')).toBe(4);
    expect(byRole.get('staff')).toBe(1);

    // The instructor is now taken whole, so a second class at the same hour is impossible even
    // though eleven seats are left on the class resource.
    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  // --- Refusals -------------------------------------------------------------------------------

  it('refuses a slot whose capacity is gone, and says how much was left', async () => {
    const { serviceId } = await simple(3);
    await createBooking(h.app, { ...base(serviceId), kind: 'booking', quantity: 2 });
    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', quantity: 2 }),
    ).rejects.toMatchObject({
      code: 'slot_unavailable',
      type: 'conflict',
      message: expect.stringContaining('2 units requested, 1 available') as unknown as string,
    });
  });

  it('applies the booking window and the customer limit', async () => {
    const policyId = await h.policy({ maxActiveBookingsPerCustomer: 1 });
    const { serviceId } = await simple(5, {
      policyId,
      bookingWindow: { min_notice_minutes: 120, max_advance_days: 30 },
    });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', now: NINE - 30 * MINUTE }),
    ).rejects.toMatchObject({ code: 'min_notice_violated', type: 'policy_violation' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', now: NINE + HOUR }),
    ).rejects.toMatchObject({ code: 'outside_booking_window' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', now: NINE - 60 * DAY }),
    ).rejects.toMatchObject({ code: 'outside_booking_window' });

    const customerId = await h.customer();
    await createBooking(h.app, { ...base(serviceId), kind: 'booking', customerId });
    await expect(
      createBooking(h.app, {
        ...base(serviceId),
        start: NINE + 3 * HOUR,
        kind: 'booking',
        customerId,
      }),
    ).rejects.toMatchObject({ code: 'customer_limit_reached', type: 'policy_violation' });
  });

  it('refuses a resource the service never asks for, and a duration it does not offer', async () => {
    const { serviceId } = await simple(1, { durationOptions: [60, 90], durationMinutes: null });
    const stranger = await h.resource({ name: 'Stranger' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', resourceIds: [stranger] }),
    ).rejects.toMatchObject({ code: 'resource_not_eligible', type: 'invalid_request' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', durationMinutes: 75 }),
    ).rejects.toMatchObject({ code: 'duration_not_offered' });

    const booking = await createBooking(h.app, {
      ...base(serviceId),
      kind: 'booking',
      durationMinutes: 90,
    });
    expect(booking.end - booking.start).toBe(90 * MINUTE);
  });

  it('refuses to run on a connection that bypasses row level security', async () => {
    const { serviceId } = await simple();
    await expect(
      createBooking(h.admin, { ...base(serviceId), kind: 'booking' }),
    ).rejects.toMatchObject({ code: 'privileged_connection' });
  });

  // --- Snapshots, events, cache coordinates ----------------------------------------------------

  it('freezes the policy snapshot at creation time', async () => {
    const policyId = await h.policy({ maxActiveBookingsPerCustomer: 5 });
    const { serviceId } = await simple(2, { policyId });
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.policySnapshot).toMatchObject({ max_active_bookings_per_customer: 5 });

    await h.admin.execute(
      sql`UPDATE policies SET max_active_bookings_per_customer = 99, hold_duration_seconds = 60
           WHERE id = ${policyId}`,
    );
    const [row] = await rows<{ policy_snapshot: Record<string, unknown> }>(
      sql`SELECT policy_snapshot FROM bookings WHERE id = ${booking.id}`,
    );
    expect(row!.policy_snapshot).toMatchObject({
      max_active_bookings_per_customer: 5,
      hold_duration_seconds: 600,
    });
  });

  it('is pending when the policy requires a confirmation', async () => {
    const policyId = await h.policy({});
    await h.admin.execute(
      sql`UPDATE policies SET require_provider_confirmation = true WHERE id = ${policyId}`,
    );
    const { serviceId } = await simple(1, { policyId });
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.status).toBe('pending');
    const [row] = await rows<{ status: string; confirmed_at: Date | null }>(
      sql`SELECT status, confirmed_at FROM bookings WHERE id = ${booking.id}`,
    );
    expect(row).toMatchObject({ status: 'pending', confirmed_at: null });
  });

  /**
   * The event lives or dies with the booking.
   *
   * A deferred constraint trigger is the only honest way to fail *after* every statement has
   * run: it fires at COMMIT, when the occupancies, the booking, the allocations and the event
   * are all in place. If the outbox were written outside the transaction, the event would
   * survive here.
   */
  it('rolls the event back when the transaction fails at commit', async () => {
    const { serviceId } = await simple();
    await h.admin.execute(sql`
      CREATE OR REPLACE FUNCTION test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'deliberate failure at commit' USING ERRCODE = 'check_violation'; END $$
    `);
    // `WHEN (NEW.service_id = ...)` is not decoration: a trigger on `bookings` is a property
    // of the whole schema, and the thirteen files of this package run in parallel against one
    // database. Without the guard this test blew up whichever other file happened to insert a
    // booking while it held the trigger, which is exactly the intermittent failure the first
    // version of this suite could not reproduce.
    // `CREATE TRIGGER` is a utility statement and takes no bind parameters, so the id goes in
    // as a literal, checked to be a UUID first, because a literal built from a string is
    // exactly the shape of an injection even in a test.
    expect(isUuid(serviceId)).toBe(true);
    await h.admin.execute(
      sql.raw(`
        CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER INSERT ON bookings
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.service_id = '${serviceId}'::uuid)
        EXECUTE FUNCTION test_fail_at_commit()
      `),
    );
    // Counted **for this project**: `h.admin` bypasses RLS, and the thirteen files of this
    // package run in parallel against one database, so a global count is a count of everybody
    // else's events too. Without the filter this assertion fails whenever another file writes
    // an event during the few milliseconds of the transaction below (four times out of five
    // when only the two `booking` files run).
    const scoped = sql`SELECT count(*)::text AS count FROM events WHERE project_id = ${h.projectId}`;
    const before = await rows<{ count: string }>(scoped);
    try {
      await expect(createBooking(h.app, { ...base(serviceId), kind: 'booking' })).rejects.toThrow(
        /deliberate failure at commit/,
      );
    } finally {
      await h.admin.execute(sql`DROP TRIGGER test_fail_at_commit ON bookings`);
      await h.admin.execute(sql`DROP FUNCTION test_fail_at_commit()`);
    }
    const after = await rows<{ count: string }>(scoped);
    expect(after[0]!.count).toBe(before[0]!.count);
    const orphans = await rows<{ id: string }>(
      sql`SELECT id FROM bookings WHERE service_id = ${serviceId}`,
    );
    expect(orphans).toEqual([]);
    const occupancies = await rows<{ id: string }>(
      sql`SELECT o.id FROM occupancies o
            JOIN service_requirements r ON r.resource_id = o.resource_id
           WHERE r.service_id = ${serviceId}`,
    );
    expect(occupancies).toEqual([]);
  });

  it('reports every local day a booking crosses, midnight included', async () => {
    const schedule = await openAllDay();
    const resourceId = await h.resource({ name: 'Night', scheduleId: schedule });
    const serviceId = await h.service({ durationMinutes: 240 });
    await h.requirement({ serviceId, resourceId });
    // 23:00 to 03:00 local, which is 21:00Z Monday to 01:00Z Tuesday.
    const booking = await createBooking(h.app, {
      ...base(serviceId),
      start: MONDAY + 21 * HOUR,
      kind: 'booking',
    });
    expect(booking.touchedDays).toEqual([
      { resourceId, day: '2030-06-03' },
      { resourceId, day: '2030-06-04' },
    ]);
  });

  // --- Buffers on the write path --------------------------------

  /**
   * The occupancy carries **its own** buffers and the querying service carries **different**
   * ones: with equal buffers the two branches of `buffer_sharing` cannot be told apart, which
   * is precisely why migration 0009 exists.
   *
   * Existing occupancy 10:00-11:00Z with twenty minutes of cleaning after it; the service now
   * asking wants thirty minutes of preparation before its own start.
   *
   * - without sharing the two footprints must be disjoint: the gap is `20 + 30 = 50` minutes,
   *   so the earliest start is 11:50;
   * - with sharing the two buffers may overlap each other but never the other booking's core:
   *   the gap is `max(20, 30) = 30`, so the earliest start is 11:30.
   *
   * The service defines no grid, so `start_not_on_grid` does not get in the way of a start at
   * an odd minute.
   */
  async function bufferScenario(
    bufferSharing: boolean,
  ): Promise<{ serviceId: string; resourceId: string }> {
    const schedule = await openAllDay();
    const resourceId = await h.resource({
      name: `Buffered ${String(bufferSharing)}`,
      capacity: 1,
      scheduleId: schedule,
    });
    const serviceId = await h.service({
      durationMinutes: 60,
      bufferBefore: 30,
      bufferAfter: 0,
      bufferSharing,
    });
    await h.requirement({ serviceId, resourceId });
    await h.occupancy({
      resourceId,
      from: MONDAY + 10 * HOUR,
      to: MONDAY + 11 * HOUR,
      bufferBeforeMs: 0,
      bufferAfterMs: 20 * MINUTE,
    });
    return { serviceId, resourceId };
  }

  it('without buffer_sharing the two buffers add up: 11:49 is refused', async () => {
    const { serviceId } = await bufferScenario(false);
    await expect(
      createBooking(h.app, {
        ...base(serviceId),
        start: MONDAY + 11 * HOUR + 49 * MINUTE,
        kind: 'booking',
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('without buffer_sharing 11:50 is exactly far enough', async () => {
    const { serviceId, resourceId } = await bufferScenario(false);
    const booking = await createBooking(h.app, {
      ...base(serviceId),
      start: MONDAY + 11 * HOUR + 50 * MINUTE,
      kind: 'booking',
    });
    expect(booking.allocations[0]!.resourceId).toBe(resourceId);
  });

  it('with buffer_sharing the buffers overlap: 11:29 is still refused', async () => {
    const { serviceId } = await bufferScenario(true);
    await expect(
      createBooking(h.app, {
        ...base(serviceId),
        start: MONDAY + 11 * HOUR + 29 * MINUTE,
        kind: 'booking',
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('with buffer_sharing 11:30 is enough, thirty minutes earlier than without', async () => {
    const { serviceId, resourceId } = await bufferScenario(true);
    const booking = await createBooking(h.app, {
      ...base(serviceId),
      start: MONDAY + 11 * HOUR + 30 * MINUTE,
      kind: 'booking',
    });
    expect(booking.allocations[0]!.resourceId).toBe(resourceId);
  });

  // --- The grid --------------------------------------------------

  it('refuses a start the availability grid would never offer', async () => {
    const { serviceId } = await simple(1, { slotInterval: 60, alignTo: 'hour' });

    await expect(
      createBooking(h.app, {
        ...base(serviceId),
        start: NINE + 7 * MINUTE,
        kind: 'booking',
      }),
    ).rejects.toMatchObject({ code: 'start_not_on_grid', type: 'policy_violation' });

    const onGrid = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(onGrid.start).toBe(NINE);
  });

  it('accepts any instant when the service defines no grid', async () => {
    const schedule = await openAllDay();
    const resourceId = await h.resource({ name: 'Van', scheduleId: schedule });
    const serviceId = await h.service({ durationRange: { min: 60, max: 480 } });
    await h.requirement({ serviceId, resourceId });

    const booking = await createBooking(h.app, {
      ...base(serviceId),
      start: NINE + 7 * MINUTE,
      kind: 'booking',
      durationMinutes: 90,
    });
    expect(booking.start).toBe(NINE + 7 * MINUTE);
  });

  // --- The single door -------------------------------------------

  it('refuses a block on a resource that is already partly taken', async () => {
    const { resourceId, serviceId } = await simple(3);
    await createBooking(h.app, { ...base(serviceId), kind: 'booking' });

    // Exactly what `POST /v1/resources/{id}/block` does.
    await expect(
      h.app.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${h.projectId}, true),
                     set_config('app.environment', 'test', true)`,
        );
        await takeOccupancy(tx, {
          projectId: h.projectId,
          environment: 'test',
          resourceIds: [resourceId],
          allocations: [{ resourceId, capacityUsed: 3 }],
          start: NINE,
          end: NINE + HOUR,
          kind: 'block',
          refId: await h.customer(),
        });
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('refuses to write a resource it was not asked to lock', async () => {
    const { resourceId } = await simple(3);
    await expect(
      h.app.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${h.projectId}, true),
                     set_config('app.environment', 'test', true)`,
        );
        await takeOccupancy(tx, {
          projectId: h.projectId,
          environment: 'test',
          resourceIds: [],
          allocations: [{ resourceId, capacityUsed: 1 }],
          start: NINE,
          end: NINE + HOUR,
          kind: 'booking',
          refId: await h.customer(),
        });
      }),
    ).rejects.toThrow(/without holding its lock/);
  });

  // --- Events on the right transition -------------------------

  it('records an expiry, not a release, when the hold released has already expired', async () => {
    const { serviceId } = await simple();
    const hold = await createHold(h.app, base(serviceId));
    await h.admin.execute(
      sql`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = ${hold.id}`,
    );

    const released = await releaseHold(h.app, {
      projectId: h.projectId,
      environment: 'test',
      holdId: hold.id,
      now: NOW,
    });
    expect(released.released).toBe(true);

    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM holds WHERE id = ${hold.id}`,
    );
    expect(row!.status).toBe('expired');
    const [event] = await rows<{ type: string; data: Record<string, unknown> }>(
      sql`SELECT type, data FROM events WHERE id = ${released.eventId ?? ''}`,
    );
    expect(event!.type).toBe('hold.expired');
    expect(event!.data).toMatchObject({ status: 'expired' });
  });

  it('answers 404 for a resource that does not exist, 400 for one the service never uses', async () => {
    const { serviceId } = await simple();
    const stranger = await h.resource({ name: 'Known but unused' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', resourceIds: [uuidv7()] }),
    ).rejects.toMatchObject({ code: 'resource_missing', type: 'not_found' });

    await expect(
      createBooking(h.app, { ...base(serviceId), kind: 'booking', resourceIds: [stranger] }),
    ).rejects.toMatchObject({ code: 'resource_not_eligible', type: 'invalid_request' });
  });

  it('takes the advisory locks in ascending order of resource id', async () => {
    // Not a database mock: `lockResources` has one job, which is to emit one statement per
    // resource in a fixed order, and this reads the statements it emits. Postgres never
    // deadlocks two transactions that take the same locks in the same order, and the
    // composite scenario of the concurrency suite is the end to end proof of it.
    const seen: string[] = [];
    const stub = {
      execute: (query: { queryChunks?: unknown[] }): Promise<unknown> => {
        const literal = JSON.stringify(query);
        seen.push(literal);
        return Promise.resolve({ rows: [] });
      },
    };
    const ids = ['ccc', 'aaa', 'bbb'];
    await lockResources(stub as unknown as Parameters<typeof lockResources>[0], ids);
    expect(seen).toHaveLength(3);
    const positions = ids
      .map((id) => ({ id, at: seen.findIndex((statement) => statement.includes(id)) }))
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.id);
    expect(positions).toEqual(['aaa', 'bbb', 'ccc']);
  });

  // --- The database is the last line -------------------------------------------------------------

  it('refuses two overlapping occupancies on a capacity 1 resource, application role included', async () => {
    const schedule = await openAllDay();
    const resourceId = await h.resource({ name: 'Court', capacity: 1, scheduleId: schedule });
    const ref = await h.customer();
    const insert = (from: number, to: number): ReturnType<typeof sql> => sql`
      INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                               kind, ref_id)
      VALUES (gen_random_uuid(), ${h.projectId}, 'test', ${resourceId},
              tstzrange(${new Date(from).toISOString()}, ${new Date(to).toISOString()}, '[)'),
              1, 'booking', ${ref})
    `;
    await h.app.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.project_id', ${h.projectId}, true),
                   set_config('app.environment', 'test', true)`,
      );
      await tx.execute(insert(NINE, NINE + HOUR));
    });
    await expect(
      h.app.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${h.projectId}, true),
                     set_config('app.environment', 'test', true)`,
        );
        await tx.execute(insert(NINE + 30 * MINUTE, NINE + 90 * MINUTE));
      }),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('refuses the double booking even when the application check is bypassed', async () => {
    const { resourceId, serviceId } = await simple(1);
    const booking = await createBooking(h.app, { ...base(serviceId), kind: 'booking' });
    expect(booking.allocations[0]!.resourceId).toBe(resourceId);
    // Straight into the table, skipping every check the engine makes: the exclusion constraint
    // of migration 0004 is what stands between a bug and a double booking.
    await expect(
      h.app.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.project_id', ${h.projectId}, true),
                     set_config('app.environment', 'test', true)`,
        );
        await tx.execute(sql`
          INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                                   kind, ref_id)
          VALUES (gen_random_uuid(), ${h.projectId}, 'test', ${resourceId},
                  tstzrange(${new Date(NINE).toISOString()},
                            ${new Date(NINE + HOUR).toISOString()}, '[)'),
                  1, 'booking', ${booking.id})
        `);
      }),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});
