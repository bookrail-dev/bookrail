/**
 * `booking.orphaned`, against a real Postgres.
 *
 * The detection is called the way the CRUD routes call it: **after** the modification and
 * inside the same transaction. These tests therefore change a schedule or a capacity with the
 * superuser connection and then run the detection through the application role, which is
 * exactly the sequence `PATCH /v1/schedules/{id}` performs. The end-to-end version, through
 * HTTP, is in `packages/api/test/orphaned.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withProjectContext } from '@bookrail/db';
import { encodeId } from '@bookrail/shared';

import { createBooking, detectOrphanedBookings } from '../src/index.js';
import { createHarness, utc, DAY, HOUR, type Harness } from './availability-harness.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Monday 2 June 2031, 09:00 Rome = 07:00Z. */
const MONDAY = utc(2031, 6, 2);
const NINE = MONDAY + 7 * HOUR;
const NOW = MONDAY - 7 * DAY;

describe('booking.orphaned', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Orphaned');
  });

  afterAll(async () => {
    await h.close();
  });

  async function scenario(capacity = 1): Promise<{
    scheduleId: string;
    resourceId: string;
    serviceId: string;
    bookingId: string;
  }> {
    const scheduleId = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: EVERY_DAY, startTime: '08:00', endTime: '20:00' }],
    });
    const resourceId = await h.resource({ name: 'Court', capacity, scheduleId });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, resourceId });
    const booking = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: NINE,
      kind: 'booking',
      now: NOW,
    });
    return { scheduleId, resourceId, serviceId, bookingId: booking.id };
  }

  function detect(
    resourceIds: string[],
    options: { now?: number; horizonDays?: number } = {},
  ): Promise<readonly { bookingId: string; reasons: readonly { code: string }[] }[]> {
    return withProjectContext(h.app, { projectId: h.projectId, environment: 'test' }, (tx) =>
      detectOrphanedBookings(tx, {
        projectId: h.projectId,
        environment: 'test',
        resourceIds,
        now: options.now ?? NOW,
        ...(options.horizonDays === undefined ? {} : { horizonDays: options.horizonDays }),
      }),
    );
  }

  async function orphanEvents(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await h.admin.execute<{ data: Record<string, unknown> }>(sql`
      SELECT data FROM events
       WHERE project_id = ${h.projectId} AND type = 'booking.orphaned'
         AND data ->> 'id' = ${encodeId('booking', bookingId)}
       ORDER BY seq
    `);
    return rows.map((row) => row.data);
  }

  async function statusOf(bookingId: string): Promise<string> {
    const { rows } = await h.admin.execute<{ status: string }>(
      sql`SELECT status FROM bookings WHERE id = ${bookingId}`,
    );
    return rows[0]!.status;
  }

  it('says nothing when the configuration still supports the booking', async () => {
    const { resourceId, bookingId } = await scenario();
    expect(await detect([resourceId])).toEqual([]);
    expect(await orphanEvents(bookingId)).toEqual([]);
  });

  it('reports a booking left outside the opening hours, and does not touch it', async () => {
    const { scheduleId, resourceId, bookingId } = await scenario();
    // The club now opens at 14:00: the 09:00 booking is outside.
    await h.admin.execute(
      sql`UPDATE schedule_rules SET start_time = '14:00' WHERE schedule_id = ${scheduleId}`,
    );

    const orphans = await detect([resourceId]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.bookingId).toBe(bookingId);
    expect(orphans[0]!.reasons.map((reason) => reason.code)).toEqual(['outside_schedule']);

    const events = await orphanEvents(bookingId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: encodeId('booking', bookingId),
      object: 'booking',
      status: 'confirmed',
      reasons: [{ code: 'outside_schedule', resource_id: encodeId('resource', resourceId) }],
    });
    // The booking itself is a promise to a customer, and it is left alone.
    expect(await statusOf(bookingId)).toBe('confirmed');
    const { rows } = await h.admin.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM occupancies WHERE ref_id = ${bookingId} AND active
    `);
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('reports a closed-day exception', async () => {
    const { scheduleId, resourceId, bookingId } = await scenario();
    await h.admin.execute(sql`
      INSERT INTO schedule_exceptions (id, project_id, environment, schedule_id, date, type)
      VALUES (gen_random_uuid(), ${h.projectId}, 'test', ${scheduleId}, '2031-06-02', 'closed')
    `);
    const orphans = await detect([resourceId]);
    expect(orphans.map((orphan) => orphan.bookingId)).toEqual([bookingId]);
    expect(orphans[0]!.reasons[0]!.code).toBe('outside_schedule');
  });

  it('reports a capacity lowered under what is already booked', async () => {
    const { resourceId, serviceId, bookingId } = await scenario(3);
    // Three bookings on a resource of capacity three: the scenario made the first.
    const ids: string[] = [bookingId];
    for (let i = 0; i < 2; i += 1) {
      const booking = await createBooking(h.app, {
        projectId: h.projectId,
        environment: 'test',
        serviceId,
        start: NINE,
        kind: 'booking',
        now: NOW,
      });
      ids.push(booking.id);
    }
    expect(await detect([resourceId])).toEqual([]);

    await h.admin.execute(sql`UPDATE resources SET capacity = 2 WHERE id = ${resourceId}`);
    const orphans = await detect([resourceId]);
    // Every booking on that period is now standing on a resource that is over capacity, so
    // every one of them is reported: which of the three should give way is the business's
    // decision, not ours.
    expect(orphans.map((orphan) => orphan.bookingId).sort()).toEqual([...ids].sort());
    expect(orphans[0]!.reasons[0]!.code).toBe('capacity_exceeded');
  });

  it('reports a resource that was deactivated or soft deleted', async () => {
    const { resourceId, bookingId } = await scenario();
    await h.admin.execute(
      sql`UPDATE resources SET deleted_at = now(), status = 'inactive' WHERE id = ${resourceId}`,
    );
    const orphans = await detect([resourceId]);
    expect(orphans.map((orphan) => orphan.bookingId)).toEqual([bookingId]);
    expect(orphans[0]!.reasons[0]!.code).toBe('resource_unavailable');
  });

  it('ignores bookings in the past, cancelled bookings, and bookings past the horizon', async () => {
    const { scheduleId, resourceId, serviceId } = await scenario();
    const far = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      // Well past a 90 day horizon measured from NOW.
      start: NINE + 200 * DAY,
      kind: 'booking',
      now: NOW,
    });
    const cancelled = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: NINE + 2 * HOUR,
      kind: 'booking',
      now: NOW,
    });
    await h.admin.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${cancelled.id}`);
    await h.admin.execute(
      sql`UPDATE schedule_rules SET start_time = '14:00' WHERE schedule_id = ${scheduleId}`,
    );

    const reported = (await detect([resourceId])).map((orphan) => orphan.bookingId);
    expect(reported).not.toContain(far.id);
    expect(reported).not.toContain(cancelled.id);

    // Asking as if it were after the booking: history is never reported.
    expect(await detect([resourceId], { now: NINE + DAY })).toEqual([]);
    // And with a horizon wide enough, the far booking does appear.
    expect(await detect([resourceId], { horizonDays: 400 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ bookingId: far.id })]),
    );
  });

  it('writes one event per booking even when several of its resources are affected', async () => {
    const scheduleId = await h.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: EVERY_DAY, startTime: '08:00', endTime: '20:00' }],
    });
    const first = await h.resource({ name: 'A', capacity: 1, scheduleId });
    const second = await h.resource({ name: 'B', capacity: 1, scheduleId });
    const serviceId = await h.service({ durationMinutes: 60 });
    await h.requirement({ serviceId, resourceId: first, role: 'room' });
    await h.requirement({ serviceId, resourceId: second, role: 'coach' });
    const booking = await createBooking(h.app, {
      projectId: h.projectId,
      environment: 'test',
      serviceId,
      start: NINE,
      kind: 'booking',
      now: NOW,
    });
    await h.admin.execute(
      sql`UPDATE schedule_rules SET start_time = '14:00' WHERE schedule_id = ${scheduleId}`,
    );

    const orphans = await detect([first, second]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.reasons).toHaveLength(2);
    expect(await orphanEvents(booking.id)).toHaveLength(1);
  });
});
