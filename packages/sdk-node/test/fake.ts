/**
 * The injected `fetch` and `sleep` the unit tests run on.
 *
 * Only the unit tests: every integration test in this package talks to the real API over a real
 * socket. What is faked here is the network, so that a retry ladder can be asserted instead of
 * waited through, and so that a timeout can happen in a millisecond.
 */
import type { FetchLike, SleepLike } from '../src/core.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Outcome =
  | { status: number; body?: unknown; text?: string; headers?: Record<string, string> }
  /** The socket fails before any response. */
  | { throw: unknown }
  /** Never answers; resolves only when the request is aborted. */
  | { hang: true };

export interface Fake {
  fetch: FetchLike;
  sleep: SleepLike;
  calls: Call[];
  sleeps: number[];
}

function respond(outcome: Extract<Outcome, { status: number }>): Response {
  const body = outcome.text ?? (outcome.body === undefined ? '' : JSON.stringify(outcome.body));
  return new Response(body === '' ? null : body, {
    status: outcome.status,
    headers: {
      'content-type': 'application/json',
      'bookrail-request-id': 'req_fake',
      ...(outcome.headers ?? {}),
    },
  });
}

/** Answers the given outcomes in order; the last one repeats once the queue runs out. */
export function fake(outcomes: Outcome[]): Fake {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...headers },
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? { status: 200, body: {} };
    index += 1;
    if ('throw' in outcome) throw outcome.throw;
    if ('hang' in outcome) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal === null || signal === undefined) return;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    return respond(outcome);
  };

  const sleepImpl: SleepLike = async (ms) => {
    sleeps.push(ms);
  };

  return { fetch: fetchImpl, sleep: sleepImpl, calls, sleeps };
}

/** A cursored list envelope of `count` objects, in pages of `limit`. */
export function pagesOf(count: number, limit: number, prefix = 'cus'): Outcome[] {
  const outcomes: Outcome[] = [];
  for (let start = 0; start < count; start += limit) {
    const slice = Array.from({ length: Math.min(limit, count - start) }, (_unused, offset) => ({
      id: `${prefix}_${String(start + offset).padStart(4, '0')}`,
      object: prefix,
    }));
    outcomes.push({
      status: 200,
      body: { object: 'list', data: slice, has_more: start + limit < count },
    });
  }
  return outcomes;
}
