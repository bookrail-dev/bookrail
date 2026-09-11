import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_API_VERSION } from '@bookrail/shared';
import {
  createHarness,
  SITE_ORIGIN,
  SITE_URL,
  WEBHOOK_SECRET_KEY,
  type BootstrappedProject,
  type Harness,
} from './harness.js';

interface ErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    doc_url: string;
    request_id: string;
  };
}

describe('error envelope and request identity', () => {
  let h: Harness;
  let project: BootstrappedProject;

  beforeAll(async () => {
    h = createHarness();
    project = await h.bootstrap('Errors project');
  });

  afterAll(async () => {
    await h.close();
  });

  it('returns the documented error shape with a request_id', async () => {
    const res = await h.call<ErrorBody>('POST', '/v1/locations', {
      token: project.testKey,
      body: { timezone: 'Europe/Rome' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request');
    expect(res.body.error.code).toBe('parameter_missing');
    expect(res.body.error.param).toBe('name');
    expect(res.body.error.doc_url).toBe('https://bookrail.dev/docs/errors#parameter_missing');
    expect(res.body.error.request_id).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('echoes the request id in the Bookrail-Request-Id header on success and on failure', async () => {
    const ok = await h.call('GET', '/v1/locations', { token: project.testKey });
    expect(ok.headers.get('Bookrail-Request-Id')).toMatch(/^req_[0-9a-f]{24}$/);

    const ko = await h.call<ErrorBody>('GET', '/v1/locations/loc_deadbeef', {
      token: project.testKey,
    });
    expect(ko.status).toBe(404);
    expect(ko.headers.get('Bookrail-Request-Id')).toBe(ko.body.error.request_id);
  });

  it('reports the API version on every response', async () => {
    const res = await h.call('GET', '/v1/locations', { token: project.testKey });
    expect(res.headers.get('Bookrail-Version')).toBe(CURRENT_API_VERSION);
  });

  it('accepts the current Bookrail-Version header', async () => {
    const res = await h.call('GET', '/v1/locations', {
      token: project.testKey,
      headers: { 'Bookrail-Version': CURRENT_API_VERSION },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown Bookrail-Version header', async () => {
    const res = await h.call<ErrorBody>('GET', '/v1/locations', {
      token: project.testKey,
      headers: { 'Bookrail-Version': '2020-01-01' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_api_version');
  });

  it('returns 404 in the same envelope for an unknown endpoint', async () => {
    const res = await h.call<ErrorBody>('GET', '/v1/nonexistent', { token: project.testKey });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe('not_found');
    expect(res.body.error.request_id).toMatch(/^req_/);
  });

  it('rejects an unparseable body', async () => {
    const response = await h.app.request('/v1/locations', {
      method: 'POST',
      headers: { authorization: `Bearer ${project.testKey}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_body');
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const res = await h.call<ErrorBody>('POST', '/v1/locations', {
      token: project.testKey,
      body: { name: 'Club', timezone: 'Europe/Rome', surprise: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request');
  });

  it('rejects an invalid time zone', async () => {
    const res = await h.call<ErrorBody>('POST', '/v1/locations', {
      token: project.testKey,
      body: { name: 'Club', timezone: 'Mars/Olympus' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe('timezone');
  });

  it('rejects an empty PATCH', async () => {
    const created = await h.call<{ id: string }>('POST', '/v1/locations', {
      token: project.testKey,
      body: { name: 'Club', timezone: 'Europe/Rome' },
    });
    const res = await h.call<ErrorBody>('PATCH', `/v1/locations/${created.body.id}`, {
      token: project.testKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed identifier with 404, not 500', async () => {
    const res = await h.call<ErrorBody>(
      'GET',
      '/v1/locations/svc_00000000000000000000000000000000',
      {
        token: project.testKey,
      },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('resource_missing');
  });

  it('rejects a bad cursor and a bad limit', async () => {
    const badCursor = await h.call<ErrorBody>('GET', '/v1/locations?starting_after=nope', {
      token: project.testKey,
    });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.param).toBe('starting_after');
    expect(badCursor.body.error.code).toBe('parameter_invalid');

    const badLimit = await h.call<ErrorBody>('GET', '/v1/locations?limit=1000', {
      token: project.testKey,
    });
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.param).toBe('limit');
  });

  it('rejects a cursor that is an identifier of the wrong object kind', async () => {
    const service = await h.call<{ id: string }>('POST', '/v1/services', {
      token: project.testKey,
      body: { name: 'Cursor probe', duration: 30 },
    });
    const res = await h.call<ErrorBody>('GET', `/v1/locations?starting_after=${service.body.id}`, {
      token: project.testKey,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('parameter_invalid');
    expect(res.body.error.param).toBe('starting_after');
    // The message says what is actually checked: the kind, not the existence.
    expect(res.body.error.message).toBe('starting_after must be a location identifier.');
  });

  it('accepts a well formed cursor for an object that does not exist', async () => {
    // Documented behaviour: the cursor is a position, not a lookup. RLS keeps a cursor from
    // another project harmless: it simply selects rows the caller cannot see anyway.
    const res = await h.call<{ object: string; data: unknown[] }>(
      'GET',
      '/v1/locations?starting_after=loc_ffffffffffffffffffffffffffffffff',
      { token: project.testKey },
    );
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data).toEqual([]);
  });

  it('rejects an unsupported expand target', async () => {
    const res = await h.call<ErrorBody>('GET', '/v1/resources?expand[]=customer', {
      token: project.testKey,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe('expand');
  });
});

describe('request logging', () => {
  it('writes one structured line per request, with no body and with the error code', async () => {
    const { createDatabase, createPool, resolveDatabaseUrls } = await import('@bookrail/db');
    const { createLogger } = await import('@bookrail/shared');
    const { NoAvailabilityCache } = await import('@bookrail/engine');
    const { createApp } = await import('../src/app.js');
    const { TEST_DB_NAME } = await import('./db-name.js');

    const lines: string[] = [];
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    const appPool = createPool({ connectionString: urls.app, max: 2 });
    const adminPool = createPool({ connectionString: urls.admin, max: 1 });
    const app = createApp({
      db: createDatabase(appPool),
      adminDb: createDatabase(adminPool),
      logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }),
      cache: new NoAvailabilityCache(),
      bootstrapToken: 'bootstrap-token-for-tests',
      webhookSecretKey: WEBHOOK_SECRET_KEY,
      mailer: undefined,
      siteUrl: SITE_URL,
      siteOrigin: SITE_ORIGIN,
    });

    try {
      await app.request('/v1/locations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Never created', timezone: 'Europe/Rome' }),
      });

      const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const request = records.find((r) => r.msg === 'request');
      expect(request).toBeDefined();
      expect(request?.method).toBe('POST');
      expect(request?.path).toBe('/v1/locations');
      expect(request?.status).toBe(401);
      expect(request?.error_code).toBe('missing_api_key');
      expect(typeof request?.duration_ms).toBe('number');
      expect(JSON.stringify(records)).not.toContain('Never created');
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  });
});
