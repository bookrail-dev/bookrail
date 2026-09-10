/**
 * Redis implementation of {@link AvailabilityCache}.
 *
 * Redis is the shared cache of a multi-node deployment: unlike the in-memory LRU it is seen by
 * every API process, so a schedule edited on one node invalidates the timeline every node had
 * cached.
 *
 * **Availability never depends on it.** Every command is wrapped: a read that fails is a
 * miss, a write that fails is dropped, and the failure is logged at most once a minute. If
 * Redis goes down the availability calculation carries on without a cache, slower but still
 * correct. The client is configured to fail fast, with one retry per command and a command
 * timeout, because a cache that hangs is worse than a cache that is missing.
 *
 * `invalidateResource` must drop every day of a resource without scanning the keyspace, so
 * each write also records its key in a per-resource Set (`avail:keys:{resource}`). The Set
 * is only an index: a stale member costs one no-op `UNLINK`, never a wrong answer.
 */
import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '@bookrail/shared';

import {
  cacheIndexKey,
  cacheKey,
  ThrottledWarner,
  type AvailabilityCache,
  type CacheDay,
  type CacheWrite,
} from './index.js';

/** Lifetime of the per-resource key index. Longer than any value it points at. */
const INDEX_TTL_SECONDS = 86_400;

export interface RedisCacheOptions {
  logger?: Logger;
  /** How often a degraded cache may complain. Default: once a minute. */
  warnWindowMs?: number;
  /** Set when this object created the client and must close it. */
  ownsClient?: boolean;
}

/** Client tuned so that an unreachable Redis costs milliseconds, not seconds. */
export function createRedisClient(url: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...overrides,
  });
  // Without a listener a connection error is an unhandled 'error' event, which takes the
  // process down. The cache is optional; its failures are not fatal.
  client.on('error', () => undefined);
  return client;
}

export class RedisAvailabilityCache implements AvailabilityCache {
  private readonly warner: ThrottledWarner;
  private readonly ownsClient: boolean;
  private closed = false;

  constructor(
    private readonly client: Redis,
    options: RedisCacheOptions = {},
  ) {
    this.warner = new ThrottledWarner(options.logger, options.warnWindowMs ?? 60_000);
    this.ownsClient = options.ownsClient ?? false;
  }

  static fromUrl(url: string, options: RedisCacheOptions = {}): RedisAvailabilityCache {
    return new RedisAvailabilityCache(createRedisClient(url), { ...options, ownsClient: true });
  }

  private async guard<T>(operation: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    if (this.closed) return fallback;
    try {
      return await fn();
    } catch (error) {
      this.warner.warn('availability_cache_degraded', {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  get(key: string): Promise<string | null> {
    return this.guard('get', () => this.client.get(key), null);
  }

  getMany(keys: readonly string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.guard(
      'getMany',
      () => this.client.mget(...keys),
      keys.map(() => null),
    );
  }

  async put(writes: readonly CacheWrite[]): Promise<void> {
    if (writes.length === 0) return;
    await this.guard(
      'put',
      async () => {
        const pipeline = this.client.pipeline();
        const touched = new Set<string>();
        for (const write of writes) {
          const key = cacheKey(write.family, write.resourceId, write.day);
          pipeline.set(key, write.value, 'EX', Math.max(1, Math.floor(write.ttlSeconds)));
          pipeline.sadd(cacheIndexKey(write.resourceId), key);
          touched.add(write.resourceId);
        }
        for (const resourceId of touched) {
          pipeline.expire(cacheIndexKey(resourceId), INDEX_TTL_SECONDS);
        }
        await pipeline.exec();
        return undefined;
      },
      undefined,
    );
  }

  async invalidateResourceDay(resourceId: string, day: CacheDay): Promise<void> {
    const keys = [cacheKey('open', resourceId, day), cacheKey('occ', resourceId, day)];
    await this.guard(
      'invalidateResourceDay',
      async () => {
        const pipeline = this.client.pipeline();
        pipeline.unlink(...keys);
        pipeline.srem(cacheIndexKey(resourceId), ...keys);
        await pipeline.exec();
        return undefined;
      },
      undefined,
    );
  }

  async invalidateResource(resourceId: string): Promise<void> {
    await this.guard(
      'invalidateResource',
      async () => {
        const index = cacheIndexKey(resourceId);
        const members = await this.client.smembers(index);
        await this.client.unlink(...members, index);
        return undefined;
      },
      undefined,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.ownsClient) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
