import type { z } from 'zod';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { toRootJsonSchema } from '../config/json-schema.js';
import { configSchema, entrySchemas, ENTITY_KINDS } from '../config/schema.js';
import { renderTable, type CommandResult } from '../output.js';

/** `resource_groups` is what the API and the CLI call the collection; the config key is camel. */
const ALIASES: Record<string, string> = {
  resource_groups: 'resourceGroups',
  resourcegroups: 'resourceGroups',
  location: 'locations',
  schedule: 'schedules',
  resource: 'resources',
  policy: 'policies',
  service: 'services',
};

export const SCHEMA_NAMES = ['config', ...ENTITY_KINDS];

/**
 * The JSON Schema of the configuration, or of one of its collections.
 *
 * It is generated from the same Zod schemas `push` validates with, so an agent that writes a
 * config against this schema cannot be told later that a field does not exist. It is also the
 * machine-readable form of the file format: nothing to infer from prose.
 */
export function schema(ctx: Context, entity: string | undefined): CommandResult {
  if (entity === undefined) {
    return {
      data: { schemas: SCHEMA_NAMES },
      human: [
        `${ctx.presenter.badge()} schemas available`,
        '',
        renderTable(
          ['name', 'what'],
          [
            ['config', 'the whole bookrail.config.ts'],
            ...ENTITY_KINDS.map((kind) => [kind, `one entry of \`${kind}\``] as string[]),
          ],
        ),
      ].join('\n'),
      nextSteps: ['Run `bookrail schema config --json` for the whole configuration schema.'],
    };
  }

  const key = ALIASES[entity] ?? entity;
  if (key === 'config') {
    return { data: toRootJsonSchema(configSchema, 'bookrail.config.ts') };
  }
  const entry = (entrySchemas as Record<string, z.ZodTypeAny | undefined>)[key];
  if (!entry) {
    throw new CliError('unknown_entity', `No schema named "${entity}".`, {
      fix: `Use one of: ${SCHEMA_NAMES.join(', ')}.`,
    });
  }
  return { data: toRootJsonSchema(entry, key) };
}
