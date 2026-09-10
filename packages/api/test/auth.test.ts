import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeys, withProjectContext, createDatabase } from '@bookrail/db';
import { and, eq } from 'drizzle-orm';
import { decodeId, uuidv7 } from '@bookrail/shared';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';

describe('authentication', () => {
  let h: Harness;
  let project: BootstrappedProject;

  beforeAll(async () => {
    h = createHarness();
    project = await h.bootstrap('Auth project');
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects a request without an Authorization header', async () => {
    const res = await h.call('GET', '/v1/locations');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: { type: 'authentication', code: 'missing_api_key' },
    });
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await h.call('GET', '/v1/locations', { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'invalid_authorization_header',
    );
  });

  it('rejects a syntactically wrong key', async () => {
    const res = await h.call('GET', '/v1/locations', { token: 'not-a-key' });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('rejects an unknown but well formed key', async () => {
    const res = await h.call('GET', '/v1/locations', {
      token: `sk_test_${'A'.repeat(43)}`,
    });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('accepts a valid key and records last_used_at', async () => {
    const res = await h.call('GET', '/v1/locations', { token: project.testKey });
    expect(res.status).toBe(200);

    const db = createDatabase(h.pools.app);
    const projectId = decodeId('project', project.projectId);
    expect(projectId).not.toBeNull();
    const keyId = decodeId('api_key', project.apiKeyIds[0] ?? '');
    expect(keyId).not.toBeNull();

    const rows = await withProjectContext(
      db,
      { projectId: projectId as string, environment: 'test' },
      (tx) =>
        tx
          .select({ lastUsedAt: apiKeys.lastUsedAt })
          .from(apiKeys)
          .where(eq(apiKeys.id, keyId as string)),
    );
    expect(rows[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects a revoked key with 401', async () => {
    const revoked = await h.bootstrap('Revoked project');
    const projectId = decodeId('project', revoked.projectId) as string;

    // Revoking a key is a control plane operation: the application role has SELECT on
    // api_keys and UPDATE on last_used_at only, so this has to go through the admin
    // connection. Attempting it as the application role is asserted below.
    const adminDb = createDatabase(h.pools.admin);
    await adminDb
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.environment, 'live')));

    const res = await h.call('GET', '/v1/locations', { token: revoked.liveKey });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('revoked_api_key');

    // The test key of the same project still works.
    const ok = await h.call('GET', '/v1/locations', { token: revoked.testKey });
    expect(ok.status).toBe(200);
  });

  it('keeps test and live data apart for the two keys of one project', async () => {
    const created = await h.call<{ id: string }>('POST', '/v1/locations', {
      token: project.testKey,
      body: { name: 'Test-only club', timezone: 'Europe/Rome' },
    });
    expect(created.status).toBe(201);

    const fromLive = await h.call('GET', `/v1/locations/${created.body.id}`, {
      token: project.liveKey,
    });
    expect(fromLive.status).toBe(404);

    const liveList = await h.call<{ data: unknown[] }>('GET', '/v1/locations', {
      token: project.liveKey,
    });
    expect(liveList.body.data).toHaveLength(0);

    const testList = await h.call<{ data: unknown[] }>('GET', '/v1/locations', {
      token: project.testKey,
    });
    expect(testList.body.data.length).toBeGreaterThan(0);
  });

  it('cannot mint or revoke keys with the application role', async () => {
    const db = createDatabase(h.pools.app);
    const projectId = decodeId('project', project.projectId) as string;

    await expect(
      withProjectContext(db, { projectId, environment: 'test' }, (tx) =>
        tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.projectId, projectId)),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withProjectContext(db, { projectId, environment: 'test' }, (tx) =>
        tx.insert(apiKeys).values({
          id: uuidv7(),
          projectId,
          environment: 'test',
          prefix: 'ffffffff',
          keyHash: 'f'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a publishable key on the server API', async () => {
    // Publishable keys are in the model but their reduced permissions are not built yet, so a
    // pk_ token must not authenticate at all rather than authenticate with full powers.
    const asPublishable = project.testKey.replace(/^sk_/, 'pk_');
    const res = await h.call('GET', '/v1/locations', { token: asPublishable });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('never exposes objects of another project, even with a valid id', async () => {
    const other = await h.bootstrap('Other project');
    const created = await h.call<{ id: string }>('POST', '/v1/locations', {
      token: other.testKey,
      body: { name: 'Their club', timezone: 'Europe/Rome' },
    });
    expect(created.status).toBe(201);

    const stolen = await h.call('GET', `/v1/locations/${created.body.id}`, {
      token: project.testKey,
    });
    expect(stolen.status).toBe(404);

    const patched = await h.call('PATCH', `/v1/locations/${created.body.id}`, {
      token: project.testKey,
      body: { name: 'Hijacked' },
    });
    expect(patched.status).toBe(404);

    const deleted = await h.call('DELETE', `/v1/locations/${created.body.id}`, {
      token: project.testKey,
    });
    expect(deleted.status).toBe(404);

    // Still intact for its owner.
    const owner = await h.call<{ name: string }>('GET', `/v1/locations/${created.body.id}`, {
      token: other.testKey,
    });
    expect(owner.status).toBe(200);
    expect(owner.body.name).toBe('Their club');
  });
});

describe('bootstrap endpoint', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('requires the bootstrap token', async () => {
    const res = await h.call('POST', '/internal/bootstrap', {
      body: { account_name: 'X', project_name: 'X' },
    });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_bootstrap_token');
  });

  it('rejects a wrong bootstrap token', async () => {
    const res = await h.call('POST', '/internal/bootstrap', {
      token: 'wrong-token-of-the-same-length!',
      body: { account_name: 'X', project_name: 'X' },
    });
    expect(res.status).toBe(401);
  });

  it('returns one secret key per environment, once', async () => {
    const res = await h.call<{ secrets: { test: string; live: string } }>(
      'POST',
      '/internal/bootstrap',
      {
        token: 'bootstrap-token-for-tests',
        body: { account_name: 'Keys', project_name: 'Keys' },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.secrets.test.startsWith('sk_test_')).toBe(true);
    expect(res.body.secrets.live.startsWith('sk_live_')).toBe(true);
    expect(res.body.secrets.test).not.toBe(res.body.secrets.live);
  });
});
