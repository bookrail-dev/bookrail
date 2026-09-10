import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_API_VERSION } from '@bookrail/shared';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';

interface ProjectBody {
  id: string;
  object: string;
  name: string;
  environment: string;
  api_version: string;
  default_timezone: string;
  default_currency: string;
  api_key: {
    id: string;
    object: string;
    kind: string;
    environment: string;
    scopes: string[];
    tenant_id: string | null;
  };
  created_at: string;
}

describe('GET /v1/project', () => {
  let h: Harness;
  let p: BootstrappedProject;

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap('Project route');
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers with the project of the calling key and the key itself', async () => {
    const res = await h.call<ProjectBody>('GET', '/v1/project', { token: p.testKey });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('project');
    expect(res.body.id).toBe(p.projectId);
    expect(res.body.name).toBe('Project route');
    expect(res.body.environment).toBe('test');
    expect(res.body.api_version).toBe(CURRENT_API_VERSION);
    expect(res.body.default_timezone).toBe('Europe/Rome');
    expect(res.body.default_currency).toBe('EUR');
    expect(res.body.api_key.object).toBe('api_key');
    expect(p.apiKeyIds).toContain(res.body.api_key.id);
    expect(res.body.api_key.kind).toBe('secret');
    expect(res.body.api_key.environment).toBe('test');
    expect(res.body.api_key.scopes).toEqual([]);
    expect(res.body.api_key.tenant_id).toBeNull();
  });

  it('reports the environment of the key that called, not a default', async () => {
    const res = await h.call<ProjectBody>('GET', '/v1/project', { token: p.liveKey });
    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('live');
    expect(res.body.api_key.environment).toBe('live');
    // The same project, seen through the other environment's key.
    expect(res.body.id).toBe(p.projectId);
  });

  it('never leaks anything about another project', async () => {
    const other = await h.bootstrap('Someone else');
    const res = await h.call<ProjectBody>('GET', '/v1/project', { token: other.testKey });
    expect(res.body.id).toBe(other.projectId);
    expect(res.body.id).not.toBe(p.projectId);
    expect(res.body.name).toBe('Someone else');
  });

  it('requires a key', async () => {
    const res = await h.call('GET', '/v1/project');
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('missing_api_key');
  });

  it('carries no secret material', async () => {
    const res = await h.call<ProjectBody>('GET', '/v1/project', { token: p.testKey });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(p.testKey);
    expect(text).not.toContain(p.liveKey);
    expect(text).not.toContain('sk_');
    expect(text).not.toContain('prefix');
    expect(text).not.toContain('key_hash');
  });

  it('has no plural form and no id in the path', async () => {
    const plural = await h.call('GET', '/v1/projects', { token: p.testKey });
    expect(plural.status).toBe(404);
    const byId = await h.call('GET', `/v1/project/${p.projectId}`, { token: p.testKey });
    expect(byId.status).toBe(404);
  });
});
