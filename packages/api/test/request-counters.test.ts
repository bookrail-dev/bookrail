/**
 * The per project request counters, through the real app and against a real Redis.
 *
 * There is no stand-in here for the same reason there is none in the rate limit suite: what is
 * being tested is a handful of Redis commands and a rule about which requests reach them, and a
 * fake Redis would prove the rule and nothing about the commands. `TEST_REDIS_URL` or logical
 * database 15 of `REDIS_URL`, flushed of this family before each case.
 *
 * The counters are written **after** the response, on a promise nobody awaits, so every
 * assertion here waits for the condition rather than for a duration: the request having
 * returned is not the counter having been written, and a `setTimeout` aimed at the gap between
 * the two is the kind of test that is green on this machine and red on a runner with two cores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedisClient } from '@bookrail/engine';
import { decodeId } from '@bookrail/shared';
import {
  createUsageCounters,
  errorField,
  NO_USAGE_COUNTERS,
  parseUsageKey,
  previousUtcDay,
  readUsageDay,
  readUsageDays,
  RedisUsageCounters,
  usageCounterKey,
  USAGE_COUNTER_TTL_SECONDS,
  utcDay,
  type UsageRedis,
} from '../src/usage-counters.js';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { testRedisUrl } from './redis-url.js';
import { until } from './until.js';

describe('the request counters', () => {
  let redis: UsageRedis;
  let counters: RedisUsageCounters;
  let h: Harness;
  let p: BootstrappedProject;
  let projectId: string;
  let day: string;

  beforeAll(async () => {
    const url = testRedisUrl();
    redis = createRedisClient(url);
    counters = RedisUsageCounters.fromUrl(url);
    h = createHarness({ usageCounters: counters, webhookSecretKey: false });
    p = await h.bootstrap('Counters project');
    // The counter is keyed by the database identifier the authentication context carries, not
    // by the prefixed public one a customer sees: it has to be the value the digest joins on.
    projectId = decodeId('project', p.projectId) ?? p.projectId;
  });

  afterAll(async () => {
    await forget();
    await counters.close();
    await redis.quit();
    await h.close();
  });

  /** Drops every counter of this family, so each case starts from nothing. */
  async function forget(): Promise<void> {
    const found = await redis.keys('usage:*');
    if (found.length > 0) await redis.del(...found);
  }

  beforeEach(async () => {
    await forget();
    day = utcDay(Date.now());
  });

  /**
   * The day the middleware actually wrote, read back off the key.
   *
   * `beforeEach` guesses it from the clock, and the guess is right except across the UTC
   * midnight a test run can straddle, where the file would go red without anything being
   * broken. Reading the day out of the key that exists removes the guess: the family is empty
   * at the start of every case, so whatever key is there was written by the request this case
   * just made.
   */
  async function countedDay(): Promise<string> {
    const key = await until(
      async () => (await redis.keys('usage:*'))[0],
      (found) => found !== undefined,
      'a counter key to exist',
    );
    const parsed = parseUsageKey(key ?? '');
    expect(parsed, `unexpected key shape: ${key ?? '(none)'}`).not.toBeNull();
    return parsed?.day ?? day;
  }

  async function counted(): Promise<Record<string, string>> {
    day = await countedDay();
    return until(
      async () =>
        (await redis.hgetall(usageCounterKey(day, projectId, 'test'))) as Record<string, string>,
      (fields) => Number(fields.requests ?? 0) >= 3,
      'the three counted requests to reach Redis',
    );
  }

  it('counts one authenticated request per status class, and nothing else', async () => {
    // 200: the plainest authenticated read there is.
    const ok = await h.call('GET', '/v1/project', { token: p.testKey });
    expect(ok.status).toBe(200);

    // 404: authenticated, and the route does not exist.
    const missing = await h.call('GET', '/v1/not-a-route', { token: p.testKey });
    expect(missing.status).toBe(404);

    // 500: this harness was built without WEBHOOK_SECRET_KEY, so the one endpoint that refuses
    // to store a signing secret in the clear answers with the failure it is meant to answer
    // with. A real 5xx through the whole chain, not a simulated one.
    const broken = await h.call('POST', '/v1/webhooks', {
      token: p.testKey,
      body: { url: 'https://example.com/hook', events: ['booking.created'] },
    });
    expect(broken.status).toBe(500);

    // Neither of these may be counted: one carries no key, the other carries a wrong one, and
    // in both cases there is no project to attribute a request to.
    const health = await h.call('GET', '/health');
    expect(health.status).toBe(200);
    const unauthorized = await h.call('GET', '/v1/project', { token: 'bk_test_not_a_key' });
    expect(unauthorized.status).toBe(401);

    const fields = await counted();
    expect(fields.requests).toBe('3');
    expect(fields.err4xx).toBe('1');
    expect(fields.err5xx).toBe('1');

    // Three keys would mean the unauthenticated pair got a bucket of their own.
    const keys = await redis.keys('usage:*');
    expect(keys).toEqual([usageCounterKey(day, projectId, 'test')]);
  });

  it('gives the day a lifetime between eight and nine days', async () => {
    const ok = await h.call('GET', '/v1/project', { token: p.testKey });
    expect(ok.status).toBe(200);

    day = await countedDay();
    const ttl = await until(
      () => redis.ttl(usageCounterKey(day, projectId, 'test')),
      (seconds) => seconds > 0,
      'the counter key to get its expiry',
    );
    expect(ttl).toBeLessThanOrEqual(USAGE_COUNTER_TTL_SECONDS);
    expect(ttl).toBeGreaterThan(USAGE_COUNTER_TTL_SECONDS - 24 * 60 * 60);
  });

  it('keeps the two environments of one project apart', async () => {
    const live = await h.call('GET', '/v1/project', { token: p.liveKey });
    expect(live.status).toBe(200);

    day = await countedDay();
    await until(
      () => redis.hget(usageCounterKey(day, projectId, 'live'), 'requests'),
      (value) => value === '1',
      'the live key request to be counted under live',
    );
    expect(await redis.exists(usageCounterKey(day, projectId, 'test'))).toBe(0);
  });

  it('writes nothing at all, and fails nothing, when there is no Redis configured', async () => {
    const off = createHarness({ usageCounters: createUsageCounters(undefined) });
    try {
      expect(NO_USAGE_COUNTERS.kind).toBe('off');
      const project = await off.bootstrap('No counters project');
      const ok = await off.call('GET', '/v1/project', { token: project.testKey });
      expect(ok.status).toBe(200);
      // Nothing was written, and nothing threw. Asserted after a full round trip through the
      // app rather than on the object, so a future counter that wrote from somewhere else
      // would still be caught.
      expect(await redis.keys('usage:*')).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('reads a day back, project by project, through a SCAN', async () => {
    const ok = await h.call('GET', '/v1/project', { token: p.testKey });
    expect(ok.status).toBe(200);
    const missing = await h.call('GET', '/v1/not-a-route', { token: p.testKey });
    expect(missing.status).toBe(404);

    day = await countedDay();
    await until(
      () => redis.hget(usageCounterKey(day, projectId, 'test'), 'requests'),
      (value) => value === '2',
      'both requests to be counted',
    );

    const rows = await readUsageDay(redis, day);
    expect(rows).toEqual([{ projectId, environment: 'test', requests: 2, err4xx: 1, err5xx: 0 }]);
    // A day nobody made a request on is an empty answer, not a missing one.
    expect(await readUsageDay(redis, previousUtcDay(day, 3))).toEqual([]);

    // And the seven day read is one pass of the keyspace, with an entry for every day asked
    // for: the quiet days have to come back as zero rather than as absent, because the digest
    // prints one number per day and a hole would shift the whole row.
    const week = [6, 5, 4, 3, 2, 1, 0].map((back) => previousUtcDay(day, back));
    const read = await readUsageDays(redis, week);
    expect([...read.keys()]).toEqual(week);
    expect(read.get(day)).toHaveLength(1);
    expect(read.get(previousUtcDay(day, 3))).toEqual([]);
  });

  it('reads the day, the project and the environment back out of a key', () => {
    expect(parseUsageKey('usage:2026-09-13:0193abc:test')).toEqual({
      day: '2026-09-13',
      projectId: '0193abc',
      environment: 'test',
    });
    // Anything else under the prefix is skipped rather than guessed at.
    expect(parseUsageKey('usage:not-a-day:0193abc:test')).toBeNull();
    expect(parseUsageKey('usage:2026-09-13:0193abc:staging')).toBeNull();
    expect(parseUsageKey('usage:2026-09-13:0193abc')).toBeNull();
    expect(parseUsageKey('rl:key:0193abc')).toBeNull();
  });

  it('puts a status in the right column', () => {
    expect(errorField(200)).toBeNull();
    expect(errorField(301)).toBeNull();
    expect(errorField(400)).toBe('err4xx');
    expect(errorField(429)).toBe('err4xx');
    expect(errorField(499)).toBe('err4xx');
    expect(errorField(500)).toBe('err5xx');
    expect(errorField(503)).toBe('err5xx');
  });

  it('names a day in UTC, whatever the machine thinks the local day is', () => {
    expect(utcDay(Date.parse('2026-09-13T23:59:59.999Z'))).toBe('2026-09-13');
    expect(utcDay(Date.parse('2026-09-14T00:00:00.000Z'))).toBe('2026-09-14');
    expect(previousUtcDay('2026-09-01')).toBe('2026-08-31');
    expect(previousUtcDay('2026-03-30', 2)).toBe('2026-03-28');
  });
});
