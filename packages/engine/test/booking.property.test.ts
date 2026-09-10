/**
 * The property the whole booking transaction exists for: **no sequence of writes ever leaves a
 * resource over its capacity**.
 *
 * Random sequences of holds, bookings, conversions, releases, expiries and blocks are played
 * against a real Postgres through the application role, and after each sequence the invariant
 * is checked in SQL, not from the engine's own idea of what it did. The check is a running
 * sum over the boundaries of every active occupancy, which is the peak usage at any instant,
 * and it is compared with `resources.capacity`.
 *
 * The oracle is deliberately not the engine: if `peakUsage` were wrong, this suite would still
 * catch it. It is also scoped to **this test's project**: vitest runs the thirteen files of
 * this package in parallel against one database, and a query without that filter asserts on
 * everybody else's fixtures.
 *
 * The generated services exercise the corners the first delivery left out: buffers on both
 * sides with both settings of `buffer_sharing`, `allow_split`, a second requirement taken
 * `whole`, blocks written through `takeOccupancy`, and holds that are aged into expiry so the
 * sweep runs for real.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withProjectContext } from '@bookrail/db';
import { uuidv7 } from '@bookrail/shared';

import { createBooking, createHold, releaseHold, takeOccupancy } from '../src/index.js';
import { createHarness, utc, HOUR, type Harness } from './availability-harness.js';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MONDAY = utc(2030, 6, 10);

type Operation =
  | { kind: 'book'; slot: number; quantity: number }
  | { kind: 'hold'; slot: number; quantity: number }
  | { kind: 'convert'; index: number }
  | { kind: 'release'; index: number }
  | { kind: 'expire'; index: number }
  | { kind: 'block'; slot: number };

const arbOperation = fc.oneof(
  fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 3 }))
    .map(([slot, quantity]): Operation => ({ kind: 'book', slot, quantity })),
  fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 3 }))
    .map(([slot, quantity]): Operation => ({ kind: 'hold', slot, quantity })),
  fc.integer({ min: 0, max: 9 }).map((index): Operation => ({ kind: 'convert', index })),
  fc.integer({ min: 0, max: 9 }).map((index): Operation => ({ kind: 'release', index })),
  fc.integer({ min: 0, max: 9 }).map((index): Operation => ({ kind: 'expire', index })),
  fc.integer({ min: 0, max: 5 }).map((slot): Operation => ({ kind: 'block', slot })),
);

const arbShape = fc.record({
  capacity: fc.integer({ min: 1, max: 4 }),
  resourceCount: fc.integer({ min: 1, max: 3 }),
  bufferBefore: fc.constantFrom(0, 15),
  bufferAfter: fc.constantFrom(0, 15),
  bufferSharing: fc.boolean(),
  allowSplit: fc.boolean(),
  /** A second requirement on a single resource, taken whole: the instructor of a class. */
  withWhole: fc.boolean(),
});

describe('booking properties', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness('BookingProperty');
  });

  afterAll(async () => {
    await h.close();
  });

  /** Peak units taken at any instant, per resource of **this** project, from the table. */
  async function overCapacity(): Promise<{ id: string; capacity: number; peak: number }[]> {
    const { rows } = await h.admin.execute<{ id: string; capacity: number; peak: number }>(sql`
      WITH live AS (
        SELECT resource_id, lower(period) AS s, upper(period) AS e, capacity_used
          FROM occupancies
         WHERE project_id = ${h.projectId} AND active
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
       WHERE r.project_id = ${h.projectId}
       GROUP BY r.id, r.capacity
      HAVING COALESCE(MAX(run.used), 0) > r.capacity
    `);
    return rows;
  }

  /** Ages a hold into the past, the way a TTL running out does, without waiting for it. */
  async function age(holdId: string): Promise<void> {
    await h.admin.execute(
      sql`UPDATE holds SET expires_at = now() - interval '1 minute' WHERE id = ${holdId}`,
    );
    await h.admin.execute(
      sql`UPDATE occupancies SET expires_at = now() - interval '1 minute'
           WHERE ref_id = ${holdId} AND kind = 'hold'`,
    );
  }

  it('never leaves a resource over its capacity, whatever the sequence', async () => {
    /**
     * What the sequences actually managed to write, counted as it happens.
     *
     * The non vacuity check at the end used to be two thresholds ("more than twenty
     * occupancies, more than twenty events"), and twenty sat inside the distribution of a
     * random process: a seed whose operations were refused a little more often than usual
     * wrote exactly twenty events and the suite went red for having been unlucky, not for
     * having found anything. Measuring what the property did makes the same check exact, and
     * turns it into a stronger claim than the threshold ever made: every write the engine
     * reported is in the table.
     */
    const performed = { occupying: 0, eventful: 0 };
    // Only the two operations that cannot be idempotent are counted. A conversion of a hold
    // that was already converted, and a release of a hold that was already released, both
    // return without writing anything, which is the right behaviour and the wrong thing to
    // count: what is counted has to be a lower bound the table can never be under.

    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOperation, { minLength: 8, maxLength: 16 }),
        arbShape,
        async (operations, shape) => {
          const schedule = await h.schedule({
            timezone: 'Europe/Rome',
            rules: [{ daysOfWeek: EVERY_DAY, startTime: '00:00', endTime: '00:00' }],
          });
          const pool: string[] = [];
          for (let i = 0; i < shape.resourceCount; i += 1) {
            pool.push(
              await h.resource({
                name: `p${String(i)}`,
                capacity: shape.capacity,
                scheduleId: schedule,
              }),
            );
          }
          const groupId = await h.group({
            strategy: 'least_busy',
            members: pool.map((resourceId) => ({ resourceId })),
          });
          const serviceId = await h.service({
            durationMinutes: 60,
            bufferBefore: shape.bufferBefore,
            bufferAfter: shape.bufferAfter,
            bufferSharing: shape.bufferSharing,
            allowSplit: shape.allowSplit,
          });
          await h.requirement({ serviceId, groupId, position: 0 });
          const instructor = shape.withWhole
            ? await h.resource({ name: 'whole', capacity: shape.capacity, scheduleId: schedule })
            : null;
          if (instructor !== null) {
            await h.requirement({
              serviceId,
              resourceId: instructor,
              position: 1,
              consumes: 'whole',
            });
          }

          // A real clock: the slots are far enough ahead to be bookable, and the holds that
          // the `expire` operation ages really are in the past when the sweep looks.
          const now = Date.now();
          const base = {
            projectId: h.projectId,
            environment: 'test' as const,
            serviceId,
            now,
          };
          const holds: { id: string; start: number; quantity: number }[] = [];

          for (const operation of operations) {
            try {
              if (operation.kind === 'block') {
                const target = pool[operation.slot % pool.length]!;
                const from = MONDAY + 8 * HOUR + operation.slot * HOUR;
                await withProjectContext(
                  h.app,
                  { projectId: h.projectId, environment: 'test' },
                  (tx) =>
                    takeOccupancy(tx, {
                      projectId: h.projectId,
                      environment: 'test',
                      resourceIds: [target],
                      allocations: [{ resourceId: target, capacityUsed: shape.capacity }],
                      start: from,
                      end: from + HOUR,
                      kind: 'block',
                      refId: uuidv7(),
                      capacities: new Map([[target, shape.capacity]]),
                    }),
                );
                // A block writes one occupancy row and no event of its own.
                performed.occupying += 1;
              } else if (operation.kind === 'book' || operation.kind === 'hold') {
                const start = MONDAY + 8 * HOUR + operation.slot * HOUR;
                const result =
                  operation.kind === 'hold'
                    ? await createHold(h.app, { ...base, start, quantity: operation.quantity })
                    : await createBooking(h.app, {
                        ...base,
                        start,
                        quantity: operation.quantity,
                        kind: 'booking',
                      });
                if (operation.kind === 'hold') {
                  holds.push({ id: result.id, start, quantity: operation.quantity });
                }
                // Both write at least one occupancy row and exactly one event, `hold.created`
                // or `booking.created`.
                performed.occupying += 1;
                performed.eventful += 1;
              } else {
                const hold = holds[operation.index % Math.max(1, holds.length)];
                if (hold === undefined) continue;
                if (operation.kind === 'expire') {
                  await age(hold.id);
                } else if (operation.kind === 'convert') {
                  await createBooking(h.app, {
                    ...base,
                    start: hold.start,
                    quantity: hold.quantity,
                    kind: 'booking',
                    holdId: hold.id,
                  });
                } else {
                  await releaseHold(h.app, {
                    projectId: h.projectId,
                    environment: 'test',
                    holdId: hold.id,
                    now,
                  });
                }
              }
            } catch (error) {
              // Every refusal is a legitimate outcome: the property is about what gets
              // written, not about which requests succeed. A refusal the engine did not mean
              // to produce would be an error with no code, so it is still asserted.
              const code = (error as { code?: string }).code;
              expect(
                typeof code,
                `refusal without a code: ${String((error as Error).name)}: ${String((error as Error).message)}\n${String((error as Error).stack)}`,
              ).toBe('string');
            }
          }

          expect(await overCapacity()).toEqual([]);
        },
      ),
      { numRuns: 12 },
    );

    // Not vacuous: the sequences really do write. Without this a property that refused every
    // operation would pass while proving nothing.
    const [written] = (
      await h.admin.execute<{ occupancies: string; events: string }>(sql`
        SELECT (SELECT count(*) FROM occupancies WHERE project_id = ${h.projectId})::text
                 AS occupancies,
               (SELECT count(*) FROM events WHERE project_id = ${h.projectId})::text AS events
      `)
    ).rows;
    expect(performed.occupying, 'no operation of any sequence was accepted').toBeGreaterThan(0);
    expect(performed.eventful, 'no sequence wrote a single event').toBeGreaterThan(0);
    // And the table holds everything the engine said it wrote. Occupancies are never deleted,
    // only deactivated, so the count only grows; a conversion reuses the row of its hold, which
    // is why it counts towards the events and not towards the occupancies.
    expect(Number(written!.occupancies)).toBeGreaterThanOrEqual(performed.occupying);
    expect(Number(written!.events)).toBeGreaterThanOrEqual(performed.eventful);
  }, 240_000);
});
