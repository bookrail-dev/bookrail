/**
 * The concurrency suite: many **separate processes**, each with its own connections, racing
 * for the same slot against a real Postgres.
 *
 * One process cannot prove this. Node runs one event loop, `pg` serialises the statements of
 * one connection, and a suite that "ran two bookings at once" inside a single process would
 * mostly be testing promise scheduling. The requests here come from forked processes with
 * their own pools, through the application role, so Row Level Security, the advisory locks
 * and the exclusion constraint are all in the way exactly as they are in production.
 *
 * What is asserted, per round:
 *
 * - exactly `capacity` requests win (or, for the composite scenario, exactly the number the
 *   configuration allows), every other request is refused with `slot_unavailable`;
 * - no request fails with anything else, in particular no deadlock (`40P01`) and no
 *   serialization failure that survived the retries;
 * - a final SQL pass finds no resource over its capacity at any instant.
 *
 * The local Postgres allows twenty connections, three of them reserved, so the defaults keep
 * the fleet under a dozen: the contention is real either way, because two hundred requests
 * queue on those connections and every one of them opens its own transaction.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createDatabase, createPool, resolveDatabaseUrls, sql, type Database } from '@bookrail/db';
import { uuidv7 } from '@bookrail/shared';

import { createBooking } from '../../src/index.js';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

export type ScenarioName =
  | 'capacity'
  | 'composite'
  | 'hold_race'
  | 'block_race'
  | 'mixed'
  | 'two_services'
  | 'reschedule_race'
  | 'customer_limit_race';

export interface ScenarioOptions {
  readonly databaseName: string;
  readonly scenario: ScenarioName;
  /** Resource capacity; ignored by `composite`, which is always a set of capacity 1 rooms. */
  readonly capacity?: number;
  /** Total number of simultaneous requests. */
  readonly requests: number;
  /** Worker processes to spread them over. */
  readonly processes?: number;
  /** Connections each worker may open. `processes * connections` must stay under the server's. */
  readonly connectionsPerProcess?: number;
  /** Serialization retries each request is allowed. Three, like the engine's own default. */
  readonly maxRetries?: number;
  /** Isolation of the booking transaction; `read committed` by default. */
  readonly isolationLevel?: 'read committed' | 'serializable';
  /** `customer_limit_race`: how many bookings the policy allows the customer at once. */
  readonly customerLimit?: number;
}

export interface RoundResult {
  readonly scenario: ScenarioName;
  /**
   * How many requests may legitimately win.
   *
   * Deterministic for the scenarios that only ever take one unit each (`min === max`); a
   * range for the ones whose outcome depends on who gets there first (a block takes the whole
   * capacity, so either it wins alone or the bookings do).
   */
  readonly expectedWinners: { min: number; max: number };
  readonly won: number;
  readonly slotUnavailable: number;
  /** Every other outcome, by error code. Must be empty. */
  readonly other: Record<string, number>;
  /** Resources whose peak usage exceeded their capacity. Must be empty. */
  readonly overCapacity: { id: string; capacity: number; peak: number }[];
  /**
   * Anything the scenario knows is wrong beyond capacity. Must be empty.
   *
   * `reschedule_race` uses it: "no resource is over capacity" is necessary and nowhere near
   * sufficient there, because the failure mode of a reschedule losing a race is a **chain**
   * that comes apart: two live bookings where there should be one, a booking marked
   * `rescheduled` pointing at nothing, a slot that nobody holds any more.
   */
  readonly anomalies: string[];
  readonly durationMs: number;
}

interface Fixture {
  readonly projectId: string;
  readonly serviceId: string;
  readonly otherServiceId: string | null;
  readonly blockResourceId: string | null;
  readonly blockCapacity: number | null;
  readonly start: number;
  readonly end: number;
  readonly expectedWinners: { min: number; max: number };
  /** `reschedule_race`: the booking every process tries to move, and where it must land. */
  readonly bookingId: string | null;
  readonly targetResourceId: string | null;
  readonly targetStart: number | null;
  /** `customer_limit_race`: one room per request, and the customer they all book for. */
  readonly resourceIds: string[];
  readonly customerId: string | null;
  readonly customerLimit: number | null;
}

const HOUR = 3_600_000;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Far enough in the future that a hold created now is not born expired. */
const SLOT = Date.UTC(2031, 5, 2, 9, 0, 0);

async function buildFixture(
  admin: Database,
  app: Database,
  options: ScenarioOptions,
): Promise<Fixture> {
  const accountId = uuidv7();
  const projectId = uuidv7();
  await admin.execute(
    sql`INSERT INTO accounts (id, name, api_version) VALUES (${accountId}, 'Concurrency', '2026-09-01')`,
  );
  await admin.execute(
    sql`INSERT INTO projects (id, account_id, name) VALUES (${projectId}, ${accountId}, 'Concurrency')`,
  );
  const scheduleId = uuidv7();
  await admin.execute(sql`
    INSERT INTO schedules (id, project_id, environment, name, timezone)
    VALUES (${scheduleId}, ${projectId}, 'test', 'Round the clock', 'Europe/Rome')
  `);
  await admin.execute(sql`
    INSERT INTO schedule_rules (id, project_id, environment, schedule_id, days_of_week,
                                start_time, end_time)
    VALUES (${uuidv7()}, ${projectId}, 'test', ${scheduleId},
            ${sql.param(EVERY_DAY)}::smallint[], '00:00', '00:00')
  `);

  const resource = async (name: string, capacity: number): Promise<string> => {
    const id = uuidv7();
    await admin.execute(sql`
      INSERT INTO resources (id, project_id, environment, name, type, schedule_id, capacity)
      VALUES (${id}, ${projectId}, 'test', ${name}, 'room', ${scheduleId}, ${capacity})
    `);
    return id;
  };
  const group = async (name: string, members: string[]): Promise<string> => {
    const id = uuidv7();
    await admin.execute(sql`
      INSERT INTO resource_groups (id, project_id, environment, name, allocation_strategy)
      VALUES (${id}, ${projectId}, 'test', ${name}, 'first_available')
    `);
    for (const [priority, resourceId] of members.entries()) {
      await admin.execute(sql`
        INSERT INTO resource_group_members (id, project_id, environment, resource_group_id,
                                            resource_id, priority)
        VALUES (${uuidv7()}, ${projectId}, 'test', ${id}, ${resourceId}, ${priority})
      `);
    }
    return id;
  };

  const service = async (name: string): Promise<string> => {
    const id = uuidv7();
    await admin.execute(sql`
      INSERT INTO services (id, project_id, environment, name, duration_minutes,
                            capacity_per_booking)
      VALUES (${id}, ${projectId}, 'test', ${name}, 60, 1)
    `);
    return id;
  };
  const requirement = async (
    serviceRef: string,
    target: { resourceId?: string; groupId?: string },
    position: number,
    consumes: 'per_unit' | 'whole' = 'per_unit',
  ): Promise<void> => {
    await admin.execute(sql`
      INSERT INTO service_requirements (id, project_id, environment, service_id, resource_id,
                                        resource_group_id, quantity, consumes, position)
      VALUES (${uuidv7()}, ${projectId}, 'test', ${serviceRef}, ${target.resourceId ?? null},
              ${target.groupId ?? null}, 1, ${consumes}, ${position})
    `);
  };

  const serviceId = await service('Race');
  let otherServiceId: string | null = null;
  let blockResourceId: string | null = null;
  let blockCapacity: number | null = null;

  let expectedWinners: { min: number; max: number };
  let rescheduleTarget: string | null = null;
  const raceResources: string[] = [];
  let customerId: string | null = null;
  let customerLimit: number | null = null;
  if (options.scenario === 'customer_limit_race') {
    // One room per request, all interchangeable, and a policy that lets this customer hold
    // three bookings at a time. Every process then pins **its own** room with `resourceIds`,
    // so no two requests ever take the same advisory lock: the only thing that used to be
    // standing between them and a fourth booking was that they happened not to overlap.
    customerLimit = options.customerLimit ?? 3;
    const policyId = uuidv7();
    await admin.execute(sql`
      INSERT INTO policies (id, project_id, environment, name,
                            max_active_bookings_per_customer)
      VALUES (${policyId}, ${projectId}, 'test', 'Three at a time', ${customerLimit})
    `);
    await admin.execute(sql`
      UPDATE services SET policy_id = ${policyId} WHERE id = ${serviceId}
    `);
    for (let i = 0; i < options.requests; i += 1) {
      raceResources.push(await resource(`Room ${String(i)}`, 1));
    }
    const rooms = await group('rooms', raceResources);
    await requirement(serviceId, { groupId: rooms }, 0);
    customerId = uuidv7();
    await admin.execute(sql`
      INSERT INTO customers (id, project_id, environment, name, email)
      VALUES (${customerId}, ${projectId}, 'test', 'Racer', 'racer@example.com')
    `);
    expectedWinners = { min: customerLimit, max: customerLimit };
  } else if (options.scenario === 'composite') {
    // Three rooms of capacity one, two requirements from two groups that share the middle
    // one. Every booking takes two distinct rooms out of three, so exactly one can ever hold
    // at a time, and the two requirements make each transaction take two advisory locks,
    // which is the configuration a wrong lock order would deadlock on.
    const a = await resource('A', 1);
    const b = await resource('B', 1);
    const c = await resource('C', 1);
    const first = await group('left', [a, b]);
    const second = await group('right', [b, c]);
    await requirement(serviceId, { groupId: first }, 0);
    await requirement(serviceId, { groupId: second }, 1);
    expectedWinners = { min: 1, max: 1 };
  } else if (options.scenario === 'two_services') {
    // One resource of capacity three, two services on it: one takes a single unit, the other
    // takes it `whole`. Either the whole one wins alone, or up to three of the others do.
    const capacity = options.capacity ?? 3;
    const only = await resource('Studio', capacity);
    otherServiceId = await service('Whole');
    await requirement(serviceId, { resourceId: only }, 0, 'per_unit');
    await requirement(otherServiceId, { resourceId: only }, 0, 'whole');
    expectedWinners = { min: 1, max: capacity };
  } else if (options.scenario === 'reschedule_race') {
    // Two rooms of capacity one in a group, and one booking already sitting on the first.
    // Every process then tries to move **that same booking** to the same later hour, forced
    // onto the second room. Exactly one may win: the winner leaves the old booking
    // `rescheduled` and pointing at a new one, and every other process must find a booking
    // that no longer admits the action, never a second booking, never a slot nobody holds.
    const a = await resource('Court A', 1);
    const b = await resource('Court B', 1);
    const both = await group('courts', [a, b]);
    await requirement(serviceId, { groupId: both }, 0);
    rescheduleTarget = b;
    expectedWinners = { min: 1, max: 1 };
  } else {
    const capacity = options.capacity ?? 1;
    const only = await resource('Court', capacity);
    await requirement(serviceId, { resourceId: only }, 0);
    if (options.scenario === 'block_race') {
      blockResourceId = only;
      blockCapacity = capacity;
      // A block takes the whole capacity, so it wins alone or the bookings do.
      expectedWinners = { min: 1, max: capacity };
    } else if (options.scenario === 'mixed') {
      // Only the conversions count as wins; the releases give their capacity back.
      expectedWinners = { min: 1, max: capacity };
    } else {
      expectedWinners = { min: capacity, max: capacity };
    }
  }

  // The seed booking of `reschedule_race`, written through the engine so that it has its
  // occupancies, its allocations and its `booking.created` event exactly as a real one does.
  let bookingId: string | null = null;
  if (options.scenario === 'reschedule_race') {
    // Through the **application** role, like every other write in this suite: `createBooking`
    // refuses a connection that bypasses Row Level Security, which is the point of the check.
    const seed = await createBooking(app, {
      projectId,
      environment: 'test',
      serviceId,
      start: SLOT,
      kind: 'booking',
      now: Date.now(),
    });
    bookingId = seed.id;
  }

  return {
    projectId,
    serviceId,
    otherServiceId,
    blockResourceId,
    blockCapacity,
    start: SLOT,
    end: SLOT + HOUR,
    expectedWinners,
    bookingId,
    targetResourceId: rescheduleTarget,
    targetStart: rescheduleTarget === null ? null : SLOT + 2 * HOUR,
    resourceIds: raceResources,
    customerId,
    customerLimit,
  };
}

/**
 * What has to be true after every process has tried to book for the same customer.
 *
 * "No resource over capacity" says nothing here: the rooms are disjoint and nobody was ever
 * going to overfill one. The invariant under test is the **policy**:
 * `max_active_bookings_per_customer` is a limit, not an approximation, so the assertion is on
 * the customer's live bookings, counted in SQL.
 */
async function customerLimitAnomalies(admin: Database, fixture: Fixture): Promise<string[]> {
  if (fixture.customerId === null || fixture.customerLimit === null) return [];
  const { rows } = await admin.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM bookings
     WHERE project_id = ${fixture.projectId}
       AND customer_id = ${fixture.customerId}
       AND status IN ('pending', 'confirmed')
       AND ends_at > now()
  `);
  const live = Number(rows[0]?.n ?? 0);
  return live === fixture.customerLimit
    ? []
    : [
        `live bookings for the customer: ${String(live)}, expected ${String(fixture.customerLimit)}`,
      ];
}

/**
 * What has to be true of a reschedule chain once two hundred processes have finished fighting
 * over it.
 *
 * Four separate things, because they fail separately: exactly one booking is live, exactly one
 * is closed as `rescheduled`, the closed one points at the live one, and the live one holds
 * exactly one active occupancy, at the instant it was moved to, on the resource it was forced
 * onto. "No resource over capacity" would be satisfied by a chain that lost its slot entirely.
 */
async function rescheduleAnomalies(admin: Database, fixture: Fixture): Promise<string[]> {
  const anomalies: string[] = [];
  const { rows } = await admin.execute<{
    id: string;
    status: string;
    rescheduled_to: string | null;
    starts_ms: string;
  }>(sql`
    SELECT id, status, rescheduled_to_booking_id AS rescheduled_to,
           (extract(epoch FROM starts_at) * 1000)::bigint AS starts_ms
      FROM bookings WHERE project_id = ${fixture.projectId} ORDER BY id
  `);
  const live = rows.filter((row) => row.status === 'confirmed' || row.status === 'pending');
  const closed = rows.filter((row) => row.status === 'rescheduled');
  if (live.length !== 1) anomalies.push(`live bookings: ${String(live.length)}, expected 1`);
  if (closed.length !== 1)
    anomalies.push(`rescheduled bookings: ${String(closed.length)}, expected 1`);
  if (live.length === 1 && closed.length === 1) {
    if (closed[0]!.rescheduled_to !== live[0]!.id) {
      anomalies.push('the closed booking does not point at the live one');
    }
    if (closed[0]!.id !== fixture.bookingId) {
      anomalies.push('the booking that was closed is not the one the race was about');
    }
    if (Number(live[0]!.starts_ms) !== fixture.targetStart) {
      anomalies.push('the live booking is not at the instant it was moved to');
    }
  }

  const { rows: occupancies } = await admin.execute<{
    ref_id: string;
    resource_id: string;
    starts_ms: string;
  }>(sql`
    SELECT ref_id, resource_id, (extract(epoch FROM lower(period)) * 1000)::bigint AS starts_ms
      FROM occupancies
     WHERE project_id = ${fixture.projectId} AND active AND kind = 'booking'
  `);
  if (occupancies.length !== 1) {
    anomalies.push(`active booking occupancies: ${String(occupancies.length)}, expected 1`);
  } else {
    if (live.length === 1 && occupancies[0]!.ref_id !== live[0]!.id) {
      anomalies.push('the surviving occupancy does not belong to the live booking');
    }
    if (occupancies[0]!.resource_id !== fixture.targetResourceId) {
      anomalies.push('the surviving occupancy is not on the resource the reschedule forced');
    }
  }
  return anomalies;
}

/** Peak units taken at any instant, per resource, straight from the table. */
async function overCapacity(
  admin: Database,
  projectId: string,
): Promise<{ id: string; capacity: number; peak: number }[]> {
  const { rows } = await admin.execute<{ id: string; capacity: number; peak: number }>(sql`
    WITH live AS (
      SELECT resource_id, lower(period) AS s, upper(period) AS e, capacity_used
        FROM occupancies
       WHERE project_id = ${projectId} AND active
         AND (expires_at IS NULL OR expires_at > now())
    ), ev AS (
      SELECT resource_id, s AS at, capacity_used AS d FROM live
      UNION ALL
      SELECT resource_id, e, -capacity_used FROM live
    ), run AS (
      SELECT resource_id,
             SUM(d) OVER (PARTITION BY resource_id ORDER BY at, d
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS used
        FROM ev
    )
    SELECT r.id, r.capacity, COALESCE(MAX(run.used), 0)::int AS peak
      FROM resources r LEFT JOIN run ON run.resource_id = r.id
     WHERE r.project_id = ${projectId}
     GROUP BY r.id, r.capacity
    HAVING COALESCE(MAX(run.used), 0) > r.capacity
  `);
  return rows;
}

export async function runRound(options: ScenarioOptions): Promise<RoundResult> {
  const urls = resolveDatabaseUrls({ databaseName: options.databaseName });
  const adminPool = createPool({ connectionString: urls.admin, max: 1 });
  const admin = createDatabase(adminPool);
  // One application connection for the coordinator, used only to seed `reschedule_race`.
  const appPool = createPool({ connectionString: urls.app, max: 1 });
  const processes = options.processes ?? 6;
  const connections = options.connectionsPerProcess ?? 2;
  const started = Date.now();

  try {
    const fixture = await buildFixture(admin, createDatabase(appPool), options);
    // Spread the requests exactly: `ceil` would fire a handful more than asked, and the
    // arithmetic of "exactly `capacity` win and the rest are refused" has to add up.
    const share = Array.from(
      { length: processes },
      (_unused, index) =>
        Math.floor((options.requests * (index + 1)) / processes) -
        Math.floor((options.requests * index) / processes),
    );
    const outcomes: string[] = [];
    // The global index of the first request of each process, so a worker can pick a room that
    // no other worker will pick.
    const firstIndex = share.reduce<number[]>(
      (acc, count) => [...acc, (acc[acc.length - 1] ?? 0) + count],
      [0],
    );

    await Promise.all(
      Array.from({ length: processes }, (_unused, index) => {
        return new Promise<void>((resolve, reject) => {
          const child = fork(WORKER, [], {
            execArgv: ['--import', 'tsx'],
            env: {
              ...process.env,
              TEST_DATABASE_NAME: options.databaseName,
              BOOKRAIL_WORKER_INDEX: String(index),
            },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          });
          child.on('message', (message) => {
            outcomes.push(...(message as string[]));
          });
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`concurrency worker exited with code ${String(code)}`));
          });
          child.send({
            databaseName: options.databaseName,
            projectId: fixture.projectId,
            serviceId: fixture.serviceId,
            bookingId: fixture.bookingId,
            targetResourceId: fixture.targetResourceId,
            targetStart: fixture.targetStart,
            otherServiceId: fixture.otherServiceId,
            blockResourceId: fixture.blockResourceId,
            blockCapacity: fixture.blockCapacity,
            start: fixture.start,
            end: fixture.end,
            scenario: options.scenario,
            count: share[index] ?? 0,
            firstIndex: firstIndex[index] ?? 0,
            resourceIds: fixture.resourceIds,
            customerId: fixture.customerId,
            connections,
            maxRetries: options.maxRetries ?? 3,
            isolationLevel: options.isolationLevel ?? 'read committed',
            offset: index,
          });
        });
      }),
    );

    const tally: Record<string, number> = {};
    for (const outcome of outcomes) tally[outcome] = (tally[outcome] ?? 0) + 1;
    const won = tally.won ?? 0;
    const refused = tally.slot_unavailable ?? 0;
    delete tally.won;
    delete tally.slot_unavailable;
    // A released hold is neither a win nor a refusal: it is the `mixed` scenario giving the
    // capacity back on purpose.
    const released = tally.released ?? 0;
    delete tally.released;
    // `reschedule_race` is the one scenario whose losers are refused by the **state machine**
    // rather than by the capacity: the booking they wanted to move is no longer `confirmed`.
    // That is a legitimate refusal, exactly like `slot_unavailable`, and not an "other".
    const wrongState = tally.invalid_transition ?? 0;
    delete tally.invalid_transition;
    // `customer_limit_race`: the policy refusing a fourth booking is the correct answer, not an
    // error, exactly as `slot_unavailable` is when the room is full.
    const overLimit = tally.customer_limit_reached ?? 0;
    delete tally.customer_limit_reached;

    return {
      scenario: options.scenario,
      expectedWinners: fixture.expectedWinners,
      won,
      slotUnavailable: refused + released + wrongState + overLimit,
      other: tally,
      overCapacity: await overCapacity(admin, fixture.projectId),
      anomalies:
        options.scenario === 'reschedule_race'
          ? await rescheduleAnomalies(admin, fixture)
          : options.scenario === 'customer_limit_race'
            ? await customerLimitAnomalies(admin, fixture)
            : [],
      durationMs: Date.now() - started,
    };
  } finally {
    await adminPool.end();
    await appPool.end();
  }
}
