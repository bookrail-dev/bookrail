import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { createHarness, PADEL_CONFIG, type Harness, type Project } from './harness.js';

/** The `contents` of a resource read are text or binary; every one of ours is text. */
function textOf(result: ReadResourceResult): string {
  const first = result.contents[0];
  if (first === undefined || !('text' in first)) {
    throw new Error(`expected one text content, got ${JSON.stringify(result.contents)}`);
  }
  return first.text;
}

let h: Harness;
let project: Project;

beforeAll(async () => {
  h = await createHarness();
  project = await h.bootstrap('MCP Resources');
}, 120_000);

afterAll(async () => {
  await h.close();
});

describe('resources', () => {
  it('lists and reads every documentation page and every schema', async () => {
    const session = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.testKey } });

    const templates = await session.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((entry) => entry.uriTemplate).sort()).toEqual([
      'bookrail://docs/{path}',
      'bookrail://schema/{entity}',
    ]);

    const listed = await session.client.listResources();
    const uris = listed.resources.map((entry) => entry.uri);
    expect(uris).toContain('bookrail://config');
    expect(uris).toContain('bookrail://project');
    expect(uris).toContain('bookrail://docs/agents');
    expect(uris).toContain('bookrail://schema/config');

    for (const uri of uris) {
      const read = await session.client.readResource({ uri });
      const text = textOf(read);
      expect(text, uri).not.toBe('');
      expect(text.length, uri).toBeGreaterThan(20);
    }
    await session.close();
  });

  it('bookrail://config says the file is absent, then reflects an edit without a restart', async () => {
    const cwd = await h.workdir();
    const session = await h.session({ cwd, env: { BOOKRAIL_SECRET_KEY: project.testKey } });

    const empty = await session.client.readResource({ uri: 'bookrail://config' });
    expect(JSON.parse(textOf(empty)).present).toBe(false);

    await writeFile(
      join(cwd, 'bookrail.config.json'),
      JSON.stringify(PADEL_CONFIG, null, 2),
      'utf8',
    );
    const written = JSON.parse(
      textOf(await session.client.readResource({ uri: 'bookrail://config' })),
    );
    expect(written.present).toBe(true);
    expect(written.valid).toBe(true);
    expect(written.config.services.length).toBe(1);

    // The same long-lived session must see a later edit: `31` runs this server for hours.
    await writeFile(
      join(cwd, 'bookrail.config.json'),
      JSON.stringify(
        {
          ...PADEL_CONFIG,
          services: [
            ...PADEL_CONFIG.services,
            { ...PADEL_CONFIG.services[0], id: 'lesson', name: 'Lesson' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    const edited = JSON.parse(
      textOf(await session.client.readResource({ uri: 'bookrail://config' })),
    );
    expect(edited.config.services.length).toBe(2);
    await session.close();
  });

  it('bookrail://config reports an invalid file instead of throwing', async () => {
    const cwd = await h.workdir();
    await writeFile(join(cwd, 'bookrail.config.json'), '{"services":[{"id":3}]}', 'utf8');
    const session = await h.session({ cwd, env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    const body = JSON.parse(
      textOf(await session.client.readResource({ uri: 'bookrail://config' })),
    );
    expect(body.present).toBe(true);
    expect(body.valid).toBe(false);
    expect(body.error.code).toBe('invalid_config');
    expect(body.error.fix).toBeTruthy();
    await session.close();
  });

  it('bookrail://project answers with a reason when no key is configured', async () => {
    const session = await h.session({ env: {} });
    const body = JSON.parse(
      textOf(await session.client.readResource({ uri: 'bookrail://project' })),
    );
    expect(body.authenticated).toBe(false);
    expect(body.error.code).toBe('missing_api_key');
    expect(body.error.fix).toBeTruthy();
    await session.close();
  });

  it('bookrail://project names the project when there is one', async () => {
    const session = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    const body = JSON.parse(
      textOf(await session.client.readResource({ uri: 'bookrail://project' })),
    );
    expect(body.authenticated).toBe(true);
    expect(body.project.id).toBe(project.projectId);
    // The key is masked in `whoami` and must stay masked here.
    expect(String(JSON.stringify(body))).not.toContain(project.testKey);
    await session.close();
  });
});

describe('prompts', () => {
  it('offers the three workflows, each naming the tools it tells the agent to call', async () => {
    const session = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    const { prompts } = await session.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'add-bookings-to-app',
      'debug-availability',
      'model-my-vertical',
    ]);
    for (const prompt of prompts) {
      expect(prompt.description ?? '', prompt.name).not.toBe('');
    }

    const { tools } = await session.client.listTools();
    const known = new Set(tools.map((tool) => tool.name));

    const cases: [string, Record<string, string>, string[]][] = [
      [
        'add-bookings-to-app',
        { business: 'padel courts, 60 or 90 minutes', framework: 'nextjs' },
        ['bookrail_project_info', 'bookrail_config_push', 'bookrail_webhook_create'],
      ],
      [
        'model-my-vertical',
        { business: 'a hair salon with two chairs' },
        ['bookrail_examples', 'bookrail_schema', 'bookrail_config_validate'],
      ],
      [
        'debug-availability',
        { service_id: 'svc_x', expectation: 'Tuesday at 18:00 should be free' },
        ['bookrail_availability_check', 'bookrail_explain_unavailable'],
      ],
    ];

    for (const [name, args, expected] of cases) {
      const result = await session.client.getPrompt({ name, arguments: args });
      expect(result.messages.length, name).toBeGreaterThan(0);
      const text = result.messages
        .map((message) => (message.content.type === 'text' ? message.content.text : ''))
        .join('\n');
      expect(text.length, name).toBeGreaterThan(400);
      for (const tool of expected) expect(text, name).toContain(tool);
      // Every `bookrail_*` a prompt names must be a tool this server actually has.
      for (const mentioned of text.match(/bookrail_[a-z_]+/g) ?? []) {
        expect(known.has(mentioned), `${name} mentions ${mentioned}`).toBe(true);
      }
      // The arguments reach the text: a prompt that ignored them would be a static page.
      for (const value of Object.values(args)) expect(text, name).toContain(value);
    }
    await session.close();
  });

  it('reads the arguments back as optional when they are', async () => {
    const session = await h.session({ env: {} });
    const result = await session.client.getPrompt({
      name: 'debug-availability',
      arguments: {},
    });
    const text = result.messages
      .map((message) => (message.content.type === 'text' ? message.content.text : ''))
      .join('\n');
    expect(text).toContain('bookrail_objects_list');
    expect(text).toContain('Ask me what exactly I expected');
    await session.close();
  });
});

describe('the working directory', () => {
  it('is where bookrail.config.ts is found by the config tools', async () => {
    const cwd = await h.workdir();
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'bookrail.config.json'), JSON.stringify(PADEL_CONFIG), 'utf8');
    const session = await h.session({ cwd, env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    const result = await session.call<{ valid: boolean; source: string }>(
      'bookrail_config_validate',
      {},
    );
    expect(result.envelope.data?.valid).toBe(true);
    expect(result.envelope.data?.source).toContain('bookrail.config.json');
    await session.close();
  });
});
