/**
 * `booking.orphaned` through the CRUD endpoints that can cause it.
 *
 * The engine's suite owns the detection itself; what is checked here is the wiring: that
 * every write which can break a future booking actually calls it, that the event lands, and
 * that the booking comes out of the modification exactly as it went in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId } from '@bookrail/shared';
import { createHarness, type Harness } from './harness.js';
import { settleEventLog } from './event-horizon.js';
import { buildScenario, firstSlot, nextMonday, plusDays } from './booking-fixtures.js';

interface EventList {
  data: {
    type: string;
    data: { object: { id: string; reasons: { code: string; resource_id: string }[] } };
  }[];
}

describe('booking.orphaned through the configuration endpoints', () => {
  let h: Harness;
  let token: string;

  beforeAll(async () => {
    h = createHarness();
    token = (await h.bootstrap('Orphans')).testKey;
  });

  afterAll(async () => {
    await h.close();
  });

  const from = nextMonday();
  const to = plusDays(from, 1);

  async function booked(options: Parameters<typeof buildScenario>[2] = {}): Promise<{
    scenario: Awaited<ReturnType<typeof buildScenario>>;
    bookingId: string;
    status: string;
  }> {
    const scenario = await buildScenario(h, token, options);
    const slot = await firstSlot(h, token, scenario.serviceId, from, to);
    const created = await h.call<{ id: string; status: string }>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(created.status).toBe(201);
    return { scenario, bookingId: created.body.id, status: created.body.status };
  }

  /**
   * The `booking.orphaned` events of one booking, read after the log has settled.
   *
   * `GET /v1/events` answers from below the horizon, which is a property of the whole Postgres
   * cluster: a write transaction open in another test database or in an autovacuum worker
   * holds back the event the schedule change just wrote, and the assertion below would read
   * an empty list and call it a missing report.
   */
  async function orphansOf(bookingId: string): Promise<EventList['data']> {
    await settleEventLog(h);
    const list = await h.call<EventList>(
      'GET',
      `/v1/events?type=booking.orphaned&object_id=${bookingId}`,
      { token },
    );
    expect(list.status).toBe(200);
    return list.body.data;
  }

  async function stillConfirmed(bookingId: string): Promise<void> {
    const read = await h.call<{ status: string }>('GET', `/v1/bookings/${bookingId}`, { token });
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('confirmed');
  }

  it('reports on PATCH /v1/schedules/{id} when the rules move away from the booking', async () => {
    const { scenario, bookingId } = await booked();
    const patched = await h.call('PATCH', `/v1/schedules/${scenario.scheduleId}`, {
      token,
      body: {
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '20:00', end_time: '23:00' }],
      },
    });
    expect(patched.status).toBe(200);

    const orphans = await orphansOf(bookingId);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.data.object.reasons[0]!.code).toBe('outside_schedule');
    await stillConfirmed(bookingId);
  });

  it('reports on a closed-day exception, and says nothing for one on another day', async () => {
    const { scenario, bookingId } = await booked();
    const day = from.toISOString().slice(0, 10);

    const elsewhere = await h.call('POST', `/v1/schedules/${scenario.scheduleId}/exceptions`, {
      token,
      body: { date: plusDays(from, 5).toISOString().slice(0, 10), type: 'closed' },
    });
    expect(elsewhere.status).toBe(201);
    expect(await orphansOf(bookingId)).toEqual([]);

    const onTheDay = await h.call('POST', `/v1/schedules/${scenario.scheduleId}/exceptions`, {
      token,
      body: { date: day, type: 'closed', reason: 'flood' },
    });
    expect(onTheDay.status).toBe(201);
    expect(await orphansOf(bookingId)).toHaveLength(1);
    await stillConfirmed(bookingId);
  });

  it('reports on DELETE /v1/schedules/{id}', async () => {
    const { scenario, bookingId } = await booked();
    const deleted = await h.call('DELETE', `/v1/schedules/${scenario.scheduleId}`, { token });
    expect(deleted.status).toBe(200);
    const orphans = await orphansOf(bookingId);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.data.object.reasons[0]!.code).toBe('outside_schedule');
  });

  it('reports on PATCH /v1/resources/{id} when the capacity drops under what is sold', async () => {
    const { scenario, bookingId } = await booked({ capacity: 3 });
    // Two more bookings on the same slot: three units of a capacity of three.
    const slot = await h.call<{ start: string }>('GET', `/v1/bookings/${bookingId}`, { token });
    for (let i = 0; i < 2; i += 1) {
      const extra = await h.call('POST', '/v1/bookings', {
        token,
        body: { service_id: scenario.serviceId, start: slot.body.start },
      });
      expect(extra.status).toBe(201);
    }

    const patched = await h.call('PATCH', `/v1/resources/${scenario.resourceIds[0]!}`, {
      token,
      body: { capacity: 2 },
    });
    expect(patched.status).toBe(200);

    // All three are reported: which of them gives way is the business's decision, not ours.
    const orphans = await orphansOf(bookingId);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.data.object.reasons[0]!.code).toBe('capacity_exceeded');
    await stillConfirmed(bookingId);
  });

  it('cannot lower a resource to capacity 1 under overlapping bookings at all', async () => {
    // Not an orphan case: the exclusion constraint `occ_no_overlap_cap1` covers every active
    // occupancy of a capacity-1 resource, so the `UPDATE` itself is refused by the database
    // rather than by the trigger, which does not fire on a capacity that is only lowered.
    // The change never happens, so there is
    // nothing to be orphaned by, and this is the one capacity change the database, rather
    // than an event, protects.
    const { scenario, bookingId } = await booked({ capacity: 2 });
    const slot = await h.call<{ start: string }>('GET', `/v1/bookings/${bookingId}`, { token });
    const second = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.body.start },
    });
    expect(second.status).toBe(201);

    const refused = await h.call<{ error: { code: string } }>(
      'PATCH',
      `/v1/resources/${scenario.resourceIds[0]!}`,
      { token, body: { capacity: 1 } },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('slot_unavailable');
    expect(await orphansOf(bookingId)).toEqual([]);
  });

  it('reports on DELETE /v1/resources/{id}', async () => {
    const { scenario, bookingId } = await booked();
    const deleted = await h.call('DELETE', `/v1/resources/${scenario.resourceIds[0]!}`, { token });
    expect(deleted.status).toBe(200);
    const orphans = await orphansOf(bookingId);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.data.object.reasons[0]!.code).toBe('resource_unavailable');
    await stillConfirmed(bookingId);
  });

  it('says nothing when a change leaves every booking supported', async () => {
    const { scenario, bookingId } = await booked();
    const renamed = await h.call('PATCH', `/v1/resources/${scenario.resourceIds[0]!}`, {
      token,
      body: { name: 'Court renamed' },
    });
    expect(renamed.status).toBe(200);
    const wider = await h.call('PATCH', `/v1/schedules/${scenario.scheduleId}`, {
      token,
      body: {
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
      },
    });
    expect(wider.status).toBe(200);
    expect(await orphansOf(bookingId)).toEqual([]);
  });

  it('cannot be caused by a block, because a block over a booking is refused', async () => {
    const { scenario, bookingId } = await booked();
    const slot = await h.call<{ start: string; end: string }>('GET', `/v1/bookings/${bookingId}`, {
      token,
    });
    const blocked = await h.call<{ error: { code: string } }>(
      'POST',
      `/v1/resources/${scenario.resourceIds[0]!}/block`,
      { token, body: { from: slot.body.start, to: slot.body.end } },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('slot_unavailable');
    expect(await orphansOf(bookingId)).toEqual([]);
  });

  it('reports on PATCH /v1/locations/{id} when the time zone moves', async () => {
    // A resource whose schedule carries no time zone of its own reads the Location's, so
    // moving it moves the opening hours, and `PATCH /v1/schedules/{id}` ran the detection for
    // exactly that reason while this route did not.
    const location = await h.call<{ id: string }>('POST', '/v1/locations', {
      token,
      body: { name: 'Club', timezone: 'Europe/Rome' },
    });
    expect(location.status).toBe(201);
    const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
      token,
      // No `timezone`: the resource will read the Location's.
      body: {
        name: 'Opening hours',
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '11:00' }],
      },
    });
    expect(schedule.status).toBe(201);
    const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
      token,
      body: {
        name: 'Court',
        schedule_id: schedule.body.id,
        location_id: location.body.id,
        capacity: 1,
      },
    });
    expect(resource.status).toBe(201);
    const service = await h.call<{ id: string }>('POST', '/v1/services', {
      token,
      body: { name: 'Service', duration: 60, requirements: [{ resource_id: resource.body.id }] },
    });
    expect(service.status).toBe(201);
    const slot = await firstSlot(h, token, service.body.id, from, to);
    const created = await h.call<{ id: string }>('POST', '/v1/bookings', {
      token,
      body: { service_id: service.body.id, start: slot.start },
    });
    expect(created.status).toBe(201);

    // A rename touches no calendar and says nothing.
    const renamed = await h.call('PATCH', `/v1/locations/${location.body.id}`, {
      token,
      body: { name: 'Club renamed' },
    });
    expect(renamed.status).toBe(200);
    expect(await orphansOf(created.body.id)).toEqual([]);

    const moved = await h.call('PATCH', `/v1/locations/${location.body.id}`, {
      token,
      body: { timezone: 'America/New_York' },
    });
    expect(moved.status).toBe(200);
    const orphans = await orphansOf(created.body.id);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.data.object.reasons[0]!.code).toBe('outside_schedule');
    await stillConfirmed(created.body.id);
  });

  it('says nothing for a PATCH that cannot move the calendar', async () => {
    // Not only "finds no orphan": it does not look. Running the detection for a rename cost
    // 35 ms on a resource with 69 future bookings, inside the transaction that held its row
    // lock.
    const { scenario, bookingId } = await booked();
    for (const body of [
      { name: 'Court renamed' },
      { metadata: { floor: '2' } },
      { type: 'room' },
    ]) {
      const patched = await h.call('PATCH', `/v1/resources/${scenario.resourceIds[0]!}`, {
        token,
        body,
      });
      expect(patched.status).toBe(200);
    }
    const named = await h.call('PATCH', `/v1/schedules/${scenario.scheduleId}`, {
      token,
      body: { name: 'Opening hours renamed' },
    });
    expect(named.status).toBe(200);
    expect(await orphansOf(bookingId)).toEqual([]);
  });

  it('releases the occupancy of an unblocked block instead of deleting it', async () => {
    // `unblock` used to be the last writer of `occupancies` outside the two doors of
    // `occupancy.ts`, and it deleted rows without taking the advisory lock.
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, from, to);
    const block = await h.call<{ id: string }>(
      'POST',
      `/v1/resources/${scenario.resourceIds[0]!}/block`,
      { token, body: { from: slot.start, to: slot.end } },
    );
    expect(block.status).toBe(201);

    const unblocked = await h.call('POST', `/v1/resources/${scenario.resourceIds[0]!}/unblock`, {
      token,
      body: { block_id: block.body.id },
    });
    expect(unblocked.status).toBe(200);

    // The slot is free again…
    const again = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(again.status).toBe(201);

    // …and the block's occupancy is still there, inactive: an occupancy is a fact about a
    // period of time, and `active = false` is how it stops counting.
    const adminDb = createDatabase(h.pools.admin);
    const { rows } = await adminDb.execute<{ active: boolean }>(sql`
      SELECT active FROM occupancies WHERE ref_id = ${decodeId('resource_block', block.body.id)}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
  });

  it('leaves no event behind when the modification itself fails', async () => {
    const { scenario, bookingId } = await booked();
    // A capacity of zero is refused by the schema, so nothing is written and nothing detected.
    const refused = await h.call('PATCH', `/v1/resources/${scenario.resourceIds[0]!}`, {
      token,
      body: { capacity: 0 },
    });
    expect(refused.status).toBe(400);
    expect(await orphansOf(bookingId)).toEqual([]);
  });
});
