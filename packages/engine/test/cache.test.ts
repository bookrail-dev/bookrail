/**
 * The availability cache, both implementations, through the same parametric suite.
 *
 * The Redis half runs against a real Redis on a logical database of its own; there is no
 * fake and nothing is skipped. What the two implementations must agree on is exactly what
 * the engine relies on: a miss is `null`, `getMany` preserves order, a TTL really expires, an
 * invalidation really removes, and no failure ever propagates to the caller.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import {
  cacheIndexKey,
  cacheKey,
  MemoryAvailabilityCache,
  NoAvailabilityCache,
  RedisAvailabilityCache,
  type AvailabilityCache,
  type CacheWrite,
} from '../src/index.js';
import { testRedisUrl } from './redis-url.js';

const RESOURCE_A = '018f0000-0000-7000-8000-0000000000aa';
const RESOURCE_B = '018f0000-0000-7000-8000-0000000000bb';

function write(
  resourceId: string,
  day: string,
  value: string,
  ttlSeconds = 60,
  family: 'open' | 'occ' = 'open',
): CacheWrite {
  return { family, resourceId, day, value, ttlSeconds };
}

describe('cache keys', () => {
  it('uses the documented key shape', () => {
    expect(cacheKey('open', RESOURCE_A, '2026-09-08')).toBe(`avail:open:${RESOURCE_A}:2026-09-08`);
    expect(cacheKey('occ', RESOURCE_A, '2026-09-08')).toBe(`avail:occ:${RESOURCE_A}:2026-09-08`);
    expect(cacheIndexKey(RESOURCE_A)).toBe(`avail:keys:${RESOURCE_A}`);
  });
});

const redisUrl = testRedisUrl();
let sharedRedis: Redis | null = null;

const implementations: {
  name: string;
  create: () => Promise<AvailabilityCache>;
  destroy: (cache: AvailabilityCache) => Promise<void>;
}[] = [
  {
    name: 'MemoryAvailabilityCache',
    create: () => Promise.resolve(new MemoryAvailabilityCache()),
    destroy: (cache) => cache.close(),
  },
  {
    name: 'RedisAvailabilityCache',
    create: async () => {
      sharedRedis ??= new Redis(redisUrl, { maxRetriesPerRequest: 2 });
      await sharedRedis.flushdb();
      return new RedisAvailabilityCache(sharedRedis);
    },
    destroy: () => Promise.resolve(),
  },
];

afterAll(async () => {
  if (sharedRedis !== null) {
    await sharedRedis.flushdb();
    await sharedRedis.quit();
  }
});

for (const implementation of implementations) {
  describe(implementation.name, () => {
    let cache: AvailabilityCache;

    beforeEach(async () => {
      cache = await implementation.create();
    });

    afterAll(async () => {
      await implementation.destroy(cache);
    });

    it('returns null for a key that was never written', async () => {
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
    });

    it('reads back what it wrote', async () => {
      await cache.put([write(RESOURCE_A, '2026-09-08', '{"v":2}')]);
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBe('{"v":2}');
    });

    it('getMany answers in the order it was asked, with null for the misses', async () => {
      await cache.put([
        write(RESOURCE_A, '2026-09-08', 'one'),
        write(RESOURCE_A, '2026-09-10', 'three'),
      ]);
      const values = await cache.getMany([
        cacheKey('open', RESOURCE_A, '2026-09-08'),
        cacheKey('open', RESOURCE_A, '2026-09-09'),
        cacheKey('open', RESOURCE_A, '2026-09-10'),
      ]);
      expect(values).toEqual(['one', null, 'three']);
    });

    it('getMany of nothing is nothing', async () => {
      expect(await cache.getMany([])).toEqual([]);
    });

    it('keeps the two families apart on the same day', async () => {
      await cache.put([
        write(RESOURCE_A, '2026-09-08', 'open-value', 60, 'open'),
        write(RESOURCE_A, '2026-09-08', 'occ-value', 60, 'occ'),
      ]);
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBe('open-value');
      expect(await cache.get(cacheKey('occ', RESOURCE_A, '2026-09-08'))).toBe('occ-value');
    });

    it('invalidateResourceDay drops both families of that day and nothing else', async () => {
      await cache.put([
        write(RESOURCE_A, '2026-09-08', 'a8', 60, 'open'),
        write(RESOURCE_A, '2026-09-08', 'a8occ', 60, 'occ'),
        write(RESOURCE_A, '2026-09-09', 'a9', 60, 'open'),
        write(RESOURCE_B, '2026-09-08', 'b8', 60, 'open'),
      ]);
      await cache.invalidateResourceDay(RESOURCE_A, '2026-09-08');
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
      expect(await cache.get(cacheKey('occ', RESOURCE_A, '2026-09-08'))).toBeNull();
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-09'))).toBe('a9');
      expect(await cache.get(cacheKey('open', RESOURCE_B, '2026-09-08'))).toBe('b8');
    });

    it('invalidateResource drops every day of that resource and nothing else', async () => {
      await cache.put([
        write(RESOURCE_A, '2026-09-08', 'a8', 60, 'open'),
        write(RESOURCE_A, '2026-09-09', 'a9', 60, 'occ'),
        write(RESOURCE_B, '2026-09-08', 'b8', 60, 'open'),
      ]);
      await cache.invalidateResource(RESOURCE_A);
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
      expect(await cache.get(cacheKey('occ', RESOURCE_A, '2026-09-09'))).toBeNull();
      expect(await cache.get(cacheKey('open', RESOURCE_B, '2026-09-08'))).toBe('b8');
    });

    it('invalidating a resource that was never cached is a no-op, not an error', async () => {
      await expect(cache.invalidateResource(RESOURCE_B)).resolves.toBeUndefined();
      await expect(cache.invalidateResourceDay(RESOURCE_B, '2026-01-01')).resolves.toBeUndefined();
    });

    it('a later write replaces an earlier one', async () => {
      await cache.put([write(RESOURCE_A, '2026-09-08', 'first')]);
      await cache.put([write(RESOURCE_A, '2026-09-08', 'second')]);
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBe('second');
    });

    it('honours the TTL', async () => {
      await cache.put([write(RESOURCE_A, '2026-09-08', 'short lived', 1)]);
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBe('short lived');
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
    });
  });
}

describe('MemoryAvailabilityCache specifics', () => {
  it('expires on its own clock, without waiting', async () => {
    let now = 1_000_000;
    const cache = new MemoryAvailabilityCache({ now: () => now });
    await cache.put([write(RESOURCE_A, '2026-09-08', 'value', 60)]);
    now += 59_000;
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBe('value');
    now += 2_000;
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
  });

  it('evicts the least recently used entry once full', async () => {
    const cache = new MemoryAvailabilityCache({ maxEntries: 2 });
    await cache.put([write(RESOURCE_A, '2026-09-01', 'one')]);
    await cache.put([write(RESOURCE_A, '2026-09-02', 'two')]);
    // Touching the first makes the second the least recently used.
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-01'))).toBe('one');
    await cache.put([write(RESOURCE_A, '2026-09-03', 'three')]);
    expect(cache.size).toBe(2);
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-02'))).toBeNull();
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-01'))).toBe('one');
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-03'))).toBe('three');
  });

  it('forgets the resource index when the entries go, so it cannot grow without bound', async () => {
    const cache = new MemoryAvailabilityCache({ maxEntries: 1 });
    await cache.put([write(RESOURCE_A, '2026-09-01', 'one')]);
    await cache.put([write(RESOURCE_B, '2026-09-01', 'two')]);
    expect(cache.size).toBe(1);
    await cache.invalidateResource(RESOURCE_A);
    expect(cache.size).toBe(1);
    expect(await cache.get(cacheKey('open', RESOURCE_B, '2026-09-01'))).toBe('two');
  });
});

describe('RedisAvailabilityCache when Redis is unreachable', () => {
  it('answers every read as a miss, swallows the writes, and warns once a minute', async () => {
    const warnings: { msg: string; fields: unknown }[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error: () => undefined,
      child: () => logger,
    };
    // Port 1 is never a Redis. The client is configured to fail fast, so this is quick.
    const cache = RedisAvailabilityCache.fromUrl('redis://127.0.0.1:1', {
      logger,
      warnWindowMs: 60_000,
    });
    try {
      expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
      expect(
        await cache.getMany([
          cacheKey('open', RESOURCE_A, '2026-09-08'),
          cacheKey('occ', RESOURCE_A, '2026-09-08'),
        ]),
      ).toEqual([null, null]);
      await expect(cache.put([write(RESOURCE_A, '2026-09-08', 'value')])).resolves.toBeUndefined();
      await expect(cache.invalidateResource(RESOURCE_A)).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.msg).toBe('availability_cache_degraded');
    } finally {
      await cache.close();
    }
  }, 20_000);
});

describe('NoAvailabilityCache', () => {
  it('is always a miss and never a write', async () => {
    const cache = new NoAvailabilityCache();
    await cache.put([write(RESOURCE_A, '2026-09-08', 'value')]);
    expect(await cache.get(cacheKey('open', RESOURCE_A, '2026-09-08'))).toBeNull();
    expect(await cache.getMany([cacheKey('open', RESOURCE_A, '2026-09-08')])).toEqual([null]);
  });
});
