/**
 * How many requests each project made, counted in Redis and read once a day.
 *
 * ## Why a counter at all, and why not Postgres
 *
 * Nothing in this system knows how much it is being used. `api_keys.last_used_at` says that a
 * key was used, never how often; the access log says everything, one line per request, and
 * answering "how many requests did this project make yesterday" from it means parsing a
 * journal that rotates after fourteen days on a machine somebody has to open a shell on. The
 * daily usage digest exists precisely so that nobody has to.
 *
 * A table would make the count durable and make every request a write: one `INSERT` or one
 * `UPDATE` per request, on the path of every request, against the database that also serves
 * the booking transaction. That is the wrong trade for a number whose only reader is a message
 * sent once a day, and whose loss costs one line in one email.
 *
 * Redis is already on the path of every request (the rate limiter), the value
 * is a counter, and `HINCRBY` is the operation. The key expires after nine days, which is two
 * more than the seven the digest reports, so a digest that was missed for a day still has its
 * whole week. There is no history beyond that and deliberately no table: the retention
 * promises of the privacy notice are about people, and this counts requests.
 *
 * ## What is counted, and what is not
 *
 * Authenticated requests only, keyed by (UTC day, project, environment). A request with no API
 * key has no project to attribute it to: `GET /health`, `GET /openapi.json`, the three sign up
 * endpoints and every `401` are therefore not counted at all, and the digest says as much. The
 * key id is **not** part of the Redis key: the digest reports per project, and a per key
 * counter would multiply the key space by the number of keys for a number nobody prints.
 *
 * Three fields, because the useful question about a day is not only how many: `requests`,
 * `err4xx` (a client that is getting it wrong, which is the thing worth an email) and `err5xx`
 * (us).
 *
 * ## Failure is not an error
 *
 * The write happens **after** the response, on a promise nobody waits for, and a failure is one
 * `warn` a minute and nothing else, exactly like the degraded rate limiter. A counter that
 * could fail a request would be a counter that turned a full Redis into an outage, which is
 * the opposite of what it is for.
 */
import { createRedisClient } from '@bookrail/engine';

/**
 * How long a day's counters live. Nine days.
 *
 * The digest prints yesterday plus the six before it, so seven is the requirement and nine is
 * the requirement plus the two days a missed digest may need. Longer would be a retention
 * decision, and there is nothing here worth retaining: `usage:2026-09-13:<uuid>:test` is three
 * integers.
 */
export const USAGE_COUNTER_TTL_SECONDS = 9 * 24 * 60 * 60;

/** The prefix every key of this family carries, and what the digest scans for. */
export const USAGE_KEY_PREFIX = 'usage';

/** `usage:2026-09-13:0193…:test`. One hash of three counters. */
export function usageCounterKey(day: string, projectId: string, environment: string): string {
  return `${USAGE_KEY_PREFIX}:${day}:${projectId}:${environment}`;
}

/** The UTC day of an instant, `YYYY-MM-DD`. The digest and the counters agree on UTC. */
export function utcDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** The UTC day `n` days before `day`, which is how the seven day window is walked back. */
export function previousUtcDay(day: string, n = 1): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) - n * 24 * 60 * 60 * 1000);
}

/** Which of the three counters a response status moves, besides `requests`. */
export function errorField(status: number): 'err4xx' | 'err5xx' | null {
  if (status >= 500) return 'err5xx';
  if (status >= 400) return 'err4xx';
  return null;
}

export interface UsageCounters {
  /** What a log line and `bookrail doctor` would report: `redis`, or `off`. */
  readonly kind: 'redis' | 'off';
  /**
   * Adds one request to a project's day. Resolves when the counters have been written, and
   * rejects when they have not: the caller decides what a failure is worth, and every caller
   * there is decides it is worth one throttled `warn`.
   */
  record(day: string, projectId: string, environment: string, status: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * The deployment with no Redis: nothing is counted and nothing pretends to be.
 *
 * Not a silent no-op that looks like a working counter: the digest asks the reader side the
 * same question and prints `request counts unavailable: no Redis` rather than a zero, because
 * a zero and an absence are the two answers a daily report must never confuse.
 */
export const NO_USAGE_COUNTERS: UsageCounters = {
  kind: 'off',
  record(): Promise<void> {
    return Promise.resolve();
  },
  close(): Promise<void> {
    return Promise.resolve();
  },
};

/** The client this module drives, as the engine builds it. No direct dependency on the driver. */
export type UsageRedis = ReturnType<typeof createRedisClient>;

/**
 * How long the counter waits for Redis. Fifty milliseconds, like the rate limiter.
 *
 * This one is off the critical path, so a slow answer costs the caller nothing; the timeout is
 * here so that a Redis which has stopped answering does not leave one pending promise per
 * request in a process that is still serving.
 */
export const USAGE_COMMAND_TIMEOUT_MS = 50;

export interface RedisUsageCountersOptions {
  /** Set when this object created the client and must close it. */
  ownsClient?: boolean;
}

export class RedisUsageCounters implements UsageCounters {
  readonly kind = 'redis';
  private readonly ownsClient: boolean;
  private closed = false;

  constructor(
    private readonly client: UsageRedis,
    options: RedisUsageCountersOptions = {},
  ) {
    this.ownsClient = options.ownsClient ?? false;
  }

  static fromUrl(url: string): RedisUsageCounters {
    const client = createRedisClient(url, {
      commandTimeout: USAGE_COMMAND_TIMEOUT_MS,
      connectTimeout: USAGE_COMMAND_TIMEOUT_MS * 20,
    });
    return new RedisUsageCounters(client, { ownsClient: true });
  }

  /**
   * One round trip: two or three commands in a pipeline.
   *
   * A pipeline and not a transaction, and not a Lua script. There is nothing to make atomic:
   * `HINCRBY` is atomic on its own, the three commands touch one key, and two requests racing
   * on the same key produce the sum either way. `EXPIRE` is re-sent on every request rather
   * than only on creation, which is one command more and one round trip fewer than asking
   * whether the key is new; it is idempotent, and it means a key can never be left immortal by
   * a failure between the first `HINCRBY` and an `EXPIRE` that was sent separately.
   */
  async record(day: string, projectId: string, environment: string, status: number): Promise<void> {
    if (this.closed) return;
    const key = usageCounterKey(day, projectId, environment);
    const field = errorField(status);
    const pipeline = this.client.pipeline();
    pipeline.hincrby(key, 'requests', 1);
    if (field !== null) pipeline.hincrby(key, field, 1);
    pipeline.expire(key, USAGE_COUNTER_TTL_SECONDS);
    const replies = await pipeline.exec();
    // `exec` resolves with one [error, reply] pair per command, so a command that failed inside
    // a pipeline that arrived is not an exception. The caller only ever logs, so the first
    // failure is enough to report.
    const failed = replies?.find(([error]) => error !== null)?.[0];
    if (failed) throw failed;
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

/** Redis when a URL is configured, nothing at all otherwise. The same rule as the cache. */
export function createUsageCounters(redisUrl: string | undefined): UsageCounters {
  if (redisUrl === undefined || redisUrl === '') return NO_USAGE_COUNTERS;
  return RedisUsageCounters.fromUrl(redisUrl);
}

/**
 * A client for the reading side, or nothing when there is no Redis.
 *
 * A second client rather than the counter's own, for the same reason the rate limiter does not
 * share the cache's: the timeouts want opposite things. Writing a counter waits fifty
 * milliseconds because it is on the request path and waiting buys nothing; the digest walks the
 * keyspace once a day and would rather wait five seconds than print "unavailable" because a
 * `SCAN` took sixty milliseconds.
 */
export function createUsageRedis(url: string | undefined): UsageRedis | undefined {
  if (url === undefined || url === '') return undefined;
  return createRedisClient(url, { commandTimeout: 5_000 });
}

/** One project's day, as the digest reads it back. */
export interface UsageRow {
  projectId: string;
  environment: string;
  requests: number;
  err4xx: number;
  err5xx: number;
}

/**
 * Every project's counters, for a set of UTC days, in one pass of the keyspace.
 *
 * `SCAN` with a pattern, not an index. A day has one key per (project, environment) that made
 * a request, which is a handful today and some hundreds at a scale this product is nowhere
 * near; `SCAN` with a `COUNT` walks that in a few round trips against a keyspace whose other
 * families (`avail:*`, `rl:key:*`) are themselves small. An index would be a second thing to
 * write on the request path and a second thing to be wrong.
 *
 * **One pass for all seven days, not one per day.** `MATCH` is a filter Redis applies *after*
 * reading each key, so `usage:<one day>:*` asked seven times is seven complete walks of the
 * whole keyspace. `usage:*` asked once costs a seventh of the round trips and answers the same
 * question, because the day is written in the key and {@link parseUsageKey} reads it back.
 *
 * `SCAN` may return the same key twice (it guarantees no misses, not no duplicates), so the
 * keys are collected in a Set before they are read.
 *
 * The result has an entry for every day asked for, empty ones included: a day nobody called on
 * must read as zero and not as missing.
 */
export async function readUsageDays(
  client: UsageRedis,
  days: readonly string[],
): Promise<Map<string, UsageRow[]>> {
  const out = new Map<string, UsageRow[]>(days.map((day) => [day, []]));
  if (days.length === 0) return out;
  const wanted = new Set(days);

  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', `${USAGE_KEY_PREFIX}:*`, 'COUNT', 500);
    cursor = next;
    for (const key of batch) {
      const parsed = parseUsageKey(key);
      if (parsed !== null && wanted.has(parsed.day)) keys.add(key);
    }
  } while (cursor !== '0');

  const names = [...keys].sort();
  if (names.length === 0) return out;
  const pipeline = client.pipeline();
  for (const name of names) pipeline.hgetall(name);
  const replies = await pipeline.exec();

  names.forEach((name, index) => {
    const reply = replies?.[index];
    if (reply === undefined || reply[0] !== null) return;
    const fields = reply[1] as Record<string, string> | null;
    if (fields === null || Object.keys(fields).length === 0) return;
    const parsed = parseUsageKey(name);
    if (parsed === null) return;
    out.get(parsed.day)?.push({
      projectId: parsed.projectId,
      environment: parsed.environment,
      requests: count(fields.requests),
      err4xx: count(fields.err4xx),
      err5xx: count(fields.err5xx),
    });
  });
  return out;
}

/** One day, for a caller that wants exactly one. Thin wrapper over {@link readUsageDays}. */
export async function readUsageDay(client: UsageRedis, day: string): Promise<UsageRow[]> {
  return (await readUsageDays(client, [day])).get(day) ?? [];
}

/**
 * The (day, project, environment) a key names, or nothing.
 *
 * A key of another shape under the same prefix is skipped rather than guessed at: the digest
 * would otherwise print a row whose project column is somebody's typo.
 */
export function parseUsageKey(
  key: string,
): { day: string; projectId: string; environment: string } | null {
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== USAGE_KEY_PREFIX) return null;
  const day = parts[1];
  const projectId = parts[2];
  const environment = parts[3];
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (projectId === undefined || projectId === '') return null;
  if (environment !== 'test' && environment !== 'live') return null;
  return { day, projectId, environment };
}

function count(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
