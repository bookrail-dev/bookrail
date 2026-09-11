/**
 * The background worker: the two tasks directly, and then the real pg-boss loop on top.
 *
 * Split on purpose. `runHoldExpiry` and `purgeIdempotencyKeys` are what a reader has to trust,
 * so they are exercised in isolation, synchronously, with assertions against the database. The
 * queue is exercised once, end to end, to prove the only thing that is left: that a tick
 * actually reaches them, on its own, without anybody calling anything.
 *
 * The worker under test ticks every second rather than every ten, because the interval is a
 * configuration value and waiting ten seconds would buy nothing; the documented ten seconds is
 * asserted separately, as the default.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { MemoryAvailabilityCache, type AvailabilityCache, type CacheWrite } from '@bookrail/engine';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import {
  DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS,
  purgeIdempotencyKeys,
  purgeSignups,
  runBookingTransitions,
  runHoldExpiry,
  runIntegrityCheck,
  startWorker,
  type Worker,
} from '../src/jobs/index.js';
import { buildScenario, firstSlot, nextMonday, plusDays, slotsFor } from './booking-fixtures.js';
import { resolveDatabaseUrls } from '@bookrail/db';
import { TEST_DB_NAME } from './db-name.js';

class RecordingCache implements AvailabilityCache {
  readonly inner = new MemoryAvailabilityCache();
  invalidations: string[] = [];

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
    this.invalidations.push(`${resourceId}:${day}`);
    await this.inner.invalidateResourceDay(resourceId, day);
  }
  async invalidateResource(resourceId: string): Promise<void> {
    this.invalidations.push(`${resourceId}:*`);
    await this.inner.invalidateResource(resourceId);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Ages a hold with admin SQL, which is the only way to make "ten minutes from now" past. */
async function ageHold(h: Harness, holdId: string): Promise<void> {
  const adminDb = createDatabase(h.pools.admin);
  const id = decodeId('hold', holdId);
  await adminDb.execute(sql`
    UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = ${id}
  `);
  await adminDb.execute(sql`
    UPDATE occupancies SET expires_at = now() - interval '1 minute'
     WHERE ref_id = ${id} AND kind = 'hold'
  `);
}

async function holdStatus(h: Harness, holdId: string): Promise<string | undefined> {
  const adminDb = createDatabase(h.pools.admin);
  const { rows } = await adminDb.execute<{ status: string }>(sql`
    SELECT status FROM holds WHERE id = ${decodeId('hold', holdId)}
  `);
  return rows[0]?.status;
}

async function activeOccupancies(h: Harness, holdId: string): Promise<number> {
  const adminDb = createDatabase(h.pools.admin);
  const { rows } = await adminDb.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM occupancies
     WHERE ref_id = ${decodeId('hold', holdId)} AND kind = 'hold' AND active
  `);
  return rows[0]?.n ?? 0;
}

async function expiredEvents(h: Harness, holdId: string): Promise<number> {
  const adminDb = createDatabase(h.pools.admin);
  const { rows } = await adminDb.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM events
     WHERE type = 'hold.expired' AND data->>'id' = ${holdId}
  `);
  return rows[0]?.n ?? 0;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

describe('background jobs', () => {
  let h: Harness;
  let cache: RecordingCache;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  beforeAll(async () => {
    cache = new RecordingCache();
    h = createHarness({ cache });
    p = await h.bootstrap('Jobs project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  it('expires a hold whose time is up, writes the event, and drops the cached day', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    expect(hold.status).toBe(201);
    await ageHold(h, hold.body.id);

    cache.reset();
    const deps = {
      db: createDatabase(h.pools.app),
      cache,
      logger: h.logger,
    };
    const report = await runHoldExpiry(deps);

    expect(report.expired).toBeGreaterThanOrEqual(1);
    expect(await holdStatus(h, hold.body.id)).toBe('expired');
    expect(await activeOccupancies(h, hold.body.id)).toBe(0);
    expect(await expiredEvents(h, hold.body.id)).toBe(1);
    expect(
      cache.invalidations.some((entry) =>
        entry.startsWith(`${decodeId('resource', scenario.resourceIds[0]!) ?? ''}:`),
      ),
    ).toBe(true);

    // The slot is bookable again.
    const after = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    expect(after.map((s) => s.start)).toContain(slot.start);

    // Running it again finds nothing to do and writes no second event.
    const second = await runHoldExpiry(deps);
    expect(second.expired).toBe(0);
    expect(await expiredEvents(h, hold.body.id)).toBe(1);
  });

  it('does not touch a hold that is still alive', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, ttl: '30m' },
    });

    await runHoldExpiry({
      db: createDatabase(h.pools.app),
      cache,
      logger: h.logger,
    });

    expect(await holdStatus(h, hold.body.id)).toBe('active');
    expect(await activeOccupancies(h, hold.body.id)).toBe(1);
  });

  it('never touches a hold that became a booking', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    const booking = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start, hold_id: hold.body.id },
    });
    expect(booking.status).toBe(201);
    await ageHold(h, hold.body.id);

    await runHoldExpiry({
      db: createDatabase(h.pools.app),
      cache,
      logger: h.logger,
    });

    expect(await holdStatus(h, hold.body.id)).toBe('converted');
    expect(await expiredEvents(h, hold.body.id)).toBe(0);
  });

  /**
   * The worker holds no privileged database handle at all.
   *
   * The type says so (`startWorker` and every task take `db` and never an `adminDb`), and this
   * says it at run time, on the object a deployment actually builds: the sweeps, the purge and
   * the reconciliations all answer their cross-project question through the `SECURITY DEFINER`
   * functions of migrations 0013 and 0015, on the RLS-bound application pool.
   */
  it('runs every sweep with the application connection and nothing else', async () => {
    const deps = { db: createDatabase(h.pools.app), cache, logger: h.logger };

    // The guarantee is that the deployment cannot build a privileged worker even by mistake, and
    // that is a property of two files, not of the object literal above: asserting that a
    // literal written two lines earlier has no `adminDb` key would be a test of this test.
    // So: the entry point opens exactly one pool, and the only
    // connection string it hands `startWorker` besides the application one is pg-boss's, which
    // owns the queue schema and sees no tenant data.
    const entryPoint = await readFile(new URL('../src/worker-main.ts', import.meta.url), 'utf8');
    expect(entryPoint.match(/createPool\(/g) ?? []).toHaveLength(1);
    expect(entryPoint).toMatch(/createPool\(\{ connectionString: config\.urls\.app/);
    expect(entryPoint).not.toMatch(/adminDb/);
    // And `startWorker` has nowhere to put one: the type names the four things it takes.
    const worker = await readFile(new URL('../src/jobs/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain("Pick<AppDeps, 'db' | 'cache' | 'logger' | 'webhookSecretKey'>");

    const { rows } = await deps.db.execute<{ role: string; bypass: boolean }>(sql`
      SELECT current_user AS role, r.rolbypassrls AS bypass
        FROM pg_roles r WHERE r.rolname = current_user
    `);
    expect(rows[0]?.bypass).toBe(false);

    // Each of the four cross-project questions, asked on that connection.
    await expect(runHoldExpiry(deps)).resolves.toBeDefined();
    await expect(runBookingTransitions(deps)).resolves.toBeDefined();
    await expect(
      purgeIdempotencyKeys({ db: deps.db, logger: h.logger }),
    ).resolves.toBeGreaterThanOrEqual(0);
    await expect(purgeSignups({ db: deps.db, logger: h.logger })).resolves.toBeGreaterThanOrEqual(
      0,
    );
    await expect(runIntegrityCheck(deps)).resolves.toBeDefined();
  });

  /**
   * The sign up purge rides on the hourly queue, next to the idempotency one.
   *
   * Asserted on the file rather than by waiting for an hour: the two calls are in the same
   * handler, so a change that dropped one would leave the address of somebody who never
   * confirmed sitting in the table for ever, which is the one thing a retention promise cannot
   * survive. What the purge actually does is proved in `signups.test.ts`, with the instant as a
   * parameter and nothing waited for.
   */
  it('sweeps the sign up table on the same hourly job as the idempotency keys', async () => {
    const worker = await readFile(new URL('../src/jobs/worker.ts', import.meta.url), 'utf8');
    const handler = worker.slice(worker.indexOf('IDEMPOTENCY_PURGE_QUEUE, { batchSize: 1 }'));
    expect(handler.slice(0, 600)).toContain('purgeSignups');
    expect(worker).toContain("boss.schedule(IDEMPOTENCY_PURGE_QUEUE, '0 * * * *')");
  });

  it('runs the sweep on its own through pg-boss', async () => {
    const scenario = await buildScenario(h, token, {});
    const slot = await firstSlot(h, token, scenario.serviceId, monday, plusDays(monday, 1));
    const hold = await h.call<{ id: string }>('POST', '/v1/holds', {
      token,
      body: { service_id: scenario.serviceId, start: slot.start },
    });
    await ageHold(h, hold.body.id);

    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache,
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        {
          connectionString: urls.admin,
          intervalSeconds: 1,
          maxConnections: 2,
          // No cron watchdog: this test is about the self-rearming loop, and a scheduler
          // polling in the background would only slow the suite down.
          schedule: false,
        },
      );

      const swept = await waitFor(
        async () => (await holdStatus(h, hold.body.id)) === 'expired',
        15_000,
      );
      expect(swept).toBe(true);
      expect(await activeOccupancies(h, hold.body.id)).toBe(0);
      expect(await expiredEvents(h, hold.body.id)).toBe(1);

      // A second hold, aged after the worker started, is swept by a later tick: the loop
      // really is a loop, not one run at boot.
      const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
      const second = await h.call<{ id: string }>('POST', '/v1/holds', {
        token,
        body: { service_id: scenario.serviceId, start: slots[0]!.start },
      });
      expect(second.status).toBe(201);
      await ageHold(h, second.body.id);
      const sweptAgain = await waitFor(
        async () => (await holdStatus(h, second.body.id)) === 'expired',
        15_000,
      );
      expect(sweptAgain).toBe(true);
    } finally {
      if (worker) await worker.stop();
    }
  }, 60_000);

  it('keeps the documented ten second interval as the default', () => {
    expect(DEFAULT_HOLD_EXPIRY_INTERVAL_SECONDS).toBe(10);
  });

  it('runs as the application role, so RLS is between the job and the data', async () => {
    // `expireHolds` refuses a superuser connection: the whole safety argument of the booking
    // transaction rests on the database deciding which rows a statement may touch, and a job
    // that bypassed it would be the one writer that could cross projects.
    const adminAsApp = createDatabase(h.pools.admin);
    const { expireHolds } = await import('@bookrail/engine');
    await expect(
      expireHolds(adminAsApp, {
        projectId: decodeId('project', p.projectId) ?? p.projectId,
        environment: 'test',
      }),
    ).rejects.toThrow(/application role/i);
  });

  it('leaves an untouched idempotency key alone and deletes an expired one', async () => {
    const adminDb = createDatabase(h.pools.admin);
    const projectId = decodeId('project', p.projectId) ?? p.projectId;
    const alive = `job-alive-${uuidv7()}`;
    const dead = `job-dead-${uuidv7()}`;
    await adminDb.execute(sql`
      INSERT INTO idempotency_keys (id, project_id, environment, key, request_hash, expires_at)
      VALUES (${uuidv7()}, ${projectId}, 'test', ${alive}, repeat('c', 64),
              now() + interval '10 hours'),
             (${uuidv7()}, ${projectId}, 'test', ${dead}, repeat('d', 64),
              now() - interval '1 minute')
    `);

    await purgeIdempotencyKeys({ db: createDatabase(h.pools.app), logger: h.logger });

    const { rows } = await adminDb.execute<{ key: string }>(sql`
      SELECT key FROM idempotency_keys WHERE key IN (${alive}, ${dead})
    `);
    expect(rows.map((row) => row.key)).toEqual([alive]);
  });
});
