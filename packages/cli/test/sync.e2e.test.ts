import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATES, TEMPLATE_NAMES } from '../src/templates/index.js';
import { renderConfigFile } from '../src/render.js';
import { createHarness, type CliResult, type Harness, type Project } from './harness.js';

interface PlanItem {
  kind: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  config_id: string;
  remote_id: string | null;
  changes: string[];
}

interface PlanPayload {
  config: string;
  applied: boolean;
  plan: PlanItem[];
  counts: Record<string, number>;
  unmanaged: { kind: string; id: string }[];
  has_changes?: boolean;
}

/**
 * `init` -> `push --dry-run` -> `push` -> `diff`, against the real API.
 *
 * The property that matters is the last one: after a push, `diff` must be empty. It is the
 * only check that proves the canonical form used to build the plan and the body actually sent
 * describe the same object; every field where they disagree shows up as a permanent
 * difference, and there is nowhere for one to hide.
 */
describe('configuration as code, end to end', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function projectIn(name: string): Promise<{ project: Project; cwd: string }> {
    const project = await h.bootstrap(name);
    const cwd = await h.workdir();
    return { project, cwd };
  }

  function run(project: Project, cwd: string, args: string[]): Promise<CliResult> {
    return h.cli(args, { cwd, env: { BOOKRAIL_SECRET_KEY: project.testKey } });
  }

  /**
   * Writes a configuration file from a value rather than from a text edit of a generated one,
   * in a **new** working directory.
   *
   * Two reasons for the directory. Editing the rendered file with a regular expression is how
   * a test starts asserting the shape of the renderer instead of the behaviour of the push.
   * And the second load has to be a different path: this suite runs many invocations inside
   * one process, and Vite's module graph (unlike Node's ESM loader, which honours the cache
   * busting query `loadConfig` appends) caches a `.ts` module by path alone, so re-importing
   * the same file in-process would hand back the first version. The `bookrail` binary is a
   * fresh process per invocation, so this is a property of the test runner, not of the CLI.
   */
  async function writeConfigIn(config: unknown): Promise<string> {
    const cwd = await h.workdir();
    await writeFile(join(cwd, 'bookrail.config.ts'), renderConfigFile(config), 'utf8');
    return cwd;
  }

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  describe('every template', () => {
    for (const template of TEMPLATE_NAMES) {
      it(`"${template}" initialises, validates, and plans without an error`, async () => {
        const { project, cwd } = await projectIn(`tpl-${template}`);
        const init = await run(project, cwd, ['init', '--template', template, '--json']);
        expect(init.code).toBe(0);
        expect(init.json<{ files: string[] }>().data!.files).toHaveLength(2);

        const doctor = await run(project, cwd, ['doctor', '--json']);
        const checks = doctor.json<{ checks: { name: string; status: string }[] }>().data!.checks;
        expect(checks.find((check) => check.name === 'config')?.status).toBe('ok');

        const plan = await run(project, cwd, ['push', '--dry-run', '--json']);
        expect(plan.code).toBe(0);
        const payload = plan.json<PlanPayload>().data!;
        expect(payload.applied).toBe(false);
        expect(payload.counts.create).toBeGreaterThan(0);
        expect(payload.counts.delete).toBe(0);
        expect(payload.plan.every((item) => item.action === 'create')).toBe(true);
      });
    }

    it('writes a framework client when asked, and refuses to overwrite without --force', async () => {
      const { project, cwd } = await projectIn('framework');
      const first = await run(project, cwd, [
        'init',
        '--template',
        'salon',
        '--framework',
        'nextjs',
        '--json',
      ]);
      expect(first.code).toBe(0);
      expect(first.json<{ files: string[] }>().data!.files).toHaveLength(3);
      expect(await readFile(join(cwd, 'bookrail.ts'), 'utf8')).toContain('idempotency-key');

      const second = await run(project, cwd, ['init', '--template', 'salon', '--json']);
      expect(second.code).toBe(1);
      expect(second.json().error?.code).toBe('file_exists');
      expect(second.json().error?.fix).toContain('--force');

      const forced = await run(project, cwd, ['init', '--template', 'salon', '--force', '--json']);
      expect(forced.code).toBe(0);
    });

    it('names the templates when asked for one that does not exist', async () => {
      const { project, cwd } = await projectIn('bad-template');
      const result = await run(project, cwd, ['init', '--template', 'hotel', '--json']);
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('unknown_template');
      expect(result.json().error?.fix).toContain('salon');
    });
  });

  describe('push, diff and pull', () => {
    it('applies a whole vertical and then reports no differences', async () => {
      const { project, cwd } = await projectIn('padel-push');
      await run(project, cwd, ['init', '--template', 'padel']);

      const push = await run(project, cwd, ['push', '--json']);
      expect(push.code).toBe(0);
      const applied = push.json<PlanPayload & { applied_objects: PlanItem[] }>().data!;
      expect(applied.applied).toBe(true);
      // 1 location + 1 schedule + 2 courts + 1 group + 1 policy + 1 service.
      expect(applied.counts.create).toBe(7);
      expect(applied.counts.delete).toBe(0);

      const diff = await run(project, cwd, ['diff', '--json']);
      expect(diff.code).toBe(0);
      const payload = diff.json<PlanPayload>().data!;
      expect(payload.has_changes).toBe(false);
      expect(payload.counts.unchanged).toBe(7);
      expect(payload.unmanaged).toEqual([]);
    });

    it('is idempotent: pushing twice changes nothing the second time', async () => {
      const { project, cwd } = await projectIn('idempotent');
      await run(project, cwd, ['init', '--template', 'clinic']);
      await run(project, cwd, ['push', '--json']);
      const again = await run(project, cwd, ['push', '--json']);
      expect(again.code).toBe(0);
      const payload = again.json<PlanPayload>().data!;
      expect(payload.counts.create).toBe(0);
      expect(payload.counts.update).toBe(0);
      expect(payload.counts.delete).toBe(0);
    });

    it('leaves no difference for any of the nine verticals', async () => {
      for (const template of TEMPLATE_NAMES) {
        const { project, cwd } = await projectIn(`clean-${template}`);
        await run(project, cwd, ['init', '--template', template]);
        const push = await run(project, cwd, ['push', '--json']);
        expect(push.code, `${template}: ${push.stdout}${push.stderr}`).toBe(0);
        const diff = await run(project, cwd, ['diff', '--json']);
        const payload = diff.json<PlanPayload>().data!;
        expect(
          payload.plan.filter((item) => item.action !== 'unchanged'),
          `${template} still differs`,
        ).toEqual([]);
      }
    });

    it('updates the fields that changed, and only those', async () => {
      const { project, cwd } = await projectIn('update');
      await run(project, cwd, ['init', '--template', 'gym']);
      await run(project, cwd, ['push', '--json']);

      const config = clone(TEMPLATES.gym!.config) as {
        resources: { id: string; capacity?: number }[];
        services: { id: string; name?: string }[];
      };
      config.resources.find((resource) => resource.id === 'vinyasa')!.capacity = 18;
      config.services.find((service) => service.id === 'lesson')!.name = 'Vinyasa lesson (60)';
      const next = await writeConfigIn(config);

      const plan = await run(project, next, ['push', '--dry-run', '--json']);
      const items = plan
        .json<PlanPayload>()
        .data!.plan.filter((item) => item.action !== 'unchanged');
      expect(items).toHaveLength(2);
      expect(items.find((item) => item.config_id === 'vinyasa')?.changes).toEqual(['capacity']);
      expect(items.find((item) => item.config_id === 'lesson')?.changes).toEqual(['name']);

      const push = await run(project, next, ['push', '--json']);
      expect(push.json<PlanPayload>().data!.counts.update).toBe(2);
      expect(
        (await run(project, next, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('adds and removes schedule exceptions, which have their own endpoints', async () => {
      const { project, cwd } = await projectIn('exceptions');
      await run(project, cwd, ['init', '--template', 'tours']);
      const push = await run(project, cwd, ['push', '--json']);
      expect(push.code).toBe(0);
      expect(push.json<{ exceptions: { added: number } }>().data!.exceptions.added).toBe(3);
      expect(
        (await run(project, cwd, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);

      const config = clone(TEMPLATES.tours!.config) as {
        schedules: Record<string, { exceptions: { date: string }[] }>;
      };
      const exceptions = config.schedules.departures!.exceptions;
      exceptions[exceptions.length - 1]!.date = '2026-06-24';
      const next = await writeConfigIn(config);

      const plan = await run(project, next, ['push', '--dry-run', '--json']);
      expect(
        plan.json<PlanPayload>().data!.plan.find((item) => item.config_id === 'departures')
          ?.changes,
      ).toEqual(['exceptions']);

      const second = await run(project, next, ['push', '--json']);
      expect(second.code).toBe(0);
      const delta = second.json<{ exceptions: { added: number; removed: number } }>().data!;
      expect(delta.exceptions).toEqual({ added: 1, removed: 1 });
      expect(
        (await run(project, next, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('refuses to delete without --yes, applies nothing, and deletes with it', async () => {
      const { project, cwd } = await projectIn('deletions');
      await run(project, cwd, ['init', '--template', 'salon']);
      const first = await run(project, cwd, ['push', '--json']);
      expect(first.code).toBe(0);

      // Drop the manicure, the technician and the cabin it needs, and the two groups that
      // name them: five objects, across four kinds, with references between them.
      const config = clone(TEMPLATES.salon!.config) as {
        resources: { id: string }[];
        resourceGroups: Record<string, unknown>;
        services: { id: string }[];
      };
      config.resources = config.resources.filter(
        (resource) => resource.id !== 'cabin_1' && resource.id !== 'nadia',
      );
      delete config.resourceGroups.nail_techs;
      delete config.resourceGroups.cabins;
      config.services = config.services.filter((service) => service.id !== 'manicure');
      const next = await writeConfigIn(config);

      const refused = await run(project, next, ['push', '--json']);
      expect(refused.code).toBe(1);
      expect(refused.json().error?.code).toBe('confirmation_required');
      expect(refused.json().error?.fix).toContain('--yes');

      // Nothing was applied: the project still has all three services.
      const stillThere = await run(project, next, ['services', 'list', '--all', '--json']);
      expect(stillThere.json<{ data: unknown[] }>().data!.data).toHaveLength(3);

      const applied = await run(project, next, ['push', '--yes', '--json']);
      expect(applied.code).toBe(0);
      expect(applied.json<PlanPayload>().data!.counts.delete).toBe(5);

      const after = await run(project, next, ['services', 'list', '--all', '--json']);
      expect(after.json<{ data: unknown[] }>().data!.data).toHaveLength(2);
      expect(
        (await run(project, next, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('never touches an object it did not create', async () => {
      const { project, cwd } = await projectIn('unmanaged');
      await run(project, cwd, ['init', '--template', 'coworking']);
      await run(project, cwd, ['push', '--json']);

      const foreign = await run(project, cwd, [
        'locations',
        'create',
        '--set',
        'name=Created elsewhere',
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ]);
      const foreignId = foreign.json<{ id: string }>().data!.id;

      const diff = await run(project, cwd, ['diff', '--json']);
      const payload = diff.json<PlanPayload>().data!;
      expect(payload.has_changes).toBe(false);
      expect(payload.unmanaged).toEqual([
        { kind: 'locations', id: foreignId, name: 'Created elsewhere' },
      ]);

      const push = await run(project, cwd, ['push', '--yes', '--json']);
      expect(push.code).toBe(0);
      const still = await run(project, cwd, ['locations', 'get', foreignId, '--json']);
      expect(still.code).toBe(0);
    });

    it('pulls the project back into a file that pushes clean', async () => {
      const { project, cwd } = await projectIn('pull');
      await run(project, cwd, ['init', '--template', 'restaurant']);
      await run(project, cwd, ['push', '--json']);

      const refused = await run(project, cwd, ['pull', '--json']);
      expect(refused.code).toBe(1);
      expect(refused.json().error?.code).toBe('file_exists');

      const pulled = await run(project, cwd, ['pull', '--force', '--json']);
      expect(pulled.code).toBe(0);
      expect(pulled.json<{ adopted: unknown[] }>().data!.adopted).toEqual([]);

      const source = await readFile(join(cwd, 'bookrail.config.ts'), 'utf8');
      expect(source).toContain("import { defineConfig } from 'bookrail';");
      expect(source).toContain("id: 'dinner'");
      expect(source).toContain('allowSplit: true');

      const diff = await run(project, cwd, ['diff', '--json']);
      expect(diff.json<PlanPayload>().data!.has_changes).toBe(false);
    });

    it('pulling a project it never pushed says so instead of pretending', async () => {
      const { project, cwd } = await projectIn('pull-foreign');
      await run(project, cwd, [
        'locations',
        'create',
        '--set',
        'name=Sede Centrale',
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ]);
      const pulled = await run(project, cwd, ['pull', '--json']);
      expect(pulled.code).toBe(0);
      const data = pulled.json<{ adopted: { config_id: string }[] }>().data!;
      expect(data.adopted).toHaveLength(1);
      expect(data.adopted[0]?.config_id).toBe('sede_centrale');
      expect(pulled.json().next_steps?.join(' ')).toContain('config_id');
    });

    it('prints the plan as a table when it is not asked for JSON', async () => {
      const { project, cwd } = await projectIn('table');
      await run(project, cwd, ['init', '--template', 'tutoring']);
      const plan = await run(project, cwd, ['push', '--dry-run']);
      expect(plan.code).toBe(0);
      expect(plan.stdout).toContain('[test]');
      expect(plan.stdout).toContain('action');
      expect(plan.stdout).toContain('private_lesson');
      expect(plan.stdout).toContain('Next steps');
    });

    it('refuses to run without a configuration file, and says how to make one', async () => {
      const { project, cwd } = await projectIn('no-config');
      const result = await run(project, cwd, ['push', '--json']);
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('config_not_found');
      expect(result.json().error?.fix).toContain('bookrail init');
    });

    it('reports two remote objects claiming the same logical id', async () => {
      const { project, cwd } = await projectIn('ambiguous');
      await run(project, cwd, ['init', '--template', 'empty']);
      await run(project, cwd, ['push', '--json']);
      await run(project, cwd, [
        'locations',
        'create',
        '--data',
        JSON.stringify({
          name: 'Duplicate',
          timezone: 'Europe/Rome',
          metadata: { config_id: 'main' },
        }),
        '--json',
      ]);
      const result = await run(project, cwd, ['diff', '--json']);
      expect(result.code).toBe(1);
      expect(result.json().error?.code).toBe('ambiguous_config_id');
    });

    it('sends no request to live while pushing in test', () => {
      expect(h.seenKeys.filter((key) => key.startsWith('sk_live_'))).toEqual([]);
    });
  });

  /**
   * `slot_interval` and `align_to` used to be `optional`
   * in the API schema, so the CLI could only omit them and a stored value could never be
   * cleared. They are `nullish` now, and the push sends the `null`.
   */
  /**
   * `pricingRules` goes to the server and comes back, and a rule that moves is a difference
   * the plan names.
   */
  describe('pricing rules', () => {
    const configWith = (rules: unknown[]) => ({
      locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],
      schedules: {
        always: {
          timezone: 'Europe/Rome',
          rules: [
            { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '00:00' },
          ],
        },
      },
      resources: [
        { id: 'court-1', name: 'Court 1', type: 'court', location: 'club', schedule: 'always' },
      ],
      services: [
        {
          id: 'match',
          name: 'Match',
          duration: 60,
          price: { amount: 3000, currency: 'EUR' },
          pricingRules: rules,
          requirements: [{ resource: 'court-1' }],
        },
      ],
    });

    it('pushes rules, reports no difference, and pulls them back in the config spelling', async () => {
      const { project } = await projectIn('pricing');
      const rules = [
        { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
        { when: { timeFrom: '18:00', timeTo: '22:00' }, priceAdd: 500 },
        { when: { durationMin: 60 }, priceMultiplier: 1.4 },
      ];
      const cwd = await writeConfigIn(configWith(rules));

      const push = await run(project, cwd, ['push', '--json']);
      expect(push.code).toBe(0);
      expect(
        (await run(project, cwd, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);

      // The server holds them in its own spelling.
      const remote = await run(project, cwd, ['services', 'list', '--json']);
      const stored = remote.json<{ data: { pricing_rules: unknown[] }[] }>().data!.data[0]!;
      expect(stored.pricing_rules).toEqual([
        { when: { days: ['sat', 'sun'] }, price: 3500, label: 'Weekend' },
        { when: { time_from: '18:00', time_to: '22:00' }, price_add: 500 },
        { when: { duration_min: 60 }, price_multiplier: 1.4 },
      ]);

      // And `pull` writes a file that carries the rules back in the config spelling and
      // pushes clean.
      const pullDir = await h.workdir();
      const pulled = await h.cli(['pull', '--json'], {
        cwd: pullDir,
        env: { BOOKRAIL_SECRET_KEY: project.testKey },
      });
      expect(pulled.code).toBe(0);
      const written = await readFile(join(pullDir, 'bookrail.config.ts'), 'utf8');
      expect(written).toContain('pricingRules');
      expect(written).toContain('priceMultiplier');
      expect(written).toContain('timeFrom');
      expect(
        (await run(project, pullDir, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('names pricing_rules in the plan when a rule changes, and applies it', async () => {
      const { project } = await projectIn('pricing-change');
      const cwd = await writeConfigIn(
        configWith([{ when: { days: ['sat'] }, price: 3500, label: 'Weekend' }]),
      );
      await run(project, cwd, ['push', '--json']);

      const next = await writeConfigIn(
        configWith([{ when: { days: ['sat'] }, price: 4200, label: 'Weekend' }]),
      );
      const plan = await run(project, next, ['push', '--dry-run', '--json']);
      const changed = plan
        .json<PlanPayload>()
        .data!.plan.filter((item) => item.action === 'update');
      expect(changed).toHaveLength(1);
      expect(changed[0]?.changes).toEqual(['pricing_rules']);

      expect((await run(project, next, ['push', '--json'])).code).toBe(0);
      const remote = await run(project, next, ['services', 'list', '--json']);
      expect(
        remote.json<{ data: { pricing_rules: { price: number }[] }[] }>().data!.data[0]!
          .pricing_rules[0]!.price,
      ).toBe(4200);
    });

    it('refuses a malformed rule locally, before any request', async () => {
      const { project } = await projectIn('pricing-invalid');
      const cwd = await writeConfigIn(
        configWith([{ when: { timeFrom: '25:00', timeTo: '02:00' }, price: 3500 }]),
      );
      const push = await run(project, cwd, ['push', '--json']);
      expect(push.code).not.toBe(0);
      expect(`${push.stdout}${push.stderr}`).toContain('timeFrom');
    });
  });

  describe('removing the slot grid', () => {
    it('clears slot_interval and align_to when the config stops declaring them', async () => {
      const { project, cwd } = await projectIn('grid');
      await run(project, cwd, ['init', '--template', 'padel']);
      await run(project, cwd, ['push', '--json']);

      const services = await run(project, cwd, ['services', 'list', '--json']);
      const before = services.json<{
        data: { slot_interval: number | null; align_to: string | null }[];
      }>().data!.data;
      expect(before.some((row) => row.slot_interval !== null)).toBe(true);

      const config = clone(TEMPLATES.padel!.config) as {
        services: { id: string; slotInterval?: number; alignTo?: string }[];
      };
      for (const service of config.services) {
        delete service.slotInterval;
        delete service.alignTo;
      }
      const next = await writeConfigIn(config);

      const plan = await run(project, next, ['push', '--dry-run', '--json']);
      const changed = plan
        .json<PlanPayload>()
        .data!.plan.filter((item) => item.action === 'update');
      expect(changed.length).toBeGreaterThan(0);
      expect(changed[0]?.changes).toEqual(expect.arrayContaining(['slot_interval', 'align_to']));

      const push = await run(project, next, ['push', '--json']);
      expect(push.code).toBe(0);

      const after = await run(project, next, ['services', 'list', '--json']);
      const rows = after.json<{
        data: { slot_interval: number | null; align_to: string | null }[];
      }>().data!.data;
      expect(rows.every((row) => row.slot_interval === null)).toBe(true);
      expect(rows.every((row) => row.align_to === null)).toBe(true);

      // And the difference is gone for good, which is the half that used to be impossible.
      expect(
        (await run(project, next, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('shows the real shape of every duration in `services list`', async () => {
      const { project, cwd } = await projectIn('durations');
      await run(project, cwd, ['init', '--template', 'padel']);
      await run(project, cwd, ['push', '--json']);
      await run(project, cwd, [
        'services',
        'create',
        '--data',
        JSON.stringify({ name: 'Free rental', duration_range: { min: 30, max: 600 } }),
        '--json',
      ]);

      const table = await run(project, cwd, ['services', 'list']);
      expect(table.code).toBe(0);
      expect(table.stdout).toContain('duration');
      expect(table.stdout).toContain('grid');
      // The padel template offers 60 and 90 minutes on a 30 minute grid aligned to the hour.
      expect(table.stdout).toContain('60/90m');
      expect(table.stdout).toContain('every 30m, from hour');
      // The service just created has a range and no grid at all.
      expect(table.stdout).toContain('30-600m');
      expect(table.stdout).toContain('free');
    });
  });

  /**
   * Adoption (`--adopt`). The rule
   * it exists to keep is negative: nothing is ever adopted by name.
   */
  describe('adoption', () => {
    async function unmanagedLocation(project: Project, cwd: string, name: string): Promise<string> {
      const created = await run(project, cwd, [
        'locations',
        'create',
        '--set',
        `name=${name}`,
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ]);
      expect(created.code).toBe(0);
      return created.json<{ id: string }>().data!.id;
    }

    it('takes over an existing object under a logical id, and then updates instead of duplicating', async () => {
      const { project, cwd } = await projectIn('adopt');
      const remoteId = await unmanagedLocation(project, cwd, 'Club Nord');

      const config = {
        locations: [{ id: 'club', name: 'Club Nord', timezone: 'Europe/Rome' }],
      };
      const dir = await writeConfigIn(config);

      // Without the flag it is an unmanaged object and the push would create a second one.
      const naive = await run(project, dir, ['push', '--dry-run', '--json']);
      const naivePlan = naive.json<PlanPayload>().data!;
      expect(naivePlan.counts.create).toBe(1);
      expect(naivePlan.unmanaged.map((object) => object.id)).toContain(remoteId);

      const dryRun = await run(project, dir, [
        'push',
        '--dry-run',
        '--adopt',
        `locations:club=${remoteId}`,
        '--json',
      ]);
      expect(dryRun.code).toBe(0);
      const planned = dryRun.json<PlanPayload & { would_adopt: unknown[] }>().data!;
      expect(planned.would_adopt).toHaveLength(1);
      expect(planned.counts.create).toBe(0);
      // Nothing was written: without the adoption, the object is still unmanaged.
      const untouched = await run(project, dir, ['push', '--dry-run', '--json']);
      expect(untouched.json<PlanPayload>().data!.counts.create).toBe(1);

      const push = await run(project, dir, [
        'push',
        '--adopt',
        `locations:club=${remoteId}`,
        '--json',
      ]);
      expect(push.code).toBe(0);
      const applied = push.json<
        PlanPayload & { adopted: { status: string; remote_id: string }[] }
      >().data!;
      expect(applied.adopted).toHaveLength(1);
      expect(applied.adopted[0]).toMatchObject({ status: 'adopted', remote_id: remoteId });
      expect(applied.counts.create).toBe(0);

      // One location, not two, and it is the one that already existed.
      const list = await run(project, dir, ['locations', 'list', '--json']);
      const rows = list.json<{ data: { id: string; metadata: { config_id?: string } }[] }>().data!
        .data;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(remoteId);
      expect(rows[0]?.metadata.config_id).toBe('club');

      expect(
        (await run(project, dir, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);

      // Re-running the same adoption converges rather than failing.
      const again = await run(project, dir, [
        'push',
        '--adopt',
        `locations:club=${remoteId}`,
        '--json',
      ]);
      expect(again.code).toBe(0);
      expect(again.json<{ adopted: { status: string }[] }>().data!.adopted[0]?.status).toBe(
        'already',
      );
    });

    it('refuses every ambiguous or impossible adoption, before writing anything', async () => {
      const { project, cwd } = await projectIn('adopt-refusals');
      const remoteId = await unmanagedLocation(project, cwd, 'Club Sud');
      const dir = await writeConfigIn({
        locations: [{ id: 'club', name: 'Club Sud', timezone: 'Europe/Rome' }],
      });

      const badSpec = await run(project, dir, ['push', '--adopt', 'nonsense', '--json']);
      expect(badSpec.code).toBe(1);
      expect(badSpec.json().error?.code).toBe('parameter_invalid');
      expect(badSpec.json().error?.message).toContain('kind:config_id=remote_id');
      expect(badSpec.json().error?.fix).toContain('resources:court_1=res_');

      const badKind = await run(project, dir, [
        'push',
        '--adopt',
        `widgets:club=${remoteId}`,
        '--json',
      ]);
      expect(badKind.code).toBe(1);
      expect(badKind.json().error?.message).toContain('not a configuration kind');

      const missing = await run(project, dir, [
        'push',
        '--adopt',
        'locations:club=loc_00000000',
        '--json',
      ]);
      expect(missing.code).toBe(1);
      expect(missing.json().error?.code).toBe('resource_missing');

      const notDeclared = await run(project, dir, [
        'push',
        '--adopt',
        `locations:ghost=${remoteId}`,
        '--json',
      ]);
      expect(notDeclared.code).toBe(1);
      expect(notDeclared.json().error?.code).toBe('unknown_config_id');
      expect(notDeclared.json().error?.fix).toContain('plan its deletion');

      // Nothing above wrote: the object is still unmanaged.
      const plan = await run(project, dir, ['push', '--dry-run', '--json']);
      expect(plan.json<PlanPayload>().data!.unmanaged.map((object) => object.id)).toContain(
        remoteId,
      );

      // An object that already carries a different id is refused too.
      await run(project, dir, ['push', '--adopt', `locations:club=${remoteId}`, '--json']);
      const other = await writeConfigIn({
        locations: [{ id: 'other', name: 'Club Sud', timezone: 'Europe/Rome' }],
      });
      const already = await run(project, other, [
        'push',
        '--adopt',
        `locations:other=${remoteId}`,
        '--json',
      ]);
      expect(already.code).toBe(1);
      expect(already.json().error?.code).toBe('already_managed');
      expect(already.json().error?.fix).toContain('club');
    });

    it('pull --adopt stamps every unmanaged object, so the file it writes pushes clean', async () => {
      const { project, cwd } = await projectIn('pull-adopt');
      await run(project, cwd, [
        'locations',
        'create',
        '--set',
        'name=Sede Nord',
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ]);
      await run(project, cwd, [
        'policies',
        'create',
        '--set',
        'name=Standard',
        '--set',
        'hold_duration_seconds=900',
        '--json',
      ]);

      const pulled = await run(project, cwd, ['pull', '--adopt', '--json']);
      expect(pulled.code).toBe(0);
      const data = pulled.json<{
        adopted: unknown[];
        stamped: { kind: string; config_id: string; status: string }[];
      }>().data!;
      expect(data.stamped).toHaveLength(2);
      expect(data.stamped.every((entry) => entry.status === 'adopted')).toBe(true);
      expect(data.stamped.map((entry) => entry.config_id).sort()).toEqual([
        'sede_nord',
        'standard',
      ]);
      // After the stamp, nothing is unmanaged any more.
      expect(data.adopted).toEqual([]);

      const source = await readFile(join(cwd, 'bookrail.config.ts'), 'utf8');
      expect(source).toContain("id: 'sede_nord'");
      expect(source).toContain('stamped with metadata.config_id');

      // The whole point: pushing the pulled file changes nothing instead of duplicating.
      const plan = await run(project, cwd, ['push', '--dry-run', '--json']);
      expect(plan.json<PlanPayload>().data!.counts.create).toBe(0);
      expect(
        (await run(project, cwd, ['diff', '--json'])).json<PlanPayload>().data!.has_changes,
      ).toBe(false);
    });

    it('pull without --adopt still writes nothing to the project', async () => {
      const { project, cwd } = await projectIn('pull-readonly');
      await run(project, cwd, [
        'locations',
        'create',
        '--set',
        'name=Sede Sud',
        '--set',
        'timezone=Europe/Rome',
        '--json',
      ]);
      const before = h.seenRequests.filter((request) => request.startsWith('PATCH')).length;
      const pulled = await run(project, cwd, ['pull', '--json']);
      expect(pulled.code).toBe(0);
      expect(pulled.json<{ stamped: unknown[] }>().data!.stamped).toEqual([]);
      expect(h.seenRequests.filter((request) => request.startsWith('PATCH')).length).toBe(before);
    });
  });
});
