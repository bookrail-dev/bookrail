/**
 * The four engine-side guarantees of the consolidation.
 *
 * They have nothing in common except that each one closes a known gap between what the engine
 * claimed and what it enforced, so they share a file rather than pretending to be four subjects:
 *
 *  * **the footprint arithmetic exists once.** `occupancyFootprint` in TypeScript and
 *    `occupancy_footprint` in SQL are held against each other on random inputs, because they are
 *    the two halves of the rule that decides whether a booking is accepted, and a disagreement of
 *    one millisecond is a slot the engine offers and then refuses;
 *  * **a ceiling carries its own error code.** The HTTP layer used to tell `range_too_large` from
 *    `parameter_invalid` with a regular expression over the message;
 *  * **the customer limit is a limit.** Twenty simultaneous bookings of one customer on twenty
 *    disjoint resources, under a policy that allows three;
 *  * **the role check is paid once per connection**, and is still paid every time on a connection
 *    that would bypass Row Level Security.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPool,
  resolveDatabaseUrls,
  sql,
  withProjectContext,
  type Database,
} from '@bookrail/db';
import { uuidv7 } from '@bookrail/shared';

import {
  applicationRoleChecksRun,
  assertApplicationRole,
  createBooking,
  discretize,
  EngineLimitError,
  materializeSchedule,
  occupancyFootprint,
  type OccupancyData,
} from '../src/index.js';
import { createHarness, utc, HOUR, type Harness } from './availability-harness.js';
import { TEST_DB_NAME } from './db-name.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MONDAY = utc(2030, 7, 8);

describe('the footprint is one rule, written once', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Footprint parity');
  });
  afterAll(async () => {
    await h.close();
  });

  /**
   * The oracle is the database, not a second TypeScript implementation: it is the SQL side that
   * `peakUsage`, `peakUsagePerPeriod` and the capacity trigger of migration 0014 all run, and it
   * is the side that is not exercised by the in-memory suites.
   */
  it('agrees with the SQL function on random occupancies', async () => {
    const arbCase = fc.record({
      startMinutes: fc.integer({ min: 0, max: 20_000 }),
      durationMinutes: fc.integer({ min: 1, max: 600 }),
      bufferBeforeMs: fc.integer({ min: 0, max: 86_400_000 }),
      bufferAfterMs: fc.integer({ min: 0, max: 86_400_000 }),
      queryBeforeMs: fc.integer({ min: 0, max: 86_400_000 }),
      queryAfterMs: fc.integer({ min: 0, max: 86_400_000 }),
      sharing: fc.boolean(),
      kind: fc.constantFrom('booking' as const, 'hold' as const, 'block' as const),
    });

    await fc.assert(
      fc.asyncProperty(arbCase, async (c) => {
        const start = MONDAY + c.startMinutes * 60_000;
        const end = start + c.durationMinutes * 60_000;
        const occupancy: OccupancyData = {
          id: uuidv7(),
          resourceId: uuidv7(),
          refId: uuidv7(),
          start,
          end,
          capacityUsed: 1,
          kind: c.kind,
          bufferBeforeMs: c.bufferBeforeMs,
          bufferAfterMs: c.bufferAfterMs,
        };
        const inMemory = occupancyFootprint(occupancy, c.queryBeforeMs, c.queryAfterMs, c.sharing);

        // The same two numbers the SQL callers pass: with sharing on, the querying service's
        // buffers absorb the occupancy's; with it off, nothing is absorbed.
        const shareLeft = c.sharing ? c.queryAfterMs : 0;
        const shareRight = c.sharing ? c.queryBeforeMs : 0;
        const { rows } = await h.admin.execute<{ lo: string; hi: string }>(sql`
          SELECT (extract(epoch FROM lower(fp)) * 1000)::bigint AS lo,
                 (extract(epoch FROM upper(fp)) * 1000)::bigint AS hi
            FROM occupancy_footprint(
                   tstzrange(${new Date(start).toISOString()}::timestamptz,
                             ${new Date(end).toISOString()}::timestamptz, '[)'),
                   ${c.kind}, ${c.bufferBeforeMs}, ${c.bufferAfterMs},
                   ${shareLeft}::int, ${shareRight}::int) AS fp
        `);
        expect(Number(rows[0]?.lo)).toBe(inMemory.start);
        expect(Number(rows[0]?.hi)).toBe(inMemory.end);
      }),
      { numRuns: 150 },
    );
  }, 60_000);

  /** With no sharing arguments the function returns the bare period, which is what the guard uses. */
  it('returns the bare period when the querying context absorbs everything', async () => {
    const start = MONDAY;
    const end = MONDAY + HOUR;
    const { rows } = await h.admin.execute<{ lo: string; hi: string }>(sql`
      SELECT (extract(epoch FROM lower(fp)) * 1000)::bigint AS lo,
             (extract(epoch FROM upper(fp)) * 1000)::bigint AS hi
        FROM occupancy_footprint(
               tstzrange(${new Date(start).toISOString()}::timestamptz,
                         ${new Date(end).toISOString()}::timestamptz, '[)'),
               'booking', 900000, 900000) AS fp
    `);
    expect(Number(rows[0]?.lo)).toBe(start);
    expect(Number(rows[0]?.hi)).toBe(end);
  });
});

describe('engine ceilings carry their own code', () => {
  it('throws EngineLimitError with range_too_large when discretize runs out of instants', () => {
    let thrown: unknown;
    try {
      discretize([{ start: 0, end: 3_600_000, capacity: 1 }], 1_000, { kind: 'epoch' }, 5);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineLimitError);
    expect((thrown as EngineLimitError).code).toBe('range_too_large');
    // Still a RangeError, because the engine is a library before it is an API.
    expect(thrown).toBeInstanceOf(RangeError);
  });

  it('throws range_too_large when a materialization spans too many local days', () => {
    let thrown: unknown;
    try {
      materializeSchedule({
        timezone: 'Europe/Rome',
        capacity: 1,
        rules: [{ daysOfWeek: EVERY_DAY, startTime: '09:00', endTime: '17:00' }],
        exceptions: [],
        from: MONDAY,
        to: MONDAY + 400 * 86_400_000,
        maxDays: 10,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineLimitError);
    expect((thrown as EngineLimitError).code).toBe('range_too_large');
  });

  it('throws parameter_invalid for an argument that is simply wrong', () => {
    let thrown: unknown;
    try {
      discretize([{ start: 0, end: 10, capacity: 1 }], 0, { kind: 'epoch' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineLimitError);
    expect((thrown as EngineLimitError).code).toBe('parameter_invalid');
  });

  it('has no bare RangeError left anywhere in the engine', () => {
    // The engine throws its own subclass everywhere it used to throw `new RangeError(...)`,
    // including where it wraps one Temporal raises. Reading the sources is what makes this a
    // permanent statement rather than a snapshot of today's call sites.
    expect(bareRangeErrorThrows()).toEqual([]);
  });
});

function bareRangeErrorThrows(): string[] {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && readFileSync(full, 'utf8').includes('new RangeError(')) {
        offenders.push(full.slice(root.length));
      }
    }
  };
  walk(root);
  return offenders;
}

describe('max_active_bookings_per_customer under contention', () => {
  let h: Harness;
  let serviceId: string;
  let customerId: string;
  let resourceIds: string[];
  /**
   * A pool of its own, wide enough that the attempts really do overlap.
   *
   * The shared harness pool holds three connections, which is fewer than the limit under test:
   * the first three attempts would then be the only ones in flight together, all would read a
   * count of zero, and all three would be allowed, which is the correct answer and proves
   * nothing. With ten connections the fourth and the fifth are inside the transaction while the
   * first three are still open, which is the interleaving that used to overshoot the limit.
   */
  let racers: Database;
  let racerPool: ReturnType<typeof createPool>;

  const RESOURCES = 20;
  const LIMIT = 3;
  const START = MONDAY + 8 * HOUR;

  beforeAll(async () => {
    h = await createHarness('Customer limit race');
    const schedule = await h.schedule({
      timezone: 'UTC',
      rules: [{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '23:00' }],
    });
    const policyId = await h.policy({ maxActiveBookingsPerCustomer: LIMIT });

    // One requirement over a group of twenty interchangeable rooms, and each attempt below then
    // pins itself to **one** of them with `resourceIds`. That is what makes the locks disjoint:
    // every transaction takes the advisory lock of its own room and of nothing else, so before
    // the advisory lock on the customer nothing at all was shared between two concurrent
    // bookings of the same customer.
    resourceIds = [];
    for (let i = 0; i < RESOURCES; i += 1) {
      resourceIds.push(await h.resource({ name: `Room ${String(i)}`, scheduleId: schedule }));
    }
    const groupId = await h.group({ members: resourceIds.map((id) => ({ resourceId: id })) });
    serviceId = await h.service({ durationMinutes: 60, policyId, slotInterval: 60 });
    await h.requirement({ serviceId, groupId });
    customerId = await h.customer();

    racerPool = createPool({
      connectionString: resolveDatabaseUrls({ databaseName: TEST_DB_NAME }).app,
      max: 10,
    });
    racers = createDatabase(racerPool);
  }, 60_000);

  afterAll(async () => {
    await racerPool.end();
    await h.close();
  });

  it('creates exactly the limit when twenty bookings race on disjoint resources', async () => {
    const outcomes = await Promise.all(
      resourceIds.map((resourceId) =>
        createBooking(racers, {
          projectId: h.projectId,
          environment: h.environment,
          serviceId,
          customerId,
          resourceIds: [resourceId],
          start: START,
          kind: 'booking',
          now: MONDAY - 86_400_000,
        }).then(
          () => 'created' as const,
          (error: unknown) => (error as { code?: string }).code ?? 'unknown',
        ),
      ),
    );

    const created = outcomes.filter((o) => o === 'created').length;
    const refused = outcomes.filter((o) => o === 'customer_limit_reached').length;
    expect(created).toBe(LIMIT);
    expect(refused).toBe(RESOURCES - LIMIT);

    const { rows } = await h.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM bookings
       WHERE customer_id = ${customerId} AND status IN ('pending', 'confirmed')
    `);
    expect(Number(rows[0]?.n)).toBe(LIMIT);
  }, 60_000);
});

describe('the application role check', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('Role check memo');
  });
  afterAll(async () => {
    await h.close();
  });

  it('runs once per connection, not once per transaction', async () => {
    const scope = { projectId: h.projectId, environment: h.environment };
    // One connection, taken and released ten times: the pool hands the same client back.
    await withProjectContext(h.app, scope, (tx) => assertApplicationRole(tx));
    const after = applicationRoleChecksRun();
    for (let i = 0; i < 10; i += 1) {
      await withProjectContext(h.app, scope, (tx) => assertApplicationRole(tx));
    }
    expect(applicationRoleChecksRun()).toBe(after);
  });

  it('still refuses a connection that bypasses row level security, every time', async () => {
    const scope = { projectId: h.projectId, environment: h.environment };
    for (let i = 0; i < 3; i += 1) {
      const before = applicationRoleChecksRun();
      await expect(
        withProjectContext(h.admin, scope, (tx) => assertApplicationRole(tx)),
      ).rejects.toThrow(/bypasses row level security/);
      // Never memoized: the check ran again.
      expect(applicationRoleChecksRun()).toBeGreaterThan(before);
    }
  });
});
