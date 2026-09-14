/**
 * The rate limit as a caller sees it: the headers, the `429`, and the three things it must not do.
 *
 * Everything here goes through the real app, the real middleware chain and the real Postgres. Two
 * of the tests need a Redis that is not there, and they get one by asking the operating system for
 * a port and then not listening on it, which is a connection refused rather than a simulated one.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, uuidv7, type Logger, type LogLevel } from '@bookrail/shared';
import { generateApiKey, parseApiKey } from '../src/keys.js';
import {
  POLICY_UNAVAILABLE,
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
} from '../src/middleware/rate-limit.js';
import { MemoryRateLimiter, RedisRateLimiter } from '../src/rate-limit.js';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { testRedisUrl } from './redis-url.js';

interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

/**
 * The real logger with its sink captured, the way the other suites of this package do it.
 *
 * A hand-written stand-in would be a second implementation of something whose whole job is to
 * produce exactly these lines; this reads the lines the product actually writes.
 */
function recordingLogger(): { logger: Logger; lines: LogRecord[]; raw: string[] } {
  const raw: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => raw.push(line) });
  return {
    logger,
    raw,
    get lines(): LogRecord[] {
      return raw.map((line) => JSON.parse(line) as LogRecord);
    },
  };
}

/** A TCP port nothing is listening on: opened, its number read, and closed again. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A second secret key in the same project and the same environment as the first.
 *
 * Written with the privileged pool the way `POST /internal/bootstrap` writes the first two, and
 * for the same reason: `api_keys` is not writable by the application role, and there is no
 * endpoint that mints a key for an existing project yet.
 */
async function secondTestKey(h: Harness, project: BootstrappedProject): Promise<string> {
  const generated = generateApiKey('test');
  await h.pools.admin.query(
    `INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash, scopes)
     VALUES ($1, $2, 'test', 'secret', 'second test key', $3, $4, '{}')`,
    [uuidv7(), await projectUuid(h, project.testKey), generated.prefix, generated.keyHash],
  );
  return generated.key;
}

/**
 * The project of a key, as the database stores it.
 *
 * The identifier the API returns is prefixed (`proj_...`) and the column is a UUID, and the
 * statements below write the column. The key is the one thing that names both.
 */
async function projectUuid(h: Harness, key: string): Promise<string> {
  const parsed = parseApiKey(key);
  const { rows } = await h.pools.admin.query<{ project_id: string }>(
    'SELECT project_id FROM api_keys WHERE prefix = $1',
    [parsed?.prefix ?? ''],
  );
  const found = rows[0]?.project_id;
  if (found === undefined) throw new Error('The key of this test is not in the database.');
  return found;
}

describe('the headers, and the refusal', () => {
  let h: Harness;
  let project: BootstrappedProject;
  /**
   * Held by name so that every case below can start from an empty bucket.
   *
   * At two a second a token comes back every five hundred milliseconds, so a case that inherited
   * the bucket of the one before it would be asserting how long vitest and Postgres had taken
   * between them. Each case spends the budget it needs and asserts inside the same handful of
   * milliseconds instead.
   */
  const limiter = new MemoryRateLimiter();

  beforeAll(async () => {
    // Two a second with a burst of two: reachable in three calls, and a drain time of one second.
    h = createHarness({ rateLimit: { rate: 2, burst: 2, limiter } });
    project = await h.bootstrap('rate limit headers');
  });

  beforeEach(() => {
    limiter.clear();
  });

  afterAll(async () => {
    await h.close();
  });

  /** Spends the whole burst, so that the next call is the refused one. */
  async function drain(): Promise<void> {
    for (let index = 0; index < 2; index += 1) {
      expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(200);
    }
  }

  it('counts the budget down on every accepted response', async () => {
    const first = await h.call('GET', '/v1/project', { token: project.testKey });
    expect(first.status).toBe(200);
    expect(first.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('2');
    expect(first.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('1');
    // One request of two in flight at one every 500 ms: half a second to drain, rounded up.
    expect(first.headers.get(RATE_LIMIT_RESET_HEADER)).toBe('1');
    expect(first.headers.get(RATE_LIMIT_POLICY_HEADER)).toBeNull();

    const second = await h.call('GET', '/v1/project', { token: project.testKey });
    expect(second.status).toBe(200);
    expect(second.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('0');
  });

  it('answers the next one with 429 rate_limited, Retry-After and the three counters', async () => {
    await drain();
    const refused = await h.call<{ error: Record<string, unknown> }>('GET', '/v1/project', {
      token: project.testKey,
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({
      type: 'rate_limit',
      code: 'rate_limited',
      message: 'This key may make 2 requests per second, with bursts of 2.',
      fix: 'Wait for Retry-After, or spread the calls. Live keys have higher limits.',
      doc_url: 'https://bookrail.dev/docs/errors#rate_limited',
    });
    expect(refused.body.error.request_id).toBe(refused.headers.get('bookrail-request-id'));
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('2');
    expect(refused.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('0');
    expect(refused.headers.get(RATE_LIMIT_RESET_HEADER)).toBe('1');
    // The envelope of every other error, so a client needs no special case for it.
    expect(refused.headers.get('bookrail-version')).not.toBeNull();
  });

  it('serves the same caller again after the wait it asked for', async () => {
    await drain();
    const refused = await h.call('GET', '/v1/project', { token: project.testKey });
    expect(refused.status).toBe(429);
    const seconds = Number(refused.headers.get('retry-after'));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 50));
    const served = await h.call('GET', '/v1/project', { token: project.testKey });
    expect(served.status).toBe(200);
  });

  it('puts the counters on an error a route produced too', async () => {
    const h2 = createHarness({ rateLimit: { rate: 50, burst: 50 } });
    try {
      const project2 = await h2.bootstrap('rate limit on errors');
      const missing = await h2.call('GET', '/v1/bookings/bk_00000000000000000000000000', {
        token: project2.testKey,
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('50');
      // The first request this key has made: `POST /internal/bootstrap` is not under `/v1` and
      // therefore not counted, which is right, because it is not a call a customer can make.
      expect(missing.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('49');
    } finally {
      await h2.close();
    }
  });
});

describe('what the bucket is, and what it is not', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ rateLimit: { rate: 2, burst: 2 } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('gives two keys of one project two buckets', async () => {
    const project = await h.bootstrap('two keys one project');
    const other = await secondTestKey(h, project);

    for (let index = 0; index < 2; index += 1) {
      expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(200);
    }
    expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(429);
    // Same project, same environment, a different key: a full budget.
    const second = await h.call('GET', '/v1/project', { token: other });
    expect(second.status).toBe(200);
    expect(second.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('1');
  });

  it('gives two projects two buckets', async () => {
    const one = await h.bootstrap('bucket project one');
    const two = await h.bootstrap('bucket project two');
    for (let index = 0; index < 2; index += 1) {
      await h.call('GET', '/v1/project', { token: one.testKey });
    }
    expect((await h.call('GET', '/v1/project', { token: one.testKey })).status).toBe(429);
    expect((await h.call('GET', '/v1/project', { token: two.testKey })).status).toBe(200);
  });

  it('leaves the routes that have no key alone', async () => {
    // `/v1/signups` is under the same middleware chain and is the one part of it with no key in
    // front of it. A caller with nothing to name has no bucket, and gets no counters.
    const response = await h.call('POST', '/v1/signups', {
      // A caller address of its own: the sign up endpoints have a limit per address in the
      // database, and this test is not about that one.
      headers: { 'x-forwarded-for': '203.0.113.251' },
      body: { email: `no-bucket-${String(Date.now())}@example.com`, client: 'web' },
    });
    expect(response.status).toBe(202);
    expect(response.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBeNull();
    expect(response.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBeNull();
    expect(response.headers.get(RATE_LIMIT_POLICY_HEADER)).toBeNull();
  });

  it('counts a request that fails authentication against nothing', async () => {
    const response = await h.call('GET', '/v1/project', { token: 'sk_test_nonsense' });
    expect(response.status).toBe(401);
    expect(response.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBeNull();
  });
});

describe('a 429 and an Idempotency-Key', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ rateLimit: { rate: 2, burst: 1 } });
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * The reason the limiter sits in front of the idempotency middleware and not behind it.
   *
   * Behind it, the refusal would have been stored as the answer of the key, and the retry the
   * refusal invited would have been served that same `429` for twenty-four hours. The header
   * promises a retry the same answer, and "you were going too fast" is the one answer that must be
   * allowed to change.
   */
  it('does not consume the key, so the retry runs for real', async () => {
    const project = await h.bootstrap('idempotency under a limit');
    const key = `rate-limit-idempotency-${String(Date.now())}`;
    const body = { name: 'Bucket Tester' };

    // Spend the budget on something else, so the POST below is the refused one.
    expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(200);

    const refused = await h.call<{ error: { code: string } }>('POST', '/v1/customers', {
      token: project.testKey,
      headers: { 'idempotency-key': key },
      body,
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');

    await new Promise((resolve) =>
      setTimeout(resolve, Number(refused.headers.get('retry-after')) * 1000 + 50),
    );

    const created = await h.call<{ id: string }>('POST', '/v1/customers', {
      token: project.testKey,
      headers: { 'idempotency-key': key },
      body,
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('idempotent-replayed')).toBeNull();
    expect(created.body.id).toMatch(/^cus_/);
  });
});

describe('when the store of the counters is unreachable', () => {
  let h: Harness;
  const log = recordingLogger();

  beforeAll(async () => {
    const port = await closedPort();
    h = createHarness({
      logger: log.logger,
      rateLimit: {
        rate: 1,
        burst: 1,
        limiter: RedisRateLimiter.fromUrl(`redis://127.0.0.1:${String(port)}`),
      },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves the request, says so, and complains once a minute', async () => {
    const project = await h.bootstrap('fail open');
    // Three requests at a ceiling of one a second: without the fail open the last two would be
    // `429`, and with it all three are served.
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await h.call('GET', '/v1/project', { token: project.testKey }));
    }
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    for (const response of responses) {
      expect(response.headers.get(RATE_LIMIT_POLICY_HEADER)).toBe(POLICY_UNAVAILABLE);
      expect(response.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBeNull();
      expect(response.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBeNull();
    }

    const warnings = log.lines.filter(
      (line) => line.level === 'warn' && line.msg === 'rate_limiter_degraded',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.limiter).toBe('redis');
    // Nothing about the caller, and nothing about where the store is.
    expect(JSON.stringify(warnings[0])).not.toContain('127.0.0.1');
  });

  it('reports the limiter it was configured with on /health', async () => {
    const health = await h.call<{ rate_limiter: string }>('GET', '/health');
    expect(health.body.rate_limiter).toBe('redis');
  });
});

describe('with the limit switched off', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('adds no header and refuses nothing', async () => {
    const project = await h.bootstrap('limit off');
    for (let index = 0; index < 12; index += 1) {
      const response = await h.call('GET', '/v1/project', { token: project.testKey });
      expect(response.status).toBe(200);
      expect(response.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBeNull();
      expect(response.headers.get(RATE_LIMIT_POLICY_HEADER)).toBeNull();
    }
  });

  it('says so on /health', async () => {
    const health = await h.call<{ rate_limiter: string }>('GET', '/health');
    expect(health.body.rate_limiter).toBe('off');
  });
});

describe('over the real Redis', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({
      rateLimit: { rate: 2, burst: 2, limiter: RedisRateLimiter.fromUrl(testRedisUrl()) },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('applies the same ceiling through the shared store, and says memory is not in use', async () => {
    const project = await h.bootstrap(`redis bucket ${String(Date.now())}`);
    const served = [];
    for (let index = 0; index < 3; index += 1) {
      served.push(await h.call('GET', '/v1/project', { token: project.testKey }));
    }
    expect(served.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(served[2]?.headers.get('retry-after')).toBe('1');

    const health = await h.call<{ rate_limiter: string }>('GET', '/health');
    expect(health.body.rate_limiter).toBe('redis');
  });
});

describe('the in-process limiter behind the app', () => {
  it('is what a deployment with no Redis gets, and it works the same', async () => {
    const limiter = new MemoryRateLimiter();
    const h = createHarness({ rateLimit: { rate: 2, burst: 1, limiter } });
    try {
      const project = await h.bootstrap('memory bucket');
      expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(200);
      expect((await h.call('GET', '/v1/project', { token: project.testKey })).status).toBe(429);
      const health = await h.call<{ rate_limiter: string }>('GET', '/health');
      expect(health.body.rate_limiter).toBe('memory');
    } finally {
      await h.close();
    }
  });
});

describe('a live key and a test key have different ceilings', () => {
  /**
   * The one line that turns "20 on test keys, 100 on live ones" into behaviour.
   *
   * The two environments therefore get two different ceilings here, and both are read back from
   * the headers: with one policy for both, a middleware that always looked up `test`, or always
   * `live`, would have passed this file from end to end, and the numbers in the pricing note, in
   * the README and in the public changelog would have rested on nothing.
   */
  it('reads the policy of the environment the key belongs to', async () => {
    const h = createHarness({ rateLimit: { rate: 2, burst: 1, live: { rate: 10, burst: 4 } } });
    try {
      const project = await h.bootstrap('two environments');
      const test = await h.call('GET', '/v1/project', { token: project.testKey });
      const live = await h.call('GET', '/v1/project', { token: project.liveKey });
      expect(test.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('1');
      expect(live.headers.get(RATE_LIMIT_LIMIT_HEADER)).toBe('4');
      // And the two are separate buckets, because they are separate keys.
      expect(test.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('0');
      expect(live.headers.get(RATE_LIMIT_REMAINING_HEADER)).toBe('3');

      // The refusal quotes the policy of the key that was refused, and the other key, which has
      // the wider one, is untouched by it.
      const refused = await h.call<{ error: { message: string } }>('GET', '/v1/project', {
        token: project.testKey,
      });
      expect(refused.status).toBe(429);
      expect(refused.body.error.message).toBe(
        'This key may make 2 requests per second, with bursts of 1.',
      );
      expect((await h.call('GET', '/v1/project', { token: project.liveKey })).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

/** The one statement that proves the bucket name never carries the key itself. */
describe('what is written down', () => {
  it('logs the key id and never the key', async () => {
    const log = recordingLogger();
    const h = createHarness({ logger: log.logger, rateLimit: { rate: 2, burst: 1 } });
    try {
      const project = await h.bootstrap('what is logged');
      await h.call('GET', '/v1/project', { token: project.testKey });
      const refused = await h.call('GET', '/v1/project', { token: project.testKey });
      expect(refused.status).toBe(429);

      const line = log.lines.find((entry) => entry.msg === 'rate_limited');
      expect(line?.level).toBe('info');
      expect(line).toMatchObject({
        project_id: await projectUuid(h, project.testKey),
        environment: 'test',
        method: 'GET',
        path: '/v1/project',
        rate: 2,
        burst: 1,
      });
      expect(line?.api_key_id).toEqual(expect.any(String));
      expect(log.raw.join('\n')).not.toContain(project.testKey);
      // And nothing at all for the request that was served.
      expect(log.lines.filter((entry) => entry.msg === 'rate_limited')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
