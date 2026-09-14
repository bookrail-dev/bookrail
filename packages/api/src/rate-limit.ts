/**
 * The per key rate limiter: GCRA, one Redis key per API key, and the same arithmetic in memory.
 *
 * ## Why GCRA
 *
 * The generic cell rate algorithm is a leaky bucket written as a single timestamp, the
 * theoretical arrival time (TAT) of the next request that would be exactly on schedule. Two
 * parameters describe a policy: `rate` requests a second and `burst`, the number a caller may
 * fire in one go. From them come the two constants of the algorithm:
 *
 *   * the emission interval `T = 1000 / rate` milliseconds, the spacing of a perfectly paced
 *     caller;
 *   * the tolerance `tau = (burst - 1) * T`, how far ahead of schedule a caller may be and
 *     still be served. At `burst - 1` intervals, a caller starting from rest gets exactly
 *     `burst` requests through before the next one is refused.
 *
 * A fixed window was rejected because of its boundary: a window of `burst / rate` seconds with
 * a quota of `burst` lets `2 * burst` requests through in a single instant, `burst` at the end of
 * one window and `burst` at the start of the next. GCRA has no instant like that, which is the
 * property worth having in front of an API. What it does **not** promise, and what is easy to
 * assume it promises, is a ceiling of `burst` over a window of `burst / rate` seconds: like every
 * leaky bucket it admits `burst + rate * W` requests over a window of `W` seconds, so over
 * `burst / rate` seconds the true ceiling is `2 * burst`, spread out rather than simultaneous.
 * The property tests assert the real bound.
 *
 * A sliding window over a log of arrivals was rejected for its cost: it needs one entry per
 * request per caller, where this needs one number per caller, and it buys a precision nobody is
 * asking for.
 *
 * ## Where the clock comes from
 *
 * `check` takes `nowMs` rather than reading the clock, so the arithmetic can be driven by a fake
 * one. The Redis implementation deliberately ignores it and uses `redis.call('TIME')`, the clock
 * of the server that holds the bucket: with the instant coming from the API processes instead,
 * two of them whose clocks differ by a second would compute two different answers from the same
 * stored value, and a bucket would drain or refuse according to which process was asked.
 *
 * ## What happens when Redis is gone
 *
 * Nothing, from the caller's point of view. Every method here simply fails; the decision to let
 * the request through is taken by the middleware, which says so in a response header. A rate
 * limiter is a protection, not a correctness requirement, and an unreachable Redis turning into
 * an unreachable API would be a worse outcome than an unlimited one for the minutes it lasts.
 */
import { createHash } from 'node:crypto';
import { createRedisClient } from '@bookrail/engine';

export interface RateLimitDecision {
  allowed: boolean;
  /** The burst: the most a caller may have in flight at one instant. */
  limit: number;
  /** How many more requests would be accepted right now. An integer, never negative. */
  remaining: number;
  /** Milliseconds until `remaining` is back at `limit`, that is until the bucket is empty. */
  resetMs: number;
  /** Zero when allowed, otherwise the wait before this same request would be accepted. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** What `GET /health` reports. */
  readonly kind: 'redis' | 'memory';
  check(id: string, rate: number, burst: number, nowMs: number): Promise<RateLimitDecision>;
  close(): Promise<void>;
}

/**
 * One bucket per API key.
 *
 * A key id is a UUID, so two projects can never collide on one and the name needs no project or
 * environment prefix. No braces around the id: on a Redis Cluster they would be a hash tag, and
 * the one thing this key must not do is share a slot with anything else.
 */
export function rateLimitKey(id: string): string {
  return `rl:key:${id}`;
}

/**
 * How much slack the admission test allows, in milliseconds, for the arithmetic of the TAT.
 *
 * The tolerance is computed as one multiplication, `(burst - 1) * interval`, while the theoretical
 * arrival time is built by adding `interval` once per request **to a timestamp**. For every `rate`
 * whose reciprocal is not a binary fraction, which is every `rate` that is not of the form
 * `2^a * 5^b` (3, 6, 7, 9, 11, 12, 13, 60, 200 and most others), the repeated sum lands above the
 * product and the last request of a burst is refused. The symptom is visible where it matters
 * most: `RateLimit-Limit` says `burst` and `burst - 1` get through. Eighty-six of the first
 * hundred and twenty integer rates behave that way without this.
 *
 * The size of the error is set by the timestamp, not by the interval: a double near the current
 * epoch in milliseconds (about 1.79e12) has neighbours some 2.4e-4 ms apart, so **each** addition
 * rounds by up to half of that, and a TAT built by `burst` additions can sit that much times
 * `burst` above the exact value. A fixed millionth of a millisecond is four orders of magnitude
 * too small for it; the slack has to be relative to the clock, which is what this is:
 * `|now| * 2^-52 * (burst + 1)` is twice the worst accumulated rounding, which is 0.016 ms at the
 * test defaults and 0.2 ms at the live ones. Both are some four orders of magnitude below
 * anything a clock here can measure, so no real request is let through early.
 */
export function admissionSlackMs(nowMs: number, burst: number): number {
  return Math.abs(nowMs) * SLACK_PER_ADDITION * (burst + 1);
}

/**
 * The slack the admission test actually uses: never more than half an emission interval.
 *
 * The relative slack above grows with the burst while the interval shrinks with the rate, so past
 * a product of some `2.5e6` (`rate * (burst + 1)`, with today's clock, and the threshold falls as
 * the epoch grows) it would be wider than a whole interval and let `burst + 1` requests through
 * where `RateLimit-Limit` promises `burst`. Half an interval is a tolerance that cannot do that,
 * whatever the numbers: the `burst + 1`th request of a burst is a whole interval early, and half
 * an interval of forgiveness never reaches it. Below the threshold the cap changes nothing, which
 * is every configuration `config.ts` will start with.
 *
 * The same two lines are in the Lua script, because the two paths must decide the same way.
 */
function cappedSlackMs(nowMs: number, burst: number, interval: number): number {
  return Math.min(admissionSlackMs(nowMs, burst), interval / 2);
}

/** The relative size of one rounding of a sum, passed to the script so it is written once. */
const SLACK_PER_ADDITION = Number.EPSILON;

/**
 * The whole algorithm, in one function, over a stored TAT that may be absent or in the past.
 *
 * Returns the decision and the TAT to store. `storedTatMs` is `null` for a caller with no
 * bucket, which is the same case as a bucket whose TAT has already gone by: both mean "nothing
 * in flight", and both are answered by starting the arithmetic at `nowMs`.
 *
 * The Lua script below is a transcription of these lines, and the two are driven by the same
 * sequences in the tests.
 */
export function gcra(
  storedTatMs: number | null,
  nowMs: number,
  rate: number,
  burst: number,
): { decision: RateLimitDecision; tatMs: number } {
  const interval = 1000 / rate;
  const tolerance = (burst - 1) * interval;
  const slack = cappedSlackMs(nowMs, burst, interval);
  const tat = storedTatMs === null || storedTatMs < nowMs ? nowMs : storedTatMs;
  const ahead = tat - nowMs;

  if (ahead > tolerance + slack) {
    return {
      decision: {
        allowed: false,
        limit: burst,
        remaining: remainingFrom(ahead, interval, burst, slack),
        resetMs: Math.max(0, ahead),
        retryAfterMs: ahead - tolerance,
      },
      tatMs: tat,
    };
  }

  const aheadAfter = ahead + interval;
  return {
    decision: {
      allowed: true,
      limit: burst,
      remaining: remainingFrom(aheadAfter, interval, burst, slack),
      resetMs: Math.max(0, aheadAfter),
      retryAfterMs: 0,
    },
    tatMs: tat + interval,
  };
}

/**
 * How many whole requests are left, from how far ahead of schedule the bucket now is.
 *
 * `ahead / interval` is the number of requests in flight, and it is a whole number for every
 * sequence that starts from rest; the floor is there for the sequences that do not, where a
 * fraction of an interval has leaked away since the last arrival. Flooring is the conservative
 * direction: it never promises a request that would then be refused.
 *
 * The same slack as the admission test, divided by the interval because this side of the
 * arithmetic counts requests and not milliseconds. Without it the header would be one short for
 * every rate whose reciprocal is not a binary fraction, which is the same defect as the one the
 * admission test has, seen through the other window: `RateLimit-Remaining` would say `0` while
 * one more request was in fact about to be accepted.
 */
function remainingFrom(ahead: number, interval: number, burst: number, slackMs: number): number {
  const left = Math.floor(burst - (ahead - slackMs) / interval);
  return left < 0 ? 0 : left;
}

/**
 * The in-process limiter: a Map from key to TAT.
 *
 * It is the right answer for a single process, which is what `pnpm dev` and a self hosted
 * deployment without Redis are, and it is what the arithmetic tests run against. It is **not** a
 * fallback for a deployment with several API processes: each process would then hold a bucket of
 * its own and the effective limit would be the configured one times the number of processes.
 * That is why the factory below picks it only when no Redis is configured at all, and never
 * because a configured Redis has stopped answering.
 *
 * Entries are dropped once their TAT has gone by, since a bucket in the past is
 * indistinguishable from one that never existed. The sweep is amortised over the checks rather
 * than run on a timer: a timer would have to be stopped, and a limiter that has to be closed
 * before a process can exit is a trap in a test suite.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly kind = 'memory';
  private readonly buckets = new Map<string, number>();
  private sinceSweep = 0;

  constructor(private readonly sweepEvery = 1_000) {}

  check(id: string, rate: number, burst: number, nowMs: number): Promise<RateLimitDecision> {
    const key = rateLimitKey(id);
    const stored = this.buckets.get(key);
    const { decision, tatMs } = gcra(stored ?? null, nowMs, rate, burst);
    this.buckets.set(key, tatMs);

    this.sinceSweep += 1;
    if (this.sinceSweep >= this.sweepEvery) {
      this.sinceSweep = 0;
      for (const [name, tat] of this.buckets) {
        if (tat <= nowMs) this.buckets.delete(name);
      }
    }
    return Promise.resolve(decision);
  }

  /** How many buckets are being kept. Read by the test that proves the sweep happens. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Forget every bucket.
   *
   * Used by the tests that need each case to start from rest rather than from whatever the
   * previous one left behind: without it an assertion about a refusal is really an assertion
   * about how long the test before it took, which is the kind of test that passes for a year and
   * then fails on a busy machine.
   */
  clear(): void {
    this.buckets.clear();
  }

  close(): Promise<void> {
    this.clear();
    return Promise.resolve();
  }
}

/**
 * The Lua transcription of {@link gcra}, run with `EVALSHA`: one round trip, atomic per key.
 *
 * Lua numbers are doubles, so the slack of {@link admissionSlackMs} is needed here for exactly the
 * same reason. It is relative to the clock, and the clock here is the server's, so what is passed
 * in is the factor and the script multiplies: the arithmetic is written once, and the instant it
 * is scaled by is the same instant the decision is taken at. The same cap as `cappedSlackMs`, half
 * an emission interval, so the two paths cannot decide differently.
 *
 * On this path the slack rarely changes an answer, and the reason is worth writing down: the
 * script rereads `TIME` on every call, so the real time between two requests (tens of microseconds
 * for one round trip on loopback) already covers the drift of one addition (a quarter of a
 * microsecond). It matters where a burst is large enough for the slack to be milliseconds, and it
 * is kept for the plainer reason that two implementations of one decision must not differ.
 *
 * Atomicity matters more here than anywhere else in this service. Read, decide and write as three
 * commands would let two requests that arrive together read the same TAT and both be allowed,
 * which is precisely the case a rate limiter exists for.
 *
 * `PX` on the key is the time the bucket needs to drain, so Redis forgets a caller who stops
 * calling and nothing has to sweep. The three values come back as strings because they are
 * fractional milliseconds and a Lua number returned to Redis is truncated to an integer.
 */
export const RATE_LIMIT_SCRIPT = `
local interval = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])
local slack_factor = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = clock[1] * 1000 + clock[2] / 1000
local slack = math.min(now * slack_factor, interval / 2)
local tat = tonumber(redis.call('GET', KEYS[1]))
if tat == nil or tat < now then tat = now end
local ahead = tat - now
if ahead > tolerance + slack then
  return {0, tostring(ahead), tostring(ahead - tolerance), tostring(slack)}
end
ahead = ahead + interval
redis.call('SET', KEYS[1], tat + interval, 'PX', math.max(1, math.ceil(ahead)))
return {1, tostring(ahead), '0', tostring(slack)}
`;

/**
 * How long the limiter waits for Redis before giving up on it.
 *
 * Fifty milliseconds. The script is one `GET` and one `SET` on a server on the same machine,
 * which is tens of microseconds; anything near this number means the server is not well, and the
 * right answer then is to stop asking rather than to add the wait to every request. The
 * availability cache allows a whole second for the opposite reason: a miss there costs a
 * recomputation, so waiting is sometimes worth it. Here waiting buys nothing at all.
 */
export const RATE_LIMIT_COMMAND_TIMEOUT_MS = 50;

/** The client this limiter drives, as the engine builds it. No direct dependency on the driver. */
export type RateLimitRedis = ReturnType<typeof createRedisClient>;

export interface RedisRateLimiterOptions {
  /** Set when this object created the client and must close it. */
  ownsClient?: boolean;
}

export class RedisRateLimiter implements RateLimiter {
  readonly kind = 'redis';
  private readonly sha: string;
  private readonly ownsClient: boolean;
  private closed = false;

  constructor(
    private readonly client: RateLimitRedis,
    options: RedisRateLimiterOptions = {},
  ) {
    this.sha = createHash('sha1').update(RATE_LIMIT_SCRIPT, 'utf8').digest('hex');
    this.ownsClient = options.ownsClient ?? false;
  }

  static fromUrl(url: string): RedisRateLimiter {
    const client = createRedisClient(url, {
      commandTimeout: RATE_LIMIT_COMMAND_TIMEOUT_MS,
      connectTimeout: RATE_LIMIT_COMMAND_TIMEOUT_MS * 10,
    });
    return new RedisRateLimiter(client, { ownsClient: true });
  }

  /**
   * Runs the script, sending its text only when the server has never seen it.
   *
   * `EVALSHA` on a server that does not hold the script (a restart, a `SCRIPT FLUSH`, a replica
   * that has just been promoted) answers `NOSCRIPT`. That is a fact about the server and not an
   * error to report, so the body is sent once with `EVAL`, which both loads and runs it, and
   * every later call is an `EVALSHA` again. Every other failure propagates to the middleware,
   * which fails open.
   */
  async check(
    id: string,
    rate: number,
    burst: number,
    /** Ignored on purpose: the clock that counts is the one inside the script, on the server. */
    _nowMs: number,
  ): Promise<RateLimitDecision> {
    if (this.closed) throw new Error('The rate limiter is closed.');
    const interval = 1000 / rate;
    const tolerance = (burst - 1) * interval;
    const args = [
      rateLimitKey(id),
      String(interval),
      String(tolerance),
      String(SLACK_PER_ADDITION * (burst + 1)),
    ];

    let raw: unknown;
    try {
      raw = await this.client.evalsha(this.sha, 1, ...args);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      raw = await this.client.eval(RATE_LIMIT_SCRIPT, 1, ...args);
    }
    return readReply(raw, burst, interval);
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

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

function readReply(raw: unknown, burst: number, interval: number): RateLimitDecision {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error('The rate limit script answered something that is not its four values.');
  }
  const allowed = Number(raw[0]) === 1;
  const ahead = Number(raw[1]);
  const retryAfterMs = Number(raw[2]);
  // The slack the script used, sent back rather than recomputed here: it is scaled by the clock
  // of the server that took the decision, and this process is not that server.
  const slack = Number(raw[3]);
  if (!Number.isFinite(ahead) || !Number.isFinite(retryAfterMs) || !Number.isFinite(slack)) {
    throw new Error('The rate limit script answered a value that is not a number.');
  }
  return {
    allowed,
    limit: burst,
    remaining: remainingFrom(ahead, interval, burst, slack),
    resetMs: Math.max(0, ahead),
    retryAfterMs: allowed ? 0 : Math.max(1, retryAfterMs),
  };
}

/**
 * Redis when a URL is configured, the in-process Map otherwise.
 *
 * The same rule, and the same reason, as the availability cache: a deployment says where its
 * shared state lives by setting one variable, and a deployment that says nothing gets something
 * that works for one process.
 *
 * Nothing here takes a logger, unlike the cache factory: the one failure worth a line is the one
 * that spoiled a request, and the middleware is the only place that knows which request that was.
 */
export function createRateLimiter(redisUrl: string | undefined): RateLimiter {
  if (redisUrl === undefined || redisUrl === '') return new MemoryRateLimiter();
  return RedisRateLimiter.fromUrl(redisUrl);
}
