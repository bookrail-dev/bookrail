#!/usr/bin/env tsx
/* eslint-disable no-console -- this is a command line runner; printing is its output. */
/**
 * `pnpm test:concurrency`: the suite that has to be run, not read.
 *
 * It creates a throwaway database, migrates it, and then plays three scenarios for as many
 * rounds as asked: capacity 1, 3 and 15 with two hundred simultaneous
 * requests each, composite resources shared by two requirements, and holds racing bookings.
 * A round fails if a single request wins that should not have, if any request comes back with
 * anything but `slot_unavailable`, or if the final SQL pass finds a resource over capacity.
 *
 * Usage:
 *   pnpm test:concurrency                  # 1 round
 *   pnpm test:concurrency -- --rounds 20   # 20 consecutive rounds
 *   pnpm test:concurrency -- --requests 40 --processes 4
 *   pnpm test:concurrency -- --isolation serializable   # reproduces the measurement in `06`
 */
import { createTestDatabase, dropTestDatabase } from '@bookrail/db/testing';

import { runRound, type RoundResult, type ScenarioOptions } from '../test/concurrency/scenario.js';

function flag(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const DATABASE_NAME = process.env.CONCURRENCY_DATABASE_NAME ?? 'bookrail_concurrency';

async function main(): Promise<void> {
  const rounds = flag('rounds', 1);
  const requests = flag('requests', 200);
  const processes = flag('processes', 6);
  const connections = flag('connections', 2);
  const maxRetries = flag('retries', 3);
  // `--isolation serializable` reproduces the measurement that settled the isolation level:
  // the same suite, run the way the design originally prescribed, and what it does to the
  // outcome. The invariant holds either way; what changes is how many requests come back as a
  // serialization failure instead of a clean `slot_unavailable`.
  // The value has to follow the flag immediately: `--isolation read` with the word
  // `serializable` somewhere else on the line used to turn it on.
  const isolationAt = process.argv.indexOf('--isolation');
  const isolationLevel =
    isolationAt !== -1 && process.argv[isolationAt + 1] === 'serializable'
      ? ('serializable' as const)
      : ('read committed' as const);

  // Every scenario carries the same knobs, `isolationLevel` included: only `composite` used
  // to, so `--isolation serializable` measured one scenario out of five, and not the one
  // that had failed.
  const common = {
    requests,
    processes,
    connectionsPerProcess: connections,
    maxRetries,
    isolationLevel,
  };
  const plan: Omit<ScenarioOptions, 'databaseName'>[] = [
    { scenario: 'capacity', capacity: 1, ...common },
    { scenario: 'capacity', capacity: 3, ...common },
    { scenario: 'capacity', capacity: 15, ...common },
    { scenario: 'composite', ...common },
    { scenario: 'hold_race', capacity: 1, ...common },
    { scenario: 'block_race', capacity: 3, ...common },
    { scenario: 'mixed', capacity: 3, ...common },
    { scenario: 'two_services', capacity: 3, ...common },
    { scenario: 'reschedule_race', ...common },
    { scenario: 'customer_limit_race', ...common },
  ];

  console.log(
    `bookrail concurrency: ${String(rounds)} round(s), ${String(requests)} simultaneous requests ` +
      `over ${String(processes)} processes × ${String(connections)} connections`,
  );
  await createTestDatabase(DATABASE_NAME);
  let failures = 0;
  try {
    for (let round = 1; round <= rounds; round += 1) {
      for (const spec of plan) {
        const result = await runRound({ ...spec, databaseName: DATABASE_NAME });
        const ok = verdict(result);
        if (!ok) failures += 1;
        console.log(
          `  round ${String(round).padStart(2, ' ')} ${label(spec)}: ` +
            `${ok ? 'ok  ' : 'FAIL'} won=${String(result.won)}/${range(result.expectedWinners)} ` +
            `slot_unavailable=${String(result.slotUnavailable)} ` +
            `other=${JSON.stringify(result.other)} ` +
            `over_capacity=${String(result.overCapacity.length)} ` +
            `anomalies=${result.anomalies.length === 0 ? '0' : JSON.stringify(result.anomalies)} ` +
            `${String(result.durationMs)}ms`,
        );
      }
    }
  } finally {
    await dropTestDatabase(DATABASE_NAME);
  }

  if (failures > 0) {
    console.error(`bookrail concurrency: ${String(failures)} failing round(s).`);
    process.exit(1);
  }
  console.log('bookrail concurrency: every round green.');
}

function label(spec: Omit<ScenarioOptions, 'databaseName'>): string {
  return spec.scenario === 'capacity'
    ? `capacity=${String(spec.capacity ?? 1)} `.padEnd(16, ' ')
    : `${spec.scenario}`.padEnd(16, ' ');
}

function range(bounds: { min: number; max: number }): string {
  return bounds.min === bounds.max
    ? String(bounds.min)
    : `${String(bounds.min)}-${String(bounds.max)}`;
}

export function verdict(result: RoundResult): boolean {
  return (
    result.won >= result.expectedWinners.min &&
    result.won <= result.expectedWinners.max &&
    Object.keys(result.other).length === 0 &&
    result.overCapacity.length === 0 &&
    result.anomalies.length === 0
  );
}

await main();
