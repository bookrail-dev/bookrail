/**
 * The three availability endpoints, end to end: real Postgres, real HTTP handlers, the real
 * engine, and the real cache underneath.
 *
 * Fixtures are built through the API itself rather than by writing rows, because half of
 * what is under test is the contract (prefixed identifiers in and out, ISO 8601 with an
 * offset in, UTC out) and a fixture that bypasses it would not exercise any of that. The one
 * exception is the booking used for the customer limit: the engine owns the writer, so the row
 * is inserted with SQL, on the same database, through the same pool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { MemoryAvailabilityCache, type AvailabilityCache, type CacheWrite } from '@bookrail/engine';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';

/** Wraps a real cache and counts what the endpoints ask of it, per key family. */
class CountingCache implements AvailabilityCache {
  readonly inner = new MemoryAvailabilityCache();
  hits = 0;
  misses = 0;
  invalidations = 0;

  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
  }

  private record(values: (string | null)[]): void {
    for (const value of values) {
      if (value === null) this.misses += 1;
      else this.hits += 1;
    }
  }

  async get(key: string): Promise<string | null> {
    const value = await this.inner.get(key);
    this.record([value]);
    return value;
  }

  async getMany(keys: readonly string[]): Promise<(string | null)[]> {
    const values = await this.inner.getMany(keys);
    this.record(values);
    return values;
  }

  put(writes: readonly CacheWrite[]): Promise<void> {
    return this.inner.put(writes);
  }

  async invalidateResourceDay(resourceId: string, day: string): Promise<void> {
    this.invalidations += 1;
    await this.inner.invalidateResourceDay(resourceId, day);
  }

  async invalidateResource(resourceId: string): Promise<void> {
    this.invalidations += 1;
    await this.inner.invalidateResource(resourceId);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Midnight UTC of a Monday at least a week away, so `min_notice` is never in the way. */
function nextMonday(): Date {
  const day = new Date(Date.now() + 7 * 86_400_000);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

const HOUR_IN_ROME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  hour12: false,
});

function romeHour(iso: string): number {
  return Number(HOUR_IN_ROME.format(new Date(iso)));
}

function plusDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

interface Slot {
  object: string;
  start: string;
  end: string;
  duration_minutes: number | null;
  min_duration_minutes?: number;
  max_duration_minutes?: number;
  available_capacity: number;
  price: { amount: number; currency: string } | null;
  price_rule: { index: number; label: string | null } | null;
  resource_options: {
    resources: { resource_id: string; role: string | null; capacity_used: number }[];
  }[];
}

interface AvailabilityBody {
  object: string;
  service_id: string;
  timezone: string;
  granularity: string;
  slots: Slot[];
  next_available: string | null;
  reason?: { code: string; message: string };
  explain?: {
    at: string;
    reasons: { code: string; message: string; resource_id?: string; ref_id?: string }[];
  }[];
  explain_notes?: { code: string; message: string; index: number }[];
  explain_truncated?: boolean;
}

interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string };
}

describe('availability endpoints', () => {
  let h: Harness;
  let cache: CountingCache;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  /** Location + schedule + resource + service, all through the public API. */
  async function scenario(options: {
    rules?: { days_of_week: number[]; start_time: string; end_time: string }[];
    scheduleTimezone?: string | null;
    withLocation?: boolean;
    capacity?: number;
    service: Record<string, unknown>;
    resources?: number;
  }): Promise<{
    locationId: string | null;
    scheduleId: string;
    resourceIds: string[];
    serviceId: string;
  }> {
    const locationId =
      options.withLocation === false
        ? null
        : (
            await h.call<{ id: string }>('POST', '/v1/locations', {
              token,
              body: { name: `Club ${uuidv7().slice(0, 8)}`, timezone: 'Europe/Rome' },
            })
          ).body.id;

    const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
      token,
      body: {
        name: 'Opening hours',
        timezone: options.scheduleTimezone === undefined ? 'Europe/Rome' : options.scheduleTimezone,
        rules: options.rules ?? [
          { days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00' },
        ],
      },
    });
    expect(schedule.status).toBe(201);

    const resourceIds: string[] = [];
    for (let i = 0; i < (options.resources ?? 1); i += 1) {
      const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
        token,
        body: {
          name: `Court ${String(i + 1)}`,
          type: 'room',
          schedule_id: schedule.body.id,
          ...(locationId === null ? {} : { location_id: locationId }),
          capacity: options.capacity ?? 1,
        },
      });
      expect(resource.status).toBe(201);
      resourceIds.push(resource.body.id);
    }

    const service = await h.call<{ id: string }>('POST', '/v1/services', {
      token,
      body: {
        name: 'Service',
        requirements: resourceIds.map((id) => ({ resource_id: id })),
        ...options.service,
      },
    });
    expect(service.status).toBe(201);

    return { locationId, scheduleId: schedule.body.id, resourceIds, serviceId: service.body.id };
  }

  function availability(
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: AvailabilityBody }> {
    return h.call<AvailabilityBody>('POST', '/v1/availability', { token, body });
  }

  beforeAll(async () => {
    cache = new CountingCache();
    h = createHarness({ cache });
    p = await h.bootstrap('Availability project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  describe('POST /v1/availability', () => {
    it('returns UTC slots on the local grid, with price and prefixed resource options', async () => {
      const { serviceId, resourceIds } = await scenario({
        service: { duration: 60, price: { amount: 2500, currency: 'EUR' } },
      });

      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('availability');
      expect(response.body.service_id).toBe(serviceId);
      expect(response.body.timezone).toBe('Europe/Rome');
      expect(response.body.granularity).toBe('slots');
      // 09:00 to 18:00 with a one hour booking: nine starts, the last at 17:00.
      expect(response.body.slots).toHaveLength(9);
      expect(romeHour(response.body.slots[0]!.start)).toBe(9);
      expect(romeHour(response.body.slots[8]!.start)).toBe(17);
      expect(response.body.next_available).toBe(response.body.slots[0]!.start);

      const first = response.body.slots[0]!;
      expect(first.object).toBe('availability_slot');
      expect(first.start.endsWith('Z')).toBe(true);
      expect(new Date(first.end).getTime() - new Date(first.start).getTime()).toBe(3_600_000);
      expect(first.duration_minutes).toBe(60);
      expect(first.available_capacity).toBe(1);
      expect(first.price).toEqual({ amount: 2500, currency: 'EUR' });
      expect(first.resource_options).toEqual([
        { resources: [{ resource_id: resourceIds[0], role: null, capacity_used: 1 }] },
      ]);
    });

    /**
     * The price on a slot is the price the rules produce, and `price_rule` names the rule. The
     * fixture is one service open every day 09:00-18:00 Rome with a rule on the evening band,
     * so the same request carries two different prices depending on the hour.
     */
    it('prices every slot with the rules of the service and names the rule that applied', async () => {
      const { serviceId } = await scenario({
        service: {
          duration: 60,
          price: { amount: 2500, currency: 'EUR' },
          pricing_rules: [
            { when: { time_from: '17:00', time_to: '18:00' }, price_add: 1000, label: 'Evening' },
          ],
        },
      });

      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      expect(response.status).toBe(200);
      expect(response.body.slots).toHaveLength(9);

      for (const slot of response.body.slots) {
        const hour = romeHour(slot.start);
        if (hour === 17) {
          expect(slot.price).toEqual({ amount: 3500, currency: 'EUR' });
          expect(slot.price_rule).toEqual({ index: 0, label: 'Evening' });
        } else {
          expect(slot.price).toEqual({ amount: 2500, currency: 'EUR' });
          expect(slot.price_rule).toBeNull();
        }
      }
    });

    it('echoes the requested presentation time zone without moving the grid', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const rome = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      const tokyo = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        timezone: 'Asia/Tokyo',
      });

      expect(tokyo.body.timezone).toBe('Asia/Tokyo');
      expect(rome.body.timezone).toBe('Europe/Rome');
      expect(tokyo.body.slots.map((s) => s.start)).toEqual(rome.body.slots.map((s) => s.start));
    });

    it('accepts any offset on input and answers in UTC', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const withOffset = new Date(monday.getTime()).toISOString().replace('Z', '+00:00');
      const response = await availability({
        service_id: serviceId,
        from: withOffset,
        to: plusDays(monday, 1).toISOString(),
      });
      expect(response.status).toBe(200);
      expect(response.body.slots.every((slot) => slot.start.endsWith('Z'))).toBe(true);
    });

    it('filters by resource_ids', async () => {
      const { serviceId, resourceIds } = await scenario({
        resources: 2,
        service: { duration: 60 },
      });
      // Two required resources: filtering one out leaves the service unsatisfiable.
      const filtered = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        resource_ids: [resourceIds[0]!],
      });
      expect(filtered.status).toBe(200);
      expect(filtered.body.slots).toHaveLength(0);
      expect(filtered.body.next_available).toBeNull();
    });

    it('reports the capacity a bigger quantity leaves', async () => {
      const { serviceId } = await scenario({ capacity: 4, service: { duration: 60 } });
      const two = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        quantity: 2,
      });
      expect(two.body.slots[0]?.available_capacity).toBe(4);

      const nine = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        quantity: 9,
      });
      expect(nine.body.slots).toHaveLength(0);
    });

    it('returns continuous ranges, truncated at `to`, with the real maximum duration', async () => {
      const { serviceId } = await scenario({
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
        service: { duration_range: { min: 120, max: 4320 } },
      });
      const to = plusDays(monday, 2);
      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: to.toISOString(),
        granularity: 'ranges',
      });

      expect(response.status).toBe(200);
      expect(response.body.granularity).toBe('ranges');
      expect(response.body.slots.length).toBeGreaterThan(0);
      const range = response.body.slots[0]!;
      expect(range.duration_minutes).toBeNull();
      expect(range.min_duration_minutes).toBe(120);
      // The range itself reaches past the window; `end` is capped, `max_duration` is not.
      expect(new Date(range.end).getTime()).toBeLessThanOrEqual(to.getTime());
      expect(range.max_duration_minutes).toBeGreaterThan(
        (to.getTime() - new Date(range.start).getTime()) / 60_000,
      );
    });

    it('explains the instants it discarded', async () => {
      const { serviceId, resourceIds } = await scenario({ service: { duration: 60 } });
      const block = await h.call<{ id: string }>('POST', `/v1/resources/${resourceIds[0]!}/block`, {
        token,
        body: {
          from: new Date(monday.getTime() + 7 * 3_600_000).toISOString(),
          to: new Date(monday.getTime() + 10 * 3_600_000).toISOString(),
          reason: 'Maintenance',
        },
      });
      expect(block.status).toBe(201);

      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        explain: true,
      });

      expect(response.status).toBe(200);
      expect(response.body.explain).toBeDefined();
      expect(response.body.explain_truncated).toBe(false);
      const codes = new Set(response.body.explain?.flatMap((e) => e.reasons.map((r) => r.code)));
      expect(codes.has('blocked')).toBe(true);
      const blocked = response.body.explain
        ?.flatMap((e) => e.reasons)
        .find((r) => r.code === 'blocked');
      expect(blocked?.resource_id).toBe(resourceIds[0]);
      expect(blocked?.message).toContain('blocked');
    });

    /**
     * A rule the strict schema refuses is skipped, and `explain` says so instead of leaving the
     * caller to notice that `price_rule.index` points somewhere else. The bad rule goes in with
     * SQL because the API refuses it, which is the point: it can only come from a row written
     * before the schema.
     */
    it('names a stored pricing rule it had to ignore, and prices with the next one', async () => {
      const { serviceId } = await scenario({
        service: {
          duration: 60,
          price: { amount: 3000, currency: 'EUR' },
          pricing_rules: [{ when: { days: ['mon'] }, price_add: 500, label: 'Monday' }],
        },
      });
      const adminDb = createDatabase(h.pools.admin);
      await adminDb.execute(sql`
        UPDATE services
           SET pricing_rules = ${JSON.stringify([
             { when: { time_from: '09:00' }, price: 9900, label: 'Broken' },
             { when: { days: ['mon'] }, price_add: 500, label: 'Monday' },
           ])}::jsonb
         WHERE id = ${decodeId('service', serviceId)}
      `);

      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        explain: true,
      });
      expect(response.status).toBe(200);
      expect(response.body.explain_notes).toHaveLength(1);
      expect(response.body.explain_notes?.[0]).toMatchObject({
        code: 'pricing_rule_ignored',
        index: 0,
      });

      // Monday, so rule 1 matches, and it is still rule 1: the hole keeps its position.
      for (const slot of response.body.slots) {
        expect(slot.price).toEqual({ amount: 3500, currency: 'EUR' });
        expect(slot.price_rule).toEqual({ index: 1, label: 'Monday' });
      }

      // Without `explain` the field is absent, like every other part of `explain`.
      const quiet = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      expect(quiet.body.explain_notes).toBeUndefined();
    });

    it('refuses explain over a window wider than seven days', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 8).toISOString(),
          explain: true,
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('range_too_large');
      expect(response.body.error.param).toBe('explain');
    });

    it('refuses a window wider than ninety days', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 91).toISOString(),
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.type).toBe('invalid_request');
      expect(response.body.error.code).toBe('range_too_large');
    });

    it('refuses a window × interval combination that would blow past the instant ceiling', async () => {
      const { serviceId } = await scenario({
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
        service: { duration: 60, slot_interval: 1 },
      });
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 89).toISOString(),
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('range_too_large');
      expect(response.body.error.message).toContain('candidate instants');
    });

    it('turns an engine ceiling into a 400, never a 500', async () => {
      // A service that may run for a year forces a materialization window of 372 local days,
      // over `materializeSchedule`'s 366 day ceiling. The engine raises `EngineLimitError` with
      // `code: 'range_too_large'` and the route translates it **by type**:
      // until then the code was read off the message with a regular expression, so rewording an
      // engine error silently changed the code of a public API.
      const { serviceId } = await scenario({
        service: { duration_range: { min: 60, max: 525_600 } },
      });
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 7).toISOString(),
          granularity: 'ranges',
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.type).toBe('invalid_request');
      expect(response.body.error.code).toBe('range_too_large');
      expect(response.body.error.message).toContain('local days');
    });

    it('carries the code on the error object, not in its wording', async () => {
      // The other branch of the translation, reached through HTTP: a stored time zone the
      // engine does not recognise. `schedules.timezone` is plain `text`, so it can be written
      // around the API's own validation, which is exactly how a database restored from a bad
      // import would look. The engine answers `EngineLimitError` with
      // `code: 'parameter_invalid'` and the route reads that field: it no longer runs a
      // regular expression over the message to decide.
      const { serviceId, scheduleId } = await scenario({ service: { duration: 60 } });
      const adminDb = createDatabase(h.pools.admin);
      await adminDb.execute(sql`
        UPDATE schedules SET timezone = 'Nowhere/Nothing'
         WHERE id = ${decodeId('schedule', scheduleId)}
      `);
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 1).toISOString(),
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('parameter_invalid');
    });

    it('404s an unknown service and 400s a malformed one', async () => {
      const missing = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: `svc_${uuidv7().replace(/-/g, '')}`,
          from: monday.toISOString(),
          to: plusDays(monday, 1).toISOString(),
        },
      });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('resource_missing');

      const malformed = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: 'loc_not_a_service',
          from: monday.toISOString(),
          to: plusDays(monday, 1).toISOString(),
        },
      });
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe('parameter_invalid');
    });

    it('400s a resource that cannot say which clock it runs on', async () => {
      const { serviceId } = await scenario({
        withLocation: false,
        scheduleTimezone: null,
        service: { duration: 60 },
      });
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: monday.toISOString(),
          to: plusDays(monday, 1).toISOString(),
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('timezone_missing');
    });

    it('400s an inverted window and an instant without an offset', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const inverted = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: {
          service_id: serviceId,
          from: plusDays(monday, 1).toISOString(),
          to: monday.toISOString(),
        },
      });
      expect(inverted.status).toBe(400);
      expect(inverted.body.error.param).toBe('to');

      const naive = await h.call<ErrorBody>('POST', '/v1/availability', {
        token,
        body: { service_id: serviceId, from: '2026-09-08T09:00:00', to: '2026-09-09T09:00:00' },
      });
      expect(naive.status).toBe(400);
      expect(naive.body.error.code).toBe('parameter_invalid');
    });

    it('answers 200 with a reason when the customer is already at the policy limit', async () => {
      const policy = await h.call<{ id: string }>('POST', '/v1/policies', {
        token,
        body: { name: 'One at a time', max_active_bookings_per_customer: 1 },
      });
      expect(policy.status).toBe(201);
      const { serviceId } = await scenario({
        service: { duration: 60, policy_id: policy.body.id },
      });
      const customer = await h.call<{ id: string }>('POST', '/v1/customers', {
        token,
        body: { name: 'Ada', email: `ada-${uuidv7().slice(0, 8)}@example.com` },
      });
      expect(customer.status).toBe(201);

      // The engine owns the booking writer; the row goes in with SQL, on the same database.
      const starts = new Date(monday.getTime() + 30 * 86_400_000);
      await h.pools.admin.query(
        `INSERT INTO bookings (id, project_id, environment, status, service_id, customer_id,
                               starts_at, ends_at, timezone)
         SELECT $1, project_id, environment, 'confirmed', id, $2, $3, $4, 'Europe/Rome'
           FROM services WHERE id = $5`,
        [
          uuidv7(),
          decodeId('customer', customer.body.id),
          starts.toISOString(),
          new Date(starts.getTime() + 3_600_000).toISOString(),
          decodeId('service', serviceId),
        ],
      );

      const response = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
        customer_id: customer.body.id,
      });
      expect(response.status).toBe(200);
      expect(response.body.slots).toHaveLength(0);
      expect(response.body.reason?.code).toBe('customer_limit_reached');
      expect(response.body.reason?.message).toContain('active bookings');
    });

    it('requires an API key', async () => {
      const response = await h.call<ErrorBody>('POST', '/v1/availability', {
        body: { service_id: 'svc_x', from: monday.toISOString(), to: monday.toISOString() },
      });
      expect(response.status).toBe(401);
    });
  });

  describe('GET /v1/availability/next', () => {
    it('finds the next slot and says how far it looked', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const response = await h.call<{
        object: string;
        service_id: string;
        timezone: string;
        next_available: string | null;
        slot: Slot | null;
        searched_through: string;
      }>(
        'GET',
        `/v1/availability/next?service_id=${serviceId}&from=${encodeURIComponent(monday.toISOString())}`,
        {
          token,
        },
      );

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('availability_next');
      expect(response.body.service_id).toBe(serviceId);
      expect(response.body.timezone).toBe('Europe/Rome');
      expect(response.body.next_available).not.toBeNull();
      expect(romeHour(response.body.next_available as string)).toBe(9);
      expect(response.body.slot?.duration_minutes).toBe(60);
      // The first thirty day window was enough.
      expect(new Date(response.body.searched_through).getTime()).toBe(
        monday.getTime() + 30 * 86_400_000,
      );
    });

    it('answers null after scanning the whole ninety day horizon', async () => {
      const { serviceId } = await scenario({
        rules: [
          {
            days_of_week: [0, 1, 2, 3, 4, 5, 6],
            start_time: '09:00',
            end_time: '18:00',
          },
        ],
        service: { duration: 60 },
      });
      // Ten hours does not fit in a nine hour opening band: nothing is ever available.
      const extra = await h.call('PATCH', `/v1/services/${serviceId}`, {
        token,
        body: { duration: 600 },
      });
      expect(extra.status).toBe(200);

      const response = await h.call<{ next_available: string | null; searched_through: string }>(
        'GET',
        `/v1/availability/next?service_id=${serviceId}&from=${encodeURIComponent(monday.toISOString())}`,
        { token },
      );
      expect(response.status).toBe(200);
      expect(response.body.next_available).toBeNull();
      expect(new Date(response.body.searched_through).getTime()).toBe(
        monday.getTime() + 90 * 86_400_000,
      );
    });

    it('takes quantity and timezone, and rejects an unknown query parameter', async () => {
      const { serviceId } = await scenario({ capacity: 3, service: { duration: 60 } });
      const ok = await h.call<{ timezone: string; slot: Slot | null }>(
        'GET',
        `/v1/availability/next?service_id=${serviceId}&quantity=3&timezone=Asia/Tokyo`,
        { token },
      );
      expect(ok.status).toBe(200);
      expect(ok.body.timezone).toBe('Asia/Tokyo');
      expect(ok.body.slot?.available_capacity).toBe(3);

      const typo = await h.call<ErrorBody>(
        'GET',
        `/v1/availability/next?service_id=${serviceId}&quantitiy=3`,
        { token },
      );
      expect(typo.status).toBe(400);
      expect(typo.body.error.type).toBe('invalid_request');
    });
  });

  describe('POST /v1/availability/check', () => {
    it('confirms a slot the listing offered', async () => {
      const { serviceId, resourceIds } = await scenario({
        service: { duration: 60, price: { amount: 1500, currency: 'EUR' } },
      });
      const listing = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      const start = listing.body.slots[0]!.start;

      const response = await h.call<{
        object: string;
        available: boolean;
        available_capacity: number;
        duration_minutes: number | null;
        price: { amount: number } | null;
        resource_options: { resources: { resource_id: string }[] }[];
        reasons?: { code: string }[];
      }>('POST', '/v1/availability/check', {
        token,
        body: { service_id: serviceId, start, quantity: 1 },
      });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('availability_check');
      expect(response.body.available).toBe(true);
      expect(response.body.available_capacity).toBe(1);
      expect(response.body.duration_minutes).toBe(60);
      expect(response.body.price).toEqual({ amount: 1500, currency: 'EUR' });
      expect(response.body.resource_options[0]?.resources[0]?.resource_id).toBe(resourceIds[0]);
      expect(response.body.reasons).toBeUndefined();
    });

    it('explains an instant that is not on the grid at all', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      // 04:00 UTC is well before the 09:00 Rome opening.
      const response = await h.call<{
        available: boolean;
        available_capacity: number;
        reasons: { code: string; resource_id?: string }[];
      }>('POST', '/v1/availability/check', {
        token,
        body: {
          service_id: serviceId,
          start: new Date(monday.getTime() + 4 * 3_600_000).toISOString(),
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.available).toBe(false);
      expect(response.body.available_capacity).toBe(0);
      expect(response.body.reasons.map((r) => r.code)).toContain('outside_schedule');
    });

    it('says a slot is taken once something occupies it', async () => {
      const { serviceId, resourceIds } = await scenario({ service: { duration: 60 } });
      const listing = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      const start = listing.body.slots[1]!.start;
      const blocked = await h.call<{ id: string }>(
        'POST',
        `/v1/resources/${resourceIds[0]!}/block`,
        {
          token,
          body: { from: start, to: new Date(new Date(start).getTime() + 3_600_000).toISOString() },
        },
      );
      expect(blocked.status).toBe(201);

      const response = await h.call<{ available: boolean; reasons: { code: string }[] }>(
        'POST',
        '/v1/availability/check',
        { token, body: { service_id: serviceId, start } },
      );
      expect(response.body.available).toBe(false);
      expect(response.body.reasons.map((r) => r.code)).toContain('blocked');
    });

    it('picks one of several durations, and refuses one the service does not offer', async () => {
      const { serviceId } = await scenario({ service: { duration_options: [30, 60, 90] } });
      const listing = await availability({
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 1).toISOString(),
      });
      const start = listing.body.slots[0]!.start;

      const ninety = await h.call<{ available: boolean; duration_minutes: number }>(
        'POST',
        '/v1/availability/check',
        { token, body: { service_id: serviceId, start, duration_minutes: 90 } },
      );
      expect(ninety.status).toBe(200);
      expect(ninety.body.available).toBe(true);
      expect(ninety.body.duration_minutes).toBe(90);

      const refused = await h.call<ErrorBody>('POST', '/v1/availability/check', {
        token,
        body: { service_id: serviceId, start, duration_minutes: 45 },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('parameter_invalid');
      expect(refused.body.error.param).toBe('duration_minutes');
    });
  });

  describe('the two level cache', () => {
    it('misses cold, hits warm, and reflects a schedule change immediately', async () => {
      const { serviceId, scheduleId } = await scenario({ service: { duration: 60 } });
      const window = {
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 3).toISOString(),
      };

      cache.reset();
      const cold = await availability(window);
      expect(cold.status).toBe(200);
      expect(cache.misses).toBeGreaterThan(0);
      const coldMisses = cache.misses;

      cache.reset();
      const warm = await availability(window);
      expect(warm.body.slots).toEqual(cold.body.slots);
      expect(cache.hits).toBe(coldMisses);
      expect(cache.misses).toBe(0);

      // PATCH on the schedule must invalidate the resource's cached days.
      cache.reset();
      const patched = await h.call('PATCH', `/v1/schedules/${scheduleId}`, {
        token,
        body: {
          rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '14:00', end_time: '18:00' }],
        },
      });
      expect(patched.status).toBe(200);
      expect(cache.invalidations).toBeGreaterThan(0);

      cache.reset();
      const after = await availability(window);
      expect(cache.misses).toBeGreaterThan(0);
      expect(romeHour(after.body.slots[0]!.start)).toBe(14);
      expect(after.body.slots.length).toBeLessThan(cold.body.slots.length);
    });

    it('invalidates on a new exception, on a block, and on a capacity change', async () => {
      const { serviceId, scheduleId, resourceIds } = await scenario({
        service: { duration: 60 },
      });
      const window = {
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 2).toISOString(),
      };
      await availability(window);

      const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(monday);
      cache.reset();
      const exception = await h.call('POST', `/v1/schedules/${scheduleId}/exceptions`, {
        token,
        body: { date: localDay, type: 'closed', reason: 'Holiday' },
      });
      expect(exception.status).toBe(201);
      expect(cache.invalidations).toBeGreaterThan(0);

      const closed = await availability(window);
      expect(
        closed.body.slots.filter(
          (slot) => new Date(slot.start).getTime() < monday.getTime() + 86_400_000,
        ),
      ).toHaveLength(0);

      cache.reset();
      const blocked = await h.call<{ id: string }>(
        'POST',
        `/v1/resources/${resourceIds[0]!}/block`,
        {
          token,
          body: {
            from: new Date(monday.getTime() + 86_400_000 + 8 * 3_600_000).toISOString(),
            to: new Date(monday.getTime() + 86_400_000 + 9 * 3_600_000).toISOString(),
          },
        },
      );
      expect(blocked.status).toBe(201);
      expect(cache.invalidations).toBeGreaterThan(0);

      cache.reset();
      const capacity = await h.call('PATCH', `/v1/resources/${resourceIds[0]!}`, {
        token,
        body: { capacity: 5 },
      });
      expect(capacity.status).toBe(200);
      expect(cache.invalidations).toBe(1);

      const wider = await availability(window);
      expect(wider.body.slots[0]?.available_capacity).toBe(5);
    });

    it('gives the same answer with the cache disabled', async () => {
      const { serviceId } = await scenario({ service: { duration: 60 } });
      const window = {
        service_id: serviceId,
        from: monday.toISOString(),
        to: plusDays(monday, 2).toISOString(),
      };
      const cached = await availability(window);

      const { NoAvailabilityCache } = await import('@bookrail/engine');
      const bare = createHarness({ cache: new NoAvailabilityCache() });
      try {
        const response = await bare.call<AvailabilityBody>('POST', '/v1/availability', {
          token,
          body: window,
        });
        expect(response.body.slots).toEqual(cached.body.slots);
      } finally {
        await bare.close();
      }
    });
  });
});
