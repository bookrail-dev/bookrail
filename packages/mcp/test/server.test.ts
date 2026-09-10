import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Project } from './harness.js';

let h: Harness;
let project: Project;

beforeAll(async () => {
  h = await createHarness();
  project = await h.bootstrap('MCP Padel');
}, 120_000);

afterAll(async () => {
  await h.close();
});

function env(): Record<string, string> {
  return { BOOKRAIL_SECRET_KEY: project.testKey };
}

describe('tools/list', () => {
  it('describes every tool with a schema, an output schema and annotations', async () => {
    const session = await h.session({ env: env() });
    const { tools } = await session.client.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(30);
    for (const tool of tools) {
      expect(tool.name.startsWith('bookrail_'), tool.name).toBe(true);
      expect(tool.description ?? '', tool.name).not.toBe('');
      // Every description says what it returns and what to call next, so nothing is guessed.
      expect(tool.description ?? '', tool.name).toMatch(/Returns:/);
      expect(tool.description ?? '', tool.name).toMatch(/Next:|Next\b/);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe('boolean');
    }
    await session.close();
  });

  /**
   * Every registered tool is actually *called* somewhere in this suite.
   *
   * An earlier version of this suite registered thirty-four tools and exercised twenty-seven
   * of them; the other seven were pass-throughs, asserted only through `tools/list`, which
   * proves the schema and
   * nothing about the argv the tool builds, and a wrong flag name is precisely the bug a
   * pass-through has. The check is on the source of the test files rather than on a runtime
   * counter because vitest gives each file its own module graph, so there is no shared object
   * to count into; what it guarantees is the thing that matters: a tool cannot be added without
   * a test that calls it.
   */
  it('has no tool that no test ever calls', async () => {
    const session = await h.session({ env: env() });
    const { tools } = await session.client.listTools();
    await session.close();

    const directory = dirname(fileURLToPath(import.meta.url));
    const files = (await readdir(directory)).filter((name) => name.endsWith('.test.ts'));
    const sources = await Promise.all(files.map((name) => readFile(join(directory, name), 'utf8')));
    const suite = sources.join('\n');

    const uncalled = tools
      .map((tool) => tool.name)
      .filter((name) => !suite.includes(`'${name}'`) && !suite.includes(`"${name}"`))
      .sort();
    expect(uncalled).toEqual([]);
  });

  it('marks exactly the irreversible tools destructive, and never a read-only one', async () => {
    const session = await h.session({ env: env() });
    const { tools } = await session.client.listTools();
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();

    expect(destructive).toEqual([
      'bookrail_booking_cancel',
      'bookrail_config_push',
      'bookrail_object_delete',
      'bookrail_webhook_delete',
    ]);
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint === true) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
    }
    await session.close();
  });

  it('gives every tool that talks to the API an environment argument defaulting to test', async () => {
    const session = await h.session({ env: env() });
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      if (tool.annotations?.openWorldHint !== true) continue;
      const schema = tool.inputSchema as {
        properties?: Record<string, { default?: unknown; enum?: unknown[] }>;
      };
      const environment = schema.properties?.environment;
      expect(environment, tool.name).toBeDefined();
      expect(environment?.default, tool.name).toBe('test');
      expect(environment?.enum, tool.name).toEqual(['test', 'live']);
    }
    await session.close();
  });
});

describe('discovery tools, with no key at all', () => {
  it('searches, reads, schemas, examples and edge cases without credentials', async () => {
    // No BOOKRAIL_SECRET_KEY, no credentials file: these five must still answer.
    const session = await h.session({ env: {} });

    const search = await session.call<{ hits: { topic: string; excerpts: string[] }[] }>(
      'bookrail_docs_search',
      { query: 'daylight saving' },
    );
    expect(search.isError).toBe(false);
    expect(search.envelope.data?.hits.length).toBeGreaterThan(0);
    expect(search.envelope.data?.hits[0]?.topic).toBe('timezones');
    expect(search.envelope.data?.hits[0]?.excerpts.length).toBeGreaterThan(0);

    const page = await session.call<{ topic: string; markdown: string }>('bookrail_docs_get', {
      path: 'config',
    });
    expect(page.envelope.data?.topic).toBe('config');
    expect(page.envelope.data?.markdown.length).toBeGreaterThan(200);

    const list = await session.call<{ topics: { topic: string }[] }>('bookrail_docs_get', {});
    expect(list.envelope.data?.topics.length).toBe(7);

    const schema = await session.call<{ properties?: Record<string, unknown> }>('bookrail_schema', {
      entity: 'config',
    });
    expect(schema.isError).toBe(false);
    expect(Object.keys(schema.envelope.data?.properties ?? {})).toContain('services');

    const example = await session.call<{ vertical: string; config: { services: unknown[] } }>(
      'bookrail_examples',
      { vertical: 'padel' },
    );
    expect(example.envelope.data?.vertical).toBe('padel');
    expect(example.envelope.data?.config.services.length).toBe(1);

    const edges = await session.call<{ topics: { topic: string; markdown: string }[] }>(
      'bookrail_edge_cases',
      {},
    );
    // Six since `pricing` was added.
    expect(edges.envelope.data?.topics.length).toBe(6);
    expect(edges.envelope.data?.topics.map((topic) => topic.topic)).toContain('pricing');
    for (const topic of edges.envelope.data?.topics ?? []) {
      expect(topic.markdown.length, topic.topic).toBeGreaterThan(50);
    }
    const one = await session.call<{ topics: { topic: string }[] }>('bookrail_edge_cases', {
      topic: 'daylight-saving',
    });
    expect(one.envelope.data?.topics.map((entry) => entry.topic)).toEqual(['daylight-saving']);

    const pricing = await session.call<{ topics: { topic: string; markdown: string }[] }>(
      'bookrail_edge_cases',
      { topic: 'pricing' },
    );
    expect(pricing.envelope.data?.topics[0]?.markdown).toContain('first');

    // Nothing above needed the API.
    expect(h.seenRequests.filter((line) => line.startsWith('GET /v1'))).toEqual([]);
    await session.close();
  });

  it('reports a missing key as an error with a fix, not as an exception', async () => {
    const session = await h.session({ env: {} });
    const result = await session.call('bookrail_project_info', {});
    expect(result.isError).toBe(true);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('missing_api_key');
    expect(result.envelope.error?.fix).toContain('BOOKRAIL_TEST_SECRET_KEY');
    expect(result.envelope.error?.doc_url).toContain('http');
    await session.close();
  });
});

describe('the live barrier', () => {
  it('refuses environment "live" without BOOKRAIL_MCP_ALLOW_LIVE, and sends nothing', async () => {
    const session = await h.session({
      env: { BOOKRAIL_SECRET_KEY: project.testKey, BOOKRAIL_LIVE_SECRET_KEY: project.liveKey },
    });
    const before = h.seenKeys.length;

    for (const [name, args] of [
      ['bookrail_project_info', {}],
      ['bookrail_availability_next', { service_id: 'svc_whatever' }],
      ['bookrail_booking_list', {}],
      ['bookrail_config_pull', {}],
      ['bookrail_objects_list', { kind: 'services' }],
    ] as [string, Record<string, unknown>][]) {
      const result = await session.call(name, { ...args, environment: 'live' });
      expect(result.isError, name).toBe(true);
      expect(result.envelope.error?.code, name).toBe('live_not_allowed');
      expect(result.envelope.error?.fix, name).toContain('BOOKRAIL_MCP_ALLOW_LIVE');
      expect(result.envelope.environment, name).toBe('live');
    }

    // The barrier is before the client: not one request left, and the live key was never used.
    expect(h.seenKeys.slice(before)).toEqual([]);
    expect(h.seenKeys).not.toContain(project.liveKey);
    await session.close();
  });

  it('refuses live when it is allowed but no live key is configured', async () => {
    const session = await h.session({
      env: { BOOKRAIL_SECRET_KEY: project.testKey, BOOKRAIL_MCP_ALLOW_LIVE: '1' },
    });
    const before = h.seenKeys.length;
    const result = await session.call('bookrail_project_info', { environment: 'live' });
    expect(result.isError).toBe(true);
    expect(result.envelope.error?.code).toBe('live_key_missing');
    expect(result.envelope.error?.fix).toContain('BOOKRAIL_LIVE_SECRET_KEY');
    expect(h.seenKeys.slice(before)).toEqual([]);
    await session.close();
  });

  it('never uses a live BOOKRAIL_SECRET_KEY for a test call', async () => {
    const session = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.liveKey } });
    const before = h.seenKeys.length;
    const result = await session.call('bookrail_project_info', {});
    expect(result.isError).toBe(true);
    expect(result.envelope.error?.code).toBe('missing_api_key');
    expect(result.envelope.error?.message).toContain('test');
    expect(h.seenKeys.slice(before)).toEqual([]);
    await session.close();
  });

  it('works against live when both the flag and the key are there', async () => {
    const session = await h.session({
      env: {
        BOOKRAIL_LIVE_SECRET_KEY: project.liveKey,
        BOOKRAIL_MCP_ALLOW_LIVE: '1',
      },
    });
    const result = await session.call<{ project: { id: string } }>('bookrail_project_info', {
      environment: 'live',
    });
    expect(result.isError).toBe(false);
    expect(result.envelope.environment).toBe('live');
    expect(result.envelope.data?.project.id).toBe(project.projectId);
    expect(h.seenKeys).toContain(project.liveKey);
    await session.close();
  });
});

/**
 * `Bookrail-Actor: mcp` on every request this server makes.
 *
 * The CLI suite proves that `BOOKRAIL_ACTOR` in the environment becomes the header; this proves
 * the other half, which is the half that matters here: that **this** package puts `mcp` there,
 * and that it does so even when the user's own shell says something else. `packages/mcp/src/
 * cli.ts` sets the variable *after* spreading `workspace.env` precisely so that an ambient
 * value cannot make an agent's writes look like a human's.
 */
describe('Bookrail-Actor', () => {
  it('declares itself `mcp` on every request, whatever the ambient variable says', async () => {
    const session = await h.session({ env: { ...env(), BOOKRAIL_ACTOR: 'dashboard' } });
    const before = h.seenActors.length;
    const result = await session.call('bookrail_project_info', {});
    expect(result.isError).toBe(false);
    const actors = h.seenActors.slice(before);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every((actor) => actor === 'mcp')).toBe(true);
    await session.close();
  });
});
