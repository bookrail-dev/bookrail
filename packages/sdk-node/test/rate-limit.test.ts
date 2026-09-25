/**
 * The retry policy of this package, against the rate limit of the real API.
 *
 * `retry.test.ts` proves the policy against a scripted network: it knows what the client does
 * when it is handed a `429` with a `Retry-After`. This file answers a different question, which no
 * amount of scripting can: does the client wait the right amount and succeed against the limiter
 * the server actually runs. Nothing is mocked. `createApp` serves the requests with the GCRA
 * limiter in front of them, on a real socket, over a real Postgres.
 *
 * **No change to the retry code was needed for any of this**, which is the point of the file: the
 * client already read `Retry-After` in seconds or as an HTTP date, with a ceiling, before the
 * server had anything to put in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookrailRateLimitError } from '../src/index.js';
import { createHarness, type Harness, type Project } from './harness.js';

/** Two a second, two in one go: reached on the third immediate call. */
const RATE = 2;
const BURST = 2;

let h: Harness;
let project: Project;

beforeAll(async () => {
  h = await createHarness({ rateLimit: { rate: RATE, burst: BURST } });
  project = await h.bootstrap('sdk under a rate limit');
});

afterAll(async () => {
  await h.close();
});

describe('a client that is allowed to retry', () => {
  it('waits out the refusal and gets the answer', async () => {
    const bookrail = h.client(project.testKey);
    const started = Date.now();
    // Three calls started together against a burst of two: one of them is refused, waits the
    // `Retry-After` the server sent, and comes back with the answer rather than with an error.
    const projects = await Promise.all([
      bookrail.project.retrieve(),
      bookrail.project.retrieve(),
      bookrail.project.retrieve(),
    ]);
    expect(projects.map((p) => p.object)).toEqual(['project', 'project', 'project']);
    // The wait is the server's, not a guess: at least the one second the header asked for.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('reads the counters off an accepted response', async () => {
    // A fresh bucket: the drain time of the two calls above has passed while this file ran.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const bookrail = h.client(project.testKey);
    const { response } = await bookrail.project.retrieve().withResponse();
    expect(response.headers['ratelimit-limit']).toBe(String(BURST));
    expect(response.headers['ratelimit-remaining']).toBe(String(BURST - 1));
    expect(Number(response.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(1);
    expect(response.headers['ratelimit-policy']).toBeUndefined();
  });
});

describe('a client that is not allowed to retry', () => {
  it('throws BookrailRateLimitError with the code, the fix and the headers', async () => {
    const bookrail = h.client(project.testKey, { maxRetries: 0 });
    let caught: BookrailRateLimitError | null = null;
    // With no retries left the first refusal is final, so the budget is spent deliberately first.
    for (let attempt = 0; attempt < BURST + 2 && caught === null; attempt += 1) {
      try {
        await bookrail.project.retrieve();
      } catch (error) {
        if (!(error instanceof BookrailRateLimitError)) throw error;
        caught = error;
      }
    }

    expect(caught).toBeInstanceOf(BookrailRateLimitError);
    expect(caught?.type).toBe('rate_limit');
    expect(caught?.code).toBe('rate_limited');
    expect(caught?.status).toBe(429);
    expect(caught?.message).toBe(
      `This key may make ${String(RATE)} requests per second, with bursts of ${String(BURST)}.`,
    );
    expect(caught?.fix).toBe(
      "Wait for Retry-After, or spread the calls. A live key has the limit of its account's plan: https://bookrail.dev/docs/errors/#rate-limits",
    );
    expect(caught?.docUrl).toBe('https://bookrail.dev/docs/errors#rate_limited');
    expect(caught?.requestId).toMatch(/^req_/);
    expect(caught?.headers?.['retry-after']).toBe('1');
    expect(caught?.headers?.['ratelimit-limit']).toBe(String(BURST));
    expect(caught?.headers?.['ratelimit-remaining']).toBe('0');
    expect(caught?.headers?.['ratelimit-reset']).toBe('1');
  });
});
