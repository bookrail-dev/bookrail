/**
 * The retry policy, which is the one part of this package that can book twice if it is wrong.
 *
 * Two facts hold everything up: a POST carries the **same** `Idempotency-Key` on every attempt,
 * so the API answers the stored response instead of doing the work again; and nothing is ever
 * retried after a 4xx except `429` and the two `409` codes that mean "not yet".
 */
import { describe, expect, it } from 'vitest';
import Bookrail, {
  RETRY_INITIAL_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  BookrailConflictError,
  BookrailConnectionError,
  type BookrailError,
  BookrailInternalError,
  BookrailRateLimitError,
} from '../src/index.js';
import { fake, type Outcome } from './fake.js';

const KEY = 'sk_test_0123456789abcdef';

function client(
  outcomes: Outcome[],
  options: Record<string, unknown> = {},
): {
  bookrail: Bookrail;
  network: ReturnType<typeof fake>;
} {
  const network = fake(outcomes);
  const bookrail = new Bookrail(KEY, {
    baseUrl: 'https://api.example.test',
    fetch: network.fetch,
    sleep: network.sleep,
    ...options,
  });
  return { bookrail, network };
}

function apiError(type: string, code: string): Record<string, unknown> {
  return {
    error: { type, code, message: code, doc_url: 'https://docs', request_id: 'req_1' },
  };
}

/** Every step of the ladder, before jitter. */
function nominal(attempt: number): number {
  return Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS);
}

describe('what is retried', () => {
  it('retries a 500 and returns the answer of the attempt that worked', async () => {
    const { bookrail, network } = client([
      { status: 500, body: apiError('internal', 'internal_error') },
      { status: 500, body: apiError('internal', 'internal_error') },
      { status: 200, body: { object: 'project', id: 'prj_1' } },
    ]);
    const { data, response } = await bookrail.project.retrieve().withResponse();
    expect(data).toEqual({ object: 'project', id: 'prj_1' });
    expect(network.calls).toHaveLength(3);
    expect(response.retries).toBe(2);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { bookrail, network } = client(
      [{ status: 503, body: apiError('internal', 'internal_error') }],
      { maxRetries: 3 },
    );
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailInternalError);
    expect(network.calls).toHaveLength(4);
    expect(network.sleeps).toHaveLength(3);
  });

  it('retries a 429 and a network failure, and not a caller abort', async () => {
    const { bookrail, network } = client([
      { status: 429, body: apiError('rate_limit', 'rate_limited') },
      { throw: new TypeError('fetch failed') },
      { status: 200, body: { object: 'project' } },
    ]);
    await bookrail.project.retrieve();
    expect(network.calls).toHaveLength(3);
  });

  it('retries the two 409 codes that mean “not yet”', async () => {
    for (const code of ['idempotency_key_in_progress', 'serialization_failure']) {
      const { bookrail, network } = client([
        { status: 409, body: apiError('conflict', code) },
        { status: 201, body: { object: 'booking' } },
      ]);
      await bookrail.bookings.create({ service_id: 's', start: '2026-01-01T00:00:00Z' });
      expect(network.calls, code).toHaveLength(2);
    }
  });
});

describe('what is never retried', () => {
  for (const [status, type, code] of [
    [400, 'invalid_request', 'parameter_invalid'],
    [401, 'authentication', 'invalid_api_key'],
    [403, 'permission', 'operation_not_permitted'],
    [404, 'not_found', 'resource_missing'],
    [409, 'conflict', 'slot_unavailable'],
    [422, 'policy_violation', 'invalid_transition'],
  ] as const) {
    it(`does not retry ${String(status)} ${code}`, async () => {
      const { bookrail, network } = client([{ status, body: apiError(type, code) }]);
      const error = (await bookrail.bookings
        .create({ service_id: 's', start: '2026-01-01T00:00:00Z' })
        .catch((caught: unknown) => caught)) as BookrailError;
      expect(error.code).toBe(code);
      expect(network.calls).toHaveLength(1);
      expect(network.sleeps).toHaveLength(0);
    });
  }

  it('does not retry a 409 whose code is not one of the two', async () => {
    const { bookrail, network } = client([
      { status: 409, body: apiError('conflict', 'hold_not_active') },
    ]);
    const error = (await bookrail.holds
      .release('hold_1')
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailConflictError);
    expect(network.calls).toHaveLength(1);
  });
});

describe('the same Idempotency-Key on every attempt', () => {
  it('sends one generated key, unchanged, across three attempts', async () => {
    const { bookrail, network } = client(
      [
        { status: 500, body: apiError('internal', 'internal_error') },
        { status: 500, body: apiError('internal', 'internal_error') },
        { status: 201, body: { object: 'booking', id: 'bk_1' } },
      ],
      { maxRetries: 2 },
    );
    await bookrail.bookings.create({ service_id: 's', start: '2026-01-01T00:00:00Z' });
    const keys = network.calls.map((call) => call.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the caller’s key across attempts too', async () => {
    const { bookrail, network } = client([
      { status: 503, body: apiError('internal', 'internal_error') },
      { status: 201, body: { object: 'booking' } },
    ]);
    await bookrail.bookings.create(
      { service_id: 's', start: '2026-01-01T00:00:00Z' },
      { idempotencyKey: 'order-4711' },
    );
    expect(network.calls.map((call) => call.headers['idempotency-key'])).toEqual([
      'order-4711',
      'order-4711',
    ]);
  });

  it('generates a different key for a different call', async () => {
    const { bookrail, network } = client([{ status: 201, body: { object: 'booking' } }]);
    await bookrail.bookings.create({ service_id: 's', start: '2026-01-01T00:00:00Z' });
    await bookrail.bookings.create({ service_id: 's', start: '2026-01-01T00:00:00Z' });
    expect(network.calls[0]!.headers['idempotency-key']).not.toBe(
      network.calls[1]!.headers['idempotency-key'],
    );
  });

  it('exposes Idempotent-Replayed on the retry that got the stored answer', async () => {
    const { bookrail } = client([
      { throw: new TypeError('socket hang up') },
      {
        status: 201,
        body: { object: 'booking', id: 'bk_1' },
        headers: { 'idempotent-replayed': 'true' },
      },
    ]);
    const { response } = await bookrail.bookings
      .create({ service_id: 's', start: '2026-01-01T00:00:00Z' })
      .withResponse();
    expect(response.idempotentReplayed).toBe(true);
    expect(response.retries).toBe(1);
  });
});

describe('the backoff', () => {
  it('follows 0.5 s, 1 s, 2 s, 4 s, 8 s, capped, within the jitter band', async () => {
    const { bookrail, network } = client(
      [{ status: 500, body: apiError('internal', 'internal_error') }],
      { maxRetries: 6 },
    );
    await bookrail.project.retrieve().catch(() => undefined);
    expect(network.sleeps).toHaveLength(6);
    network.sleeps.forEach((slept, attempt) => {
      const base = nominal(attempt);
      expect(slept).toBeGreaterThanOrEqual(Math.floor(base * (1 - RETRY_JITTER)));
      expect(slept).toBeLessThanOrEqual(Math.ceil(base * (1 + RETRY_JITTER)));
    });
    expect(network.sleeps[5]).toBeLessThanOrEqual(Math.ceil(RETRY_MAX_MS * (1 + RETRY_JITTER)));
  });

  it('honours Retry-After in seconds', async () => {
    const { bookrail, network } = client([
      {
        status: 429,
        body: apiError('rate_limit', 'rate_limited'),
        headers: { 'retry-after': '3' },
      },
      { status: 200, body: { object: 'project' } },
    ]);
    await bookrail.project.retrieve();
    expect(network.sleeps).toEqual([3000]);
  });

  it('honours Retry-After as an HTTP date', async () => {
    const at = new Date(Date.now() + 4_000).toUTCString();
    const { bookrail, network } = client([
      {
        status: 503,
        body: apiError('internal', 'internal_error'),
        headers: { 'retry-after': at },
      },
      { status: 200, body: { object: 'project' } },
    ]);
    await bookrail.project.retrieve();
    expect(network.sleeps).toHaveLength(1);
    expect(network.sleeps[0]).toBeGreaterThan(2_000);
    expect(network.sleeps[0]).toBeLessThanOrEqual(4_000);
  });

  it('refuses to sit through a Retry-After longer than a minute', async () => {
    const { bookrail, network } = client([
      {
        status: 429,
        body: apiError('rate_limit', 'rate_limited'),
        headers: { 'retry-after': '600' },
      },
    ]);
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailRateLimitError);
    expect(network.calls).toHaveLength(1);
    expect(network.sleeps).toHaveLength(0);
  });
});

describe('timeouts and aborts', () => {
  it('turns a timeout into a retryable connection error', async () => {
    const { bookrail, network } = client([{ hang: true }, { status: 200, body: { ok: true } }], {
      timeoutMs: 20,
    });
    const { response } = await bookrail.project.retrieve().withResponse();
    expect(response.retries).toBe(1);
    expect(network.calls).toHaveLength(2);
  });

  it('reports the timeout when every attempt times out', async () => {
    const { bookrail, network } = client([{ hang: true }], { timeoutMs: 20, maxRetries: 1 });
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailConnectionError;
    expect(error).toBeInstanceOf(BookrailConnectionError);
    expect(error.code).toBe('timeout');
    expect(error.status).toBeUndefined();
    expect(network.calls).toHaveLength(2);
  });

  it('honours a per-call timeout over the client one', async () => {
    const { bookrail } = client([{ hang: true }], { timeoutMs: 60_000, maxRetries: 0 });
    const error = (await bookrail.project
      .retrieve({ timeoutMs: 20 })
      .catch((caught: unknown) => caught)) as BookrailConnectionError;
    expect(error.code).toBe('timeout');
  });

  it('never retries an abort from the caller', async () => {
    const controller = new AbortController();
    const { bookrail, network } = client([{ hang: true }], { maxRetries: 5 });
    const promise = bookrail.project
      .retrieve({ signal: controller.signal })
      .catch((caught: unknown) => caught);
    controller.abort();
    const error = (await promise) as BookrailConnectionError;
    expect(error).toBeInstanceOf(BookrailConnectionError);
    expect(error.code).toBe('aborted');
    expect(network.calls).toHaveLength(1);
    expect(network.sleeps).toHaveLength(0);
  });

  it('refuses a call whose signal is already aborted, without touching the network', async () => {
    const { bookrail, network } = client([{ status: 200, body: {} }]);
    const error = (await bookrail.project
      .retrieve({ signal: AbortSignal.abort() })
      .catch((caught: unknown) => caught)) as BookrailConnectionError;
    expect(error.code).toBe('aborted');
    expect(network.calls).toHaveLength(0);
  });
});
