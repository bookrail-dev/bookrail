/**
 * The bookable project the operational suites need, built **through the CLI itself**.
 *
 * Not a shortcut: half of the command surface is the CRUD, and a fixture that wrote rows,
 * or even one that called the API directly, would let a regression in `bookrail services
 * create` hide behind a green operational suite. Everything below is a command an agent types.
 */
import { expect } from 'vitest';
import type { CliResult, Harness } from './harness.js';

const DAY_MS = 86_400_000;

/** Midnight UTC of a Monday at least a week away, so nothing is near `now`. */
export function nextMonday(): Date {
  const day = new Date(Date.now() + 7 * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

export function plusDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export interface Scenario {
  locationId: string;
  scheduleId: string;
  resourceIds: string[];
  groupId: string;
  policyId: string;
  serviceId: string;
}

export interface ScenarioOptions {
  name?: string;
  resources?: number;
  capacity?: number;
  /** Extra fields for the service body, merged over the defaults. */
  service?: Record<string, unknown>;
  /** Extra fields for the policy body. */
  policy?: Record<string, unknown>;
}

function ok<T>(result: CliResult, what: string): T {
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${String(result.code)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.json<T>().data as T;
}

export async function buildScenario(
  h: Harness,
  key: string,
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const env = { env: { BOOKRAIL_SECRET_KEY: key } };
  const suffix = options.name ?? Math.random().toString(36).slice(2, 8);

  const location = ok<{ id: string }>(
    await h.cli(
      [
        'locations',
        'create',
        '--set',
        `name=Club ${suffix}`,
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ],
      env,
    ),
    'locations create',
  );

  // A rule whose `to` is at or before its `from` crosses midnight, so 00:00 to 00:00 is the
  // whole local day, which keeps every scenario free of "is 09:00 in Rome inside the window"
  // arithmetic.
  const schedule = ok<{ id: string }>(
    await h.cli(
      [
        'schedules',
        'create',
        '--data',
        JSON.stringify({
          name: `Always ${suffix}`,
          timezone: 'Europe/Rome',
          rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' }],
        }),
        '--json',
      ],
      env,
    ),
    'schedules create',
  );

  const resourceIds: string[] = [];
  for (let index = 0; index < (options.resources ?? 1); index += 1) {
    const resource = ok<{ id: string }>(
      await h.cli(
        [
          'resources',
          'create',
          '--data',
          JSON.stringify({
            name: `Court ${String(index + 1)} ${suffix}`,
            type: 'court',
            location_id: location.id,
            schedule_id: schedule.id,
            capacity: options.capacity ?? 1,
          }),
          '--json',
        ],
        env,
      ),
      'resources create',
    );
    resourceIds.push(resource.id);
  }

  const group = ok<{ id: string }>(
    await h.cli(
      [
        'resource_groups',
        'create',
        '--data',
        JSON.stringify({ name: `Courts ${suffix}`, resource_ids: resourceIds }),
        '--json',
      ],
      env,
    ),
    'resource_groups create',
  );

  const policy = ok<{ id: string }>(
    await h.cli(
      [
        'policies',
        'create',
        '--data',
        JSON.stringify({
          name: `Standard ${suffix}`,
          hold_duration_seconds: 600,
          ...options.policy,
        }),
        '--json',
      ],
      env,
    ),
    'policies create',
  );

  const service = ok<{ id: string }>(
    await h.cli(
      [
        'services',
        'create',
        '--data',
        JSON.stringify({
          name: `Match ${suffix}`,
          duration: 60,
          // A real grid, so `start_not_on_grid` is reachable and `availability` returns whole
          // hours that are easy to reason about.
          slot_interval: 60,
          align_to: 'hour',
          policy_id: policy.id,
          requirements: [{ resource_group_id: group.id, quantity: 1 }],
          ...options.service,
        }),
        '--json',
      ],
      env,
    ),
    'services create',
  );

  return {
    locationId: location.id,
    scheduleId: schedule.id,
    resourceIds,
    groupId: group.id,
    policyId: policy.id,
    serviceId: service.id,
  };
}

export interface Slot {
  start: string;
  end: string;
  duration_minutes: number | null;
  available_capacity: number;
  resource_options: { resources: { resource_id: string }[] }[];
}

export async function slotsFor(
  h: Harness,
  key: string,
  serviceId: string,
  from: Date,
  to: Date,
  extra: string[] = [],
): Promise<Slot[]> {
  const result = await h.cli(
    [
      'availability',
      '--service',
      serviceId,
      '--from',
      from.toISOString(),
      '--to',
      to.toISOString(),
      ...extra,
      '--json',
    ],
    { env: { BOOKRAIL_SECRET_KEY: key } },
  );
  expect(result.code).toBe(0);
  return result.json<{ slots: Slot[] }>().data!.slots;
}

export async function firstSlot(
  h: Harness,
  key: string,
  serviceId: string,
  from: Date,
  to: Date,
): Promise<Slot> {
  const slots = await slotsFor(h, key, serviceId, from, to);
  const slot = slots[0];
  if (slot === undefined) throw new Error('the scenario produced no bookable slot');
  return slot;
}
