/**
 * The two level cache in front of the availability computation: a process-local LRU, and
 * optionally a Redis shared by the whole fleet.
 *
 * Nothing here caches an availability **response**. The unit of caching is the pair
 * (resource, local day), and there are two families of value:
 *
 * - `avail:open:{resource}:{day}`: the open timeline of that resource on that local day
 *   (rules ⊕ exceptions ⊖ blocks), which changes only when a schedule, an exception, a block
 *   or the resource's capacity changes;
 * - `avail:occ:{resource}:{day}`: the occupancies of that resource overlapping that local
 *   day, which change on every booking, hold and block.
 *
 * The response is always recomputed from those. That is possible only because
 * `computeAvailability` is a function of its data: the slot grid is anchored to the
 * opening bands, so two identical requests a minute apart get the same grid, and `now`
 * enters only through the `min_notice` / `max_advance` trim.
 *
 * A resource id is a UUID and is therefore globally unique, so the keys need no project or
 * environment prefix: two projects can never collide on one. The key shapes are fixed and
 * documented; the exact shape of the values is an implementation detail of this package and
 * carries a version tag so a redeploy can change it without serving nonsense.
 */
import type { Logger } from '@bookrail/shared';

/** `YYYY-MM-DD` in the resource's own zone. */
export type CacheDay = string;

export type CacheFamily = 'open' | 'occ';

export function cacheKey(family: CacheFamily, resourceId: string, day: CacheDay): string {
  return `avail:${family}:${resourceId}:${day}`;
}

/** Key of the per-resource index that makes `invalidateResource` an O(days) operation. */
export function cacheIndexKey(resourceId: string): string {
  return `avail:keys:${resourceId}`;
}

/** One value to write, with the coordinates the index needs. */
export interface CacheWrite {
  readonly family: CacheFamily;
  readonly resourceId: string;
  readonly day: CacheDay;
  readonly value: string;
  /** Seconds. A store may round it up but must never keep the value longer. */
  readonly ttlSeconds: number;
}

/**
 * What the availability engine needs from a cache. Deliberately a string store: the engine
 * serializes and deserializes, so an implementation never has to know what a timeline is,
 * and a miss is always `null`, never a throw. An implementation that cannot reach its
 * backend degrades to "everything is a miss" rather than failing the request: if the shared
 * cache falls, availability keeps answering.
 */
export interface AvailabilityCache {
  get(key: string): Promise<string | null>;
  /** One round trip for many keys. Same order as the input; `null` for a miss. */
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
  put(writes: readonly CacheWrite[]): Promise<void>;
  /** Drops both families for one (resource, day). */
  invalidateResourceDay(resourceId: string, day: CacheDay): Promise<void>;
  /** Drops every cached day of a resource, both families. */
  invalidateResource(resourceId: string): Promise<void>;
  /** Releases whatever the implementation holds. Safe to call twice. */
  close(): Promise<void>;
}

/** Default lifetimes. Schedules move rarely; occupancies move on every booking. */
export const DEFAULT_OPEN_TTL_SECONDS = 900;
export const DEFAULT_OCCUPANCY_TTL_SECONDS = 60;

// --- In memory ----------------------------------------------------------------------------

interface MemoryEntry {
  value: string;
  expiresAt: number;
  resourceId: string;
}

export interface MemoryCacheOptions {
  /** Hard ceiling on entries; the least recently used is evicted first. */
  maxEntries?: number;
  /** Injectable clock, so the TTL is testable without waiting. */
  now?: () => number;
}

/**
 * Process-local LRU with per-entry TTL.
 *
 * It is the default when no `REDIS_URL` is configured, and it is the unshared cache that a
 * fleet deliberately does not rely on: correct, but private to one process, so a fleet of API
 * nodes warms it N times and an invalidation issued on one node does not reach the others.
 * Single node deployments and the test suite are exactly the cases where that does not matter.
 */
export class MemoryAvailabilityCache implements AvailabilityCache {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly byResource = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.drop(key);
      return null;
    }
    // Touch: re-inserting moves the key to the end of the Map's insertion order, which is
    // the LRU order this class evicts from.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    const bucket = this.byResource.get(entry.resourceId);
    if (bucket !== undefined) {
      bucket.delete(key);
      if (bucket.size === 0) this.byResource.delete(entry.resourceId);
    }
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.read(key));
  }

  getMany(keys: readonly string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.read(key)));
  }

  put(writes: readonly CacheWrite[]): Promise<void> {
    const at = this.now();
    for (const write of writes) {
      const key = cacheKey(write.family, write.resourceId, write.day);
      this.drop(key);
      this.entries.set(key, {
        value: write.value,
        expiresAt: at + write.ttlSeconds * 1000,
        resourceId: write.resourceId,
      });
      const bucket = this.byResource.get(write.resourceId) ?? new Set<string>();
      bucket.add(key);
      this.byResource.set(write.resourceId, bucket);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
    return Promise.resolve();
  }

  invalidateResourceDay(resourceId: string, day: CacheDay): Promise<void> {
    this.drop(cacheKey('open', resourceId, day));
    this.drop(cacheKey('occ', resourceId, day));
    return Promise.resolve();
  }

  invalidateResource(resourceId: string): Promise<void> {
    for (const key of [...(this.byResource.get(resourceId) ?? [])]) this.drop(key);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.entries.clear();
    this.byResource.clear();
    return Promise.resolve();
  }
}

// --- Disabled -----------------------------------------------------------------------------

/** Always a miss, never a write. The behaviour of a deployment that opted out of caching. */
export class NoAvailabilityCache implements AvailabilityCache {
  get(_key: string): Promise<string | null> {
    return Promise.resolve(null);
  }
  getMany(keys: readonly string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map(() => null));
  }
  put(_writes: readonly CacheWrite[]): Promise<void> {
    return Promise.resolve();
  }
  invalidateResourceDay(_resourceId: string, _day: CacheDay): Promise<void> {
    return Promise.resolve();
  }
  invalidateResource(_resourceId: string): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// --- Degradation --------------------------------------------------------------------------

/** Emits at most one warning per window, so a cache outage cannot flood the log. */
export class ThrottledWarner {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly logger: Logger | undefined,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  warn(message: string, fields: Record<string, unknown>): void {
    const at = this.now();
    if (at - this.lastAt < this.windowMs) return;
    this.lastAt = at;
    this.logger?.warn(message, fields);
  }
}
