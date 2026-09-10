/**
 * Adoption: giving an object that already exists a `metadata.config_id`, so that a
 * configuration file starts managing it instead of creating a second copy of it.
 *
 * ## Why it is explicit, and never by name
 *
 * `push` maps a config entry to a remote object through `metadata.config_id` and nothing else
 * (`sync/plan.ts`). An object created through the API, the dashboard or another tool has none,
 * so it is `unmanaged`: the push leaves it alone, and pushing a `pull`ed file would create a
 * duplicate of every one of them. The obvious fix, match on `name`, is the wrong one: names
 * are not unique, and a push that adopts the wrong "Court 1" writes a config's opening hours
 * onto somebody else's court. So adoption is a decision the caller states, object by object,
 * with the remote id in their hand:
 *
 *     bookrail push --adopt resources:court_1=res_01H...
 *     bookrail pull --adopt          # stamp every unmanaged object with the id pull gave it
 *
 * ## What it does, and what it refuses
 *
 * One `PATCH` per object, whose only change is `metadata`: the existing metadata plus
 * `config_id`. A `PATCH` replaces `metadata` wholesale, so the merge happens here rather than
 * server-side, and every other field of the object is untouched. The push that follows is what
 * makes it match the file, and it is a normal `update` the plan shows like any other.
 *
 * Four refusals, all before anything is written:
 *
 *  - a kind that is not one of the six configuration kinds;
 *  - a remote id that does not exist in this project and environment;
 *  - an object that already carries a **different** `config_id` (the same one is a no-op, so
 *    re-running an adoption converges rather than failing);
 *  - a `config_id` already claimed by another object of the same kind, which would make the
 *    project ambiguous and break `fetchRemoteState` on the next command.
 *
 * `push --adopt` additionally refuses a `config_id` the configuration does not declare: that
 * adoption would stamp an object only to have the very same push plan its deletion.
 */
import type { ApiClient } from '../api/client.js';
import { CliError } from '../errors.js';
import { CONFIG_ID_KEY, configIdOf, type RemoteObject } from '../config/desired.js';
import { KIND_LABEL, PUSH_ORDER, type NormalizedConfig } from '../config/normalize.js';
import type { EntityKind } from '../config/schema.js';
import { ENDPOINT, type RemoteState } from './plan.js';

export interface Adoption {
  kind: EntityKind;
  config_id: string;
  remote_id: string;
}

export interface AdoptionOutcome extends Adoption {
  /** `adopted` when the stamp was written, `already` when the object already carried it. */
  status: 'adopted' | 'already';
  name: string;
}

/** The command-line spelling of each kind, plus the internal camelCase one. */
const KIND_ALIASES: Record<string, EntityKind> = {
  locations: 'locations',
  location: 'locations',
  schedules: 'schedules',
  schedule: 'schedules',
  resources: 'resources',
  resource: 'resources',
  resource_groups: 'resourceGroups',
  resourceGroups: 'resourceGroups',
  resource_group: 'resourceGroups',
  policies: 'policies',
  policy: 'policies',
  services: 'services',
  service: 'services',
};

/** `resources:court_1=res_01H...` */
export function parseAdoption(spec: string): Adoption {
  const colon = spec.indexOf(':');
  const equals = spec.indexOf('=');
  if (colon <= 0 || equals <= colon + 1 || equals === spec.length - 1) {
    throw new CliError(
      'parameter_invalid',
      `--adopt expects kind:config_id=remote_id, got "${spec}".`,
      {
        param: 'adopt',
        fix: 'Write it as `--adopt resources:court_1=res_01H...`. Kinds: locations, schedules, resources, resource_groups, policies, services.',
      },
    );
  }
  const rawKind = spec.slice(0, colon).trim();
  const kind = KIND_ALIASES[rawKind];
  if (kind === undefined) {
    throw new CliError('parameter_invalid', `"${rawKind}" is not a configuration kind.`, {
      param: 'adopt',
      fix: 'Use one of: locations, schedules, resources, resource_groups, policies, services.',
    });
  }
  return {
    kind,
    config_id: spec.slice(colon + 1, equals).trim(),
    remote_id: spec.slice(equals + 1).trim(),
  };
}

function findRemote(state: RemoteState, adoption: Adoption): RemoteObject {
  const object = state.objects[adoption.kind].find(
    (candidate) => candidate.id === adoption.remote_id,
  );
  if (object === undefined) {
    throw new CliError(
      'resource_missing',
      `No ${KIND_LABEL[adoption.kind]} with id ${adoption.remote_id} in this project and environment.`,
      {
        param: 'adopt',
        fix: `Run \`bookrail ${endpointCommand(adoption.kind)} list --json\` to see the ids that exist here.`,
      },
    );
  }
  return object;
}

function endpointCommand(kind: EntityKind): string {
  return kind === 'resourceGroups' ? 'resource_groups' : kind;
}

/**
 * Validates a batch of adoptions against the current remote state, and against the config when
 * one is given. Throws on the first problem; writes nothing.
 */
export function validateAdoptions(
  adoptions: Adoption[],
  state: RemoteState,
  config: NormalizedConfig | null,
): void {
  const claimed = new Map<string, string>();
  for (const adoption of adoptions) {
    const object = findRemote(state, adoption);
    const existing = configIdOf(object);
    if (existing !== undefined && existing !== adoption.config_id) {
      throw new CliError(
        'already_managed',
        `${adoption.remote_id} already carries metadata.config_id "${existing}".`,
        {
          param: 'adopt',
          fix: `Use "${existing}" as the config id, or change it in the object's metadata first.`,
        },
      );
    }

    const owner = state.managed[adoption.kind].get(adoption.config_id);
    if (owner !== undefined && owner.id !== adoption.remote_id) {
      throw new CliError(
        'ambiguous_config_id',
        `Another ${KIND_LABEL[adoption.kind]} (${owner.id}) already carries metadata.config_id "${adoption.config_id}".`,
        {
          param: 'adopt',
          fix: 'Pick a config id that is free, or adopt that object instead.',
        },
      );
    }

    const key = `${adoption.kind}:${adoption.config_id}`;
    const twice = claimed.get(key);
    if (twice !== undefined && twice !== adoption.remote_id) {
      throw new CliError(
        'ambiguous_config_id',
        `Two --adopt flags claim "${adoption.config_id}" for ${KIND_LABEL[adoption.kind]}: ${twice} and ${adoption.remote_id}.`,
        { param: 'adopt', fix: 'Keep one of the two.' },
      );
    }
    claimed.set(key, adoption.remote_id);

    if (
      config !== null &&
      !config[adoption.kind].some((entry) => entry.id === adoption.config_id)
    ) {
      throw new CliError(
        'unknown_config_id',
        `The configuration declares no ${KIND_LABEL[adoption.kind]} with id "${adoption.config_id}".`,
        {
          param: 'adopt',
          fix: `Add it to bookrail.config.ts first: adopting an object the config does not declare would make this same push plan its deletion.`,
        },
      );
    }
  }
}

/**
 * The remote state as it *would* be once the adoptions are written, without writing them.
 *
 * This is what keeps the order of a push honest: the plan has to be computed against the
 * adopted world (an adopted object is an `update`, not a `create`), but the refusal for a plan
 * with deletions and no `--yes` has to happen **before** anything is written. Projecting the
 * stamp in memory gives both, and costs one fewer round trip than stamping and re-fetching.
 */
export function withAdoptions(state: RemoteState, adoptions: Adoption[]): RemoteState {
  if (adoptions.length === 0) return state;
  const stamp = new Map<string, string>();
  for (const adoption of adoptions) stamp.set(adoption.remote_id, adoption.config_id);

  const objects = {} as RemoteState['objects'];
  const managed = {} as RemoteState['managed'];
  const logical = {} as RemoteState['logical'];
  for (const kind of PUSH_ORDER) {
    objects[kind] = state.objects[kind].map((object) => {
      const configId = stamp.get(object.id);
      if (configId === undefined) return object;
      return {
        ...object,
        metadata: {
          ...((object.metadata as Record<string, unknown> | undefined) ?? {}),
          [CONFIG_ID_KEY]: configId,
        },
      };
    });
    const byConfigId = new Map<string, RemoteObject>();
    const byRemoteId = new Map<string, string>();
    for (const object of objects[kind]) {
      const configId = configIdOf(object);
      if (configId === undefined) continue;
      byConfigId.set(configId, object);
      byRemoteId.set(object.id, configId);
    }
    managed[kind] = byConfigId;
    logical[kind] = byRemoteId;
  }
  return { objects, managed, logical };
}

/** Writes the stamps. One `PATCH` per object, `metadata` only. */
export async function applyAdoptions(
  client: ApiClient,
  adoptions: Adoption[],
  state: RemoteState,
): Promise<AdoptionOutcome[]> {
  const outcomes: AdoptionOutcome[] = [];
  for (const adoption of adoptions) {
    const object = findRemote(state, adoption);
    const name = String(object.name ?? '');
    if (configIdOf(object) === adoption.config_id) {
      outcomes.push({ ...adoption, status: 'already', name });
      continue;
    }
    const metadata = {
      ...((object.metadata as Record<string, unknown> | undefined) ?? {}),
      [CONFIG_ID_KEY]: adoption.config_id,
    };
    await client.patch(`${ENDPOINT[adoption.kind]}/${adoption.remote_id}`, { metadata });
    outcomes.push({ ...adoption, status: 'adopted', name });
  }
  return outcomes;
}

/** Every unmanaged object, paired with the logical id `pull` derived from its name. */
export function adoptionsFromPull(
  state: RemoteState,
  assigned: { kind: EntityKind; id: string; config_id: string }[],
): Adoption[] {
  const byKind = new Set(PUSH_ORDER);
  return assigned
    .filter((entry) => byKind.has(entry.kind))
    .map((entry) => ({
      kind: entry.kind,
      config_id: entry.config_id,
      remote_id: entry.id,
    }))
    .filter((adoption) => {
      const object = state.objects[adoption.kind].find((row) => row.id === adoption.remote_id);
      return object !== undefined && configIdOf(object) === undefined;
    });
}
