import { CliError } from '../errors.js';
import { configSchema, ENTITY_KINDS, type EntityKind, type BookrailConfig } from './schema.js';

export interface ConfigIssue {
  /** Dotted path inside the config, e.g. `services[1].requirements[0].group`. */
  path: string;
  message: string;
}

export type Entry<T> = T & { id: string };

export interface NormalizedConfig {
  project: string | undefined;
  locations: Entry<Record<string, unknown>>[];
  schedules: Entry<Record<string, unknown>>[];
  resources: Entry<Record<string, unknown>>[];
  resourceGroups: Entry<Record<string, unknown>>[];
  policies: Entry<Record<string, unknown>>[];
  services: Entry<Record<string, unknown>>[];
}

/**
 * The order `push` creates in, and the reverse of the order it deletes in.
 *
 * It is a topological order of the references between the objects: a resource points at a
 * location and a schedule, a group at resources, a service at a policy and at resources or
 * groups. It is fixed here explicitly so that a push is deterministic.
 */
export const PUSH_ORDER: EntityKind[] = [
  'locations',
  'schedules',
  'resources',
  'resourceGroups',
  'policies',
  'services',
];

/** Human name of a kind, for messages and tables. */
export const KIND_LABEL: Record<EntityKind, string> = {
  locations: 'location',
  schedules: 'schedule',
  resources: 'resource',
  resourceGroups: 'resource group',
  policies: 'policy',
  services: 'service',
};

function toEntries(
  value: unknown,
  kind: EntityKind,
  issues: ConfigIssue[],
): Entry<Record<string, unknown>>[] {
  if (value === undefined) return [];
  const entries: Entry<Record<string, unknown>>[] = [];
  const seen = new Map<string, string>();

  const push = (id: string, body: Record<string, unknown>, path: string): void => {
    const previous = seen.get(id);
    if (previous !== undefined) {
      issues.push({ path, message: `Duplicate id "${id}" (already declared at ${previous}).` });
      return;
    }
    seen.set(id, path);
    entries.push({ ...body, id });
  };

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const { id, ...body } = item as { id: string } & Record<string, unknown>;
      push(id, body, `${kind}[${index}]`);
    });
    return entries;
  }

  for (const [id, body] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    push(id, body, `${kind}.${id}`);
  }
  return entries;
}

export interface ValidationResult {
  config: NormalizedConfig | null;
  issues: ConfigIssue[];
}

/**
 * Parses and cross-checks a config object.
 *
 * Zod covers the shape; this adds what Zod cannot see: a reference to a logical id that the
 * file does not declare. Those are reported with their position rather than discovered at
 * push time as a `404` from the API, because an agent that gets a positioned message can fix
 * the file, and one that gets a `resource_missing` from a half-applied push cannot.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: null,
      issues: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const issues: ConfigIssue[] = [];
  const value = parsed.data as BookrailConfig & Record<string, unknown>;
  const normalized: NormalizedConfig = {
    project: value.project,
    locations: toEntries(value.locations, 'locations', issues),
    schedules: toEntries(value.schedules, 'schedules', issues),
    resources: toEntries(value.resources, 'resources', issues),
    resourceGroups: toEntries(value.resourceGroups, 'resourceGroups', issues),
    policies: toEntries(value.policies, 'policies', issues),
    services: toEntries(value.services, 'services', issues),
  };

  const ids: Record<EntityKind, Set<string>> = {
    locations: new Set(normalized.locations.map((entry) => entry.id)),
    schedules: new Set(normalized.schedules.map((entry) => entry.id)),
    resources: new Set(normalized.resources.map((entry) => entry.id)),
    resourceGroups: new Set(normalized.resourceGroups.map((entry) => entry.id)),
    policies: new Set(normalized.policies.map((entry) => entry.id)),
    services: new Set(normalized.services.map((entry) => entry.id)),
  };

  const reference = (kind: EntityKind, id: unknown, path: string, target: EntityKind): void => {
    if (typeof id !== 'string') return;
    if (ids[target].has(id)) return;
    issues.push({
      path,
      message: `No ${KIND_LABEL[target]} with id "${id}" is declared in this config.`,
    });
    void kind;
  };

  normalized.resources.forEach((entry, index) => {
    reference('resources', entry.location, `resources[${index}].location`, 'locations');
    reference('resources', entry.schedule, `resources[${index}].schedule`, 'schedules');
  });

  normalized.resourceGroups.forEach((entry, index) => {
    const members = (entry.resources ?? []) as string[];
    members.forEach((member, position) => {
      reference(
        'resourceGroups',
        member,
        `resourceGroups[${index}].resources[${position}]`,
        'resources',
      );
    });
  });

  normalized.services.forEach((entry, index) => {
    reference('services', entry.policy, `services[${index}].policy`, 'policies');
    const requirements = (entry.requirements ?? []) as { resource?: string; group?: string }[];
    requirements.forEach((requirement, position) => {
      const base = `services[${index}].requirements[${position}]`;
      reference('services', requirement.resource, `${base}.resource`, 'resources');
      reference('services', requirement.group, `${base}.group`, 'resourceGroups');
    });
    const durations = [entry.duration, entry.durationOptions, entry.durationRange].filter(
      (candidate) => candidate !== undefined,
    );
    if (durations.length !== 1) {
      issues.push({
        path: `services[${index}]`,
        message:
          'A service declares exactly one of `duration`, `durationOptions` or `durationRange`.',
      });
    }
    const range = entry.durationRange as { min: number; max: number } | undefined;
    if (range && range.max < range.min) {
      issues.push({
        path: `services[${index}].durationRange`,
        message: '`max` must be greater than or equal to `min`.',
      });
    }
  });

  return { config: issues.length === 0 ? normalized : null, issues };
}

export function formatPath(path: (string | number)[]): string {
  let out = '';
  for (const segment of path) {
    out += typeof segment === 'number' ? `[${segment}]` : out === '' ? segment : `.${segment}`;
  }
  return out === '' ? '<root>' : out;
}

/** Throws an error that names the path of every invalid field and how to repair it. */
export function assertValidConfig(raw: unknown, source: string): NormalizedConfig {
  const result = validateConfig(raw);
  if (result.config) return result.config;
  const lines = result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
  throw new CliError(
    'invalid_config',
    `${source} is not a valid Bookrail configuration:\n${lines}`,
    {
      fix: 'Fix the fields listed above. `bookrail schema config --json` prints the full schema.',
    },
  );
}

export { ENTITY_KINDS };
