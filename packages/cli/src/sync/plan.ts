import type { ApiClient } from '../api/client.js';
import { CliError } from '../errors.js';
import {
  canonicalFromConfig,
  canonicalFromRemote,
  changedFields,
  configIdOf,
  type Canonical,
  type RemoteObject,
} from '../config/desired.js';
import { KIND_LABEL, PUSH_ORDER, type NormalizedConfig } from '../config/normalize.js';
import type { EntityKind } from '../config/schema.js';
import type { Environment } from '../version.js';

export const ENDPOINT: Record<EntityKind, string> = {
  locations: '/v1/locations',
  schedules: '/v1/schedules',
  resources: '/v1/resources',
  resourceGroups: '/v1/resource_groups',
  policies: '/v1/policies',
  services: '/v1/services',
};

const EXPAND: Partial<Record<EntityKind, string[]>> = {
  services: ['requirements'],
};

export interface RemoteState {
  /** Every object of the project, by kind, in the order the API returned them. */
  objects: Record<EntityKind, RemoteObject[]>;
  /** `metadata.config_id` -> object, per kind. Only objects the config manages appear here. */
  managed: Record<EntityKind, Map<string, RemoteObject>>;
  /** Remote prefixed id -> logical id, per kind. */
  logical: Record<EntityKind, Map<string, string>>;
}

export async function fetchRemoteState(client: ApiClient): Promise<RemoteState> {
  const objects = {} as Record<EntityKind, RemoteObject[]>;
  const managed = {} as Record<EntityKind, Map<string, RemoteObject>>;
  const logical = {} as Record<EntityKind, Map<string, string>>;

  for (const kind of PUSH_ORDER) {
    const expand = EXPAND[kind];
    const list = await client.listAll<RemoteObject>(ENDPOINT[kind], expand ? { expand } : {});
    objects[kind] = list;
    const byConfigId = new Map<string, RemoteObject>();
    const byRemoteId = new Map<string, string>();
    for (const object of list) {
      const configId = configIdOf(object);
      if (configId === undefined) continue;
      const previous = byConfigId.get(configId);
      if (previous) {
        throw new CliError(
          'ambiguous_config_id',
          `Two ${KIND_LABEL[kind]}s carry metadata.config_id "${configId}": ${previous.id} and ${object.id}.`,
          {
            fix: `Delete or rename one of them (\`bookrail ${kind === 'resourceGroups' ? 'resource_groups' : kind} delete ${object.id}\`), then run the command again.`,
          },
        );
      }
      byConfigId.set(configId, object);
      byRemoteId.set(object.id, configId);
    }
    managed[kind] = byConfigId;
    logical[kind] = byRemoteId;
  }

  return { objects, managed, logical };
}

export type PlanAction = 'create' | 'update' | 'delete' | 'unchanged';

export interface PlanItem {
  kind: EntityKind;
  action: PlanAction;
  config_id: string;
  /** `null` for a creation: the object does not exist yet. */
  remote_id: string | null;
  name: string;
  /** Canonical field names that differ. Empty for `create`, `delete` and `unchanged`. */
  changes: string[];
}

export interface Plan {
  environment: Environment;
  items: PlanItem[];
  counts: Record<PlanAction, number>;
  /** Remote objects with no `metadata.config_id`: never created, never updated, never deleted. */
  unmanaged: { kind: EntityKind; id: string; name: string }[];
}

/**
 * The plan of a `push`, and the whole content of a `diff`.
 *
 * Two safety rules are structural rather than optional.
 *
 * 1. **Only objects carrying `metadata.config_id` are ever touched.** An object created
 *    through the API or the dashboard is invisible to the push: it is listed as `unmanaged`
 *    and left alone. A declarative tool that deleted what it did not create would be
 *    unusable on any project that has more than one client.
 * 2. **A deletion is a plan item, not a side effect.** `push` refuses to apply a plan that
 *    contains one unless `--yes` was given.
 */
export function buildPlan(
  config: NormalizedConfig,
  remote: RemoteState,
  environment: Environment,
): Plan {
  const items: PlanItem[] = [];
  const index = {
    logicalIdOf: (kind: EntityKind, remoteId: string): string | undefined =>
      remote.logical[kind].get(remoteId),
  };

  for (const kind of PUSH_ORDER) {
    const entries = config[kind];
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      const desired = canonicalFromConfig(kind, entry);
      const existing = remote.managed[kind].get(entry.id);
      if (!existing) {
        items.push({
          kind,
          action: 'create',
          config_id: entry.id,
          remote_id: null,
          name: String(desired.name ?? entry.id),
          changes: [],
        });
        continue;
      }
      const actual = canonicalFromRemote(kind, existing, index, 'tenant_id' in desired);
      const changes = changedFields(desired, actual);
      items.push({
        kind,
        action: changes.length === 0 ? 'unchanged' : 'update',
        config_id: entry.id,
        remote_id: existing.id,
        name: String(desired.name ?? entry.id),
        changes,
      });
    }

    for (const [configId, object] of remote.managed[kind]) {
      if (seen.has(configId)) continue;
      items.push({
        kind,
        action: 'delete',
        config_id: configId,
        remote_id: object.id,
        name: String(object.name ?? configId),
        changes: [],
      });
    }
  }

  const counts: Record<PlanAction, number> = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const item of items) counts[item.action] += 1;

  const unmanaged: Plan['unmanaged'] = [];
  for (const kind of PUSH_ORDER) {
    for (const object of remote.objects[kind]) {
      if (configIdOf(object) !== undefined) continue;
      unmanaged.push({ kind, id: object.id, name: String(object.name ?? '') });
    }
  }

  return { environment, items, counts, unmanaged };
}

export function planHasDeletions(plan: Plan): boolean {
  return plan.counts.delete > 0;
}

export function planIsEmpty(plan: Plan): boolean {
  return plan.counts.create + plan.counts.update + plan.counts.delete === 0;
}

export function canonicalOf(
  kind: EntityKind,
  remote: RemoteObject,
  state: RemoteState,
  declaresTenant = false,
): Canonical {
  return canonicalFromRemote(
    kind,
    remote,
    { logicalIdOf: (k, id) => state.logical[k].get(id) },
    declaresTenant,
  );
}
