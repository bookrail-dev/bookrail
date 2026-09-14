/**
 * The arithmetic of the rate limiter, and the Lua transcription of it, against a real Redis.
 *
 * Two halves. The first drives {@link MemoryRateLimiter} from a clock the test holds, which is
 * the only way to ask what happens at a precise instant; the second drives
 * {@link RedisRateLimiter} against the server named by `TEST_REDIS_URL`, which is the only way
 * to know that the script is atomic and that `TIME` inside it behaves.
 *
 * The property the second half exists for cannot be tested any other way: twenty requests that
 * arrive together must not all be allowed, and whether they are is a property of how Redis runs
 * a script, not of anything written here.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from '@bookrail/engine';
import {
  admissionSlackMs,
  gcra,
  MemoryRateLimiter,
  RATE_LIMIT_SCRIPT,
  rateLimitKey,
  RedisRateLimiter,
} from '../src/rate-limit.js';
import { headersOf, retryAfterSeconds } from '../src/middleware/rate-limit.js';
import { DEFAULT_RATE_LIMITS, MAX_RATE_LIMIT_PRODUCT } from '../src/config.js';
import { testRedisUrl } from './redis-url.js';

const START = 1_700_000_000_000;

describe('the arithmetic, on a clock the test holds', () => {
  it('lets exactly the burst through at one instant, and refuses the next', async () => {
    const limiter = new MemoryRateLimiter();
    const decisions = [];
    for (let index = 0; index < 6; index += 1) {
      decisions.push(await limiter.check('k', 20, 5, START));
    }
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
    expect(decisions.every((d) => d.limit === 5)).toBe(true);
  });

  /**
   * `RateLimit-Limit` is a promise, and it has to be true for every rate somebody can configure.
   *
   * The tolerance is one multiplication and the theoretical arrival time is a repeated sum, so for
   * every rate whose reciprocal is not a binary fraction the sum ends a fraction of a unit in the
   * last place above the product and the last request of a burst is refused. Eighty-six of the
   * hundred and twenty rates below behaved that way before the admission test gained its slack, and
   * the two defaults (20 and 100) were not among them, which is why nothing else noticed.
   */
  it.each([
    [7, START],
    [40, START],
    // A clock far from today's, because the size of the rounding is set by the magnitude of the
    // timestamp and by nothing else: a slack written as a fixed number of milliseconds passes at
    // one epoch and fails at another, which is exactly how the first version of this got through.
    [40, START * 2],
  ])(
    'lets exactly the burst through for every rate from 1 to 120, burst %i at clock %i',
    async (burst, clock) => {
      const wrong: string[] = [];
      for (let rate = 1; rate <= 120; rate += 1) {
        const limiter = new MemoryRateLimiter();
        let accepted = 0;
        for (let index = 0; index < burst + 1; index += 1) {
          const decision = await limiter.check('k', rate, burst, clock);
          if (decision.allowed) accepted += 1;
          if (index === 0 && decision.limit !== burst)
            wrong.push(`rate=${String(rate)} wrong limit`);
          if (decision.allowed && decision.remaining !== burst - accepted) {
            wrong.push(
              `rate=${String(rate)}: remaining ${String(decision.remaining)} after ${String(accepted)} of ${String(burst)}`,
            );
          }
        }
        if (accepted !== burst) {
          wrong.push(
            `rate=${String(rate)}: ${String(accepted)} accepted, ${String(burst)} promised`,
          );
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  /**
   * The slack is a property of the clock, not a constant.
   *
   * Two neighbouring doubles near the current epoch in milliseconds are some 2.4e-4 ms apart, and
   * every addition of an interval to a timestamp rounds to one of them; the slack has to cover
   * `burst` of those roundings, so it grows with both. What it must never do is grow to anything
   * a clock can measure: a millisecond of slack would be a millisecond of free requests.
   */
  /**
   * What happens above the product `config.ts` refuses to start with.
   *
   * The relative slack grows with the burst while the emission interval shrinks with the rate, so
   * for a large enough `rate * (burst + 1)` it used to be wider than a whole interval: `burst + 1`
   * requests were admitted and `RateLimit-Remaining` came back **above** `RateLimit-Limit` on the
   * first one, which is a counter above its own ceiling. Capping it at half an interval makes both
   * impossible whatever the numbers, and these are the three products the second review measured.
   *
   * Above that regime the ceiling is no longer exact in the other direction, and that is the
   * honest thing to assert here: at `10000 / 5000` the drift of five thousand additions is larger
   * than half an interval, so **4 995** of 5 000 get through. Never more than the burst, sometimes
   * a tenth of a percent fewer, and only for configurations that cannot be deployed, which is
   * exactly why `MAX_RATE_LIMIT_PRODUCT` exists.
   */
  it.each([
    [1_000, 5_000, 5_000],
    [5_000, 1_000, 1_000],
    [10_000, 5_000, 4_995],
  ])(
    'never admits more than the burst at rate %i burst %i, a product config.ts refuses',
    async (rate, burst, expected) => {
      const limiter = new MemoryRateLimiter();
      let accepted = 0;
      let worstRemaining = 0;
      for (let index = 0; index < burst + 1; index += 1) {
        const decision = await limiter.check('k', rate, burst, START);
        if (decision.allowed) accepted += 1;
        worstRemaining = Math.max(worstRemaining, decision.remaining);
        expect(decision.limit).toBe(burst);
      }
      expect(accepted).toBeLessThanOrEqual(burst);
      expect(accepted).toBe(expected);
      // `RateLimit-Remaining` above `RateLimit-Limit` is the visible half of the same defect.
      expect(worstRemaining).toBeLessThanOrEqual(burst);
      expect(worstRemaining).toBe(burst - 1);
    },
  );

  /**
   * And inside the regime a deployment can reach, the ceiling is exact to the request.
   *
   * The three pairs on the boundary are the extremes `MAX_RATE_LIMIT_PRODUCT` allows: the highest
   * rate, the largest burst, and a middle. If the cap of half an interval were ever tightened, or
   * the product ceiling raised, this is the test that would notice.
   */
  it.each([
    [1_000, 999],
    [10_000, 99],
    [100, 9_999],
    [DEFAULT_RATE_LIMITS.test.rate, DEFAULT_RATE_LIMITS.test.burst],
    [DEFAULT_RATE_LIMITS.live.rate, DEFAULT_RATE_LIMITS.live.burst],
  ])(
    'admits exactly the burst at rate %i burst %i, which config.ts accepts',
    async (rate, burst) => {
      expect(rate * (burst + 1)).toBeLessThanOrEqual(MAX_RATE_LIMIT_PRODUCT);
      const limiter = new MemoryRateLimiter();
      let accepted = 0;
      for (let index = 0; index < burst + 1; index += 1) {
        const decision = await limiter.check('k', rate, burst, START);
        if (decision.allowed) accepted += 1;
        expect(decision.remaining).toBeLessThanOrEqual(burst);
      }
      expect(accepted).toBe(burst);
    },
  );

  it('scales the slack with the clock and the burst, and stays far below a millisecond', () => {
    expect(admissionSlackMs(START, 40) * 2).toBeCloseTo(admissionSlackMs(START * 2, 40), 9);
    expect(admissionSlackMs(START, 40)).toBeLessThan(admissionSlackMs(START, 500));
    expect(admissionSlackMs(START, 500)).toBeLessThan(0.5);
    // And it is larger than the error it exists to absorb: six additions of 1000/6 to this clock
    // land about half a thousandth of a millisecond above six times the interval.
    let summed = START;
    for (let index = 0; index < 6; index += 1) summed += 1000 / 6;
    expect(admissionSlackMs(START, 7)).toBeGreaterThan(summed - START - 1000);
  });

  it('asks for one emission interval of patience, and never less than a second', async () => {
    const limiter = new MemoryRateLimiter();
    // 20 requests a second is one every 50 ms, so the sixth request of a burst of five is 50 ms
    // early. `Retry-After` cannot say that, and rounding it down to zero would invite a retry
    // that fails again, so the header says one second.
    for (let index = 0; index < 5; index += 1) await limiter.check('k', 20, 5, START);
    const refused = await limiter.check('k', 20, 5, START);
    expect(refused.retryAfterMs).toBeCloseTo(50, 6);
    expect(retryAfterSeconds(refused.retryAfterMs)).toBe(1);
    // Five in flight at one every 50 ms is a quarter of a second to drain.
    expect(refused.resetMs).toBeCloseTo(250, 6);
    expect(headersOf(refused)).toEqual({
      'RateLimit-Limit': '5',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '1',
    });
  });

  it('gives the budget back one request at a time as the interval passes', async () => {
    const limiter = new MemoryRateLimiter();
    for (let index = 0; index < 5; index += 1) await limiter.check('k', 20, 5, START);
    // One interval later exactly one request has leaked away.
    const one = await limiter.check('k', 20, 5, START + 50);
    expect(one.allowed).toBe(true);
    expect(one.remaining).toBe(0);
    const refused = await limiter.check('k', 20, 5, START + 50);
    expect(refused.allowed).toBe(false);
    // And a quarter of a second after the last acceptance the whole burst is back.
    const empty = await limiter.check('k', 20, 5, START + 50 + 250);
    expect(empty.allowed).toBe(true);
    expect(empty.remaining).toBe(4);
  });

  it('keeps one bucket per identifier', async () => {
    const limiter = new MemoryRateLimiter();
    for (let index = 0; index < 3; index += 1) await limiter.check('one', 20, 3, START);
    expect((await limiter.check('one', 20, 3, START)).allowed).toBe(false);
    expect((await limiter.check('two', 20, 3, START)).allowed).toBe(true);
  });

  it('never refuses a caller whose last accepted request is older than the drain time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { maxLength: 40 }),
        async (rate, burst, gaps) => {
          const limiter = new MemoryRateLimiter();
          const drainMs = (burst * 1000) / rate;
          let at = START;
          let lastAllowedAt: number | null = null;
          for (const gap of gaps) {
            at += gap;
            const decision = await limiter.check('k', rate, burst, at);
            if (decision.allowed) {
              lastAllowedAt = at;
            } else {
              expect(lastAllowedAt).not.toBeNull();
              expect(at - (lastAllowedAt ?? at)).toBeLessThan(drainMs);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * The real ceiling of a leaky bucket over a window, which is not the one it is tempting to
   * assume.
   *
   * Over a window of `W` milliseconds a GCRA admits at most `burst + W / T` requests: the `burst`
   * that may be in flight when the window opens, plus one for every emission interval that
   * passes inside it. Over `burst / rate` seconds, the window a fixed counter would use, that
   * comes to `2 * burst`, spread out. What GCRA removes is the instant in which a fixed counter
   * lets `2 * burst` through at once, not the total over a window.
   */
  it('admits at most the burst plus one per interval over any window', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 60 }),
        async (rate, burst, gaps) => {
          const limiter = new MemoryRateLimiter();
          const interval = 1000 / rate;
          const accepted: number[] = [];
          let at = START;
          for (const gap of gaps) {
            at += gap;
            if ((await limiter.check('k', rate, burst, at)).allowed) accepted.push(at);
          }
          for (let from = 0; from < accepted.length; from += 1) {
            for (let to = from; to < accepted.length; to += 1) {
              const window = (accepted[to] ?? 0) - (accepted[from] ?? 0);
              const ceiling = burst + Math.floor(window / interval + 1e-9);
              expect(to - from + 1).toBeLessThanOrEqual(ceiling);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('answers the same whatever the absolute instant is', async () => {
    await fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (rate, burst, ahead, shift) => {
          const here = gcra(START + ahead, START, rate, burst);
          const there = gcra(START + shift + ahead, START + shift, rate, burst);
          expect(there.decision).toEqual(here.decision);
          expect(there.tatMs - (START + shift)).toBeCloseTo(here.tatMs - START, 6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('forgets a bucket once it has drained', async () => {
    const limiter = new MemoryRateLimiter(4);
    for (let index = 0; index < 3; index += 1)
      await limiter.check(`k${String(index)}`, 20, 1, START);
    expect(limiter.size).toBe(3);
    // The fourth check triggers the sweep, and by then the first three buckets have drained.
    await limiter.check('k3', 20, 1, START + 10_000);
    expect(limiter.size).toBe(1);
  });
});

describe('the Lua script, against a real Redis', () => {
  const url = testRedisUrl();
  const client = createRedisClient(url);
  let limiter: RedisRateLimiter;

  beforeAll(async () => {
    await client.flushdb();
    limiter = new RedisRateLimiter(client);
  });

  afterAll(async () => {
    await limiter.close();
    await client.flushdb();
    await client.quit();
  });

  it('lets the burst through, refuses the next, and says how long to wait', async () => {
    const id = 'burst';
    const decisions = [];
    for (let index = 0; index < 4; index += 1) {
      decisions.push(await limiter.check(id, 4, 3, Date.now()));
    }
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.limit)).toEqual([3, 3, 3, 3]);
    // Four a second is one every 250 ms, so the fourth request is up to 250 ms early.
    const refused = decisions[3];
    expect(refused?.retryAfterMs).toBeGreaterThan(0);
    expect(refused?.retryAfterMs).toBeLessThanOrEqual(250);
    expect(refused?.remaining).toBe(0);
  });

  it('puts an expiry on the bucket so that nothing has to sweep it', async () => {
    const id = 'expiry';
    await limiter.check(id, 2, 4, Date.now());
    const ttl = await client.pttl(rateLimitKey(id));
    // One request at two a second drains in 500 ms; Redis rounds the expiry up to the millisecond.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(500);
  });

  it('keeps one bucket per identifier', async () => {
    for (let index = 0; index < 2; index += 1) await limiter.check('left', 4, 2, Date.now());
    expect((await limiter.check('left', 4, 2, Date.now())).allowed).toBe(false);
    expect((await limiter.check('right', 4, 2, Date.now())).allowed).toBe(true);
  });

  it('lets the caller through again once the bucket has drained', async () => {
    const id = 'drain';
    // Twenty a second, burst of two: the bucket drains in a hundred milliseconds.
    for (let index = 0; index < 2; index += 1) await limiter.check(id, 20, 2, Date.now());
    const refused = await limiter.check(id, 20, 2, Date.now());
    expect(refused.allowed).toBe(false);
    // Waited against the condition the limiter itself reported, not against a guessed delay.
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(refused.resetMs) + 20));
    expect((await limiter.check(id, 20, 2, Date.now())).allowed).toBe(true);
  });

  /**
   * The reason this half of the suite exists.
   *
   * Twenty checks started in the same tick, against a bucket of five. Read, decide and write as
   * three separate commands would let several of them see the same stored value and all be
   * allowed; one script is one atomic step, so exactly five get through.
   */
  it('admits exactly the burst of twenty simultaneous requests', async () => {
    const id = 'together';
    const at = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.check(id, 1, 5, at)),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
  });

  it('reloads the script when the server has forgotten it', async () => {
    const id = 'noscript';
    expect((await limiter.check(id, 10, 2, Date.now())).allowed).toBe(true);
    await client.script('FLUSH');
    expect((await limiter.check(id, 10, 2, Date.now())).allowed).toBe(true);
    expect((await limiter.check(id, 10, 2, Date.now())).allowed).toBe(false);
  });

  /**
   * The script and {@link gcra} are the same arithmetic, checked against a bucket the test placed
   * by hand rather than against the passage of time.
   *
   * The bucket is set to a chosen distance ahead of the server's own clock, read from `TIME` a
   * fraction of a millisecond earlier, and the distances are a long way from the decision
   * boundary (one request a second, so an interval of a thousand milliseconds) so that the
   * microseconds between the two calls cannot change an answer. Comparing the two through real
   * sleeps instead would compare two clocks and one of them would always overshoot.
   */
  it('computes what the arithmetic in memory computes, from the same stored value', async () => {
    const rate = 1;
    const burst = 3;
    for (const ahead of [0, 500, 1_500, 2_500, 2_900]) {
      const id = `same-${String(ahead)}`;
      const clock = await client.time();
      const now = Number(clock[0]) * 1000 + Number(clock[1]) / 1000;
      if (ahead > 0) await client.set(rateLimitKey(id), String(now + ahead), 'PX', 60_000);
      const actual = await limiter.check(id, rate, burst, 0);
      const expected = gcra(ahead === 0 ? null : now + ahead, now, rate, burst).decision;

      expect(actual.allowed, `ahead=${String(ahead)}`).toBe(expected.allowed);
      expect(actual.limit).toBe(expected.limit);
      expect(actual.remaining, `ahead=${String(ahead)}`).toBe(expected.remaining);
      expect(actual.resetMs).toBeCloseTo(expected.resetMs, -1);
      if (!expected.allowed) expect(actual.retryAfterMs).toBeCloseTo(expected.retryAfterMs, -1);
    }
  });

  /**
   * The same ceiling, on the path production uses, asked in the only way a real server allows.
   *
   * `burst + 1` real calls would not measure the arithmetic here: at these rates an emission
   * interval is a tenth of a millisecond and five thousand round trips take a second, so what the
   * count would measure is how much the bucket drained while the test was talking. The two halves
   * are therefore asked separately, and neither depends on how long anything takes.
   */
  describe('a tolerance that stays inside one emission interval', () => {
    it.each([
      [1_000, 5_000],
      [5_000, 1_000],
      [10_000, 5_000],
    ])('never promises more than the burst at rate %i burst %i', async (rate, burst) => {
      // An empty bucket, which is where the visible half shows: the first request of a burst
      // reports `burst - 1` left, and with a slack wider than an interval it reported more than
      // `burst`, which is a counter above its own ceiling.
      const id = `ceiling-${String(rate)}-${String(burst)}`;
      await client.del(rateLimitKey(id));
      const first = await limiter.check(id, rate, burst, Date.now());
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(burst);
      expect(first.remaining).toBeLessThanOrEqual(burst);
      expect(first.remaining).toBe(burst - 1);
    });

    it('refuses the request after the burst, with a TAT the test placed', async () => {
      // Two a second, so an emission interval of half a second and a cap of a quarter: wide
      // enough that the round trip between placing the bucket and asking cannot change the
      // answer. The burst is two million, which without the cap would buy a tolerance of about
      // eight hundred milliseconds, more than a whole interval, and the request below would be
      // admitted: it would be the `burst + 1`th of the burst.
      const rate = 2;
      const burst = 2_000_000;
      const interval = 1000 / rate;
      const id = 'ceiling-capped';
      const clock = await client.time();
      const now = Number(clock[0]) * 1000 + Number(clock[1]) / 1000;
      // The TAT a bucket holds after exactly `burst` requests taken in one instant.
      await client.set(rateLimitKey(id), String(now + burst * interval), 'PX', 60_000);
      const decision = await limiter.check(id, rate, burst, Date.now());
      expect(decision.allowed).toBe(false);
      expect(decision.remaining).toBe(0);
    });
  });

  /**
   * The line the second review found unguarded: `local slack = ...` inside the script.
   *
   * It cannot be reached by counting real requests, because the script rereads the clock and the
   * time between two round trips is hundreds of times the drift of one addition, which is the
   * reviewer's own point. What can be done is to place a bucket whose distance from the clock
   * falls **inside** the tolerance and outside the bare tolerance, and see which way the script
   * decides. With the slack it is admitted; with `local slack = 0` it is refused, and this test
   * fails. Mutating that line is how the assertion was checked.
   *
   * The numbers: three a second (a rate whose reciprocal is not a binary fraction, so the TAT is
   * built the way the script builds it, by repeated addition) and a burst of two hundred thousand,
   * which is a tolerance of some eighty milliseconds against an interval of three hundred and
   * thirty. The bucket is placed forty milliseconds past the tolerance, well inside the first and
   * well beyond anything the round trip can eat.
   */
  it('forgives a bucket that sits inside the tolerance, and the tolerance comes from the script', async () => {
    const rate = 3;
    const burst = 200_000;
    const interval = 1000 / rate;
    const id = 'lua-slack';
    const clock = await client.time();
    const now = Number(clock[0]) * 1000 + Number(clock[1]) / 1000;
    let tat = now + 40;
    for (let index = 0; index < burst - 1; index += 1) tat += interval;
    await client.set(rateLimitKey(id), String(tat), 'PX', 60_000);

    const decision = await limiter.check(id, rate, burst, Date.now());
    expect(decision.allowed).toBe(true);
    // And the bucket really was past the bare tolerance: without the slack this was a refusal.
    const aheadBefore = decision.resetMs - interval;
    expect(aheadBefore).toBeGreaterThan((burst - 1) * interval);
  });

  it('uses the digest Redis itself computes for the script', async () => {
    // The limiter sends the body once and then reuses a digest it computed locally. If the two
    // ever disagreed, every call would be a `NOSCRIPT` followed by a full `EVAL`: correct, and
    // twice the work for ever. This is the assertion that would notice.
    const digest = String(await client.script('LOAD', RATE_LIMIT_SCRIPT));
    expect(digest).toBe(createHash('sha1').update(RATE_LIMIT_SCRIPT, 'utf8').digest('hex'));
  });

  it('refuses to work once closed', async () => {
    const own = new RedisRateLimiter(client);
    await own.close();
    await expect(own.check('closed', 10, 10, Date.now())).rejects.toThrow(/closed/);
  });

  it('sees the same bucket from two limiter instances', async () => {
    const other = new RedisRateLimiter(client);
    const id = 'shared';
    for (let index = 0; index < 2; index += 1) await limiter.check(id, 2, 2, Date.now());
    expect((await other.check(id, 2, 2, Date.now())).allowed).toBe(false);
  });
});
