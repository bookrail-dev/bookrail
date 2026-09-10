import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type Project } from './harness.js';

/** Any ANSI escape sequence. Nothing may emit one without a terminal, and never with --json. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

/**
 * End to end against the real API: a real HTTP server, a real Postgres, real keys.
 *
 * Nothing is mocked. The one thing the harness adds is a recorder in front of the server, so
 * that "no request carries the live key without --live" can be asserted rather than argued.
 */
describe('bookrail CLI, end to end', () => {
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('CLI');
  });

  afterAll(async () => {
    await h.close();
  });

  const withKey = (extra: Record<string, string> = {}): { env: Record<string, string> } => ({
    env: { BOOKRAIL_SECRET_KEY: project.testKey, ...extra },
  });

  describe('authentication', () => {
    it('refuses to log in without a key when there is nothing to ask on', async () => {
      const result = await h.cli(['login', '--json']);
      expect(result.code).toBe(1);
      const envelope = result.json();
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('missing_input');
      expect(envelope.error?.fix).toContain('bookrail login --token');
    });

    it('reads the key from standard input when --token is a single dash', async () => {
      // A key on a command line is a key in `ps` and in a shell history file. A deployment's
      // smoke test pipes it in instead.
      const result = await h.cli(['login', '--token', '-', '--json'], {
        stdin: `${project.testKey}\n`,
      });
      expect(result.code).toBe(0);
      expect(result.json().ok).toBe(true);
      expect(result.stdout).not.toContain(project.testKey);
    });

    it('says so when --token is a dash and nothing arrives on standard input', async () => {
      const result = await h.cli(['login', '--token', '-', '--json'], { stdin: '' });
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.fix).toContain('bookrail login --token -');
    });

    it('refuses to prompt when --non-interactive is given, even on a terminal', async () => {
      const result = await h.cli(['login', '--non-interactive', '--json'], { tty: true });
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.fix).toContain('BOOKRAIL_SECRET_KEY');
    });

    it('stores the test key with mode 600 and never prints it', async () => {
      const result = await h.cli(['login', '--token', project.testKey, '--json']);
      expect(result.code).toBe(0);
      const envelope = result.json<{
        credentials_path: string;
        key: string;
        verified: boolean;
        project: { name: string } | null;
      }>();
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.verified).toBe(true);
      expect(envelope.data?.project?.name).toBe('CLI');
      expect(result.stdout).not.toContain(project.testKey);
      expect(result.stderr).not.toContain(project.testKey);

      const path = join(h.configHome, 'bookrail', 'credentials.json');
      const stats = await stat(path);
      expect((stats.mode & 0o777).toString(8)).toBe('600');
      const stored = JSON.parse(await readFile(path, 'utf8')) as { keys: { test: string } };
      expect(stored.keys.test).toBe(project.testKey);
    });

    it('reports who it is, with the key masked and the project named', async () => {
      const result = await h.cli(['whoami', '--json']);
      expect(result.code).toBe(0);
      const envelope = result.json<{
        key: string;
        environment: string;
        key_source: string;
        project: { id: string; name: string; default_timezone: string };
        api_key: { id: string; scopes: string[]; tenant_id: string | null };
      }>();
      expect(envelope.environment).toBe('test');
      expect(envelope.data?.key_source).toBe('credentials');
      expect(envelope.data?.key.startsWith('sk_test_****')).toBe(true);
      expect(result.stdout).not.toContain(project.testKey);
      // `GET /v1/project` exists, so `project` is no longer null.
      expect(envelope.data?.project.id).toBe(project.projectId);
      expect(envelope.data?.project.name).toBe('CLI');
      expect(envelope.data?.project.default_timezone).toBe('Europe/Rome');
      expect(envelope.data?.api_key.id.startsWith('key_')).toBe(true);
      expect(envelope.data?.api_key.scopes).toEqual([]);
      expect(envelope.data?.api_key.tenant_id).toBeNull();

      const human = await h.cli(['whoami']);
      expect(human.stdout).toContain('project  CLI');
    });

    it('prefers BOOKRAIL_SECRET_KEY over the stored key', async () => {
      const other = await h.bootstrap('Other');
      const result = await h.cli(['whoami', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: other.testKey },
      });
      expect(result.json<{ key_source: string }>().data?.key_source).toBe('env');
    });

    it('exits 2 with a fix when the key is invalid', async () => {
      const result = await h.cli(['whoami', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: 'sk_test_definitely_not_a_real_key' },
      });
      expect(result.code).toBe(2);
      expect(result.json().error?.code).toBe('invalid_api_key');
      expect(result.json().error?.fix).toBeDefined();
    });

    it('exits 2 when no key is configured at all', async () => {
      const result = await h.cli(['whoami', '--json'], {
        env: { XDG_CONFIG_HOME: join(h.configHome, 'empty') },
      });
      expect(result.code).toBe(2);
      expect(result.json().error?.code).toBe('missing_api_key');
    });

    it('forgets the key', async () => {
      const home = join(h.configHome, 'logout');
      await h.cli(['login', '--token', project.testKey], { env: { XDG_CONFIG_HOME: home } });
      const result = await h.cli(['logout', '--json'], { env: { XDG_CONFIG_HOME: home } });
      expect(result.code).toBe(0);
      const after = await h.cli(['whoami', '--json'], { env: { XDG_CONFIG_HOME: home } });
      expect(after.code).toBe(2);
    });
  });

  describe('the live barrier', () => {
    it('refuses a live key in the environment when --live was not given, before any request', async () => {
      const before = h.seenKeys.length;
      const result = await h.cli(['whoami', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: project.liveKey },
      });
      expect(result.code).toBe(2);
      expect(result.json().error?.code).toBe('live_key_without_live');
      expect(result.json().error?.fix).toContain('--live');
      expect(h.seenKeys.length).toBe(before);
    });

    it('refuses to store a live key without --live', async () => {
      const result = await h.cli(['login', '--token', project.liveKey, '--json']);
      expect(result.code).toBe(2);
      expect(result.json().error?.code).toBe('live_key_without_live');
    });

    it('refuses a test key when --live was given', async () => {
      const result = await h.cli(['whoami', '--live', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: project.testKey },
      });
      expect(result.code).toBe(2);
      expect(result.json().error?.code).toBe('test_key_with_live');
      expect(result.json().environment).toBe('live');
    });

    it('does reach live when --live is given, and only then', async () => {
      const result = await h.cli(['whoami', '--live', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: project.liveKey },
      });
      expect(result.code).toBe(0);
      expect(result.json().environment).toBe('live');
      expect(h.seenKeys).toContain(project.liveKey);
    });
  });

  describe('CRUD', () => {
    const ids: Record<string, string> = {};

    it('creates one object of every configuration entity', async () => {
      const location = await h.cli(
        ['locations', 'create', '--set', 'name=Club', '--set', 'timezone=Europe/Rome', '--json'],
        withKey(),
      );
      expect(location.code).toBe(0);
      ids.location = location.json<{ id: string }>().data!.id;
      expect(ids.location.startsWith('loc_')).toBe(true);

      const schedule = await h.cli(
        [
          'schedules',
          'create',
          '--data',
          JSON.stringify({
            name: 'Opening',
            timezone: 'Europe/Rome',
            rules: [{ days_of_week: [1, 2, 3], start_time: '09:00', end_time: '18:00' }],
          }),
          '--json',
        ],
        withKey(),
      );
      expect(schedule.code).toBe(0);
      ids.schedule = schedule.json<{ id: string }>().data!.id;

      const resource = await h.cli(
        [
          'resources',
          'create',
          '--set',
          'name=Court 1',
          '--set',
          'type=court',
          '--set',
          'capacity=2',
          '--set',
          `location_id=${ids.location}`,
          '--set',
          `schedule_id=${ids.schedule}`,
          '--json',
        ],
        withKey(),
      );
      expect(resource.code).toBe(0);
      const resourceBody = resource.json<{ id: string; capacity: number; type: string }>().data!;
      ids.resource = resourceBody.id;
      // `--set capacity=2` must arrive as the number 2, not as the string "2".
      expect(resourceBody.capacity).toBe(2);
      expect(resourceBody.type).toBe('court');

      const group = await h.cli(
        [
          'resource_groups',
          'create',
          '--set',
          'name=Courts',
          '--data',
          JSON.stringify({ resource_ids: [ids.resource] }),
          '--json',
        ],
        withKey(),
      );
      expect(group.code).toBe(0);
      ids.group = group.json<{ id: string }>().data!.id;

      const policy = await h.cli(
        [
          'policies',
          'create',
          '--set',
          'name=Standard',
          '--set',
          'hold_duration_seconds=900',
          '--json',
        ],
        withKey(),
      );
      expect(policy.code).toBe(0);
      ids.policy = policy.json<{ id: string }>().data!.id;

      const service = await h.cli(
        [
          'services',
          'create',
          '--data',
          JSON.stringify({
            name: 'Match',
            duration: 60,
            policy_id: ids.policy,
            requirements: [{ resource_group_id: ids.group, quantity: 1 }],
          }),
          '--json',
        ],
        withKey(),
      );
      expect(service.code).toBe(0);
      ids.service = service.json<{ id: string }>().data!.id;

      const customer = await h.cli(
        ['customers', 'create', '--set', 'email=ada@example.com', '--set', 'name=Ada', '--json'],
        withKey(),
      );
      expect(customer.code).toBe(0);
      ids.customer = customer.json<{ id: string }>().data!.id;
    });

    it('reads one back, expands it, and lists the collection', async () => {
      const got = await h.cli(
        ['services', 'get', ids.service!, '--expand', 'requirements', '--json'],
        withKey(),
      );
      expect(got.code).toBe(0);
      const service = got.json<{ requirements: { resource_group_id: string }[] }>().data!;
      expect(service.requirements[0]?.resource_group_id).toBe(ids.group);

      const list = await h.cli(['resources', 'list', '--json'], withKey());
      expect(list.code).toBe(0);
      const envelope = list.json<{ object: string; data: { id: string }[]; has_more: boolean }>();
      expect(envelope.data?.object).toBe('list');
      expect(envelope.data?.data.some((row) => row.id === ids.resource)).toBe(true);
      expect(envelope.data?.has_more).toBe(false);
    });

    it('paginates with the cursor it hands back', async () => {
      const page = await h.cli(['resources', 'list', '--limit', '1', '--json'], withKey());
      expect(page.code).toBe(0);
      expect(page.json<{ data: unknown[] }>().data?.data).toHaveLength(1);

      const all = await h.cli(['resources', 'list', '--all', '--json'], withKey());
      expect(all.json<{ data: unknown[] }>().data!.data.length).toBeGreaterThanOrEqual(1);
    });

    it('refuses a limit outside the documented range', async () => {
      const result = await h.cli(['resources', 'list', '--limit', '500', '--json'], withKey());
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('parameter_invalid');
    });

    it('updates an object', async () => {
      const result = await h.cli(
        ['resources', 'update', ids.resource!, '--set', 'name=Court One', '--json'],
        withKey(),
      );
      expect(result.code).toBe(0);
      expect(result.json<{ name: string }>().data?.name).toBe('Court One');
    });

    it('refuses to delete without --yes, and deletes with it', async () => {
      const refused = await h.cli(['customers', 'delete', ids.customer!, '--json'], withKey());
      expect(refused.code).toBe(1);
      expect(refused.json().error?.code).toBe('confirmation_required');
      expect(refused.json().error?.fix).toContain('--yes');

      const deleted = await h.cli(
        ['customers', 'delete', ids.customer!, '--yes', '--json'],
        withKey(),
      );
      expect(deleted.code).toBe(0);
      expect(deleted.json<{ deleted: boolean }>().data?.deleted).toBe(true);

      const gone = await h.cli(['customers', 'get', ids.customer!, '--json'], withKey());
      expect(gone.code).toBe(1);
      expect(gone.json().error?.code).toBe('resource_missing');
    });

    it('maps a 404 to exit 1 with a fix, and a bad body to a parameter error', async () => {
      const missing = await h.cli(['services', 'get', 'svc_00000000', '--json'], withKey());
      expect(missing.code).toBe(1);
      expect(missing.json().error?.fix).toContain('list');

      const bad = await h.cli(
        [
          'locations',
          'create',
          '--set',
          'name=Nowhere',
          '--set',
          'timezone=Mars/Olympus',
          '--json',
        ],
        withKey(),
      );
      expect(bad.code).toBe(1);
      expect(bad.json().error?.code).toBe('parameter_invalid');
      expect(bad.json().error?.param).toBe('timezone');
    });

    it('asks for a body when none was given', async () => {
      const result = await h.cli(['locations', 'create', '--json'], withKey());
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('missing_input');
      expect(result.json().error?.fix).toContain('--file');
    });

    it('reads a body from stdin', async () => {
      const result = await h.cli(['locations', 'create', '--file', '-', '--json'], {
        ...withKey(),
      });
      // The harness gives an empty stdin, which is not an object: the error names the origin.
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('invalid_body');
    });
  });

  describe('doctor', () => {
    it('is all green against a reachable API with a good key', async () => {
      const result = await h.cli(['doctor', '--json'], withKey());
      expect(result.code).toBe(0);
      const data = result.json<{
        checks: { name: string; status: string; message: string }[];
        summary: { fail: number };
      }>().data!;
      expect(data.summary.fail).toBe(0);
      const byName = Object.fromEntries(data.checks.map((check) => [check.name, check.status]));
      expect(byName.node_version).toBe('ok');
      expect(byName.credentials).toBe('ok');
      expect(byName.environment).toBe('ok');
      expect(byName.api_reachable).toBe('ok');
      expect(byName.api_version).toBe('ok');
      expect(byName.authentication).toBe('ok');
      // The "project selected" check, which needs an endpoint to ask.
      expect(byName.project).toBe('ok');
      expect(byName.project_environment).toBe('ok');
      expect(result.json<{ project: { name: string } }>().data?.project.name).toBe('CLI');
      const notChecked = data.checks.find((check) => check.name === 'not_checked');
      expect(notChecked?.message).not.toContain('project selection');
    });

    it('exits 1 and names the fix when the API is not reachable', async () => {
      const result = await h.cli(['doctor', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: project.testKey, BOOKRAIL_API_URL: 'http://127.0.0.1:1' },
      });
      expect(result.code).toBe(1);
      const data = result.json<{ checks: { name: string; status: string; fix?: string }[] }>()
        .data!;
      const check = data.checks.find((candidate) => candidate.name === 'api_reachable');
      expect(check?.status).toBe('fail');
      expect(check?.fix).toContain('BOOKRAIL_API_URL');
      expect(result.json().next_steps?.length).toBeGreaterThan(0);
    });

    it('fails the environment check on a live key without --live, and sends nothing', async () => {
      const before = h.seenKeys.length;
      const result = await h.cli(['doctor', '--json'], {
        env: { BOOKRAIL_SECRET_KEY: project.liveKey, BOOKRAIL_API_URL: 'http://127.0.0.1:1' },
      });
      expect(result.code).toBe(1);
      const data = result.json<{ checks: { name: string; status: string }[] }>().data!;
      expect(data.checks.find((check) => check.name === 'environment')?.status).toBe('fail');
      expect(h.seenKeys.length).toBe(before);
    });

    it('warns, without failing, when the credentials file is too permissive', async () => {
      const home = join(h.configHome, 'loose');
      await h.cli(['login', '--token', project.testKey], { env: { XDG_CONFIG_HOME: home } });
      const { chmod } = await import('node:fs/promises');
      await chmod(join(home, 'bookrail', 'credentials.json'), 0o644);
      const result = await h.cli(['doctor', '--json'], { env: { XDG_CONFIG_HOME: home } });
      const data = result.json<{ checks: { name: string; status: string }[] }>().data!;
      expect(data.checks.find((check) => check.name === 'credentials_permissions')?.status).toBe(
        'warn',
      );
      expect(result.code).toBe(0);
    });
  });

  describe('output conventions', () => {
    it('wraps every success in { ok, environment, data } and every failure in { ok, error }', async () => {
      const ok = await h.cli(['version', '--json']);
      expect(Object.keys(ok.json())).toEqual(expect.arrayContaining(['ok', 'environment', 'data']));
      const failure = await h.cli(['schema', 'nope', '--json']);
      expect(failure.json().ok).toBe(false);
      expect(failure.json().error?.doc_url).toContain('bookrail.dev/docs/errors#');
    });

    it('never emits an escape sequence when stdout is not a terminal', async () => {
      const results = await Promise.all([
        h.cli(['resources', 'list'], withKey()),
        h.cli(['doctor'], withKey()),
        h.cli(['schema']),
        h.cli(['whoami'], withKey()),
      ]);
      for (const result of results) {
        expect(result.stdout).not.toMatch(ANSI);
        expect(result.stderr).not.toMatch(ANSI);
      }
    });

    it('paints when stdout is a terminal, and never with --json', async () => {
      const tty = await h.cli(['doctor'], { ...withKey(), tty: true });
      expect(tty.stdout).toMatch(ANSI);
      const json = await h.cli(['doctor', '--json'], { ...withKey(), tty: true });
      expect(json.stdout).not.toMatch(ANSI);
    });

    it('declares the environment on every output, human and JSON', async () => {
      const human = await h.cli(['resources', 'list'], withKey());
      expect(human.stdout).toContain('[test]');
      expect((await h.cli(['resources', 'list', '--json'], withKey())).json().environment).toBe(
        'test',
      );
    });

    it('reports an unknown command and an unknown option as exit 1 with a fix', async () => {
      const unknownCommand = await h.cli(['nope', '--json']);
      expect(unknownCommand.code).toBe(1);
      expect(unknownCommand.json().error?.code).toBe('invalid_usage');
      expect(unknownCommand.json().error?.fix).toContain('--help');

      const unknownOption = await h.cli(['doctor', '--nope', '--json']);
      expect(unknownOption.code).toBe(1);
      expect(unknownOption.json().error?.code).toBe('invalid_usage');
    });

    it('exits 0 for --help and for --version', async () => {
      const help = await h.cli(['--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('booking infrastructure as code');
      const version = await h.cli(['--version']);
      expect(version.code).toBe(0);
    });

    it('documents, for every command, what it needs and what it returns', async () => {
      for (const command of ['login', 'init', 'push', 'pull', 'diff', 'doctor', 'whoami']) {
        const help = await h.cli([command, '--help']);
        expect(help.code).toBe(0);
        expect(help.stdout).toMatch(/Needs:|Returns:|Sub-commands:/);
      }
    });
  });

  describe('documentation and schemas', () => {
    it('lists and prints every bundled page', async () => {
      const list = await h.cli(['docs', '--json']);
      expect(list.code).toBe(0);
      const topics = list.json<{ topics: { topic: string }[] }>().data!.topics;
      expect(topics.map((topic) => topic.topic)).toEqual(
        expect.arrayContaining([
          'getting-started',
          'config',
          'entities',
          'api',
          'errors',
          'timezones',
          'agents',
        ]),
      );
      for (const { topic } of topics) {
        const page = await h.cli(['docs', topic, '--markdown', '--json']);
        expect(page.code).toBe(0);
        expect(page.json<{ markdown: string }>().data!.markdown.length).toBeGreaterThan(200);
      }
    });

    it('names the pages when asked for one that does not exist', async () => {
      const result = await h.cli(['docs', 'nope', '--json']);
      expect(result.code).toBe(1);
      expect(result.json().error?.fix).toContain('getting-started');
    });

    it('prints the JSON Schema of the config and of one collection', async () => {
      const config = await h.cli(['schema', 'config', '--json']);
      expect(config.code).toBe(0);
      expect(config.json<{ $schema: string }>().data!.$schema).toContain('json-schema.org');

      const services = await h.cli(['schema', 'services', '--json']);
      expect(services.json<{ title: string }>().data!.title).toBe('services');

      const alias = await h.cli(['schema', 'resource_groups', '--json']);
      expect(alias.json<{ title: string }>().data!.title).toBe('resourceGroups');
    });

    it('prints a complete example for every vertical, in curl and in TypeScript', async () => {
      const list = await h.cli(['examples', '--json']);
      const verticals = list.json<{ verticals: { name: string }[] }>().data!.verticals;
      expect(verticals).toHaveLength(10);
      for (const { name } of verticals) {
        const example = await h.cli(['examples', name, '--json']);
        expect(example.code).toBe(0);
        const data = example.json<{ config_file: string; calls: string }>().data!;
        expect(data.config_file).toContain('defineConfig(');
        expect(data.calls).toContain('bookrail push');
      }
      const typescript = await h.cli(['examples', 'padel', '--framework', 'nextjs', '--json']);
      expect(typescript.json<{ calls: string }>().data!.calls).toContain("from './bookrail'");
    });

    it('prints the environment variables with the key masked', async () => {
      const result = await h.cli(['env', '--json'], withKey());
      expect(result.code).toBe(0);
      expect(JSON.stringify(result.json())).not.toContain(project.testKey);
      expect(
        result.json<{ variables: { BOOKRAIL_SECRET_KEY: string } }>().data!.variables
          .BOOKRAIL_SECRET_KEY,
      ).toContain('****');
    });
  });

  describe('commands that are not in this build', () => {
    it('says why they are missing instead of failing as unknown', async () => {
      // The operational commands are here now, and so is `mcp install`; what is left are the
      // ones with no endpoint behind them at all, and each says which of the two reasons
      // applies.
      for (const name of ['logs', 'requests', 'keys', 'projects', 'dev', 'migrate', 'upgrade']) {
        const result = await h.cli([name, '--json']);
        expect(result.code, name).toBe(1);
        expect(result.json().error?.code, name).toBe('not_yet_available');
        expect(result.json().error?.fix, name).toBeDefined();
      }
    });
  });

  describe('the live environment is never touched by accident', () => {
    it('has only ever seen the live key on the invocations that asked for it', () => {
      const liveCalls = h.seenKeys.filter((key) => key.startsWith('sk_live_'));
      // The two requests of the single `whoami --live` above (one authenticated read, one
      // /health) and nothing else: every other invocation of this suite ran in test.
      expect(liveCalls.every((key) => key === project.liveKey)).toBe(true);
      expect(liveCalls).toHaveLength(2);
    });
  });
});
