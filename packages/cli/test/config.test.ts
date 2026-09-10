import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateConfig } from '../src/config/normalize.js';
import { evaluateDefineConfigLiteral, loadConfig } from '../src/config/load.js';
import { toJsonSchema, toRootJsonSchema } from '../src/config/json-schema.js';
import { configSchema, entrySchemas, ENTITY_KINDS } from '../src/config/schema.js';
import { PRICING_RULE_CONFORMANCE_CASES } from '@bookrail/shared';
import {
  canonicalFromConfig,
  changedFields,
  durationToSeconds,
  pricingRuleFromConfig,
  pricingRuleToConfig,
  secondsToDuration,
  stableStringify,
} from '../src/config/desired.js';
import { renderConfigFile, renderValue } from '../src/render.js';
import { TEMPLATES, TEMPLATE_NAMES } from '../src/templates/index.js';
import { uniqueSlug } from '../src/sync/pull.js';
import type { Io } from '../src/io.js';

function io(cwd: string): Io {
  return {
    env: {},
    cwd,
    home: cwd,
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => '',
  };
}

describe('config schema', () => {
  it('accepts a collection as an array and as a record, and normalises both', () => {
    const asArray = validateConfig({
      locations: [{ id: 'main', name: 'Main', timezone: 'Europe/Rome' }],
    });
    const asRecord = validateConfig({
      locations: { main: { name: 'Main', timezone: 'Europe/Rome' } },
    });
    expect(asArray.issues).toEqual([]);
    expect(asRecord.issues).toEqual([]);
    expect(asArray.config?.locations).toEqual(asRecord.config?.locations);
  });

  it('defaults the name to the logical id', () => {
    const result = validateConfig({ locations: { club: { timezone: 'Europe/Rome' } } });
    expect(canonicalFromConfig('locations', result.config!.locations[0]!).name).toBe('club');
  });

  it('reports an unknown reference with its position', () => {
    const result = validateConfig({
      locations: [{ id: 'main', timezone: 'Europe/Rome' }],
      resources: [{ id: 'a', location: 'main', schedule: 'nope' }],
    });
    expect(result.config).toBeNull();
    expect(result.issues).toEqual([
      {
        path: 'resources[0].schedule',
        message: 'No schedule with id "nope" is declared in this config.',
      },
    ]);
  });

  it('reports a duplicate logical id', () => {
    const result = validateConfig({
      locations: [
        { id: 'main', timezone: 'Europe/Rome' },
        { id: 'main', timezone: 'Europe/Rome' },
      ],
    });
    expect(result.issues[0]?.message).toContain('Duplicate id "main"');
  });

  it('requires exactly one duration form on a service', () => {
    const none = validateConfig({ services: [{ id: 's', name: 'S' }] });
    expect(none.issues[0]?.message).toContain('exactly one of');
    const two = validateConfig({
      services: [{ id: 's', name: 'S', duration: 30, durationOptions: [30, 60] }],
    });
    expect(two.issues[0]?.message).toContain('exactly one of');
  });

  it('rejects an unknown field', () => {
    const result = validateConfig({ locations: [{ id: 'a', timezone: 'UTC', colour: 'red' }] });
    expect(result.config).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects an invalid time zone and an impossible time of day', () => {
    expect(
      validateConfig({ locations: [{ id: 'a', timezone: 'Mars/Olympus' }] }).config,
    ).toBeNull();
    expect(
      validateConfig({
        schedules: { s: { rules: [{ days: ['mon'], from: '25:00', to: '26:00' }] } },
      }).config,
    ).toBeNull();
  });

  it('accepts a band that crosses midnight and one that covers the whole day', () => {
    const result = validateConfig({
      schedules: {
        night: { rules: [{ days: ['fri'], from: '22:00', to: '02:00' }] },
        always: { rules: [{ days: ['mon'], from: '00:00', to: '00:00' }] },
      },
    });
    expect(result.issues).toEqual([]);
  });

  it('requires a requirement to name exactly one of resource and group', () => {
    const both = validateConfig({
      resources: [{ id: 'r', schedule: undefined }],
      services: [{ id: 's', duration: 30, requirements: [{ resource: 'r', group: 'g' }] }],
    });
    expect(both.config).toBeNull();
    const neither = validateConfig({
      services: [{ id: 's', duration: 30, requirements: [{}] }],
    });
    expect(neither.config).toBeNull();
  });
});

/**
 * The CLI declares the pricing rule schema a second time, because the published package cannot
 * depend on `@bookrail/shared` (`packages/cli/src/config/schema.ts` says why). A duplicate is
 * only acceptable if something compares the two, and this is that something: the conformance
 * corpus exported by `@bookrail/shared` (a development dependency here, so a test may import
 * it) is run through the CLI's schema and has to get the same verdict on every case.
 *
 * The corpus is written in the API's `snake_case`; the config file is `camelCase` from end to
 * end, like every other nested object in it, so each case is renamed on the way in. The rename
 * is deliberately partial: a key the map does not know is left alone, so the "unknown field"
 * and "unknown condition" cases still reach the schema as unknown and are still refused.
 */
const RULE_KEYS: Record<string, string> = {
  price_add: 'priceAdd',
  price_multiplier: 'priceMultiplier',
};
const WHEN_KEYS: Record<string, string> = {
  time_from: 'timeFrom',
  time_to: 'timeTo',
  date_from: 'dateFrom',
  date_to: 'dateTo',
  resource_id: 'resourceId',
  duration_min: 'durationMin',
};

function rename(value: unknown, map: Record<string, string>): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [map[key] ?? key, item]),
  );
}

function toConfigRule(rule: unknown): unknown {
  const renamed = rename(rule, RULE_KEYS);
  if (renamed === null || typeof renamed !== 'object' || Array.isArray(renamed)) return renamed;
  const out = renamed as Record<string, unknown>;
  return 'when' in out ? { ...out, when: rename(out.when, WHEN_KEYS) } : out;
}

describe('pricing rules, against the schema of @bookrail/shared', () => {
  const schema = entrySchemas.services;

  it.each(PRICING_RULE_CONFORMANCE_CASES.map((entry) => [entry.title, entry] as const))(
    'agrees on %s',
    (_title, entry) => {
      const parsed = schema.safeParse({
        id: 'match',
        name: 'Match',
        duration: 60,
        price: { amount: 3000, currency: 'EUR' },
        pricingRules: [toConfigRule(entry.rule)],
      });
      expect(parsed.success, entry.title).toBe(entry.valid);
    },
  );

  it('translates a rule to the API spelling and back without losing anything', () => {
    const config = {
      when: {
        days: ['sat'],
        timeFrom: '18:00',
        timeTo: '22:00',
        dateFrom: '2026-07-01',
        dateTo: '2026-08-31',
        resourceId: 'res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c',
        durationMin: 90,
      },
      priceAdd: 500,
      label: 'Summer evening',
    };
    const api = pricingRuleFromConfig(config);
    expect(api).toEqual({
      when: {
        days: ['sat'],
        time_from: '18:00',
        time_to: '22:00',
        date_from: '2026-07-01',
        date_to: '2026-08-31',
        resource_id: 'res_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c',
        duration_min: 90,
      },
      price_add: 500,
      label: 'Summer evening',
    });
    expect(pricingRuleToConfig(api)).toEqual(config);
  });

  it('puts the rules in the canonical form in the API spelling, so the diff compares like with like', () => {
    const canonical = canonicalFromConfig('services', {
      id: 'match',
      name: 'Match',
      duration: 60,
      price: { amount: 3000, currency: 'EUR' },
      pricingRules: [{ when: { timeFrom: '18:00', timeTo: '22:00' }, priceAdd: 500 }],
    });
    expect(canonical.pricing_rules).toEqual([
      { when: { time_from: '18:00', time_to: '22:00' }, price_add: 500 },
    ]);
  });

  it('reports pricing_rules as a changed field when a rule moves', () => {
    const service = (rules: unknown[]) =>
      canonicalFromConfig('services', {
        id: 'match',
        name: 'Match',
        duration: 60,
        price: { amount: 3000, currency: 'EUR' },
        pricingRules: rules,
      });
    const before = service([{ when: { days: ['sat'] }, price: 3500 }]);
    const after = service([{ when: { days: ['sat'] }, price: 4000 }]);
    expect(changedFields(after, before)).toContain('pricing_rules');
    expect(changedFields(before, before)).not.toContain('pricing_rules');
  });
});

describe('canonical form', () => {
  it('writes out every default the API would apply', () => {
    const result = validateConfig({ resources: [{ id: 'r' }] });
    expect(canonicalFromConfig('resources', result.config!.resources[0]!)).toEqual({
      name: 'r',
      type: 'staff',
      location: null,
      schedule: null,
      capacity: 1,
      attributes: {},
      status: 'active',
      metadata: {},
    });
  });

  it('omits tenant_id unless the config declares it', () => {
    const without = validateConfig({ locations: [{ id: 'l', timezone: 'UTC' }] });
    expect('tenant_id' in canonicalFromConfig('locations', without.config!.locations[0]!)).toBe(
      false,
    );
    const withTenant = validateConfig({
      locations: [{ id: 'l', timezone: 'UTC', tenantId: 'acme' }],
    });
    expect(canonicalFromConfig('locations', withTenant.config!.locations[0]!).tenant_id).toBe(
      'acme',
    );
  });

  it('turns day names into the numbers the API stores, sorted and deduplicated', () => {
    const result = validateConfig({
      schedules: { s: { rules: [{ days: ['fri', 'mon', 'mon'], from: '09:00', to: '17:00' }] } },
    });
    const canonical = canonicalFromConfig('schedules', result.config!.schedules[0]!);
    expect((canonical.rules as { days_of_week: number[] }[])[0]?.days_of_week).toEqual([1, 5]);
  });

  it('converts a hold duration to seconds and back', () => {
    expect(durationToSeconds('10m')).toBe(600);
    expect(durationToSeconds('1h')).toBe(3600);
    expect(durationToSeconds('90s')).toBe(90);
    expect(durationToSeconds('2d')).toBe(172800);
    expect(secondsToDuration(600)).toBe('10m');
    expect(secondsToDuration(3600)).toBe('1h');
    expect(secondsToDuration(90)).toBe('90s');
  });

  it('compares independently of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(changedFields({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
  });
});

describe('templates', () => {
  it('has the nine verticals plus empty', () => {
    expect(TEMPLATE_NAMES).toEqual([
      'salon',
      'padel',
      'gym',
      'rental',
      'restaurant',
      'clinic',
      'coworking',
      'tours',
      'tutoring',
      'empty',
    ]);
  });

  for (const name of Object.keys(TEMPLATES)) {
    it(`"${name}" validates, renders, and reloads to the same configuration`, async () => {
      const template = TEMPLATES[name]!;
      const validated = validateConfig(template.config);
      expect(validated.issues).toEqual([]);

      const source = renderConfigFile(template.config, { header: template.notes });
      const directory = await mkdtemp(join(tmpdir(), `bookrail-tpl-${name}-`));
      await writeFile(join(directory, 'bookrail.config.ts'), source, 'utf8');
      const reloaded = await loadConfig(io(directory));
      expect(reloaded.config).toEqual(validated.config);
    });
  }
});

describe('config loading', () => {
  it('reads a .json config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-json-'));
    await writeFile(
      join(directory, 'bookrail.config.json'),
      JSON.stringify({ locations: [{ id: 'a', timezone: 'UTC' }] }),
      'utf8',
    );
    const loaded = await loadConfig(io(directory));
    expect(loaded.loader).toBe('json');
    expect(loaded.config.locations[0]?.id).toBe('a');
  });

  it('reads a .mjs config through a real import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-mjs-'));
    await writeFile(
      join(directory, 'bookrail.config.mjs'),
      'export default { locations: [{ id: "a", timezone: "UTC" }] };\n',
      'utf8',
    );
    const loaded = await loadConfig(io(directory));
    expect(loaded.loader).toBe('import');
    expect(loaded.config.locations[0]?.id).toBe('a');
  });

  it('reads a .ts config, however the runtime happens to be able to', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-ts-'));
    await writeFile(
      join(directory, 'bookrail.config.ts'),
      [
        "import { defineConfig } from 'bookrail';",
        '',
        'export default defineConfig({',
        "  // a comment with a ) and a '{' in it",
        "  locations: [{ id: 'a', timezone: 'UTC' }],",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadConfig(io(directory));
    expect(['import', 'literal']).toContain(loaded.loader);
    expect(loaded.config.locations[0]?.id).toBe('a');
  });

  it('falls back to the literal when the module cannot be imported at all', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-ts-fallback-'));
    await writeFile(
      join(directory, 'bookrail.config.ts'),
      [
        "import { defineConfig } from 'bookrail-no-such-package-xyz';",
        '',
        'export default defineConfig({',
        "  locations: [{ id: 'a', timezone: 'UTC' }],",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadConfig(io(directory));
    expect(loaded.loader).toBe('literal');
    expect(loaded.config.locations[0]?.id).toBe('a');
  });

  it('finds the balanced literal past strings, comments and nested braces', () => {
    const value = evaluateDefineConfigLiteral(
      `export default defineConfig({ a: '})', /* } */ b: { c: [1, 2] } });`,
      'x.ts',
    );
    expect(value).toEqual({ a: '})', b: { c: [1, 2] } });
  });

  it('says what to do when the file cannot be evaluated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-bad-'));
    await writeFile(
      join(directory, 'bookrail.config.ts'),
      [
        "import { defineConfig } from 'bookrail-no-such-package-xyz';",
        'export default defineConfig({ locations: [] as Location[] });',
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadConfig(io(directory))).rejects.toMatchObject({
      code: 'config_unreadable',
    });
  });

  it('refuses a valid file that is not a valid configuration, with positions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookrail-invalid-'));
    await writeFile(
      join(directory, 'bookrail.config.json'),
      JSON.stringify({ resources: [{ id: 'r', schedule: 'missing' }] }),
      'utf8',
    );
    await expect(loadConfig(io(directory))).rejects.toMatchObject({ code: 'invalid_config' });
  });
});

describe('JSON Schema generation', () => {
  it('produces a draft 2020-12 schema for the whole configuration', () => {
    const schema = toRootJsonSchema(configSchema, 'bookrail.config.ts');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.title).toBe('bookrail.config.ts');
    const properties = schema.properties as Record<string, unknown>;
    for (const kind of ENTITY_KINDS) expect(properties[kind]).toBeDefined();
  });

  it('describes each collection entry, with the required fields and no extras', () => {
    const service = toJsonSchema(entrySchemas.services) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(service.required).toEqual(['id']);
    expect(service.additionalProperties).toBe(false);
    expect(service.properties.consumes).toBeUndefined();
    expect(service.properties.bufferSharing).toEqual({ type: 'boolean' });
    expect(service.properties.slotInterval).toEqual({
      type: 'integer',
      exclusiveMinimum: 0,
      maximum: 1440,
    });
    expect(service.properties.alignTo).toEqual({
      type: 'string',
      enum: ['hour', 'half_hour', 'schedule_start'],
    });
  });

  it('renders a nullable field as an anyOf with null', () => {
    const schema = toJsonSchema(z.string().nullish()) as { anyOf: unknown[] };
    expect(schema.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('throws on a node it does not know rather than emitting an empty schema', () => {
    expect(() => toJsonSchema(z.map(z.string(), z.string()))).toThrow(/unsupported Zod node/);
  });
});

describe('rendering', () => {
  it('quotes only the keys that need it and keeps short objects on one line', () => {
    expect(renderValue({ id: 'a', 'needs-quotes': 1 })).toBe("{ id: 'a', 'needs-quotes': 1 }");
  });

  it('escapes quotes and backslashes', () => {
    expect(renderValue("it's a \\ backslash")).toBe("'it\\'s a \\\\ backslash'");
  });

  it('breaks a long object over lines with trailing commas', () => {
    const rendered = renderValue({
      name: 'a rather long name that will not fit on one line at all, truly',
      nested: { a: 1 },
    });
    expect(rendered).toContain('\n');
    expect(rendered).toContain('nested: { a: 1 },');
  });

  it('writes a file that starts with the typed import', () => {
    const file = renderConfigFile({ locations: [] }, { header: ['hello', ''] });
    expect(file.startsWith("import { defineConfig } from 'bookrail';")).toBe(true);
    expect(file).toContain('// hello\n//\n');
    expect(file.trimEnd().endsWith('});')).toBe(true);
  });
});

describe('slugs', () => {
  it('turns a name into a logical id and keeps them unique', () => {
    const used = new Set<string>();
    const first = uniqueSlug('Campo 1', used);
    used.add(first);
    expect(first).toBe('campo_1');
    expect(uniqueSlug('Campo 1', used)).toBe('campo_1_2');
    expect(uniqueSlug('Città!', new Set())).toBe('citta');
    expect(uniqueSlug('***', new Set())).toBe('item');
  });
});
