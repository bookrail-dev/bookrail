/**
 * The concurrency suite, at a size that belongs in `pnpm test`.
 *
 * Forty simultaneous requests instead of two hundred, one round instead of twenty: enough to
 * fail loudly if the transaction stops being safe, cheap enough to run on every change. The
 * full size lives in `pnpm test:concurrency`, which is the one to run twenty times before a
 * release.
 *
 * The processes are real child processes with their own pools against the real Postgres. The
 * database is the one this package's `globalSetup` already created, so no extra migration
 * runs here.
 */
import { describe, expect, it } from 'vitest';

import { runRound } from './concurrency/scenario.js';
import { TEST_DB_NAME } from './db-name.js';

const REQUESTS = 40;
/**
 * Three processes, two connections each. The local Postgres allows twenty connections in
 * total and `pnpm test` runs the three packages at once, each with its own pools: the suite
 * has to leave room for its neighbours, and forty requests queueing on six connections are
 * every bit as contended as forty on forty.
 */
const PROCESSES = 3;

describe('concurrent writes on the same slot', () => {
  it.each([
    { scenario: 'capacity' as const, capacity: 1 },
    { scenario: 'capacity' as const, capacity: 3 },
    { scenario: 'composite' as const, capacity: 1 },
    { scenario: 'hold_race' as const, capacity: 1 },
    { scenario: 'block_race' as const, capacity: 3 },
    { scenario: 'mixed' as const, capacity: 3 },
    { scenario: 'two_services' as const, capacity: 3 },
    { scenario: 'reschedule_race' as const, capacity: 1 },
    { scenario: 'customer_limit_race' as const, capacity: 1 },
  ])(
    '$scenario (capacity $capacity): never more than the capacity wins',
    async ({ scenario, capacity }) => {
      const result = await runRound({
        databaseName: TEST_DB_NAME,
        scenario,
        capacity,
        requests: REQUESTS,
        processes: PROCESSES,
        connectionsPerProcess: 2,
      });
      expect(result.other).toEqual({});
      expect(result.overCapacity).toEqual([]);
      // `reschedule_race` is the only scenario that fills this: "no resource over capacity"
      // would be satisfied by a chain that lost its slot entirely.
      expect(result.anomalies).toEqual([]);
      expect(result.won).toBeGreaterThanOrEqual(result.expectedWinners.min);
      expect(result.won).toBeLessThanOrEqual(result.expectedWinners.max);
      expect(result.won + result.slotUnavailable).toBe(REQUESTS);
    },
    120_000,
  );
});
