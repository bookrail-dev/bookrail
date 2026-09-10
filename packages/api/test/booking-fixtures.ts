/**
 * The scenario the hold, booking, idempotency and job suites all need: a location, a
 * schedule, some resources and a service, built **through the public API** rather than by
 * writing rows.
 *
 * Building them through the API is not laziness: half of what these suites test is the
 * contract (prefixed identifiers in and out, ISO 8601 with an offset in, UTC out) and a
 * fixture that inserted rows directly would exercise none of it. It also means a change that
 * breaks the CRUD endpoints breaks these suites too, which is the right direction of travel.
 */
import { expect } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, uuidv7 } from '@bookrail/shared';
import type { Harness } from './harness.js';

const DAY_MS = 86_400_000;

/** Midnight UTC of a Monday at least a week away, so `min_notice` is never in the way. */
export function nextMonday(): Date {
  const day = new Date(Date.now() + 7 * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  return day;
}

export function plusDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** 09:00 Rome on the given day; the schedules below open at 09:00. */
export function atRomeHour(day: Date, hour: number): Date {
  // Rome is UTC+2 in summer and UTC+1 in winter; the schedule is expressed in local time, so
  // the instant is found by asking the availability grid rather than by guessing an offset.
  return new Date(day.getTime() + hour * 3_600_000);
}

export interface Scenario {
  locationId: string;
  scheduleId: string;
  resourceIds: string[];
  serviceId: string;
  policyId: string | null;
}

export interface ScenarioOptions {
  rules?: { days_of_week: number[]; start_time: string; end_time: string }[];
  capacity?: number;
  resources?: number;
  /** When set, every resource is a member of a group and the service requires the group. */
  group?: { allocation_strategy?: string };
  policy?: Record<string, unknown>;
  service?: Record<string, unknown>;
  timezone?: string;
}

export async function buildScenario(
  h: Harness,
  token: string,
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const timezone = options.timezone ?? 'Europe/Rome';

  const location = await h.call<{ id: string }>('POST', '/v1/locations', {
    token,
    body: { name: `Club ${uuidv7().slice(0, 8)}`, timezone },
  });
  expect(location.status).toBe(201);

  const schedule = await h.call<{ id: string }>('POST', '/v1/schedules', {
    token,
    body: {
      name: 'Opening hours',
      timezone,
      rules: options.rules ?? [
        { days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00' },
      ],
    },
  });
  expect(schedule.status).toBe(201);

  const resourceIds: string[] = [];
  for (let i = 0; i < (options.resources ?? 1); i += 1) {
    const resource = await h.call<{ id: string }>('POST', '/v1/resources', {
      token,
      body: {
        name: `Court ${String(i + 1)}`,
        type: 'room',
        schedule_id: schedule.body.id,
        location_id: location.body.id,
        capacity: options.capacity ?? 1,
      },
    });
    expect(resource.status).toBe(201);
    resourceIds.push(resource.body.id);
  }

  let policyId: string | null = null;
  if (options.policy) {
    const policy = await h.call<{ id: string }>('POST', '/v1/policies', {
      token,
      body: { name: 'Policy', ...options.policy },
    });
    expect(policy.status).toBe(201);
    policyId = policy.body.id;
  }

  let requirements: Record<string, unknown>[];
  if (options.group) {
    const group = await h.call<{ id: string }>('POST', '/v1/resource_groups', {
      token,
      body: {
        name: 'Courts',
        resource_ids: resourceIds,
        ...(options.group.allocation_strategy
          ? { allocation_strategy: options.group.allocation_strategy }
          : {}),
      },
    });
    expect(group.status).toBe(201);
    requirements = [{ resource_group_id: group.body.id }];
  } else {
    requirements = resourceIds.map((id) => ({ resource_id: id }));
  }

  const service = await h.call<{ id: string }>('POST', '/v1/services', {
    token,
    body: {
      name: 'Service',
      duration: 60,
      requirements,
      ...(policyId ? { policy_id: policyId } : {}),
      ...options.service,
    },
  });
  expect(service.status).toBe(201);

  return {
    locationId: location.body.id,
    scheduleId: schedule.body.id,
    resourceIds,
    serviceId: service.body.id,
    policyId,
  };
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  available_capacity: number;
  price?: { amount: number; currency: string } | null;
  price_rule?: { index: number; label: string | null } | null;
}

/** The first slot the service offers in the given window, as the API reports it. */
export async function firstSlot(
  h: Harness,
  token: string,
  serviceId: string,
  from: Date,
  to: Date,
): Promise<AvailabilitySlot> {
  const response = await h.call<{ slots: AvailabilitySlot[] }>('POST', '/v1/availability', {
    token,
    body: { service_id: serviceId, from: from.toISOString(), to: to.toISOString() },
  });
  expect(response.status).toBe(200);
  const slot = response.body.slots[0];
  if (!slot) throw new Error('the scenario offers no slot at all');
  return slot;
}

export async function slotsFor(
  h: Harness,
  token: string,
  serviceId: string,
  from: Date,
  to: Date,
): Promise<AvailabilitySlot[]> {
  const response = await h.call<{ slots: AvailabilitySlot[] }>('POST', '/v1/availability', {
    token,
    body: { service_id: serviceId, from: from.toISOString(), to: to.toISOString() },
  });
  expect(response.status).toBe(200);
  return response.body.slots;
}

export interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string };
}

/**
 * Moves a booking's period into the past, with admin SQL.
 *
 * `POST /v1/bookings` refuses to backdate, so a booking made through the API always starts in
 * the future, and a booking cannot be **completed** before it starts
 * (`422 complete_too_early`). A suite that needs a booking whose
 * time has come therefore has to age the row, which is the only thing that separates the
 * fixture from a booking the clock has caught up with.
 *
 * `next_transition_at` moves with the period when it is set, so an automatic transition
 * scheduled on the old instants stays scheduled on the new ones.
 */
export async function ageBooking(
  h: Harness,
  bookingId: string,
  options: { startsAgo?: string } = {},
): Promise<void> {
  // The shift is computed from the row rather than fixed, because `nextMonday()` is anywhere
  // between seven and fourteen days out: a constant interval would age some fixtures into the
  // past and leave others in the future, which is exactly the kind of "passes on Tuesday"
  // test this suite should not have.
  const startsAgo = options.startsAgo ?? '2 hours';
  const id = decodeId('booking', bookingId);
  if (id === null) throw new Error(`not a booking id: ${bookingId}`);
  const adminDb = createDatabase(h.pools.admin);
  const { rows } = await adminDb.execute<{ shift: string }>(sql`
    UPDATE bookings b
       SET starts_at = starts_at - shift.v,
           ends_at = ends_at - shift.v,
           next_transition_at = next_transition_at - shift.v
      FROM (SELECT (starts_at - (now() - ${startsAgo}::interval)) AS v
              FROM bookings WHERE id = ${id}) AS shift
     WHERE b.id = ${id}
    RETURNING shift.v::text AS shift
  `);
  const shift = rows[0]?.shift;
  if (shift === undefined) throw new Error(`no such booking: ${bookingId}`);
  await adminDb.execute(sql`
    UPDATE occupancies
       SET period = tstzrange(lower(period) - ${shift}::interval,
                              upper(period) - ${shift}::interval, '[)')
     WHERE ref_id = ${id} AND kind = 'booking'
  `);
}
