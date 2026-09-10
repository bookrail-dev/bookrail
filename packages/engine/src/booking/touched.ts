/**
 * Which (resource, local day) entries of `avail:occ` a write has just made false.
 *
 * Every writer of `occupancies` (the booking transaction, the release of a hold, the
 * periodic expiry job) owes its caller this list, and no writer invalidates the cache
 * itself: doing it from inside the transaction would drop the entry before the row it
 * describes is visible, and a concurrent availability request would immediately put the
 * stale value back. See {@link CreateBookingResult.touchedDays}.
 */
import { sql, type Transaction } from '@bookrail/db';

import { localDaysBetween } from '../schedule/index.js';
import type { TouchedDay } from './types.js';

/**
 * The zone of each resource, for a caller that has no `AvailabilityData` to read it from:
 * a release, or the expiry job, knows only the occupancies it is about to deactivate.
 */
export async function resourceZones(
  tx: Transaction,
  resourceIds: readonly string[],
): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  if (resourceIds.length === 0) return zones;
  const { rows } = await tx.execute<{ id: string; timezone: string | null }>(sql`
    SELECT r.id, COALESCE(s.timezone, l.timezone) AS timezone
      FROM resources r
      LEFT JOIN schedules s ON s.id = r.schedule_id
      LEFT JOIN locations l ON l.id = r.location_id
     WHERE r.id = ANY(${sql.param([...resourceIds])}::uuid[])
  `);
  for (const row of rows) if (row.timezone !== null) zones.set(row.id, row.timezone);
  return zones;
}

/**
 * The days `avail:occ` has to lose for one period.
 *
 * The cache slices occupancies by the day their **core** period touches, so those are the
 * days to drop, not the ones the buffers reach into, which belong to no slice. A resource
 * whose zone is unknown contributes nothing: it has no cached day to name.
 */
export function touchedDaysOf(
  allocations: readonly { resourceId: string }[],
  zones: ReadonlyMap<string, string>,
  start: number,
  end: number,
): TouchedDay[] {
  const out: TouchedDay[] = [];
  for (const allocation of allocations) {
    const zone = zones.get(allocation.resourceId);
    if (zone === undefined) continue;
    for (const day of localDaysBetween(zone, start, end)) {
      out.push({ resourceId: allocation.resourceId, day });
    }
  }
  return out;
}
