/** The client: construction, headers, envelopes, and the mapping of errors to classes. */
import { describe, expect, it } from 'vitest';
import Bookrail, {
  API_VERSION,
  BookrailAuthenticationError,
  BookrailConflictError,
  BookrailError,
  BookrailInternalError,
  BookrailInvalidRequestError,
  BookrailNotFoundError,
  BookrailPaymentRequiredError,
  BookrailPermissionError,
  BookrailPolicyViolationError,
  BookrailRateLimitError,
  USER_AGENT,
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

describe('construction', () => {
  it('refuses a publishable key synchronously, before any request', () => {
    expect(() => new Bookrail('pk_test_abc')).toThrow(BookrailError);
    try {
      new Bookrail('pk_test_abc');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BookrailError);
      const thrown = error as BookrailError;
      expect(thrown.code).toBe('invalid_api_key');
      expect(thrown.message).toContain('sk_test_');
      expect(thrown.message).toContain('pk_test_');
    }
  });

  it('refuses an empty key with a message that says what to do', () => {
    expect(() => new Bookrail('')).toThrow(/secret key is required/);
    // @ts-expect-error the runtime check exists for JavaScript callers too.
    expect(() => new Bookrail(undefined)).toThrow(/secret key is required/);
  });

  it('derives the environment from the prefix, and nothing else', () => {
    expect(new Bookrail('sk_test_x').environment).toBe('test');
    expect(new Bookrail('sk_live_x').environment).toBe('live');
  });

  it('defaults the base URL and the API version to what the specification declares', () => {
    const bookrail = new Bookrail(KEY);
    expect(bookrail.baseUrl).toBe('https://api.bookrail.dev');
    expect(bookrail.apiVersion).toBe(API_VERSION);
    expect(new Bookrail(KEY, { baseUrl: 'http://x.test/' }).baseUrl).toBe('http://x.test');
  });
});

describe('the headers of every request', () => {
  it('sends authorization, version, actor, user agent and accept', async () => {
    const { bookrail, network } = client([{ status: 200, body: { object: 'project' } }]);
    await bookrail.project.retrieve();
    const call = network.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.example.test/v1/project');
    expect(call.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(call.headers['bookrail-version']).toBe(API_VERSION);
    expect(call.headers['bookrail-actor']).toBe('sdk');
    expect(call.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^bookrail-node\/\d+\.\d+\.\d+$/);
    expect(call.headers['accept']).toBe('application/json');
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.headers['idempotency-key']).toBeUndefined();
  });

  it('omits Bookrail-Actor when the caller passes actor: undefined explicitly', async () => {
    const { bookrail, network } = client([{ status: 200, body: { object: 'project' } }], {
      actor: undefined,
    });
    await bookrail.project.retrieve();
    expect(network.calls[0]!.headers['bookrail-actor']).toBeUndefined();
  });

  it('sends content-type and a generated Idempotency-Key on a POST', async () => {
    const { bookrail, network } = client([{ status: 201, body: { object: 'booking' } }]);
    await bookrail.bookings.create({ service_id: 'svc_1', start: '2026-09-08T07:00:00Z' });
    const call = network.calls[0]!;
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['idempotency-key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(call.body).toBe('{"service_id":"svc_1","start":"2026-09-08T07:00:00Z"}');
  });

  it('uses the caller’s Idempotency-Key when given, and extra headers last', async () => {
    const { bookrail, network } = client([{ status: 201, body: { object: 'booking' } }]);
    await bookrail.bookings.create(
      { service_id: 'svc_1', start: '2026-09-08T07:00:00Z' },
      { idempotencyKey: 'order-4711', headers: { 'X-Trace': 'abc' } },
    );
    expect(network.calls[0]!.headers['idempotency-key']).toBe('order-4711');
    expect(network.calls[0]!.headers['x-trace']).toBe('abc');
  });

  it('sends no Authorization for GET /openapi.json, which takes none', async () => {
    const { bookrail, network } = client([{ status: 200, body: { openapi: '3.1.0' } }]);
    await bookrail.openapi.retrieve();
    expect(network.calls[0]!.url).toBe('https://api.example.test/openapi.json');
    expect(network.calls[0]!.headers['authorization']).toBeUndefined();
  });
});

describe('query parameters', () => {
  it('repeats an array as name[], and adds expand[] from the request options', async () => {
    const { bookrail, network } = client([
      { status: 200, body: { object: 'list', data: [], has_more: false } },
    ]);
    await bookrail.events.list(
      { type: ['booking.created', 'booking.cancelled'], limit: 5 },
      { expand: ['customer'] },
    );
    const url = new URL(network.calls[0]!.url);
    expect(url.pathname).toBe('/v1/events');
    expect(url.searchParams.getAll('type[]')).toEqual(['booking.created', 'booking.cancelled']);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.getAll('expand[]')).toEqual(['customer']);
  });

  it('drops undefined values instead of sending the string "undefined"', async () => {
    const { bookrail, network } = client([
      { status: 200, body: { object: 'list', data: [], has_more: false } },
    ]);
    await bookrail.bookings.list({ status: undefined, limit: 2 });
    expect(new URL(network.calls[0]!.url).search).toBe('?limit=2');
  });
});

describe('the returned value', () => {
  it('is the object, and the envelope is one call away', async () => {
    const { bookrail } = client([
      {
        status: 201,
        body: { object: 'booking', id: 'bk_1' },
        headers: { 'idempotent-replayed': 'true', 'bookrail-request-id': 'req_7' },
      },
    ]);
    const call = bookrail.bookings.create({ service_id: 's', start: '2026-01-01T00:00:00Z' });
    const { data, response } = await call.withResponse();
    expect(data).toEqual({ object: 'booking', id: 'bk_1' });
    expect(response.status).toBe(201);
    expect(response.requestId).toBe('req_7');
    expect(response.idempotentReplayed).toBe(true);
    expect(response.retries).toBe(0);
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('awaits to the object itself, and supports catch and finally', async () => {
    const { bookrail } = client([{ status: 200, body: { object: 'project', id: 'prj_1' } }]);
    const project = await bookrail.project.retrieve();
    expect(project).toEqual({ object: 'project', id: 'prj_1' });

    const { bookrail: failing } = client([
      {
        status: 404,
        body: {
          error: {
            type: 'not_found',
            code: 'resource_missing',
            message: 'No such booking.',
            doc_url: 'https://x',
            request_id: 'req_1',
          },
        },
      },
    ]);
    let ran = false;
    const caught = await failing.bookings
      .retrieve('bk_missing')
      .catch((error: unknown) => error)
      .finally(() => {
        ran = true;
      });
    expect(ran).toBe(true);
    expect(caught).toBeInstanceOf(BookrailNotFoundError);
  });
});

describe('errors', () => {
  const families = [
    ['invalid_request', 400, BookrailInvalidRequestError],
    ['authentication', 401, BookrailAuthenticationError],
    ['permission', 403, BookrailPermissionError],
    ['not_found', 404, BookrailNotFoundError],
    ['conflict', 409, BookrailConflictError],
    ['rate_limit', 429, BookrailRateLimitError],
    ['policy_violation', 422, BookrailPolicyViolationError],
    ['payment_required', 402, BookrailPaymentRequiredError],
    ['internal', 500, BookrailInternalError],
  ] as const;

  for (const [type, status, constructor] of families) {
    it(`maps ${type} to ${constructor.name}, and instanceof works`, async () => {
      const { bookrail } = client(
        [
          {
            status,
            body: {
              error: {
                type,
                code: `${type}_code`,
                message: 'nope',
                param: 'service_id',
                doc_url: `https://docs/${type}`,
                request_id: 'req_9',
              },
            },
          },
        ],
        { maxRetries: 0 },
      );
      const error = await bookrail.project.retrieve().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(constructor);
      expect(error).toBeInstanceOf(BookrailError);
      expect(error).toBeInstanceOf(Error);
      const thrown = error as BookrailError;
      expect(thrown.name).toBe(constructor.name);
      expect(thrown.type).toBe(type);
      expect(thrown.code).toBe(`${type}_code`);
      expect(thrown.message).toBe('nope');
      expect(thrown.param).toBe('service_id');
      expect(thrown.docUrl).toBe(`https://docs/${type}`);
      expect(thrown.requestId).toBe('req_9');
      expect(thrown.status).toBe(status);
      expect(thrown.headers?.['content-type']).toBe('application/json');
    });
  }

  it('turns a body that is not the error envelope into an internal error with the raw text', async () => {
    const { bookrail } = client([{ status: 502, text: '<html>Bad gateway from a proxy</html>' }], {
      maxRetries: 0,
    });
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailInternalError);
    expect(error.code).toBe('unexpected_response');
    expect(error.message).toContain('Bad gateway from a proxy');
  });

  it('truncates a very long unexpected body', async () => {
    const { bookrail } = client([{ status: 500, text: 'x'.repeat(5000) }], { maxRetries: 0 });
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error.message.length).toBeLessThan(700);
    expect(error.message.endsWith('…')).toBe(true);
  });

  it('rejects a 200 whose body is not JSON', async () => {
    const { bookrail } = client([{ status: 200, text: 'not json at all' }]);
    const error = (await bookrail.project
      .retrieve()
      .catch((caught: unknown) => caught)) as BookrailError;
    expect(error).toBeInstanceOf(BookrailInternalError);
    expect(error.message).toContain('not JSON');
  });
});
