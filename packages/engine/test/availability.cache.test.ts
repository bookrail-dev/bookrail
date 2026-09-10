/**
 * The cache in front of the real calculation, on a real Postgres and a real Redis.
 *
 * The property that matters is not "it is faster": it is that **the answer does not change**.
 * Every test here computes the same request twice (once cold, once warm) and compares the
 * whole result, so a serialization that loses a segment boundary or a day slice that is
 * assembled one millisecond off fails immediately.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import {
  cacheKey,
  computeAvailability,
  loadOpenTimelines,
  MemoryAvailabilityCache,
  RedisAvailabilityCache,
  type AvailabilityCache,
  type AvailabilityDataQuery,
  type AvailabilityResult,
  type Granularity,
} from '../src/index.js';
import { createHarness, utc, type Harness } from './availability-harness.js';
import { testRedisUrl } from './redis-url.js';

const NOW = utc(2026, 9, 1, 6, 0);

let harness: Harness;
let redis: Redis;

beforeAll(async () => {
  harness = await createHarness('availability-cache');
  redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 2 });
  await redis.flushdb();
});

afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
  await harness.close();
});

interface Scenario {
  serviceId: string;
  resourceId: string;
  scheduleId: string;
}

/** Court open every day 08:00-20:00 Rome, one hour slots, one existing booking. */
async function tennis(): Promise<Scenario> {
  const location = await harness.location('Europe/Rome');
  const scheduleId = await harness.schedule({
    timezone: 'Europe/Rome',
    rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '20:00' }],
  });
  const resourceId = await harness.resource({ scheduleId, locationId: location, capacity: 1 });
  const serviceId = await harness.service({
    durationMinutes: 60,
    price: { amount: 2500, currency: 'EUR' },
  });
  await harness.requirement({ serviceId, resourceId });
  await harness.occupancy({
    resourceId,
    from: utc(2026, 9, 8, 8, 0),
    to: utc(2026, 9, 8, 9, 0),
  });
  return { serviceId, resourceId, scheduleId };
}

async function run(
  query: AvailabilityDataQuery,
  cache: AvailabilityCache | null,
  options: {
    granularity?: Granularity;
    explain?: boolean;
    quantity?: number;
    now?: number;
  } = {},
): Promise<AvailabilityResult> {
  const data = await harness.load(
    query,
    cache === null ? undefined : { occupancyCache: { cache } },
  );
  const timelines =
    cache === null
      ? undefined
      : (await loadOpenTimelines(data, query.from, query.to, { cache })).timelines;
  return computeAvailability({
    data,
    from: query.from,
    to: query.to,
    now: options.now ?? NOW,
    granularity: options.granularity,
    explain: options.explain,
    quantity: options.quantity ?? null,
    ...(timelines === undefined ? {} : { openTimelines: timelines }),
  });
}

describe('availability with the (resource, day) cache', () => {
  it('gives the same answer cold, warm, and with no cache at all', async () => {
    const { serviceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const query = {
      serviceId,
      from: utc(2026, 9, 8, 0, 0),
      to: utc(2026, 9, 11, 0, 0),
    };

    const uncached = await run(query, null);
    const cold = await run(query, cache);
    const warm = await run(query, cache);

    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
    expect(warm.slots.length).toBeGreaterThan(0);
  });

  it('misses the first time and hits the second, on the days the window touches', async () => {
    const { serviceId, resourceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 10, 0, 0) };

    const data = await harness.load(query);
    const cold = await loadOpenTimelines(data, query.from, query.to, { cache });
    expect(cold.hits).toBe(0);
    expect(cold.misses).toBeGreaterThan(0);

    const warm = await loadOpenTimelines(data, query.from, query.to, { cache });
    expect(warm.misses).toBe(0);
    expect(warm.hits).toBe(cold.misses);

    // The keys really are the documented ones, in the resource's own zone.
    expect(await cache.get(cacheKey('open', resourceId, '2026-09-08'))).not.toBeNull();
    expect(await cache.get(cacheKey('open', resourceId, '2026-09-09'))).not.toBeNull();
  });

  it('goes back to a miss for the invalidated day only', async () => {
    const { serviceId, resourceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 10, 0, 0) };
    const data = await harness.load(query);

    const cold = await loadOpenTimelines(data, query.from, query.to, { cache });
    await cache.invalidateResourceDay(resourceId, '2026-09-08');
    const after = await loadOpenTimelines(data, query.from, query.to, { cache });

    expect(after.misses).toBe(1);
    expect(after.hits).toBe(cold.misses - 1);
  });

  it('a stale open entry written for a different capacity is not believed', async () => {
    const { serviceId, resourceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 9, 0, 0) };
    const data = await harness.load(query);
    await loadOpenTimelines(data, query.from, query.to, { cache });

    const raw = await cache.get(cacheKey('open', resourceId, '2026-09-08'));
    expect(raw).not.toBeNull();
    const tampered = JSON.parse(raw as string) as { c: number };
    tampered.c = 99;
    await cache.put([
      {
        family: 'open',
        resourceId,
        day: '2026-09-08',
        value: JSON.stringify(tampered),
        ttlSeconds: 60,
      },
    ]);

    const again = await loadOpenTimelines(data, query.from, query.to, { cache });
    expect(again.misses).toBeGreaterThan(0);
  });

  it('survives a DST transition: the warm answer equals the cold one across 29 March 2026', async () => {
    const scheduleId = await harness.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }],
    });
    const resourceId = await harness.resource({ scheduleId, capacity: 1 });
    const serviceId = await harness.service({
      durationMinutes: 60,
      slotInterval: 60,
      alignTo: 'hour',
    });
    await harness.requirement({ serviceId, resourceId });

    const query = { serviceId, from: utc(2026, 3, 28, 0, 0), to: utc(2026, 3, 31, 0, 0) };
    const cache = new MemoryAvailabilityCache();
    // `now` has to sit before the window: the engine trims to `[now, ...)`.
    const march = { now: utc(2026, 3, 1, 0, 0) };
    const uncached = await run(query, null, march);
    const cold = await run(query, cache, march);
    const warm = await run(query, cache, march);

    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
    // The spring-forward day is 23 hours long: 23 hourly starts, not 24.
    const onTheDay = warm.slots.filter(
      (slot) => slot.start >= utc(2026, 3, 28, 23, 0) && slot.start < utc(2026, 3, 29, 22, 0),
    );
    expect(onTheDay).toHaveLength(23);
  });

  it('caches around exceptions and blocks without losing either', async () => {
    const scheduleId = await harness.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '18:00' }],
      exceptions: [{ date: '2026-09-09', type: 'closed' }],
    });
    const resourceId = await harness.resource({ scheduleId, capacity: 1 });
    await harness.block({
      resourceId,
      from: utc(2026, 9, 10, 9, 0),
      to: utc(2026, 9, 10, 12, 0),
    });
    const serviceId = await harness.service({ durationMinutes: 60 });
    await harness.requirement({ serviceId, resourceId });

    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 12, 0, 0) };
    const cache = new MemoryAvailabilityCache();
    const uncached = await run(query, null, { explain: true });
    const cold = await run(query, cache, { explain: true });
    const warm = await run(query, cache, { explain: true });

    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
    const codes = new Set(warm.explain?.flatMap((e) => e.reasons.map((r) => r.code)) ?? []);
    expect(codes.has('exception_closed')).toBe(true);
    expect(codes.has('blocked')).toBe(true);
  });

  it('caches continuous ranges identically', async () => {
    const scheduleId = await harness.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' }],
    });
    const resourceId = await harness.resource({ scheduleId, capacity: 2 });
    const serviceId = await harness.service({ durationRange: { min: 120, max: 4320 } });
    await harness.requirement({ serviceId, resourceId });

    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 11, 0, 0) };
    const cache = new MemoryAvailabilityCache();
    const uncached = await run(query, null, { granularity: 'ranges' });
    const warmCache = await run(query, cache, { granularity: 'ranges' });
    const warm = await run(query, cache, { granularity: 'ranges' });

    expect(warmCache).toEqual(uncached);
    expect(warm).toEqual(uncached);
    expect(warm.slots.length).toBeGreaterThan(0);
  });

  it('an expired hold cached while it was alive stops occupying once it expires', async () => {
    const scheduleId = await harness.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '18:00' }],
    });
    const resourceId = await harness.resource({ scheduleId, capacity: 1 });
    const serviceId = await harness.service({ durationMinutes: 60 });
    await harness.requirement({ serviceId, resourceId });
    // A hold that is still alive now and expires in an hour.
    const expiresAt = Date.now() + 3_600_000;
    // 09:00-10:00 Rome is 07:00-08:00 UTC.
    await harness.occupancy({
      resourceId,
      from: utc(2026, 9, 8, 7, 0),
      to: utc(2026, 9, 8, 8, 0),
      kind: 'hold',
      expiresAt,
    });

    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 9, 0, 0) };
    const cache = new MemoryAvailabilityCache();
    const held = await run(query, cache);
    expect(held.slots.some((slot) => slot.start === utc(2026, 9, 8, 7, 0))).toBe(false);

    // Same cached rows, read after the hold's own expiry: the reader drops it.
    const data = await harness.load(query, { occupancyCache: { cache, now: expiresAt + 1 } });
    const after = computeAvailability({ data, from: query.from, to: query.to, now: NOW });
    expect(after.slots.some((slot) => slot.start === utc(2026, 9, 8, 7, 0))).toBe(true);
  });

  it('works the same against Redis as against memory', async () => {
    const { serviceId } = await tennis();
    const cache = new RedisAvailabilityCache(redis);
    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 11, 0, 0) };

    const uncached = await run(query, null);
    const cold = await run(query, cache);
    const warm = await run(query, cache);

    expect(cold).toEqual(uncached);
    expect(warm).toEqual(uncached);
  });

  /**
   * A rule changed on the service has to be visible in the very next answer.
   *
   * The cache stores the two layers of a (resource, local day): the open timeline and the
   * occupancies, and **never the response**, so the price is recomputed from
   * `services.pricing_rules` on every request and there is nothing to invalidate. This test is
   * the proof of that rather than an assumption about it: the cache is warmed until every day
   * of the window is a hit, the rules are rewritten as an API `PATCH` would rewrite them, and
   * the same query answers the new price with the cache still fully warm.
   */
  it('reflects a change to pricing_rules in the next answer, with the cache still warm', async () => {
    const { serviceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const query = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 10, 0, 0) };

    const before = await run(query, cache);
    expect(before.slots.length).toBeGreaterThan(0);
    expect(before.slots.every((slot) => slot.price?.amount === 2500)).toBe(true);
    expect(before.slots.every((slot) => slot.priceRule === null)).toBe(true);

    await harness.setPricingRules(serviceId, [
      { when: { time_from: '18:00', time_to: '20:00' }, price: 4000, label: 'Evening' },
    ]);

    const data = await harness.load(query, { occupancyCache: { cache } });
    const layers = await loadOpenTimelines(data, query.from, query.to, { cache });
    // Every day of the window is served from the cache: nothing was invalidated.
    expect(layers.misses).toBe(0);
    const after = computeAvailability({
      data,
      from: query.from,
      to: query.to,
      now: NOW,
      openTimelines: layers.timelines,
    });

    expect(after.slots.map((slot) => slot.start)).toEqual(before.slots.map((slot) => slot.start));
    const evening = after.slots.filter((slot) => {
      const hour = new Date(slot.start).getUTCHours();
      // 18:00 and 19:00 in Rome are 16:00 and 17:00 UTC in September.
      return hour === 16 || hour === 17;
    });
    expect(evening.length).toBeGreaterThan(0);
    expect(evening.every((slot) => slot.price?.amount === 4000)).toBe(true);
    expect(evening.every((slot) => slot.priceRule?.index === 0)).toBe(true);
    expect(evening.every((slot) => slot.priceRule?.label === 'Evening')).toBe(true);
    const rest = after.slots.filter((slot) => !evening.includes(slot));
    expect(rest.every((slot) => slot.price?.amount === 2500)).toBe(true);
    expect(rest.every((slot) => slot.priceRule === null)).toBe(true);
  });

  it('a request whose window is a subset of a cached one reads the same days', async () => {
    const { serviceId } = await tennis();
    const cache = new MemoryAvailabilityCache();
    const wide = { serviceId, from: utc(2026, 9, 8, 0, 0), to: utc(2026, 9, 12, 0, 0) };
    const narrow = { serviceId, from: utc(2026, 9, 9, 0, 0), to: utc(2026, 9, 10, 0, 0) };

    await run(wide, cache);
    const narrowWarm = await run(narrow, cache);
    const narrowCold = await run(narrow, null);
    expect(narrowWarm).toEqual(narrowCold);

    const data = await harness.load(narrow);
    const stats = await loadOpenTimelines(data, narrow.from, narrow.to, { cache });
    expect(stats.misses).toBe(0);
  });
});
