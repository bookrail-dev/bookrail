/**
 * `POST /v1/holds` and `DELETE /v1/holds/{id}`, end to end: real Postgres, the real engine,
 * the real availability cache underneath, and every fixture built through the public API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeId } from '@bookrail/shared';
import { createDatabase, sql } from '@bookrail/db';
import { MemoryAvailabilityCache, type AvailabilityCache, type CacheWrite } from '@bookrail/engine';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import {
  buildScenario,
  firstSlot,
  nextMonday,
  plusDays,
  slotsFor,
  type ErrorBody,
} from './booking-fixtures.js';

/** Counts what the endpoints ask of the cache, so "was it invalidated?" is a fact. */
class CountingCache implements AvailabilityCache {
  readonly inner = new MemoryAvailabilityCache();
  invalidations: { resourceId: string; day: string }[] = [];

  reset(): void {
    this.invalidations = [];
  }

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }
  getMany(keys: readonly string[]): Promise<(string | null)[]> {
    return this.inner.getMany(keys);
  }
  put(writes: readonly CacheWrite[]): Promise<void> {
    return this.inner.put(writes);
  }
  async invalidateResourceDay(resourceId: string, day: string): Promise<void> {
    this.invalidations.push({ resourceId, day });
    await this.inner.invalidateResourceDay(resourceId, day);
  }
  async invalidateResource(resourceId: string): Promise<void> {
    this.invalidations.push({ resourceId, day: '*' });
    await this.inner.invalidateResource(resourceId);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

interface HoldBody {
  id: string;
  object: string;
  status: string;
  service_id: string;
  customer_id: string | null;
  start: string;
  end: string;
  duration_minutes: number;
  quantity: number;
  timezone: string;
  expires_at: string;
  price: { amount: number; currency: string } | null;
  allocations: {
    object: string;
    resource_id: string;
    role: string | null;
    capacity_used: number;
  }[];
  environment: string;
}

describe('holds', () => {
  let h: Harness;
  let cache: CountingCache;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  beforeAll(async () => {
    cache = new CountingCache();
    h = createHarness({ cache });
    p = await h.bootstrap('Holds project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  it('creates a hold, freezes the slot, and invalidates the cached day', async () => {
    const scenario = await buildScenario(h, token, {
      service: { price: { amount: 2500, currency: 'EUR' } },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    cache.reset();

    const created = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });

    expect(created.status).toBe(201);
    expect(created.body.object).toBe('hold');
    expect(created.body.id.startsWith('hold_')).toBe(true);
    expect(created.body.status).toBe('active');
    expect(created.body.service_id).toBe(scenario.serviceId);
    expect(created.body.start).toBe(slot.start);
    expect(created.body.duration_minutes).toBe(60);
    expect(created.body.quantity).toBe(1);
    expect(created.body.timezone).toBe('Europe/Rome');
    expect(created.body.price).toEqual({ amount: 2500, currency: 'EUR' });
    expect(created.body.environment).toBe('test');
    expect(created.body.allocations).toEqual([
      {
        object: 'booking_allocation',
        resource_id: scenario.resourceIds[0],
        role: null,
        capacity_used: 1,
      },
    ]);
    // Default TTL of ten minutes, from `hold_duration_seconds` on the policy.
    const ttlMs = new Date(created.body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);

    expect(cache.invalidations.map((entry) => entry.resourceId)).toContain(
      decodeId('resource', scenario.resourceIds[0]!),
    );

    // The slot is gone from availability on the very next request.
    const after = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    expect(after.map((s) => s.start)).not.toContain(slot.start);
  });

  it('honours ttl, and clamps it at the policy maximum of thirty minutes', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const short = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, ttl: '120s' },
    });
    expect(short.status).toBe(201);
    const shortTtl = new Date(short.body.expires_at).getTime() - Date.now();
    expect(shortTtl).toBeGreaterThan(110_000);
    expect(shortTtl).toBeLessThanOrEqual(120_000);

    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const other = slots[0]!;
    const long = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: other.start, ttl: '4h' },
    });
    expect(long.status).toBe(201);
    const longTtl = new Date(long.body.expires_at).getTime() - Date.now();
    expect(longTtl).toBeLessThanOrEqual(30 * 60_000);
  });

  it('refuses a malformed ttl', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const response = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, ttl: '10 minutes' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('parameter_invalid');
    expect(response.body.error.param).toBe('ttl');
  });

  it('creates the customer inline and reuses it by email on the next hold', async () => {
    const scenario = await buildScenario(h, token, { resources: 1, capacity: 2 });
    const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const first = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[0]!.start,
        customer: { email: 'Ada@example.test', name: 'Ada' },
      },
    });
    expect(first.status).toBe(201);
    expect(first.body.customer_id).not.toBeNull();

    const second = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slots[1]!.start,
        customer: { email: 'ada@example.test', phone: '+390000000' },
      },
    });
    expect(second.status).toBe(201);
    expect(second.body.customer_id).toBe(first.body.customer_id);

    // The merge kept the name and added the phone.
    const customer = await h.call<{ name: string; phone: string }>(
      'GET',
      `/v1/customers/${String(first.body.customer_id)}`,
      { token },
    );
    expect(customer.body.name).toBe('Ada');
    expect(customer.body.phone).toBe('+390000000');
  });

  it('refuses customer_id and customer together', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const customer = await h.call<{ id: string }>('POST', '/v1/customers', {
      token,
      body: { email: 'both@example.test' },
    });
    const response = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        customer_id: customer.body.id,
        customer: { email: 'both@example.test' },
      },
    });
    expect(response.status).toBe(400);
  });

  it('forces the resource with resource_ids, and refuses one the service never uses', async () => {
    const scenario = await buildScenario(h, token, {
      resources: 3,
      group: { allocation_strategy: 'first_available' },
    });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const forced = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        resource_ids: [scenario.resourceIds[2]],
      },
    });
    expect(forced.status).toBe(201);
    expect(forced.body.allocations[0]?.resource_id).toBe(scenario.resourceIds[2]);

    const stranger = await buildScenario(h, token, {});
    const notEligible = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        resource_ids: [stranger.resourceIds[0]],
      },
    });
    expect(notEligible.status).toBe(400);
    expect(notEligible.body.error.code).toBe('resource_not_eligible');

    const missing = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: slot.start,
        resource_ids: ['res_00000000000000000000000000000000'],
      },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('resource_missing');
  });

  it('refuses a second hold when the capacity is gone', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const first = await h.call<HoldBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(first.status).toBe(201);

    const second = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.type).toBe('conflict');
    expect(second.body.error.code).toBe('slot_unavailable');
    expect(second.body.error.message).toMatch(/1 unit requested, 0 available/);
  });

  it('refuses a start outside the grid, and one in the past', async () => {
    const scenario = await buildScenario(h, token, { service: { slot_interval: 60 } });
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));

    const offGrid = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: {
        service_id: scenario.serviceId,
        start: new Date(new Date(slot.start).getTime() + 7 * 60_000).toISOString(),
      },
    });
    expect(offGrid.status).toBe(422);
    expect(offGrid.body.error.type).toBe('policy_violation');
    expect(offGrid.body.error.code).toBe('start_not_on_grid');

    const past = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: '2020-01-06T09:00:00Z' },
    });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe('outside_booking_window');
  });

  it('refuses a duration the service does not offer', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const response = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, duration_minutes: 45 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('duration_not_offered');
    expect(response.body.error.param).toBe('duration_minutes');
  });

  it('404s on a service of another project, and on a malformed id', async () => {
    const other = await h.bootstrap('Holds other project');
    const scenario = await buildScenario(h, other.testKey, {});
    const slot = await firstSlot(h, other.testKey, scenario.serviceId, monday, plusDays(monday, 1));

    const crossProject = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(crossProject.status).toBe(404);

    const malformed = await h.call<ErrorBody>('POST', '/v1/holds', {
      token,
      body: { service_id: 'svc_nope', start: slot.start },
    });
    expect(malformed.status).toBe(400);
  });

  it('keeps test and live apart', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const live = await h.call<ErrorBody>('POST', '/v1/holds', {
      token: p.liveKey,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(live.status).toBe(404);
  });

  /**
   * `GET /v1/holds/{id}`.
   *
   * A hold is answered once at creation and then, until this endpoint, never again: an id that
   * got lost meant waiting ten minutes. The four states are the point of the read, so all four
   * are exercised here, including `expired`, which the row does not say until the sweep runs.
   */
  describe('GET /v1/holds/{id}', () => {
    it('reads an active hold back, in the shape the creation returned', async () => {
      const scenario = await buildScenario(h, token, {
        service: { price: { amount: 2500, currency: 'EUR' } },
      });
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const created = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: {
          service_id: scenario.serviceId,
          start: slot.start,
          customer: { email: 'read@example.com', name: 'Read' },
        },
      });
      expect(created.status).toBe(201);

      const read = await h.call<HoldBody & { booking_id: string | null }>(
        'GET',
        `/v1/holds/${created.body.id}`,
        { token },
      );
      expect(read.status).toBe(200);
      expect(read.body.id).toBe(created.body.id);
      expect(read.body.object).toBe('hold');
      expect(read.body.status).toBe('active');
      expect(read.body.booking_id).toBeNull();
      expect(read.body.service_id).toBe(created.body.service_id);
      expect(read.body.customer_id).toBe(created.body.customer_id);
      expect(read.body.start).toBe(created.body.start);
      expect(read.body.end).toBe(created.body.end);
      expect(read.body.expires_at).toBe(created.body.expires_at);
      expect(read.body.quantity).toBe(created.body.quantity);
      expect(read.body.duration_minutes).toBe(created.body.duration_minutes);
      expect(read.body.timezone).toBe(created.body.timezone);
      expect(read.body.environment).toBe('test');
      // The resources it holds, in the same allocation shape, minus `role`, which lives on
      // the requirement and not on the occupancy.
      expect(read.body.allocations.map((a) => a.resource_id)).toEqual(
        created.body.allocations.map((a) => a.resource_id),
      );
      expect(read.body.allocations.map((a) => a.capacity_used)).toEqual(
        created.body.allocations.map((a) => a.capacity_used),
      );
      expect(read.body.allocations.every((a) => a.object === 'booking_allocation')).toBe(true);
      // A hold has no stored price: the creation computed one, the row keeps none.
      expect(created.body.price).toEqual({ amount: 2500, currency: 'EUR' });
      expect(read.body.price).toBeNull();
    });

    it('says `released` after a release, and still names the resources it had held', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const created = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });
      await h.call('DELETE', `/v1/holds/${created.body.id}`, { token });

      const read = await h.call<HoldBody & { booking_id: string | null }>(
        'GET',
        `/v1/holds/${created.body.id}`,
        { token },
      );
      expect(read.body.status).toBe('released');
      expect(read.body.booking_id).toBeNull();
      expect(read.body.allocations.map((a) => a.resource_id)).toEqual(
        created.body.allocations.map((a) => a.resource_id),
      );
    });

    it('says `converted` and names the booking', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const created = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });
      const booking = await h.call<{ id: string }>('POST', '/v1/bookings', {
        token,
        body: {
          service_id: scenario.serviceId,
          start: slot.start,
          hold_id: created.body.id,
        },
      });
      expect(booking.status).toBe(201);

      const read = await h.call<HoldBody & { booking_id: string | null }>(
        'GET',
        `/v1/holds/${created.body.id}`,
        { token },
      );
      expect(read.body.status).toBe('converted');
      expect(read.body.booking_id).toBe(booking.body.id);
    });

    it('says `expired` as soon as the deadline has passed, before any sweep has run', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const created = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });

      // Only the deadline is moved. `holds.status` stays `active`, which is exactly the state
      // the row is in between the expiry and the ten-second sweep, and reporting `active`
      // there would tell the caller they can still convert something they cannot.
      const holdId = decodeId('hold', created.body.id);
      expect(holdId).not.toBeNull();
      const adminDb = createDatabase(h.pools.admin);
      await adminDb.execute(
        sql`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = ${holdId}`,
      );
      const stored = await adminDb.execute<{ status: string }>(
        sql`SELECT status FROM holds WHERE id = ${holdId}`,
      );
      expect(stored.rows[0]?.status).toBe('active');

      const read = await h.call<HoldBody & { booking_id: string | null }>(
        'GET',
        `/v1/holds/${created.body.id}`,
        { token },
      );
      expect(read.body.status).toBe('expired');
      expect(read.body.booking_id).toBeNull();
    });

    it('404s on a hold of another project, on one that never existed, and on a malformed id', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const mine = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });

      const other = await h.bootstrap('Hold reader');
      const foreign = await h.call<ErrorBody>('GET', `/v1/holds/${mine.body.id}`, {
        token: other.testKey,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe('resource_missing');

      const missing = await h.call<ErrorBody>(
        'GET',
        '/v1/holds/hold_00000000000000000000000000000000',
        { token },
      );
      expect(missing.status).toBe(404);
      const malformed = await h.call<ErrorBody>('GET', '/v1/holds/hold_nope', { token });
      expect(malformed.status).toBe(404);
      // A well formed id of another kind is a 404 too, never a 400 (`pathId` in `http.ts`).
      const wrongKind = await h.call<ErrorBody>(
        'GET',
        '/v1/holds/bk_00000000000000000000000000000000',
        { token },
      );
      expect(wrongKind.status).toBe(404);
    });

    it('keeps a live hold invisible to a test key', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const mine = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });
      const fromLive = await h.call<ErrorBody>('GET', `/v1/holds/${mine.body.id}`, {
        token: p.liveKey,
      });
      expect(fromLive.status).toBe(404);
    });

    it('is not a list: GET /v1/holds is unknown_endpoint', async () => {
      const response = await h.call<ErrorBody>('GET', '/v1/holds', { token });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_endpoint');
    });
  });

  describe('DELETE /v1/holds/{id}', () => {
    it('releases the hold, gives the slot back, and is idempotent', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const hold = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });
      expect(hold.status).toBe(201);

      cache.reset();
      const released = await h.call<{ id: string; object: string; deleted: boolean }>(
        'DELETE',
        `/v1/holds/${hold.body.id}`,
        { token },
      );
      expect(released.status).toBe(200);
      expect(released.body).toEqual({ id: hold.body.id, object: 'hold', deleted: true });
      expect(cache.invalidations.length).toBeGreaterThan(0);

      const after = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      expect(after.map((s) => s.start)).toContain(slot.start);

      // Releasing twice is not an error: the caller wanted the slot free, and it is.
      const again = await h.call('DELETE', `/v1/holds/${hold.body.id}`, { token });
      expect(again.status).toBe(200);
    });

    it('409s on a hold that has already become a booking', async () => {
      const scenario = await buildScenario(h, token, {});
      const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const hold = await h.call<HoldBody>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slot.start },
      });
      const booking = await h.call('POST', '/v1/bookings', {
        token,
        body: {
          service_id: scenario.serviceId,
          start: slot.start,
          hold_id: hold.body.id,
        },
      });
      expect(booking.status).toBe(201);

      const response = await h.call<ErrorBody>('DELETE', `/v1/holds/${hold.body.id}`, { token });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('hold_not_active');
    });

    it('404s on a hold that does not exist, or belongs to another project', async () => {
      const missing = await h.call<ErrorBody>(
        'DELETE',
        '/v1/holds/hold_00000000000000000000000000000000',
        { token },
      );
      expect(missing.status).toBe(404);

      const malformed = await h.call<ErrorBody>('DELETE', '/v1/holds/hold_nope', { token });
      expect(malformed.status).toBe(404);
    });
  });
});
