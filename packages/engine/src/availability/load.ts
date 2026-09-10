/**
 * The only part of the availability engine that talks to Postgres.
 *
 * `loadAvailabilityData` runs inside a transaction that already carries the RLS context
 * (`withProjectContext` from `@bookrail/db`), so every statement here is scoped to one
 * project and one environment by the database itself, not by a `where` clause this module
 * could forget. It returns a plain {@link AvailabilityData}, which `computeAvailability`
 * turns into slots without touching the database again: the split is what makes the whole
 * computation reproducible from a fixture.
 *
 * Identifiers in and out are bare UUIDs. Prefixing them (`svc_…`, `res_…`) is the API's
 * job, and so is turning the `BookrailError`s raised here into HTTP responses.
 */
import { sql, type Transaction } from '@bookrail/db';
import { errors, pricingRulesSchema, type PricingRule } from '@bookrail/shared';

import type { ScheduleException, ScheduleRule } from '../schedule/index.js';
import {
  loadCachedOccupancies,
  type LoadedOccupancy,
  type OccupancyCacheOptions,
} from './cached.js';
import type {
  AlignTo,
  AllocationStrategy,
  AvailabilityData,
  BookingWindow,
  ConsumesMode,
  OccupancyData,
  OccupancyKind,
  PolicyData,
  RequirementData,
  ResourceData,
  ServiceData,
} from './compute.js';

const MINUTE_MS = 60_000;

/**
 * Slack added to the window the occupancies are read over.
 *
 * The cache stores **whole local days**, so a day slice may only ever be
 * written from a read that covered the whole of it. No local day is longer than 25 hours and
 * no zone is further than 14 hours from UTC, so 26 hours on each side brackets every local
 * day the request touches. Rows outside the materialization window change nothing
 * (`materializeSchedule` clips, and an occupancy outside the open timeline is subtracted
 * from nothing), so the padding is applied whether or not a cache is in play, and the two
 * paths read exactly the same rows.
 */
const DAY_PAD_MS = 26 * 60 * 60 * 1000;

/** Options of {@link loadAvailabilityData}; today, only the occupancy cache. */
export interface LoadAvailabilityOptions {
  readonly occupancyCache?: OccupancyCacheOptions;
}

export interface AvailabilityDataQuery {
  /** Bare UUID of the service. */
  readonly serviceId: string;
  /** Window of interest for the **start** of the booking, epoch milliseconds. */
  readonly from: number;
  readonly to: number;
  /** When present, only these resources are considered. */
  readonly resourceIds?: readonly string[] | null;
  /** When present, the customer's active bookings are counted for the policy limit. */
  readonly customerId?: string | null;
}

type ServiceRow = {
  id: string;
  duration_minutes: number | null;
  duration_options: number[] | null;
  duration_min_minutes: number | null;
  duration_max_minutes: number | null;
  capacity_per_booking: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_interval_minutes: number | null;
  align_to: string | null;
  price_amount: number | null;
  price_currency: string | null;
  pricing_rules: unknown;
  booking_window: unknown;
  buffer_sharing: boolean;
  allow_split: boolean;
  policy_id: string | null;
};

type RequirementRow = {
  id: string;
  resource_id: string | null;
  resource_group_id: string | null;
  quantity: number;
  consumes: string;
  role: string | null;
};

type MemberRow = {
  resource_group_id: string;
  resource_id: string;
};

type GroupRow = {
  id: string;
  allocation_strategy: string;
};

type ResourceRow = {
  id: string;
  name: string;
  capacity: number;
  schedule_id: string | null;
  schedule_timezone: string | null;
  location_timezone: string | null;
};

type RuleRow = {
  schedule_id: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  valid_from: string | null;
  valid_until: string | null;
};

type ExceptionRow = {
  schedule_id: string;
  date: string;
  type: string;
  start_time: string | null;
  end_time: string | null;
};

/**
 * Range bounds come back as epoch milliseconds in an `int8`, which node-postgres hands over
 * as a string: `Date` round trips through the driver's own text parser and the engine's
 * domain is integer milliseconds anyway, so the conversion is done by Postgres.
 */
type RangeRow = {
  id: string;
  resource_id: string;
  starts_ms: string;
  ends_ms: string;
};

type OccupancyRow = RangeRow & {
  capacity_used: number;
  kind: string;
  ref_id: string;
  expires_ms: string | null;
  buffer_before_ms: number;
  buffer_after_ms: number;
};

/**
 * `services.booking_window`: `{ min_notice_minutes?, max_advance_days? }`.
 * Anything else in the column is ignored rather than rejected: the column is free-form
 * jsonb and an availability request is not the place to fail on a stale shape.
 */
function parseBookingWindow(value: unknown): BookingWindow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const minNotice = raw.min_notice_minutes;
  const maxAdvance = raw.max_advance_days;
  const window: BookingWindow = {
    minNoticeMinutes: typeof minNotice === 'number' && minNotice >= 0 ? minNotice : null,
    maxAdvanceDays: typeof maxAdvance === 'number' && maxAdvance >= 0 ? maxAdvance : null,
  };
  return window.minNoticeMinutes === null && window.maxAdvanceDays === null ? null : window;
}

/**
 * `services.pricing_rules`, validated on the way **out** of the database.
 *
 * The column is a free `jsonb` array with a `CHECK (jsonb_typeof = 'array')` and nothing more,
 * and the strict schema arrived after the column did. Every row in existence holds `[]`
 * (verified before that schema shipped), but the engine must not be the thing that breaks if
 * one day one does not: a rule the schema refuses is **skipped**, which is the same discipline
 * `policy_snapshot` follows in `booking/policy.ts` (a malformed tier is discarded, it does not
 * make the whole operation fail). Refusing to price a slot because of a typo written two years
 * ago would be the wrong error at the wrong moment.
 *
 * A skipped rule leaves a `null` **in its place** rather than closing the gap: `price_rule.index`
 * points into `services.pricing_rules` as the caller wrote it, and a hole that renumbered the
 * rules behind it would make that pointer lie.
 *
 * The way in is the strict one: `POST`/`PATCH /v1/services` refuses a malformed rule with a
 * `400 parameter_invalid` naming its index, so nothing new can get in through the API.
 *
 * Skipped is not the same as unnoticed. The indices of the rules that were refused are counted
 * and carried on {@link AvailabilityData}, so `explain` can say `pricing_rule_ignored` and name
 * them: the day someone tightens the schema, rules already written stop applying and the price
 * changes, and the only symptom without this is a `price_rule.index` pointing at a different
 * rule.
 */
function parsePricingRules(value: unknown): {
  rules: readonly (PricingRule | null)[];
  ignored: readonly number[];
} {
  if (!Array.isArray(value) || value.length === 0) return { rules: [], ignored: [] };
  const ignored: number[] = [];
  const rules = value.map((entry, index) => {
    const parsed = pricingRulesSchema.element.safeParse(entry);
    if (parsed.success) return parsed.data;
    ignored.push(index);
    return null;
  });
  return { rules, ignored };
}

function alignToOf(value: string | null): AlignTo | null {
  return value === 'hour' || value === 'half_hour' || value === 'schedule_start' ? value : null;
}

function strategyOf(value: string): AllocationStrategy {
  return value === 'least_busy' || value === 'round_robin' || value === 'priority'
    ? value
    : 'first_available';
}

function kindOf(value: string): OccupancyKind {
  return value === 'hold' || value === 'block' ? value : 'booking';
}

function consumesOf(value: string): ConsumesMode {
  return value === 'whole' ? 'whole' : 'per_unit';
}

/** Widest duration the service can ask for, in minutes; used to size the read window. */
function maxDurationMinutes(row: ServiceRow): number {
  if (row.duration_max_minutes !== null) return row.duration_max_minutes;
  if (row.duration_options !== null && row.duration_options.length > 0) {
    return Math.max(...row.duration_options);
  }
  return row.duration_minutes ?? row.duration_min_minutes ?? 0;
}

export async function loadAvailabilityData(
  tx: Transaction,
  query: AvailabilityDataQuery,
  options: LoadAvailabilityOptions = {},
): Promise<AvailabilityData> {
  const serviceRows = await tx.execute<ServiceRow>(sql`
    SELECT id, duration_minutes, duration_options, duration_min_minutes, duration_max_minutes,
           capacity_per_booking, buffer_before_minutes, buffer_after_minutes,
           slot_interval_minutes, align_to, price_amount, price_currency, pricing_rules,
           booking_window, buffer_sharing, allow_split, policy_id
      FROM services
     WHERE id = ${query.serviceId} AND deleted_at IS NULL
  `);
  const serviceRow = serviceRows.rows[0];
  if (serviceRow === undefined) throw errors.notFound('service', query.serviceId);

  const pricingRules = parsePricingRules(serviceRow.pricing_rules);
  const service: ServiceData = {
    id: serviceRow.id,
    durationMinutes: serviceRow.duration_minutes,
    durationOptions: serviceRow.duration_options,
    durationMinMinutes: serviceRow.duration_min_minutes,
    durationMaxMinutes: serviceRow.duration_max_minutes,
    capacityPerBooking: serviceRow.capacity_per_booking,
    bufferBeforeMinutes: serviceRow.buffer_before_minutes,
    bufferAfterMinutes: serviceRow.buffer_after_minutes,
    slotIntervalMinutes: serviceRow.slot_interval_minutes,
    alignTo: alignToOf(serviceRow.align_to),
    priceAmount: serviceRow.price_amount,
    priceCurrency: serviceRow.price_currency,
    pricingRules: pricingRules.rules,
    bookingWindow: parseBookingWindow(serviceRow.booking_window),
    bufferSharing: serviceRow.buffer_sharing,
    allowSplit: serviceRow.allow_split,
  };

  // The window the occupancies and blocks have to cover: a booking that starts inside
  // [from, to) reaches `duration + buffer_after` past it, and its buffer_before reaches back.
  const padMs =
    (maxDurationMinutes(serviceRow) +
      serviceRow.buffer_before_minutes +
      serviceRow.buffer_after_minutes) *
    MINUTE_MS;
  const readFrom = new Date(query.from - padMs);
  const readTo = new Date(query.to + padMs);

  const requirementRows = await tx.execute<RequirementRow>(sql`
    SELECT id, resource_id, resource_group_id, quantity, consumes, role
      FROM service_requirements
     WHERE service_id = ${query.serviceId}
     ORDER BY position, id
  `);

  // `resource_groups.selector` (dynamic membership on resources.attributes) is out of scope
  // for now: only the rows of resource_group_members are resolved.
  const groupIds = requirementRows.rows
    .map((row) => row.resource_group_id)
    .filter((id): id is string => id !== null);

  const members = new Map<string, string[]>();
  const strategies = new Map<string, AllocationStrategy>();
  if (groupIds.length > 0) {
    const groupRows = await tx.execute<GroupRow>(sql`
      SELECT id, allocation_strategy FROM resource_groups WHERE id = ANY(${sql.param(groupIds)}::uuid[])
    `);
    for (const row of groupRows.rows) strategies.set(row.id, strategyOf(row.allocation_strategy));

    const memberRows = await tx.execute<MemberRow>(sql`
      SELECT resource_group_id, resource_id
        FROM resource_group_members
       WHERE resource_group_id = ANY(${sql.param(groupIds)}::uuid[])
       ORDER BY priority, resource_id
    `);
    for (const row of memberRows.rows) {
      const bucket = members.get(row.resource_group_id) ?? [];
      bucket.push(row.resource_id);
      members.set(row.resource_group_id, bucket);
    }
  }

  const wanted = new Set<string>();
  for (const row of requirementRows.rows) {
    if (row.resource_id !== null) wanted.add(row.resource_id);
    if (row.resource_group_id !== null) {
      for (const id of members.get(row.resource_group_id) ?? []) wanted.add(id);
    }
  }
  const filter = query.resourceIds == null ? null : new Set(query.resourceIds);
  const candidateIds = [...wanted].filter((id) => filter === null || filter.has(id));

  // Only active, non deleted resources are candidates. A soft deleted resource still sits in
  // resource_group_members (the rows are left in place), so the filter has to be here.
  const resourceRows =
    candidateIds.length === 0
      ? { rows: [] as ResourceRow[] }
      : await tx.execute<ResourceRow>(sql`
          SELECT r.id, r.name, r.capacity, r.schedule_id,
                 s.timezone AS schedule_timezone, l.timezone AS location_timezone
            FROM resources r
            LEFT JOIN schedules s ON s.id = r.schedule_id
            LEFT JOIN locations l ON l.id = r.location_id
           WHERE r.id = ANY(${sql.param(candidateIds)}::uuid[])
             AND r.status = 'active'
             AND r.deleted_at IS NULL
           ORDER BY r.id
        `);

  const liveIds = resourceRows.rows.map((row) => row.id);
  const scheduleIds = [
    ...new Set(
      resourceRows.rows
        .map((row) => row.schedule_id)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];

  const rulesBySchedule = new Map<string, ScheduleRule[]>();
  const exceptionsBySchedule = new Map<string, ScheduleException[]>();
  if (scheduleIds.length > 0) {
    const ruleRows = await tx.execute<RuleRow>(sql`
      SELECT schedule_id, days_of_week, start_time::text AS start_time, end_time::text AS end_time,
             valid_from::text AS valid_from, valid_until::text AS valid_until
        FROM schedule_rules
       WHERE schedule_id = ANY(${sql.param(scheduleIds)}::uuid[])
       ORDER BY id
    `);
    for (const row of ruleRows.rows) {
      const bucket = rulesBySchedule.get(row.schedule_id) ?? [];
      bucket.push({
        daysOfWeek: row.days_of_week.map(Number),
        startTime: row.start_time,
        endTime: row.end_time,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
      });
      rulesBySchedule.set(row.schedule_id, bucket);
    }

    // Two days of slack on each side: an exception is a *local* date, and no zone is more
    // than a day away from UTC.
    const exceptionRows = await tx.execute<ExceptionRow>(sql`
      SELECT schedule_id, date::text AS date, type,
             start_time::text AS start_time, end_time::text AS end_time
        FROM schedule_exceptions
       WHERE schedule_id = ANY(${sql.param(scheduleIds)}::uuid[])
         AND date >= (${readFrom.toISOString()}::timestamptz - interval '2 days')::date
         AND date <= (${readTo.toISOString()}::timestamptz + interval '2 days')::date
       ORDER BY date, id
    `);
    for (const row of exceptionRows.rows) {
      const bucket = exceptionsBySchedule.get(row.schedule_id) ?? [];
      bucket.push({
        date: row.date,
        type: row.type === 'open' ? 'open' : 'closed',
        startTime: row.start_time,
        endTime: row.end_time,
      });
      exceptionsBySchedule.set(row.schedule_id, bucket);
    }
  }

  // `resource_blocks` is **not** read here, deliberately.
  // `occupancies` is the single source of truth for what takes a resource away, and
  // `POST /v1/resources/{id}/block` writes a `kind = 'block'` occupancy for every block; the
  // catalogue row survives as what the block id points at. Reading both counted a block
  // twice (harmless, because the subtraction floors at zero), but it was work done for
  // nothing and two places that could disagree.
  let occupanciesByResource = new Map<string, OccupancyData[]>();
  const padFrom = new Date(query.from - padMs - DAY_PAD_MS);
  const padTo = new Date(query.to + padMs + DAY_PAD_MS);
  if (liveIds.length > 0) {
    // An expired hold occupies nothing, even if the sweeper has not marked it yet: the
    // predicate is the guarantee, the sweeping job is only housekeeping. With a cache in
    // play the predicate moves to the reader (`loadCachedOccupancies`), because a row cached
    // while its hold was alive must not be believed after it expires; `expires_at` therefore
    // travels with the row instead of being consumed by the `WHERE`.
    const fetch = async (ids: string[]): Promise<Map<string, LoadedOccupancy[]>> => {
      const out = new Map<string, LoadedOccupancy[]>();
      if (ids.length === 0) return out;
      const rows = await tx.execute<OccupancyRow>(sql`
        SELECT id, resource_id,
               (extract(epoch FROM lower(period)) * 1000)::bigint AS starts_ms,
               (extract(epoch FROM upper(period)) * 1000)::bigint AS ends_ms,
               capacity_used, kind, ref_id, buffer_before_ms, buffer_after_ms,
               (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms
          FROM occupancies
         WHERE resource_id = ANY(${sql.param(ids)}::uuid[])
           AND active
           AND (expires_at IS NULL OR expires_at > now())
           AND period && tstzrange(${padFrom.toISOString()}, ${padTo.toISOString()}, '[)')
         ORDER BY id
      `);
      for (const row of rows.rows) {
        const bucket = out.get(row.resource_id) ?? [];
        bucket.push({
          id: row.id,
          resourceId: row.resource_id,
          start: Number(row.starts_ms),
          end: Number(row.ends_ms),
          capacityUsed: row.capacity_used,
          kind: kindOf(row.kind),
          refId: row.ref_id,
          bufferBeforeMs: row.buffer_before_ms,
          bufferAfterMs: row.buffer_after_ms,
          expiresAt: row.expires_ms === null ? null : Number(row.expires_ms),
        });
        out.set(row.resource_id, bucket);
      }
      return out;
    };

    if (options.occupancyCache === undefined) {
      const fetched = await fetch(liveIds);
      for (const [resourceId, rows] of fetched) {
        occupanciesByResource.set(
          resourceId,
          rows.map(({ expiresAt: _expiresAt, ...rest }) => rest),
        );
      }
    } else {
      const coordinates = resourceRows.rows
        .map((row) => ({
          id: row.id,
          timezone: row.schedule_timezone ?? row.location_timezone ?? '',
        }))
        .filter((row) => row.timezone !== '');
      // Days are enumerated over the read window; the fetch covers the padded one, which
      // contains every local day those days belong to, so a stored slice is always complete.
      occupanciesByResource = await loadCachedOccupancies(
        coordinates,
        readFrom.getTime(),
        readTo.getTime(),
        options.occupancyCache,
        fetch,
      );
    }
  }

  const resources: ResourceData[] = resourceRows.rows.map((row) => {
    const timezone = row.schedule_timezone ?? row.location_timezone;
    // No silent `UTC`. A candidate resource that cannot say which clock it runs on would
    // otherwise hand a UTC grid to a service whose other resources are in Kathmandu, and it
    // would do it quietly. Either the schedule or the location has to carry the zone.
    if (timezone === null || timezone === undefined) {
      throw errors.invalidRequest(
        `Resource ${row.name} has no time zone: set it on its schedule or on its location.`,
        'resource_id',
        'timezone_missing',
      );
    }
    return {
      id: row.id,
      name: row.name,
      capacity: row.capacity,
      timezone,
      rules: row.schedule_id === null ? [] : (rulesBySchedule.get(row.schedule_id) ?? []),
      exceptions: row.schedule_id === null ? [] : (exceptionsBySchedule.get(row.schedule_id) ?? []),
      occupancies: occupanciesByResource.get(row.id) ?? [],
    };
  });

  const live = new Set(liveIds);
  const requirements: RequirementData[] = requirementRows.rows.map((row) => {
    const ids =
      row.resource_id !== null
        ? [row.resource_id]
        : (members.get(row.resource_group_id ?? '') ?? []);
    return {
      id: row.id,
      quantity: row.quantity,
      consumes: consumesOf(row.consumes),
      role: row.role,
      resourceGroupId: row.resource_group_id,
      allocationStrategy:
        row.resource_group_id === null
          ? 'first_available'
          : (strategies.get(row.resource_group_id) ?? 'first_available'),
      resourceIds: ids.filter((id) => live.has(id) && (filter === null || filter.has(id))),
    };
  });

  let policy: PolicyData | null = null;
  if (serviceRow.policy_id !== null) {
    const policyRows = await tx.execute<{
      id: string;
      max_active_bookings_per_customer: number | null;
    }>(sql`
      SELECT id, max_active_bookings_per_customer FROM policies WHERE id = ${serviceRow.policy_id}
    `);
    const row = policyRows.rows[0];
    if (row !== undefined) {
      policy = { id: row.id, maxActiveBookingsPerCustomer: row.max_active_bookings_per_customer };
    }
  }

  let customerActiveBookings: number | null = null;
  if (query.customerId != null) {
    // "Active" is `pending` or `confirmed` **and not over yet**: a confirmed booking from
    // 2020 that no job ever moved to `completed` must not block the customer for the rest of
    // time.
    const countRows = await tx.execute<{ active: string }>(sql`
      SELECT count(*)::text AS active
        FROM bookings
       WHERE customer_id = ${query.customerId}
         AND status IN ('pending', 'confirmed')
         AND ends_at > now()
    `);
    customerActiveBookings = Number(countRows.rows[0]?.active ?? 0);
  }

  return {
    service,
    requirements,
    resources,
    policy,
    customerActiveBookings,
    ignoredPricingRules: pricingRules.ignored,
    timezone: alignmentTimezone(requirements, resources),
  };
}

/**
 * The zone the slot grid is aligned to: the first candidate resource **that has a schedule**,
 * taken in requirement order and then in the group's own member order.
 *
 * A service whose resources live in two zones has no single wall clock to align to, and
 * `discretize` takes one alignment for the whole timeline. Picking the first candidate keeps
 * the choice deterministic and correct for the case that actually occurs: every resource of
 * one service in one location. Resources with neither rules nor exceptions are skipped: they
 * never open, so letting one of them decide the grid of the others would be arbitrary twice
 * over. A truly multi-zone service is listed in the report as a known limitation.
 *
 * The `UTC` at the end is not a fallback for a resource without a zone (a resource like that
 * is refused by `timezone_missing` above), but the answer to "no candidate resources at all",
 * where there is no grid to align and the value is provably never read.
 */
function alignmentTimezone(
  requirements: readonly RequirementData[],
  resources: readonly ResourceData[],
): string {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const scheduled = (resource: ResourceData): boolean =>
    resource.rules.length > 0 || resource.exceptions.length > 0;
  for (const onlyScheduled of [true, false]) {
    for (const requirement of requirements) {
      for (const id of requirement.resourceIds) {
        const resource = byId.get(id);
        if (resource === undefined) continue;
        if (onlyScheduled && !scheduled(resource)) continue;
        return resource.timezone;
      }
    }
  }
  return resources[0]?.timezone ?? 'UTC';
}
