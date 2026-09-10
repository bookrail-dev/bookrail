/**
 * The availability benchmark: twenty resources with realistic schedules, two thousand
 * occupancies spread over thirty days, and a request for one week.
 *
 * It measures the whole path an HTTP request takes: the Postgres read, the (resource, day)
 * cache, and the computation. Not the pure calculation alone, because the target the cache
 * exists to meet, under 50 ms for a week over twenty resources, is a statement about the
 * endpoint, not about `computeAvailability`.
 *
 * Two tasks, and the difference between them is the whole point:
 *
 * - **cold**: a fresh cache on every iteration, so every local day of every resource is
 *   materialized from the rules;
 * - **warm**: one cache shared by every iteration, which is the steady state of a running
 *   deployment: the schedules of the next week are already there and only the response is
 *   rebuilt.
 *
 * A third task answers the question that arrived with dynamic prices: what does it cost to
 * **evaluate the rules** for every slot of the answer? It is the warm path again, on the same
 * fixture, with three `pricing_rules` on the service, so the difference between the two warm
 * numbers is the price of the pricing. The two original tasks are untouched, so they stay
 * comparable with the numbers recorded when the cache was introduced.
 *
 * `pnpm bench`.
 */
import { afterAll, beforeAll, bench, describe } from 'vitest';

import {
  computeAvailability,
  loadOpenTimelines,
  MemoryAvailabilityCache,
  type AvailabilityCache,
  type AvailabilityDataQuery,
} from '../src/index.js';
import { createHarness, utc, type Harness } from '../test/availability-harness.js';

const RESOURCES = 20;
const OCCUPANCIES = 2_000;
const SPREAD_DAYS = 30;

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The measured window: seven days, one week out. */
const FROM = utc(2026, 9, 7, 0, 0);
const TO = FROM + 7 * DAY;
const NOW = utc(2026, 9, 1, 0, 0);

let harness: Harness;
let query: AvailabilityDataQuery;
/** The same fixture with three pricing rules on the service. */
let pricedQuery: AvailabilityDataQuery;
const warm: AvailabilityCache = new MemoryAvailabilityCache();
const warmPriced: AvailabilityCache = new MemoryAvailabilityCache();

beforeAll(async () => {
  harness = await createHarness('availability-bench');
  const location = await harness.location('Europe/Rome');

  const resourceIds: string[] = [];
  for (let i = 0; i < RESOURCES; i += 1) {
    // Realistic, not identical: three opening patterns and a weekly closing day each.
    const open = ['08:00', '07:30', '09:00'][i % 3]!;
    const close = ['22:00', '20:00', '23:00'][i % 3]!;
    const closedOn = i % 7;
    const days = [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== closedOn);
    const scheduleId = await harness.schedule({
      timezone: 'Europe/Rome',
      rules: [{ daysOfWeek: days, startTime: open, endTime: close }],
      exceptions: [{ date: '2026-09-09', type: 'closed', startTime: '12:00', endTime: '14:00' }],
    });
    resourceIds.push(
      await harness.resource({
        name: `Court ${String(i + 1)}`,
        scheduleId,
        locationId: location,
        capacity: 1 + (i % 3),
      }),
    );
  }

  const groupId = await harness.group({
    strategy: 'first_available',
    members: resourceIds.map((resourceId, index) => ({ resourceId, priority: index })),
  });
  const serviceId = await harness.service({
    durationMinutes: 60,
    slotInterval: 60,
    alignTo: 'hour',
    price: { amount: 2500, currency: 'EUR' },
    bufferBefore: 10,
    bufferAfter: 10,
  });
  await harness.requirement({ serviceId, groupId, quantity: 1 });

  // Two thousand bookings over thirty days: deterministic, so the benchmark is reproducible,
  // and pairwise distinct per resource, because `occ_no_overlap_cap1` is a real constraint on
  // the resources whose capacity is one.
  const start = utc(2026, 9, 1, 0, 0);
  for (let i = 0; i < OCCUPANCIES; i += 1) {
    const resourceId = resourceIds[i % RESOURCES]!;
    const nth = Math.floor(i / RESOURCES); // 0..99 for each resource
    const day = nth % SPREAD_DAYS;
    const hour = 8 + Math.floor(nth / SPREAD_DAYS) * 3;
    const from = start + day * DAY + hour * HOUR;
    await harness.occupancy({ resourceId, from, to: from + HOUR });
  }

  query = { serviceId, from: FROM, to: TO };
  // Prime the shared cache once, outside the measurement, and refuse to benchmark an empty
  // answer, which would measure nothing at all.
  const slots = await run(warm);
  if (slots < 50) {
    throw new Error(`The benchmark fixture produced only ${String(slots)} slots; it is wrong.`);
  }

  // The same offer, priced by rules instead of by a flat number. Three rules, and the one that
  // matches is deliberately **not** the first: a weekend rule that misses on a weekday makes the
  // evaluation walk the list, which is the honest shape of the cost.
  const pricedServiceId = await harness.service({
    durationMinutes: 60,
    slotInterval: 60,
    alignTo: 'hour',
    price: { amount: 2500, currency: 'EUR' },
    bufferBefore: 10,
    bufferAfter: 10,
    pricingRules: [
      { when: { days: ['sat', 'sun'] }, price: 4000, label: 'Weekend' },
      { when: { time_from: '18:00', time_to: '23:00' }, price_add: 1000, label: 'Evening' },
      { when: { duration_min: 90 }, price_multiplier: 1.4 },
    ],
  });
  await harness.requirement({ serviceId: pricedServiceId, groupId, quantity: 1 });
  pricedQuery = { serviceId: pricedServiceId, from: FROM, to: TO };
  const pricedSlots = await run(warmPriced, pricedQuery);
  if (pricedSlots !== slots) {
    throw new Error(
      `The priced fixture produced ${String(pricedSlots)} slots and the flat one ${String(slots)}; ` +
        'the two warm tasks are only comparable if they answer the same question.',
    );
  }
});

afterAll(async () => {
  await harness.close();
});

async function run(
  cache: AvailabilityCache,
  which: AvailabilityDataQuery = query,
): Promise<number> {
  const data = await harness.load(which, { occupancyCache: { cache } });
  const { timelines } = await loadOpenTimelines(data, FROM, TO, { cache });
  const result = computeAvailability({
    data,
    from: FROM,
    to: TO,
    now: NOW,
    openTimelines: timelines,
  });
  return result.slots.length;
}

/** Long enough to make the tail percentiles mean something. */
const OPTIONS = { time: 3_000, warmupTime: 500 };

describe('availability: 7 days, 20 resources, 2000 occupancies', () => {
  bench(
    'cold cache',
    async () => {
      await run(new MemoryAvailabilityCache());
    },
    OPTIONS,
  );

  bench(
    'warm cache',
    async () => {
      await run(warm);
    },
    OPTIONS,
  );

  bench(
    'warm cache, three pricing rules',
    async () => {
      await run(warmPriced, pricedQuery);
    },
    OPTIONS,
  );
});
