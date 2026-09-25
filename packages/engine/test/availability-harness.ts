/**
 * Fixtures for the availability suites: a real Postgres, rows written straight into the
 * tables through the admin connection, and reads that go through the application role so
 * that row level security is in the middle exactly as it is in production.
 *
 * Nothing here mocks the database. `load()` opens `withProjectContext` on the application
 * pool and calls `loadAvailabilityData`, which is the same path the availability endpoint
 * takes.
 */
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
  computeAvailability,
  loadAvailabilityData,
  type AvailabilityData,
  type AvailabilityDataQuery,
  type AvailabilityResult,
  type ComputeAvailabilityInput,
  type LoadAvailabilityOptions,
} from '../src/index.js';
import { TEST_DB_NAME } from './db-name.js';

export type Environment = 'test' | 'live';

/** `Date.UTC` with a shorter name and a one-based month, which reads like the calendar. */
export function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface RuleInput {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  validFrom?: string;
  validUntil?: string;
}

export interface ExceptionInput {
  date: string;
  type: 'closed' | 'open';
  startTime?: string;
  endTime?: string;
}

export interface ServiceInput {
  name?: string;
  durationMinutes?: number | null;
  durationOptions?: number[] | null;
  durationRange?: { min: number; max: number } | null;
  capacityPerBooking?: number;
  bufferBefore?: number;
  bufferAfter?: number;
  slotInterval?: number | null;
  alignTo?: 'hour' | 'half_hour' | 'schedule_start' | null;
  price?: { amount: number; currency: string } | null;
  /** `services.pricing_rules`, written raw so a suite can put a malformed one in on purpose. */
  pricingRules?: readonly unknown[];
  bookingWindow?: { min_notice_minutes?: number; max_advance_days?: number } | null;
  bufferSharing?: boolean;
  allowSplit?: boolean;
  policyId?: string | null;
}

export interface OccupancyInput {
  resourceId: string;
  from: number;
  to: number;
  capacityUsed?: number;
  kind?: 'booking' | 'hold' | 'block';
  refId?: string;
  expiresAt?: number | null;
  active?: boolean;
  /** The buffers the occupancy carries, in milliseconds (migration 0009). */
  bufferBeforeMs?: number;
  bufferAfterMs?: number;
}

export interface Harness {
  projectId: string;
  /** The account the project belongs to. */
  accountId: string;
  environment: Environment;
  /** The pool that goes through the application role: what the booking engine writes with. */
  app: Database;
  /** Superuser connection, for fixtures and for assertions that must see everything. */
  admin: Database;
  location(timezone: string, name?: string): Promise<string>;
  schedule(input: {
    timezone?: string | null;
    rules?: RuleInput[];
    exceptions?: ExceptionInput[];
  }): Promise<string>;
  resource(input: {
    name?: string;
    capacity?: number;
    scheduleId?: string | null;
    locationId?: string | null;
    status?: 'active' | 'inactive';
    deleted?: boolean;
  }): Promise<string>;
  group(input: {
    name?: string;
    strategy?: 'least_busy' | 'round_robin' | 'first_available' | 'priority';
    members?: { resourceId: string; priority?: number }[];
  }): Promise<string>;
  addGroupMember(groupId: string, resourceId: string, priority?: number): Promise<void>;
  policy(input: {
    maxActiveBookingsPerCustomer?: number | null;
    /** Cancellation tiers, as stored: `[{before: "48h", refund_percent: 100}, …]`. */
    cancellation?: { before: string; refund_percent?: number; fee?: number }[];
    reschedule?: { before: string; refund_percent?: number; fee?: number }[];
    noShow?: { charge_percent?: number; grace_minutes?: number; auto_mark?: boolean } | null;
    autoStart?: boolean;
    autoComplete?: boolean;
    maxReschedules?: number | null;
    requiresConfirmation?: boolean;
  }): Promise<string>;
  service(input: ServiceInput): Promise<string>;
  requirement(input: {
    serviceId: string;
    resourceId?: string;
    groupId?: string;
    quantity?: number;
    consumes?: 'per_unit' | 'whole';
    role?: string | null;
    position?: number;
  }): Promise<string>;
  customer(): Promise<string>;
  booking(input: {
    serviceId: string;
    customerId?: string | null;
    from: number;
    to: number;
    status?: string;
  }): Promise<string>;
  block(input: { resourceId: string; from: number; to: number }): Promise<string>;
  softDeleteService(serviceId: string): Promise<void>;
  /** Rewrites `services.pricing_rules` in place, which is what an API `PATCH` does. */
  setPricingRules(serviceId: string, rules: readonly unknown[]): Promise<void>;
  setCustomerTimezone(customerId: string, timezone: string): Promise<void>;
  occupancy(input: OccupancyInput): Promise<string>;
  load(query: AvailabilityDataQuery, options?: LoadAvailabilityOptions): Promise<AvailabilityData>;
  compute(
    query: AvailabilityDataQuery,
    options: Omit<ComputeAvailabilityInput, 'data' | 'from' | 'to'>,
  ): Promise<AvailabilityResult>;
  close(): Promise<void>;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export async function createHarness(
  name: string,
  options: { environment?: Environment } = {},
): Promise<Harness> {
  const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
  const adminPool = createPool({ connectionString: urls.admin, max: 3 });
  const appPool = createPool({ connectionString: urls.app, max: 3 });
  const admin: Database = createDatabase(adminPool);
  const app: Database = createDatabase(appPool);

  const accountId = uuidv7();
  const projectId = uuidv7();
  // The test environment unless a suite is about what only the live one does: the plan counts
  // live bookings and nothing else.
  const environment: Environment = options.environment ?? 'test';
  await admin.execute(
    sql`INSERT INTO accounts (id, name, api_version) VALUES (${accountId}, ${name}, '2026-09-01')`,
  );
  await admin.execute(
    sql`INSERT INTO projects (id, account_id, name) VALUES (${projectId}, ${accountId}, ${name})`,
  );

  const scope = { projectId, environment };

  return {
    projectId,
    accountId,
    environment,
    app,
    admin,

    async location(timezone, locationName = 'HQ') {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO locations (id, project_id, environment, name, timezone)
        VALUES (${id}, ${projectId}, ${environment}, ${locationName}, ${timezone})
      `);
      return id;
    },

    async schedule({ timezone = null, rules = [], exceptions = [] }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO schedules (id, project_id, environment, name, timezone)
        VALUES (${id}, ${projectId}, ${environment}, 'Schedule', ${timezone})
      `);
      for (const rule of rules) {
        await admin.execute(sql`
          INSERT INTO schedule_rules (id, project_id, environment, schedule_id, days_of_week,
                                      start_time, end_time, valid_from, valid_until)
          VALUES (${uuidv7()}, ${projectId}, ${environment}, ${id},
                  ${sql.param(rule.daysOfWeek)}::smallint[], ${rule.startTime}, ${rule.endTime},
                  ${rule.validFrom ?? null}, ${rule.validUntil ?? null})
        `);
      }
      for (const exception of exceptions) {
        await admin.execute(sql`
          INSERT INTO schedule_exceptions (id, project_id, environment, schedule_id, date, type,
                                           start_time, end_time)
          VALUES (${uuidv7()}, ${projectId}, ${environment}, ${id}, ${exception.date},
                  ${exception.type}, ${exception.startTime ?? null}, ${exception.endTime ?? null})
        `);
      }
      return id;
    },

    async resource({
      name: resourceName = 'Resource',
      capacity = 1,
      scheduleId = null,
      locationId = null,
      status = 'active',
      deleted = false,
    }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO resources (id, project_id, environment, name, type, location_id, schedule_id,
                               capacity, status, deleted_at)
        VALUES (${id}, ${projectId}, ${environment}, ${resourceName}, 'room', ${locationId},
                ${scheduleId}, ${capacity}, ${status}, ${deleted ? iso(Date.now()) : null})
      `);
      return id;
    },

    async group({ name: groupName = 'Group', strategy = 'first_available', members = [] }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO resource_groups (id, project_id, environment, name, allocation_strategy)
        VALUES (${id}, ${projectId}, ${environment}, ${groupName}, ${strategy})
      `);
      for (const member of members) {
        await admin.execute(sql`
          INSERT INTO resource_group_members (id, project_id, environment, resource_group_id,
                                              resource_id, priority)
          VALUES (${uuidv7()}, ${projectId}, ${environment}, ${id}, ${member.resourceId},
                  ${member.priority ?? 0})
        `);
      }
      return id;
    },

    async addGroupMember(groupId, resourceId, priority = 0) {
      await admin.execute(sql`
        INSERT INTO resource_group_members (id, project_id, environment, resource_group_id,
                                            resource_id, priority)
        VALUES (${uuidv7()}, ${projectId}, ${environment}, ${groupId}, ${resourceId}, ${priority})
      `);
    },

    async policy({
      maxActiveBookingsPerCustomer = null,
      cancellation = [],
      reschedule = [],
      noShow = null,
      autoStart = false,
      autoComplete = false,
      maxReschedules = null,
      requiresConfirmation = false,
    }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO policies (id, project_id, environment, name, max_active_bookings_per_customer,
                              cancellation, reschedule, no_show, auto_start, auto_complete,
                              max_reschedules, require_provider_confirmation)
        VALUES (${id}, ${projectId}, ${environment}, 'Policy', ${maxActiveBookingsPerCustomer},
                ${JSON.stringify(cancellation)}::jsonb, ${JSON.stringify(reschedule)}::jsonb,
                ${noShow === null ? null : JSON.stringify(noShow)}::jsonb,
                ${autoStart}, ${autoComplete}, ${maxReschedules}, ${requiresConfirmation})
      `);
      return id;
    },

    async service(input) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO services (id, project_id, environment, name, duration_minutes, duration_options,
                              duration_min_minutes, duration_max_minutes, capacity_per_booking,
                              buffer_before_minutes, buffer_after_minutes, slot_interval_minutes,
                              align_to, price_amount, price_currency, pricing_rules, policy_id,
                              booking_window, buffer_sharing, allow_split)
        VALUES (${id}, ${projectId}, ${environment}, ${input.name ?? 'Service'},
                ${input.durationMinutes ?? null},
                ${sql.param(input.durationOptions ?? null)}::integer[],
                ${input.durationRange?.min ?? null}, ${input.durationRange?.max ?? null},
                ${input.capacityPerBooking ?? 1},
                ${input.bufferBefore ?? 0}, ${input.bufferAfter ?? 0},
                ${input.slotInterval ?? null}, ${input.alignTo ?? null},
                ${input.price?.amount ?? null}, ${input.price?.currency ?? null},
                ${JSON.stringify(input.pricingRules ?? [])}::jsonb,
                ${input.policyId ?? null},
                ${
                  input.bookingWindow === undefined || input.bookingWindow === null
                    ? null
                    : JSON.stringify(input.bookingWindow)
                }::jsonb,
                ${input.bufferSharing ?? false}, ${input.allowSplit ?? false})
      `);
      return id;
    },

    async requirement({
      serviceId,
      resourceId,
      groupId,
      quantity = 1,
      consumes = 'per_unit',
      role = null,
      position = 0,
    }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO service_requirements (id, project_id, environment, service_id, resource_id,
                                          resource_group_id, quantity, consumes, role, position)
        VALUES (${id}, ${projectId}, ${environment}, ${serviceId}, ${resourceId ?? null},
                ${groupId ?? null}, ${quantity}, ${consumes}, ${role}, ${position})
      `);
      return id;
    },

    async customer() {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO customers (id, project_id, environment, external_id, name)
        VALUES (${id}, ${projectId}, ${environment}, ${`ext-${id}`}, 'Ada')
      `);
      return id;
    },

    async booking({ serviceId, customerId = null, from, to, status = 'confirmed' }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO bookings (id, project_id, environment, status, service_id, customer_id,
                              starts_at, ends_at, timezone)
        VALUES (${id}, ${projectId}, ${environment}, ${status}, ${serviceId}, ${customerId},
                ${iso(from)}, ${iso(to)}, 'Europe/Rome')
      `);
      return id;
    },

    /**
     * A block, exactly as `POST /v1/resources/{id}/block` writes it: a `resource_blocks` row
     * **and** a `kind = 'block'` occupancy taking the whole capacity of the resource. The
     * engine reads only the second one, so a fixture that wrote only the catalogue row would
     * block nothing.
     */
    async block({ resourceId, from, to }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO resource_blocks (id, project_id, environment, resource_id, period)
        VALUES (${id}, ${projectId}, ${environment}, ${resourceId},
                tstzrange(${iso(from)}, ${iso(to)}, '[)'))
      `);
      await admin.execute(sql`
        INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                                 kind, ref_id)
        SELECT ${uuidv7()}, ${projectId}, ${environment}, ${resourceId},
               tstzrange(${iso(from)}, ${iso(to)}, '[)'), r.capacity, 'block', ${id}
          FROM resources r WHERE r.id = ${resourceId}
      `);
      return id;
    },

    async softDeleteService(serviceId) {
      await admin.execute(sql`UPDATE services SET deleted_at = now() WHERE id = ${serviceId}`);
    },

    async setPricingRules(serviceId, rules) {
      await admin.execute(
        sql`UPDATE services SET pricing_rules = ${JSON.stringify(rules)}::jsonb
             WHERE id = ${serviceId}`,
      );
    },

    async setCustomerTimezone(customerId, timezone) {
      await admin.execute(
        sql`UPDATE customers SET timezone = ${timezone} WHERE id = ${customerId}`,
      );
    },

    async occupancy({
      resourceId,
      from,
      to,
      capacityUsed = 1,
      kind = 'booking',
      refId,
      expiresAt = null,
      active = true,
      bufferBeforeMs = 0,
      bufferAfterMs = 0,
    }) {
      const id = uuidv7();
      await admin.execute(sql`
        INSERT INTO occupancies (id, project_id, environment, resource_id, period, capacity_used,
                                 kind, ref_id, expires_at, active, buffer_before_ms,
                                 buffer_after_ms)
        VALUES (${id}, ${projectId}, ${environment}, ${resourceId},
                tstzrange(${iso(from)}, ${iso(to)}, '[)'), ${capacityUsed}, ${kind},
                ${refId ?? uuidv7()}, ${expiresAt === null ? null : iso(expiresAt)}, ${active},
                ${bufferBeforeMs}, ${bufferAfterMs})
      `);
      return id;
    },

    async load(query, options) {
      return withProjectContext(app, scope, (tx) => loadAvailabilityData(tx, query, options));
    },

    async compute(query, options) {
      const data = await withProjectContext(app, scope, (tx) => loadAvailabilityData(tx, query));
      return computeAvailability({ ...options, data, from: query.from, to: query.to });
    },

    async close() {
      await appPool.end();
      await adminPool.end();
    },
  };
}
