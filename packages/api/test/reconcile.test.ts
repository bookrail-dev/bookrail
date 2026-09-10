/**
 * The two nightly reconciliations.
 *
 * Both are measurements, so both are tested the same way: run them on a healthy database and
 * check they say nothing, then break exactly one thing and check they say exactly that.
 *
 * The integrity check is asserted as a **delta** rather than as an absolute zero, because the
 * test databases are shared between suites and every suite that lowers a capacity leaves a
 * window behind.
 *
 * That last fact is also what the check itself is about. Lowering a resource's capacity under
 * what is already sold is an **allowed** operation (it is precisely what `booking.orphaned`
 * reports with `capacity_exceeded`), and it leaves the resource genuinely over capacity until
 * the business resolves it. The first version of this job called that an `error`, which would
 * have meant shouting at business as usual; since the independent review it separates the two,
 * and the three cases below are the whole specification:
 *
 *   1. nothing wrong          → `violations` and `explained` both unchanged;
 *   2. a capacity lowered via `PATCH` → `explained` grows, `violations` does not;
 *   3. a row smuggled in past the trigger → `violations` grows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { runIntegrityCheck, runOrphanReconciliation } from '../src/jobs/index.js';
import { buildScenario, nextMonday, plusDays } from './booking-fixtures.js';

const DAY_MS = 86_400_000;

describe('the nightly reconciliations', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let token: string;
  let monday: Date;

  beforeAll(async () => {
    h = createHarness({ cache: new MemoryAvailabilityCache() });
    p = await h.bootstrap('Reconciliation project');
    token = p.testKey;
    monday = nextMonday();
  });

  afterAll(async () => {
    await h.close();
  });

  const deps = (): { db: ReturnType<typeof createDatabase>; logger: Harness['logger'] } => ({
    db: createDatabase(h.pools.app),
    logger: h.logger,
  });

  it('finds nothing new while the capacity invariant holds', async () => {
    const before = await runIntegrityCheck(deps());
    const scenario = await buildScenario(h, token, { capacity: 2 });
    const start = new Date(plusDays(monday, 2).setUTCHours(8, 0, 0, 0)).toISOString();
    const first = await h.call('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start },
    });
    expect(first.status).toBe(201);

    const after = await runIntegrityCheck(deps());
    expect(after.violations).toBe(before.violations);
    expect(after.explained).toBe(before.explained);
    // The denominator of the log line exists and is at least as big as what was measured.
    expect(after.total).toBeGreaterThan(0);
    expect(after.scanned).toBeLessThanOrEqual(after.total);
  });

  /**
   * The case the independent review found, reproduced through the public API.
   *
   * Three bookings on a resource of capacity 3, then a `PATCH` that lowers it to 2. The `PATCH`
   * succeeds: lowering a capacity under what is already sold is allowed, because the invariant
   * is that no more than N units are ever taken and lowering N takes nothing, so the trigger
   * deliberately does not fire on it. It emits `booking.orphaned`
   * with reason `capacity_exceeded`, which is how the customer finds out. The resource is now
   * genuinely over capacity, and the job must call that **expected**, not a broken invariant:
   * an alarm that fires on business as usual is an alarm nobody reads.
   *
   * Capacity 3 → 2 and not 2 → 1, because at capacity 1 the exclusion constraint
   * `occ_no_overlap_cap1` refuses the `PATCH` outright with a 409: a different, already tested
   * behaviour, and not the one under examination here.
   */
  it('calls a capacity lowered under what was sold explained, not a violation', async () => {
    const before = await runIntegrityCheck(deps());
    const scenario = await buildScenario(h, token, { capacity: 3 });
    const resourceId = scenario.resourceIds[0]!;
    const start = new Date(plusDays(monday, 3).setUTCHours(9, 0, 0, 0)).toISOString();

    for (let i = 0; i < 3; i += 1) {
      const booked = await h.call('POST', '/v1/bookings', {
        token,
        body: { service_id: scenario.serviceId, start },
      });
      expect(booked.status).toBe(201);
    }

    const patched = await h.call('PATCH', `/v1/resources/${resourceId}`, {
      token,
      body: { capacity: 2 },
    });
    expect(patched.status).toBe(200);

    // The `PATCH` told the customer: that event is the whole reason the window is expected.
    const admin = createDatabase(h.pools.admin);
    const { rows: orphaned } = await admin.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events
       WHERE type = 'booking.orphaned'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(data -> 'reasons') r
                      WHERE r ->> 'code' = 'capacity_exceeded'
                        AND r ->> 'resource_id' = ${resourceId})
    `);
    expect(orphaned[0]?.n).toBeGreaterThanOrEqual(1);

    const after = await runIntegrityCheck(deps());
    expect(after.explained).toBeGreaterThan(before.explained);
    expect(after.violations).toBe(before.violations);
    expect(after.samples.map((s) => s.resourceId)).not.toContain(decodeId('resource', resourceId));
  }, 60_000);

  /**
   * The only way to produce a violation is to write around the guard, which is also the only
   * situation the check exists for. `ALTER TABLE … DISABLE TRIGGER` needs the table owner, so
   * this runs on the admin connection, the same one a support session would use, which is the
   * scenario being simulated.
   */
  it('counts a row that was written with the capacity guard disabled', async () => {
    const admin = createDatabase(h.pools.admin);
    const before = await runIntegrityCheck(deps());

    const scenario = await buildScenario(h, token, { capacity: 1 });
    const resourceId = decodeId('resource', scenario.resourceIds[0]!);
    await admin.execute(
      sql`ALTER TABLE occupancies DISABLE TRIGGER occupancies_capacity_guard_insert`,
    );
    try {
      await admin.execute(sql`
        INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                                 kind, ref_id)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'test', ${resourceId},
                tstzrange('2031-01-05T09:00:00Z'::timestamptz,
                          '2031-01-05T10:00:00Z'::timestamptz, '[)'),
                4, 'booking', ${uuidv7()})
      `);
    } finally {
      await admin.execute(
        sql`ALTER TABLE occupancies ENABLE TRIGGER occupancies_capacity_guard_insert`,
      );
    }

    const after = await runIntegrityCheck(deps());
    expect(after.violations).toBe(before.violations + 1);
    expect(after.explained).toBe(before.explained);
    expect(after.resources).toBe(before.resources + 1);
    expect(after.samples.map((s) => s.resourceId)).toContain(resourceId);

    await admin.execute(sql`DELETE FROM occupancies WHERE resource_id = ${resourceId}`);
  });

  /**
   * The gap the reconciliation exists to close: a booking 120 days out, made inconsistent by a
   * `PATCH` on its schedule. The `PATCH` says nothing (its horizon is ninety days, because it
   * runs while somebody waits for the response), and the job, which has all night, says it.
   */
  it('reports a booking past the interactive horizon that a PATCH left behind', async () => {
    const scenario = await buildScenario(h, token, {
      capacity: 1,
      rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00' }],
    });
    const far = new Date(monday.getTime() + 120 * DAY_MS);
    const start = new Date(far.setUTCHours(10, 0, 0, 0)).toISOString();

    const booking = await h.call<{ id: string }>('POST', '/v1/bookings', {
      token,
      body: { service_id: scenario.serviceId, start },
    });
    expect(booking.status).toBe(201);

    const orphanEvents = async (): Promise<number> => {
      const admin = createDatabase(h.pools.admin);
      const { rows } = await admin.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM events
         WHERE type = 'booking.orphaned' AND data->>'id' = ${booking.body.id}
      `);
      return rows[0]?.n ?? 0;
    };
    expect(await orphanEvents()).toBe(0);

    // Close the afternoon the booking sits in. The booking is 120 days out, so the write's own
    // detection, capped at ninety, does not reach it.
    const patched = await h.call('PATCH', `/v1/schedules/${scenario.scheduleId}`, {
      token,
      body: {
        rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '09:30' }],
      },
    });
    expect(patched.status).toBe(200);
    expect(await orphanEvents()).toBe(0);

    const report = await runOrphanReconciliation(deps(), { horizonDays: 365, limit: 1000 });
    expect(report.scopes).toBeGreaterThanOrEqual(1);
    expect(report.orphaned).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);
    expect(await orphanEvents()).toBe(1);
  }, 60_000);

  /** No deduplication, on purpose: one event per detection, not one per problem. */
  it('reports it again on the next run, because the log is a log', async () => {
    const admin = createDatabase(h.pools.admin);
    const { rows: before } = await admin.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events
       WHERE type = 'booking.orphaned' AND project_id = ${decodeId('project', p.projectId)}
    `);
    await runOrphanReconciliation(deps(), { horizonDays: 365, limit: 1000 });
    const { rows: after } = await admin.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM events
       WHERE type = 'booking.orphaned' AND project_id = ${decodeId('project', p.projectId)}
    `);
    expect(after[0]!.n).toBeGreaterThan(before[0]!.n);
  }, 60_000);
});
