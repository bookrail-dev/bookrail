/**
 * Cost of the two things the consolidation added to the booking transaction:
 *  - the statement level capacity guard (migration 0014);
 *  - the advisory lock plus re-read that makes `max_active_bookings_per_customer` a limit.
 *
 * Not a vitest bench: both need DDL (`ALTER TABLE … DISABLE TRIGGER`) between the runs, so the
 * measurement is a script that sets the database up, times `createBooking` on a real Postgres,
 * and prints the percentiles.
 *
 * `pnpm --filter @bookrail/engine run bench:consolidation`. It creates and drops its own
 * database (`BENCH_DB_NAME`, default `bookrail_bench_007a`), so it never measures against, nor
 * disturbs, the databases the test suites use.
 */
/* eslint-disable no-console -- this is a command line runner; printing is its output. */
import { createDatabase, createPool, resolveDatabaseUrls, sql } from '@bookrail/db';
import { createTestDatabase } from '@bookrail/db/testing';
import { uuidv7 } from '@bookrail/shared';
import { createBooking } from '@bookrail/engine';

const BENCH_DB = process.env.BENCH_DB_NAME ?? 'bookrail_bench_007a';
const urls = resolveDatabaseUrls({ databaseName: BENCH_DB });
await createTestDatabase(BENCH_DB);
const adminPool = createPool({ connectionString: urls.admin, max: 2 });
const appPool = createPool({ connectionString: urls.app, max: 2 });
const admin = createDatabase(adminPool);
const app = createDatabase(appPool);

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const HOUR = 3_600_000;
const BASE = Date.UTC(2032, 2, 1, 0, 0, 0);

const ITERATIONS = Number(process.env.ITERATIONS ?? 200);
const SEED_OCCUPANCIES = Number(process.env.SEED ?? 2000);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

async function scenario(options: {
  capacity: number;
  /** A policy row exists. `customerLimit` null with `policy` true is the control fixture. */
  policy: boolean;
  customerLimit: number | null;
}): Promise<{
  projectId: string;
  serviceId: string;
  resourceId: string;
  customerId: string | null;
}> {
  const accountId = uuidv7();
  const projectId = uuidv7();
  await admin.execute(
    sql`INSERT INTO accounts (id, name, api_version) VALUES (${accountId}, 'Consolidation bench', '2026-09-01')`,
  );
  await admin.execute(
    sql`INSERT INTO projects (id, account_id, name) VALUES (${projectId}, ${accountId}, 'Consolidation bench')`,
  );
  const scheduleId = uuidv7();
  await admin.execute(sql`
    INSERT INTO schedules (id, project_id, environment, name, timezone)
    VALUES (${scheduleId}, ${projectId}, 'test', 'Round the clock', 'UTC')
  `);
  await admin.execute(sql`
    INSERT INTO schedule_rules (id, project_id, environment, schedule_id, days_of_week,
                                start_time, end_time)
    VALUES (${uuidv7()}, ${projectId}, 'test', ${scheduleId},
            ${sql.param(EVERY_DAY)}::smallint[], '00:00', '00:00')
  `);
  const resourceId = uuidv7();
  await admin.execute(sql`
    INSERT INTO resources (id, project_id, environment, name, type, schedule_id, capacity)
    VALUES (${resourceId}, ${projectId}, 'test', 'Studio', 'room', ${scheduleId}, ${options.capacity})
  `);

  let policyId: string | null = null;
  if (options.policy) {
    policyId = uuidv7();
    await admin.execute(sql`
      INSERT INTO policies (id, project_id, environment, name, max_active_bookings_per_customer)
      VALUES (${policyId}, ${projectId}, 'test', 'Limit', ${options.customerLimit})
    `);
  }

  const serviceId = uuidv7();
  await admin.execute(sql`
    INSERT INTO services (id, project_id, environment, name, duration_minutes,
                          capacity_per_booking, slot_interval_minutes, policy_id)
    VALUES (${serviceId}, ${projectId}, 'test', 'Bench', 60, 1, 60, ${policyId})
  `);
  await admin.execute(sql`
    INSERT INTO service_requirements (id, project_id, environment, service_id, resource_id,
                                      quantity, consumes, position)
    VALUES (${uuidv7()}, ${projectId}, 'test', ${serviceId}, ${resourceId}, 1, 'per_unit', 0)
  `);

  let customerId: string | null = null;
  if (options.policy) {
    customerId = uuidv7();
    await admin.execute(sql`
      INSERT INTO customers (id, project_id, environment, name, email)
      VALUES (${customerId}, ${projectId}, 'test', 'Bench', ${`bench-${customerId}@example.com`})
    `);
  }

  // Existing load on the resource, so the guard's window really has rows to walk. Seeded with
  // the guard off: this is fixture setup, not a measurement.
  await admin.execute(
    sql`ALTER TABLE occupancies DISABLE TRIGGER occupancies_capacity_guard_insert`,
  );
  try {
    for (let i = 0; i < SEED_OCCUPANCIES; i += 1) {
      const start = BASE + (i % 720) * HOUR;
      await admin.execute(sql`
        INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                                 kind, ref_id)
        VALUES (${uuidv7()}, ${projectId}, 'test', ${resourceId},
                tstzrange(${new Date(start).toISOString()}::timestamptz,
                          ${new Date(start + HOUR).toISOString()}::timestamptz, '[)'),
                1, 'booking', ${uuidv7()})
      `);
    }
  } finally {
    await admin.execute(
      sql`ALTER TABLE occupancies ENABLE TRIGGER occupancies_capacity_guard_insert`,
    );
  }
  await admin.execute(sql`ANALYZE occupancies`);

  return { projectId, serviceId, resourceId, customerId };
}

async function alternating(
  label: string,
  fixture: { projectId: string; serviceId: string; customerId: string | null },
  blocks: number,
  perBlock: number,
  setA: () => Promise<void>,
  setB: () => Promise<void>,
  nameA: string,
  nameB: string,
): Promise<void> {
  const a: number[] = [];
  const b: number[] = [];
  let day = 40;
  for (let block = 0; block < blocks; block += 1) {
    // The order of the two blocks alternates from one round to the next. The table grows by
    // `perBlock` rows every block, so whichever configuration always ran second would always
    // be measured against a slightly larger table;
    // the distortion is small (the guard's window is only the new booking's own period), but
    // removing it costs two lines and removes the objection with it.
    const first = block % 2 === 0 ? setA : setB;
    const second = block % 2 === 0 ? setB : setA;
    const firstOut = block % 2 === 0 ? a : b;
    const secondOut = block % 2 === 0 ? b : a;
    await first();
    firstOut.push(...(await sample(fixture, day++, perBlock)));
    await second();
    secondOut.push(...(await sample(fixture, day++, perBlock)));
  }
  const pa = percentile(a, 50);
  const pb = percentile(b, 50);
  console.log(
    `${label}: ${nameA} p50 ${pa.toFixed(2)} ms (p95 ${percentile(a, 95).toFixed(2)}) | ` +
      `${nameB} p50 ${pb.toFixed(2)} ms (p95 ${percentile(b, 95).toFixed(2)}) | ` +
      `overhead ${(((pa - pb) / pb) * 100).toFixed(1)} % on ${String(a.length)} + ${String(b.length)} samples`,
  );
}

async function sample(
  fixture: { projectId: string; serviceId: string; customerId: string | null },
  offsetDays: number,
  iterations: number,
): Promise<number[]> {
  const durations: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = BASE + offsetDays * 24 * HOUR + i * HOUR;
    const began = process.hrtime.bigint();
    await createBooking(app, {
      projectId: fixture.projectId,
      environment: 'test',
      serviceId: fixture.serviceId,
      customerId: fixture.customerId,
      start,
      kind: 'booking',
      now: BASE - 86_400_000,
    });
    durations.push(Number(process.hrtime.bigint() - began) / 1e6);
  }
  return durations;
}

const enableGuard = async (): Promise<void> => {
  await admin.execute(
    sql`ALTER TABLE occupancies ENABLE TRIGGER occupancies_capacity_guard_insert`,
  );
  await admin.execute(
    sql`ALTER TABLE occupancies ENABLE TRIGGER occupancies_capacity_guard_update`,
  );
};
const disableGuard = async (): Promise<void> => {
  await admin.execute(
    sql`ALTER TABLE occupancies DISABLE TRIGGER occupancies_capacity_guard_insert`,
  );
  await admin.execute(
    sql`ALTER TABLE occupancies DISABLE TRIGGER occupancies_capacity_guard_update`,
  );
};

async function main(): Promise<void> {
  console.log(`database=${BENCH_DB} seeded occupancies=${String(SEED_OCCUPANCIES)}`);

  const guard = await scenario({ capacity: 200, policy: false, customerLimit: null });
  await enableGuard();
  await sample(guard, 20, 50); // warm up

  await alternating(
    'capacity guard  ',
    guard,
    6,
    Math.max(20, Math.floor(ITERATIONS / 6)),
    enableGuard,
    disableGuard,
    'ON ',
    'OFF',
  );
  await enableGuard();

  // The customer lock cannot be toggled with DDL, so it is two fixtures rather than two
  // settings. Both carry a policy and a customer, and the **only** difference between them is
  // `max_active_bookings_per_customer`: comparing against a service with no policy at all would
  // also be measuring the policy load and the snapshot, which the lock has nothing to do with.
  // The limit is a million, so it is never the reason a booking is refused.
  const limited = await scenario({ capacity: 200, policy: true, customerLimit: 1_000_000 });
  const free = await scenario({ capacity: 200, policy: true, customerLimit: null });
  await sample(limited, 20, 50);
  await sample(free, 20, 50);

  const withLock: number[] = [];
  const without: number[] = [];
  let day = 40;
  const perBlock = Math.max(20, Math.floor(ITERATIONS / 6));
  for (let block = 0; block < 6; block += 1) {
    // Alternating here too, for the same reason as in `alternating` above. The two fixtures are
    // separate projects with separate resources, so they do not grow each other's table, but
    // they do share a database, a cache and a page pool.
    if (block % 2 === 0) {
      withLock.push(...(await sample(limited, day, perBlock)));
      without.push(...(await sample(free, day, perBlock)));
    } else {
      without.push(...(await sample(free, day, perBlock)));
      withLock.push(...(await sample(limited, day, perBlock)));
    }
    day += 1;
  }
  const pa = percentile(withLock, 50);
  const pb = percentile(without, 50);
  console.log(
    `customer lock   : limit set p50 ${pa.toFixed(2)} ms | no limit p50 ${pb.toFixed(2)} ms | ` +
      `overhead ${(((pa - pb) / pb) * 100).toFixed(1)} % on ${String(withLock.length)} + ${String(without.length)} samples`,
  );
}

await main();
await appPool.end();
await adminPool.end();
