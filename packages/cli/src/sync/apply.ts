import type { ApiClient } from '../api/client.js';
import { CliError } from '../errors.js';
import {
  apiBody,
  canonicalFromConfig,
  type Canonical,
  type RemoteObject,
} from '../config/desired.js';
import { KIND_LABEL, PUSH_ORDER, type NormalizedConfig } from '../config/normalize.js';
import type { EntityKind } from '../config/schema.js';
import { ENDPOINT, type Plan, type PlanItem, type RemoteState } from './plan.js';

export interface AppliedItem {
  kind: EntityKind;
  action: 'create' | 'update' | 'delete';
  config_id: string;
  remote_id: string;
}

export interface ApplyResult {
  applied: AppliedItem[];
  /** Schedule exceptions added and removed, which have their own endpoints. */
  exceptions: { added: number; removed: number };
}

/**
 * Applies a plan, in dependency order:
 * location -> schedule -> resource -> group -> policy -> service, and the exact reverse for
 * deletions.
 *
 * Creations and updates of a whole kind are finished before the next kind starts, which is
 * what lets a service created in the same push reference a resource group created two steps
 * earlier. Deletions come last for the mirror reason: a resource that a group still lists
 * cannot be removed until the group has been updated without it, and the group update is part
 * of the same pass.
 *
 * There is no transaction across the API: a push that fails halfway leaves what it already
 * wrote. That is why every write is idempotent by config id: re-running the same push after
 * a failure converges instead of duplicating.
 */
export async function applyPlan(
  client: ApiClient,
  config: NormalizedConfig,
  plan: Plan,
  remote: RemoteState,
): Promise<ApplyResult> {
  const resolved: Record<EntityKind, Map<string, string>> = {
    locations: new Map(),
    schedules: new Map(),
    resources: new Map(),
    resourceGroups: new Map(),
    policies: new Map(),
    services: new Map(),
  };
  for (const kind of PUSH_ORDER) {
    for (const [configId, object] of remote.managed[kind]) resolved[kind].set(configId, object.id);
  }

  const resolve = (kind: EntityKind, logicalId: string): string => {
    const id = resolved[kind].get(logicalId);
    if (id === undefined) {
      throw new CliError(
        'unresolved_reference',
        `No ${KIND_LABEL[kind]} with id "${logicalId}" exists yet when it is referenced.`,
        {
          fix: 'Declare it in the config, or run `bookrail push` again after the failure is fixed.',
        },
      );
    }
    return id;
  };

  const applied: AppliedItem[] = [];
  const exceptions = { added: 0, removed: 0 };
  const byConfigId = new Map<string, Canonical>();
  for (const kind of PUSH_ORDER) {
    for (const entry of config[kind]) {
      byConfigId.set(`${kind}:${entry.id}`, canonicalFromConfig(kind, entry));
    }
  }

  for (const kind of PUSH_ORDER) {
    const writes = plan.items.filter(
      (item): item is PlanItem & { action: 'create' | 'update' } =>
        item.kind === kind && (item.action === 'create' || item.action === 'update'),
    );
    for (const item of writes) {
      const canonical = byConfigId.get(`${kind}:${item.config_id}`);
      if (!canonical) continue;
      const body = apiBody(kind, canonical, item.config_id, resolve);
      const object =
        item.action === 'create'
          ? (await client.post<RemoteObject>(ENDPOINT[kind], body)).data
          : (await client.patch<RemoteObject>(`${ENDPOINT[kind]}/${item.remote_id}`, body)).data;
      resolved[kind].set(item.config_id, object.id);
      applied.push({
        kind,
        action: item.action,
        config_id: item.config_id,
        remote_id: object.id,
      });
      if (kind === 'schedules') {
        const delta = await syncExceptions(client, object, canonical);
        exceptions.added += delta.added;
        exceptions.removed += delta.removed;
      }
    }
  }

  for (const kind of [...PUSH_ORDER].reverse()) {
    const deletions = plan.items.filter((item) => item.kind === kind && item.action === 'delete');
    for (const item of deletions) {
      await client.delete(`${ENDPOINT[kind]}/${item.remote_id}`);
      applied.push({
        kind,
        action: 'delete',
        config_id: item.config_id,
        remote_id: item.remote_id ?? '',
      });
    }
  }

  return { applied, exceptions };
}

interface RemoteException {
  id: string;
  date: string;
  type: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}

function exceptionKey(value: {
  date: unknown;
  type: unknown;
  start_time: unknown;
  end_time: unknown;
  reason: unknown;
}): string {
  return [
    value.date,
    value.type,
    value.start_time ?? '',
    value.end_time ?? '',
    value.reason ?? '',
  ].join('|');
}

/**
 * Brings a schedule's exceptions in line with the config.
 *
 * They are not part of `PATCH /v1/schedules/{id}`: they have endpoints of their own, so the
 * push adds and removes them one by one. Matching is by value, not by id: a config file has no
 * way to name an exception, and two exceptions with the same date, kind, hours and reason are
 * the same exception.
 */
async function syncExceptions(
  client: ApiClient,
  schedule: RemoteObject,
  canonical: Canonical,
): Promise<{ added: number; removed: number }> {
  const desired = (canonical.exceptions as Record<string, unknown>[] | undefined) ?? [];
  const current = (schedule.exceptions as unknown as RemoteException[] | undefined) ?? [];

  const wanted = new Map<string, number>();
  for (const exception of desired) {
    const key = exceptionKey(exception as never);
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }

  let removed = 0;
  for (const exception of current) {
    const key = exceptionKey(exception);
    const count = wanted.get(key) ?? 0;
    if (count > 0) {
      wanted.set(key, count - 1);
      continue;
    }
    await client.delete(`/v1/schedules/${schedule.id}/exceptions/${exception.id}`);
    removed += 1;
  }

  let added = 0;
  for (const exception of desired) {
    const key = exceptionKey(exception as never);
    const outstanding = wanted.get(key) ?? 0;
    if (outstanding === 0) continue;
    wanted.set(key, outstanding - 1);
    await client.post(`/v1/schedules/${schedule.id}/exceptions`, {
      date: exception.date,
      type: exception.type,
      start_time: exception.start_time ?? null,
      end_time: exception.end_time ?? null,
      reason: exception.reason ?? null,
    });
    added += 1;
  }

  return { added, removed };
}

export function summarizePlan(plan: Plan): string {
  const parts: string[] = [];
  for (const action of ['create', 'update', 'delete', 'unchanged'] as const) {
    if (plan.counts[action] > 0) parts.push(`${plan.counts[action]} to ${action}`);
  }
  return parts.length === 0 ? 'nothing to do' : parts.join(', ');
}

export function planRows(plan: Plan): string[][] {
  return plan.items
    .filter((item: PlanItem) => item.action !== 'unchanged')
    .map((item) => [
      item.action,
      KIND_LABEL[item.kind],
      item.config_id,
      item.name,
      item.changes.join(', '),
    ]);
}
