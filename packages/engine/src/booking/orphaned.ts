/**
 * `booking.orphaned`: a booking the configuration no longer supports.
 *
 * A booking is a promise about the future, and the configuration it rests on can be changed
 * afterwards. Somebody closes the Tuesday afternoon that a booking sits in; somebody lowers a
 * room from four seats to two while three are booked; somebody deletes the schedule the
 * resource follows. Bookrail has to decide what happens to the bookings that were already
 * there, and the decision is: **nothing happens to them.**
 *
 * The booking is not cancelled, not moved, not touched at all. It is a commitment to a
 * customer, and no `PATCH` of a calendar is allowed to break it silently, but it is now
 * inconsistent with the calendar, and the only party who can decide what to do about it is
 * the business. So the write that caused it emits, **in its own transaction**, one
 * `booking.orphaned` event per affected booking, saying which resource and why, and the
 * customer's system takes it from there.
 *
 * ## What counts as orphaned
 *
 * Two things, checked on the state the modification has just produced:
 *
 *  * `outside_schedule`: some instant of the booking's core period is no longer open on that
 *    resource. Covers a rule that moved, an exception that closed the day, a schedule that was
 *    detached or deleted, and a resource that was deactivated or soft deleted;
 *  * `capacity_exceeded`: the peak of `capacity_used` over the booking's period is now above
 *    the resource's capacity. Covers a capacity that was lowered under what was already sold.
 *
 * The buffers are deliberately **not** part of the check. A booking whose buffer now falls
 * outside opening hours is not broken (the customer will still be served), and reporting it
 * would make the event fire on changes that hurt nobody.
 *
 * ## The horizon
 *
 * Only bookings that start within {@link DEFAULT_ORPHAN_HORIZON_DAYS} days are considered. A
 * schedule change is a cheap operation a dashboard performs interactively, and walking every
 * booking a resource will ever have would make it unbounded; ninety days is the same horizon
 * the availability engine uses for the furthest question it will answer, and a
 * booking further out than that will be re-examined by the next change anyway. It is a
 * documented ceiling, not an approximation of correctness: past it, nobody is told.
 */
import { sql, type Transaction } from '@bookrail/db';
import { encodeId, type Environment } from '@bookrail/shared';

import {
  blockTimeline,
  minCapacityOver,
  resourceOpenTimelines,
  type OccupancyData,
  type ResourceData,
} from '../availability/index.js';
import { subtract } from '../timeline/index.js';
import type { ScheduleException, ScheduleRule } from '../schedule/index.js';
import { insertEvent } from './queries.js';

/** The furthest ahead the engine ever looks in one question. */
export const DEFAULT_ORPHAN_HORIZON_DAYS = 90;

const DAY_MS = 86_400_000;

export type OrphanReasonCode = 'outside_schedule' | 'capacity_exceeded' | 'resource_unavailable';

export interface OrphanReason {
  readonly code: OrphanReasonCode;
  readonly resourceId: string;
  readonly detail: string;
}

export interface OrphanedBooking {
  readonly bookingId: string;
  readonly status: string;
  readonly start: number;
  readonly end: number;
  readonly reasons: readonly OrphanReason[];
  /** The `booking.orphaned` row written in the same transaction. */
  readonly eventId: string;
}

export interface DetectOrphansInput {
  readonly projectId: string;
  readonly environment: Environment;
  /** The resources the modification touched. */
  readonly resourceIds: readonly string[];
  /** Bookings starting before this instant are history and are never reported. */
  readonly now: number;
  readonly horizonDays?: number;
  /** Ceiling on the bookings one call examines; the rest are silently left alone. */
  readonly limit?: number;
}

/** Bookings still counting on their resources. A cancelled one has nothing to be orphaned. */
const LIVE_STATUSES = ['pending', 'confirmed', 'in_progress'];

/** How many future bookings one configuration change examines. */
export const DEFAULT_ORPHAN_LIMIT = 1000;

/**
 * Finds the bookings the caller's own modification has just broken, and writes their events.
 *
 * **Must be called after the modification and inside its transaction.** Before it, the check
 * would run against the old calendar and find nothing; outside it, a rollback would leave
 * events describing a change that never happened.
 */
export async function detectOrphanedBookings(
  tx: Transaction,
  input: DetectOrphansInput,
): Promise<readonly OrphanedBooking[]> {
  const resourceIds = [...new Set(input.resourceIds)];
  if (resourceIds.length === 0) return [];
  const horizonMs = (input.horizonDays ?? DEFAULT_ORPHAN_HORIZON_DAYS) * DAY_MS;

  const bookings = await futureBookingsOn(tx, resourceIds, input.now, input.now + horizonMs, {
    limit: input.limit ?? DEFAULT_ORPHAN_LIMIT,
  });
  if (bookings.length === 0) return [];

  const window = {
    from: Math.min(...bookings.map((booking) => booking.start)),
    to: Math.max(...bookings.map((booking) => booking.end)),
  };
  const resources = await loadResourceCalendars(tx, resourceIds, window.from, window.to);

  // Every (resource, period) peak in **one** statement, before the loop. One query per booking
  // per resource made a rename of a resource with 69 future bookings cost 35 ms inside the
  // transaction that held its row lock; the arithmetic is
  // unchanged, only the number of round trips is.
  const peaks = await peakUsagePerPeriod(
    tx,
    bookings.flatMap((booking) =>
      booking.allocations
        .filter((allocation) => resourceIds.includes(allocation.resourceId))
        .map((allocation) => ({
          resourceId: allocation.resourceId,
          from: booking.start,
          to: booking.end,
        })),
    ),
  );

  const out: OrphanedBooking[] = [];
  for (const booking of bookings) {
    const reasons: OrphanReason[] = [];
    for (const allocation of booking.allocations) {
      if (!resourceIds.includes(allocation.resourceId)) continue;
      const resource = resources.get(allocation.resourceId);
      if (resource === undefined) {
        // The resource is gone from the candidate set entirely: soft deleted, deactivated, or
        // left without a time zone. Whatever it is, the booking no longer stands on anything.
        reasons.push({
          code: 'resource_unavailable',
          resourceId: allocation.resourceId,
          detail: `Resource ${encodeId('resource', allocation.resourceId)} is no longer active.`,
        });
        continue;
      }
      // The blocks are subtracted here rather than left to `resourceTimelines`, which needs a
      // service to know the buffers and there is no service in this question. A block closes a
      // resource outright, so the arithmetic is a plain subtraction.
      const calendar = resourceOpenTimelines(resource, booking.start, booking.end).withExceptions;
      const blocks = blockTimeline(resource);
      const open = blocks.length === 0 ? calendar : subtract(calendar, blocks);
      if (minCapacityOver(open, booking.start, booking.end) <= 0) {
        reasons.push({
          code: 'outside_schedule',
          resourceId: allocation.resourceId,
          detail: `Resource ${encodeId('resource', allocation.resourceId)} is no longer open for the whole of this booking.`,
        });
        continue;
      }
      const used = peaks.get(peakKey(allocation.resourceId, booking.start, booking.end)) ?? 0;
      if (used > resource.capacity) {
        reasons.push({
          code: 'capacity_exceeded',
          resourceId: allocation.resourceId,
          detail: `Resource ${encodeId('resource', allocation.resourceId)} now has capacity ${String(resource.capacity)} and ${String(used)} units are taken over this period.`,
        });
      }
    }
    if (reasons.length === 0) continue;

    const eventId = await insertEvent(
      tx,
      input.projectId,
      input.environment,
      'booking.orphaned',
      {
        id: encodeId('booking', booking.id),
        object: 'booking',
        status: booking.status,
        service_id: encodeId('service', booking.serviceId),
        customer_id: booking.customerId === null ? null : encodeId('customer', booking.customerId),
        start: new Date(booking.start).toISOString(),
        end: new Date(booking.end).toISOString(),
        timezone: booking.timezone,
        quantity: booking.quantity,
        allocations: booking.allocations.map((allocation) => ({
          resource_id: encodeId('resource', allocation.resourceId),
          role: allocation.role,
          capacity_used: allocation.capacityUsed,
        })),
        reasons: reasons.map((reason) => ({
          code: reason.code,
          resource_id: encodeId('resource', reason.resourceId),
          message: reason.detail,
        })),
      },
      { occurredAt: input.now },
    );
    out.push({
      bookingId: booking.id,
      status: booking.status,
      start: booking.start,
      end: booking.end,
      reasons,
      eventId,
    });
  }
  return out;
}

function peakKey(resourceId: string, from: number, to: number): string {
  return `${resourceId}:${String(from)}:${String(to)}`;
}

/**
 * The peak of `capacity_used` over each (resource, period) pair, in one statement.
 *
 * The same arithmetic as {@link peakUsage} (the running maximum over the boundaries of the
 * occupancy footprints, each widened by its **own** buffers and never by the caller's, blocks
 * carrying none), but for a list of independent windows instead of one window shared by every
 * resource. `peakUsage` cannot answer this question: each booking asks about its own period.
 *
 * The 25 hour padding on the join is the same one `queries.ts` explains: migration 0009 caps a
 * buffer at 24 hours, so no occupancy outside that bracket can reach into the window, and the
 * predicate stays on the GiST index of `(resource_id, period)`.
 */
async function peakUsagePerPeriod(
  tx: Transaction,
  windows: readonly { resourceId: string; from: number; to: number }[],
): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  if (windows.length === 0) return used;
  const { rows } = await tx.execute<{ k: number; used: number }>(sql`
    WITH win AS (
      SELECT * FROM unnest(${sql.param(windows.map((w) => w.resourceId))}::uuid[],
                           ${sql.param(windows.map((w) => new Date(w.from).toISOString()))}::timestamptz[],
                           ${sql.param(windows.map((w) => new Date(w.to).toISOString()))}::timestamptz[])
                    WITH ORDINALITY AS t(rid, f, tt, k)
    ), fp AS (
      SELECT w.k, w.f, w.tt, o.capacity_used,
             -- No sharing: this question has no querying service, so every occupancy is
             -- measured at its widest. occupancy_footprint is the one SQL definition of the
             -- rule, shared with peakUsage and the capacity trigger of migration 0014.
             lower(occupancy_footprint(o.period, o.kind, o.buffer_before_ms, o.buffer_after_ms,
                                       0, 0)) AS s,
             upper(occupancy_footprint(o.period, o.kind, o.buffer_before_ms, o.buffer_after_ms,
                                       0, 0)) AS e
        FROM win w
        JOIN occupancies o
          ON o.resource_id = w.rid
         AND o.active
         AND (o.expires_at IS NULL OR o.expires_at > now())
         AND o.period && tstzrange(w.f - interval '25 hours', w.tt + interval '25 hours', '[)')
    ), ev AS (
      SELECT k, GREATEST(s, f) AS at, capacity_used AS delta FROM fp WHERE s < tt AND e > f
      UNION ALL
      SELECT k, LEAST(e, tt), -capacity_used FROM fp WHERE s < tt AND e > f
    ), run AS (
      -- ORDER BY at, delta is load bearing: at one instant the closes (negative) apply
      -- before the opens, which is what a half open [start, end) period means.
      SELECT k, SUM(delta) OVER (PARTITION BY k ORDER BY at, delta
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
        FROM ev
    )
    SELECT k::int AS k, MAX(running)::int AS used FROM run GROUP BY k
  `);
  for (const row of rows) {
    const w = windows[row.k - 1];
    if (w !== undefined) used.set(peakKey(w.resourceId, w.from, w.to), row.used);
  }
  return used;
}

interface FutureBooking {
  readonly id: string;
  readonly status: string;
  readonly serviceId: string;
  readonly customerId: string | null;
  readonly timezone: string;
  readonly quantity: number;
  readonly start: number;
  readonly end: number;
  readonly allocations: readonly {
    resourceId: string;
    role: string | null;
    capacityUsed: number;
  }[];
}

async function futureBookingsOn(
  tx: Transaction,
  resourceIds: readonly string[],
  from: number,
  to: number,
  options: { limit: number },
): Promise<FutureBooking[]> {
  // A semi-join, not a join: a booking holding two allocations on one resource must appear
  // once, and the allocations are then read in full: the reasons name every resource of the
  // booking that the change touched, not only the first.
  const { rows } = await tx.execute<{
    id: string;
    status: string;
    service_id: string;
    customer_id: string | null;
    timezone: string;
    quantity: number;
    starts_ms: string;
    ends_ms: string;
  }>(sql`
    SELECT b.id, b.status, b.service_id, b.customer_id, b.timezone, b.quantity,
           (extract(epoch FROM b.starts_at) * 1000)::bigint AS starts_ms,
           (extract(epoch FROM b.ends_at) * 1000)::bigint AS ends_ms
      FROM bookings b
     WHERE b.status = ANY(${sql.param(LIVE_STATUSES)}::text[])
       AND b.starts_at >= ${new Date(from).toISOString()}::timestamptz
       AND b.starts_at < ${new Date(to).toISOString()}::timestamptz
       AND EXISTS (SELECT 1 FROM booking_allocations a
                    WHERE a.booking_id = b.id
                      AND a.resource_id = ANY(${sql.param([...resourceIds])}::uuid[]))
     ORDER BY b.starts_at, b.id
     LIMIT ${options.limit}
  `);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const { rows: allocationRows } = await tx.execute<{
    booking_id: string;
    resource_id: string;
    role: string | null;
    capacity_used: number;
  }>(sql`
    SELECT booking_id, resource_id, role, capacity_used
      FROM booking_allocations
     WHERE booking_id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY resource_id
  `);
  const byBooking = new Map<string, FutureBooking['allocations'][number][]>();
  for (const row of allocationRows) {
    const bucket = byBooking.get(row.booking_id) ?? [];
    bucket.push({
      resourceId: row.resource_id,
      role: row.role,
      capacityUsed: row.capacity_used,
    });
    byBooking.set(row.booking_id, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    serviceId: row.service_id,
    customerId: row.customer_id,
    timezone: row.timezone,
    quantity: row.quantity,
    start: Number(row.starts_ms),
    end: Number(row.ends_ms),
    allocations: byBooking.get(row.id) ?? [],
  }));
}

/**
 * The calendar of each resource, as `resourceOpenTimelines` wants it.
 *
 * A narrower read than `loadAvailabilityData`, and on purpose: that one is service-scoped and
 * this question is resource-scoped: "is this resource open then", asked of resources that
 * may belong to several services or to none. The `occupancies` array is filled with the
 * **blocks** only, because a block closes a resource and the other occupancies are exactly
 * what the capacity check counts separately.
 *
 * A resource that is inactive, soft deleted, or has no time zone anywhere is left out of the
 * map: the caller reports it as `resource_unavailable`, which is the truth in all three cases.
 */
async function loadResourceCalendars(
  tx: Transaction,
  resourceIds: readonly string[],
  from: number,
  to: number,
): Promise<Map<string, ResourceData>> {
  const out = new Map<string, ResourceData>();
  const { rows: resourceRows } = await tx.execute<{
    id: string;
    name: string;
    capacity: number;
    schedule_id: string | null;
    timezone: string | null;
  }>(sql`
    SELECT r.id, r.name, r.capacity, r.schedule_id,
           COALESCE(s.timezone, l.timezone) AS timezone
      FROM resources r
      LEFT JOIN schedules s ON s.id = r.schedule_id
      LEFT JOIN locations l ON l.id = r.location_id
     WHERE r.id = ANY(${sql.param([...resourceIds])}::uuid[])
       AND r.status = 'active'
       AND r.deleted_at IS NULL
     ORDER BY r.id
  `);
  if (resourceRows.length === 0) return out;

  const scheduleIds = [
    ...new Set(
      resourceRows.map((row) => row.schedule_id).filter((id): id is string => id !== null),
    ),
  ];
  const rules = new Map<string, ScheduleRule[]>();
  const exceptions = new Map<string, ScheduleException[]>();
  if (scheduleIds.length > 0) {
    const { rows: ruleRows } = await tx.execute<{
      schedule_id: string;
      days_of_week: number[];
      start_time: string;
      end_time: string;
      valid_from: string | null;
      valid_until: string | null;
    }>(sql`
      SELECT schedule_id, days_of_week, start_time::text AS start_time,
             end_time::text AS end_time, valid_from::text AS valid_from,
             valid_until::text AS valid_until
        FROM schedule_rules
       WHERE schedule_id = ANY(${sql.param(scheduleIds)}::uuid[])
       ORDER BY id
    `);
    for (const row of ruleRows) {
      const bucket = rules.get(row.schedule_id) ?? [];
      bucket.push({
        daysOfWeek: row.days_of_week.map(Number),
        startTime: row.start_time,
        endTime: row.end_time,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
      });
      rules.set(row.schedule_id, bucket);
    }
    // Two days of slack on each side: an exception is a *local* date and no zone is more than
    // a day away from UTC.
    const { rows: exceptionRows } = await tx.execute<{
      schedule_id: string;
      date: string;
      type: string;
      start_time: string | null;
      end_time: string | null;
    }>(sql`
      SELECT schedule_id, date::text AS date, type,
             start_time::text AS start_time, end_time::text AS end_time
        FROM schedule_exceptions
       WHERE schedule_id = ANY(${sql.param(scheduleIds)}::uuid[])
         AND date >= (${new Date(from).toISOString()}::timestamptz - interval '2 days')::date
         AND date <= (${new Date(to).toISOString()}::timestamptz + interval '2 days')::date
       ORDER BY date, id
    `);
    for (const row of exceptionRows) {
      const bucket = exceptions.get(row.schedule_id) ?? [];
      bucket.push({
        date: row.date,
        type: row.type === 'open' ? 'open' : 'closed',
        startTime: row.start_time,
        endTime: row.end_time,
      });
      exceptions.set(row.schedule_id, bucket);
    }
  }

  const { rows: blockRows } = await tx.execute<{
    id: string;
    resource_id: string;
    starts_ms: string;
    ends_ms: string;
    capacity_used: number;
    ref_id: string;
  }>(sql`
    SELECT id, resource_id, capacity_used, ref_id,
           (extract(epoch FROM lower(period)) * 1000)::bigint AS starts_ms,
           (extract(epoch FROM upper(period)) * 1000)::bigint AS ends_ms
      FROM occupancies
     WHERE resource_id = ANY(${sql.param([...resourceIds])}::uuid[])
       AND active AND kind = 'block'
       AND period && tstzrange(${new Date(from).toISOString()}, ${new Date(to).toISOString()}, '[)')
  `);
  const blocks = new Map<string, OccupancyData[]>();
  for (const row of blockRows) {
    const bucket = blocks.get(row.resource_id) ?? [];
    bucket.push({
      id: row.id,
      resourceId: row.resource_id,
      start: Number(row.starts_ms),
      end: Number(row.ends_ms),
      capacityUsed: row.capacity_used,
      kind: 'block',
      refId: row.ref_id,
      bufferBeforeMs: 0,
      bufferAfterMs: 0,
    });
    blocks.set(row.resource_id, bucket);
  }

  for (const row of resourceRows) {
    if (row.timezone === null) continue;
    out.set(row.id, {
      id: row.id,
      name: row.name,
      capacity: row.capacity,
      timezone: row.timezone,
      rules: row.schedule_id === null ? [] : (rules.get(row.schedule_id) ?? []),
      exceptions: row.schedule_id === null ? [] : (exceptions.get(row.schedule_id) ?? []),
      occupancies: blocks.get(row.id) ?? [],
    });
  }
  return out;
}
