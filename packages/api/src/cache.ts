/**
 * The API's side of the availability cache: how it is built, and who invalidates it.
 *
 * The engine owns the cache itself (`@bookrail/engine`, `cache/`); this module owns the two
 * decisions the engine cannot make. Which implementation to use (Redis when `REDIS_URL` is
 * configured, a process-local LRU otherwise) and **when a cached day stops being true**,
 * which is a property of the write endpoints, not of the calculation.
 *
 * The writes that move the open timeline are the ones that touch a schedule, an exception, a
 * block or a capacity. Every one of them goes through a CRUD route, and every one of those
 * routes calls in here **after** its transaction has committed: invalidating first would let a
 * concurrent availability request refill the entry with the value the transaction is about to
 * replace.
 *
 * The occupancy family (`avail:occ:…`) now has writers: `POST /v1/holds`, `DELETE
 * /v1/holds/{id}`, `POST /v1/bookings`, `POST /v1/resources/{id}/block` and the hold expiry
 * job. None of them invalidates from inside its transaction: that would drop the entry
 * before the row is visible, and a concurrent availability request would put the stale value
 * straight back. Each one instead receives `touchedDays` from the engine and hands it to
 * {@link invalidateTouchedDays} **after** the commit. Forgetting that call does not corrupt
 * anything: it leaves availability stale for the entry's TTL, which is the whole reason the
 * family has a short one.
 */
import type { Logger } from '@bookrail/shared';
import {
  localDaysBetween,
  MemoryAvailabilityCache,
  RedisAvailabilityCache,
  type AvailabilityCache,
} from '@bookrail/engine';

export interface CacheDeps {
  cache: AvailabilityCache;
  logger: Logger;
}

/** Redis when a URL is configured, otherwise the in-process LRU. */
export function createAvailabilityCache(
  redisUrl: string | undefined,
  logger: Logger,
): AvailabilityCache {
  if (redisUrl === undefined || redisUrl === '') return new MemoryAvailabilityCache();
  return RedisAvailabilityCache.fromUrl(redisUrl, { logger });
}

/**
 * Drops every cached day of the given resources.
 *
 * Used when what changed is not confined to a date range: a schedule's rules, a resource's
 * capacity or zone, a soft delete. Failures never propagate: a cache that cannot be
 * invalidated is a correctness problem for the seconds of its TTL, and turning a successful
 * `PATCH` into a 500 would be a worse answer than a stale timeline.
 */
export async function invalidateResources(
  deps: CacheDeps,
  resourceIds: Iterable<string>,
): Promise<void> {
  for (const id of resourceIds) {
    try {
      await deps.cache.invalidateResource(id);
    } catch (error) {
      deps.logger.warn('availability_cache_invalidation_failed', {
        resource_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Drops the cached days a period covers, in the resource's own zone.
 *
 * A block is bounded in time, so there is no reason to throw away a year of cached calendar
 * for a two hour closure. Without a zone (a resource with neither a schedule nor a location
 * carrying one) the days cannot be named and the whole resource is dropped instead.
 */
export async function invalidateResourcePeriod(
  deps: CacheDeps,
  resourceId: string,
  timezone: string | null,
  from: Date,
  to: Date,
): Promise<void> {
  if (timezone === null) {
    await invalidateResources(deps, [resourceId]);
    return;
  }
  let days: string[];
  try {
    days = localDaysBetween(timezone, from.getTime(), to.getTime());
  } catch {
    await invalidateResources(deps, [resourceId]);
    return;
  }
  for (const day of days) {
    try {
      await deps.cache.invalidateResourceDay(resourceId, day);
    } catch (error) {
      deps.logger.warn('availability_cache_invalidation_failed', {
        resource_id: resourceId,
        day,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Drops exactly the (resource, local day) entries a write made false.
 *
 * The engine names them (`CreateBookingResult.touchedDays`, `ReleaseHoldResult.touchedDays`,
 * `ExpireHoldsResult.touchedDays`) because only it knows the zone of each resource and the
 * days the period crossed there. Duplicates are common (two allocations on one day) and are
 * collapsed here rather than at every call site. Failures never propagate: turning a
 * successful `POST /v1/bookings` into a 500 because Redis blinked would be a far worse answer
 * than a timeline that is a minute out of date.
 */
export async function invalidateTouchedDays(
  deps: CacheDeps,
  days: Iterable<{ resourceId: string; day: string }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const { resourceId, day } of days) {
    const key = `${resourceId}:${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await deps.cache.invalidateResourceDay(resourceId, day);
    } catch (error) {
      deps.logger.warn('availability_cache_invalidation_failed', {
        resource_id: resourceId,
        day,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
