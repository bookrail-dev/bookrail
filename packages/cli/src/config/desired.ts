import type { EntityKind } from './schema.js';
import { dayToNumber, type DayName } from './schema.js';
import type { Entry, NormalizedConfig } from './normalize.js';

/**
 * The comparable projection of one object.
 *
 * `push`, `diff` and `pull` all work on this shape: field names are the API's (snake_case),
 * every default the API would apply is written out explicitly, and references are **logical
 * ids**, never `res_...`. Two consequences fall out of that choice:
 *
 * - `diff` compares the config against the remote project without knowing which of the two it
 *   is looking at, so `push` followed by `diff` is empty by construction rather than by luck;
 * - `pull` is the same function read backwards, so a pulled config pushes back unchanged.
 *
 * `tenant_id` is the one field that is present only when the config declares it: a key scoped
 * to a tenant makes the server stamp every object with that tenant, and comparing a field the
 * caller never wrote would report a difference on every single object forever.
 */
export type Canonical = Record<string, unknown>;

/** A remote object as the API serialises it (`packages/api/src/serialize.ts`). */
export type RemoteObject = Record<string, unknown> & { id: string };

export const CONFIG_ID_KEY = 'config_id';

export function configIdOf(remote: RemoteObject): string | undefined {
  const metadata = remote.metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = (metadata as Record<string, unknown>)[CONFIG_ID_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function metadataWithoutConfigId(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[CONFIG_ID_KEY];
  return copy;
}

/** `09:00:00` and `09:00` are the same instant of the local clock; the API answers the short form. */
function hm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length === 8 && value.endsWith(':00') ? value.slice(0, 5) : value;
}

function nullish(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** `"10m"` / `"1h"` / `"90s"` / `"2d"` / `"1w"` -> seconds. A number passes through. */
export function durationToSeconds(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2];
  const factor =
    unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 604800;
  return Math.round(amount * factor);
}

export function secondsToDuration(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// --- config entry -> canonical -------------------------------------------------------------

type Get = (key: string) => unknown;

function reader(entry: Entry<Record<string, unknown>>): Get {
  return (key) => entry[key];
}

export function canonicalFromConfig(
  kind: EntityKind,
  entry: Entry<Record<string, unknown>>,
): Canonical {
  const get = reader(entry);
  const base: Canonical = {};
  const tenant = get('tenantId');
  if (tenant !== undefined) base.tenant_id = tenant;

  switch (kind) {
    case 'locations':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        timezone: get('timezone'),
        address: nullish(get('address')),
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
    case 'schedules':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        timezone: nullish(get('timezone')),
        rules: ((get('rules') as ConfigRule[] | undefined) ?? []).map(ruleFromConfig),
        exceptions: ((get('exceptions') as ConfigException[] | undefined) ?? []).map(
          exceptionFromConfig,
        ),
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
    case 'resources':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        type: (get('type') as string | undefined) ?? 'staff',
        location: nullish(get('location')),
        schedule: nullish(get('schedule')),
        capacity: (get('capacity') as number | undefined) ?? 1,
        attributes: (get('attributes') as Canonical | undefined) ?? {},
        status: (get('status') as string | undefined) ?? 'active',
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
    case 'resourceGroups':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        selector: nullish(get('selector')),
        allocation_strategy: (get('allocationStrategy') as string | undefined) ?? 'first_available',
        resources: (get('resources') as string[] | undefined) ?? [],
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
    case 'policies':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        cancellation: ((get('cancellation') as ConfigTier[] | undefined) ?? []).map(tierFromConfig),
        reschedule: ((get('reschedule') as ConfigTier[] | undefined) ?? []).map(tierFromConfig),
        deposit: nullish(get('deposit')),
        payment_timing: (get('paymentTiming') as string | undefined) ?? 'none',
        payment_deadline: nullish(get('paymentDeadline')),
        no_show: noShowFromConfig(get('noShow')),
        hold_duration_seconds:
          get('holdDuration') === undefined
            ? 600
            : durationToSeconds(get('holdDuration') as string | number),
        max_active_bookings_per_customer: nullish(get('maxActiveBookingsPerCustomer')),
        require_customer_confirmation: (get('requireCustomerConfirmation') as boolean) ?? false,
        require_provider_confirmation: (get('requireProviderConfirmation') as boolean) ?? false,
        auto_start: (get('autoStart') as boolean) ?? false,
        auto_complete: (get('autoComplete') as boolean) ?? false,
        max_reschedules: nullish(get('maxReschedules')),
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
    case 'services':
      return {
        ...base,
        name: (get('name') as string | undefined) ?? entry.id,
        description: nullish(get('description')),
        duration: nullish(get('duration')),
        duration_options: nullish(get('durationOptions')),
        duration_range: nullish(get('durationRange')),
        capacity_per_booking: (get('capacityPerBooking') as number | undefined) ?? 1,
        buffer_before: (get('bufferBefore') as number | undefined) ?? 0,
        buffer_after: (get('bufferAfter') as number | undefined) ?? 0,
        slot_interval: nullish(get('slotInterval')),
        align_to: nullish(get('alignTo')),
        price: nullish(get('price')),
        pricing_rules: ((get('pricingRules') as unknown[] | undefined) ?? []).map(
          pricingRuleFromConfig,
        ),
        policy: nullish(get('policy')),
        booking_window: bookingWindowFromConfig(get('bookingWindow')),
        allow_recurring: (get('allowRecurring') as boolean) ?? false,
        allow_multi_day: (get('allowMultiDay') as boolean) ?? false,
        buffer_sharing: (get('bufferSharing') as boolean) ?? false,
        allow_split: (get('allowSplit') as boolean) ?? false,
        requirements: ((get('requirements') as ConfigRequirement[] | undefined) ?? []).map(
          requirementFromConfig,
        ),
        metadata: (get('metadata') as Canonical | undefined) ?? {},
      };
  }
}

interface ConfigRule {
  days: (DayName | number)[];
  from: string;
  to: string;
  validFrom?: string | null;
  validUntil?: string | null;
}

interface ConfigException {
  date: string;
  type: 'closed' | 'open';
  from?: string | null;
  to?: string | null;
  reason?: string | null;
}

interface ConfigTier {
  before: string;
  refundPercent?: number;
  fee?: number;
}

interface ConfigRequirement {
  resource?: string;
  group?: string;
  quantity?: number;
  consumes?: 'per_unit' | 'whole';
  role?: string | null;
}

function ruleFromConfig(rule: ConfigRule): Canonical {
  return {
    days_of_week: [...new Set(rule.days.map(dayToNumber))].sort((a, b) => a - b),
    start_time: hm(rule.from),
    end_time: hm(rule.to),
    valid_from: rule.validFrom ?? null,
    valid_until: rule.validUntil ?? null,
  };
}

function exceptionFromConfig(exception: ConfigException): Canonical {
  return {
    date: exception.date,
    type: exception.type,
    start_time: exception.from ? hm(exception.from) : null,
    end_time: exception.to ? hm(exception.to) : null,
    reason: exception.reason ?? null,
  };
}

function tierFromConfig(tier: ConfigTier): Canonical {
  const out: Canonical = { before: tier.before };
  if (tier.refundPercent !== undefined) out.refund_percent = tier.refundPercent;
  if (tier.fee !== undefined) out.fee = tier.fee;
  return out;
}

/**
 * The camelCase / snake_case border for `pricingRules`, in both directions.
 *
 * The config file is camelCase from end to end (`refundPercent`, `chargePercent`, `autoMark`)
 * and the API is snake_case, so a pricing rule crosses the same border every other nested
 * object crosses. The canonical form used for the diff is the **API's**, so a rule pushed from
 * a file and a rule read back from the server compare as the same value.
 *
 * The map is explicit and total rather than a generic case converter: an unknown key is left
 * exactly as it is, so a typo reaches the schema, which refuses it, instead of being renamed
 * into something that looks deliberate.
 */
const PRICING_RULE_KEYS: Readonly<Record<string, string>> = {
  priceAdd: 'price_add',
  priceMultiplier: 'price_multiplier',
};

const PRICING_WHEN_KEYS: Readonly<Record<string, string>> = {
  timeFrom: 'time_from',
  timeTo: 'time_to',
  dateFrom: 'date_from',
  dateTo: 'date_to',
  resourceId: 'resource_id',
  durationMin: 'duration_min',
};

function renameKeys(value: unknown, map: Readonly<Record<string, string>>): Canonical {
  const out: Canonical = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[map[key] ?? key] = item;
  }
  return out;
}

function invert(map: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
}

/** A rule as the config file writes it, as the API takes it. */
export function pricingRuleFromConfig(rule: unknown): Canonical {
  const out = renameKeys(rule, PRICING_RULE_KEYS);
  if ('when' in out) out.when = renameKeys(out.when, PRICING_WHEN_KEYS);
  return out;
}

/** A rule as the API returns it, as `bookrail pull` writes it into the config file. */
export function pricingRuleToConfig(rule: unknown): Canonical {
  const out = renameKeys(rule, invert(PRICING_RULE_KEYS));
  if ('when' in out) out.when = renameKeys(out.when, invert(PRICING_WHEN_KEYS));
  return out;
}

function noShowFromConfig(value: unknown): Canonical | null {
  if (value === undefined || value === null) return null;
  const source = value as {
    chargePercent?: number;
    graceMinutes?: number;
    autoMark?: boolean;
    markAfter?: string;
  };
  const out: Canonical = {};
  if (source.chargePercent !== undefined) out.charge_percent = source.chargePercent;
  if (source.graceMinutes !== undefined) out.grace_minutes = source.graceMinutes;
  if (source.autoMark !== undefined) out.auto_mark = source.autoMark;
  if (source.markAfter !== undefined) out.mark_after = source.markAfter;
  return out;
}

function bookingWindowFromConfig(value: unknown): Canonical | null {
  if (value === undefined || value === null) return null;
  const source = value as { minNoticeMinutes?: number; maxAdvanceDays?: number };
  const out: Canonical = {};
  if (source.minNoticeMinutes !== undefined) out.min_notice_minutes = source.minNoticeMinutes;
  if (source.maxAdvanceDays !== undefined) out.max_advance_days = source.maxAdvanceDays;
  return out;
}

function requirementFromConfig(requirement: ConfigRequirement): Canonical {
  return {
    resource: requirement.resource ?? null,
    group: requirement.group ?? null,
    quantity: requirement.quantity ?? 1,
    consumes: requirement.consumes ?? 'per_unit',
    role: requirement.role ?? null,
  };
}

// --- remote object -> canonical ------------------------------------------------------------

export interface RemoteIndex {
  /** Remote prefixed id -> logical id, for every object this config manages. */
  logicalIdOf: (kind: EntityKind, remoteId: string) => string | undefined;
}

/**
 * A remote id that no config entry claims.
 *
 * It is kept in the canonical form rather than dropped so that a group whose members were
 * changed outside the config shows up as a difference instead of silently comparing equal.
 */
export function unmanagedRef(remoteId: string): string {
  return `@remote:${remoteId}`;
}

export function canonicalFromRemote(
  kind: EntityKind,
  remote: RemoteObject,
  index: RemoteIndex,
  declaresTenant: boolean,
): Canonical {
  const ref = (target: EntityKind, value: unknown): string | null => {
    if (typeof value !== 'string' || value === '') return null;
    return index.logicalIdOf(target, value) ?? unmanagedRef(value);
  };
  const base: Canonical = {};
  if (declaresTenant) base.tenant_id = nullish(remote.tenant_id);

  switch (kind) {
    case 'locations':
      return {
        ...base,
        name: remote.name,
        timezone: remote.timezone,
        address: nullish(remote.address),
        metadata: metadataWithoutConfigId(remote.metadata),
      };
    case 'schedules':
      return {
        ...base,
        name: remote.name,
        timezone: nullish(remote.timezone),
        rules: ((remote.rules as Canonical[] | undefined) ?? []).map((rule) => ({
          days_of_week: [...((rule.days_of_week as number[] | undefined) ?? [])].sort(
            (a, b) => a - b,
          ),
          start_time: hm(rule.start_time),
          end_time: hm(rule.end_time),
          valid_from: nullish(rule.valid_from),
          valid_until: nullish(rule.valid_until),
        })),
        exceptions: ((remote.exceptions as Canonical[] | undefined) ?? []).map((exception) => ({
          date: exception.date,
          type: exception.type,
          start_time: exception.start_time ? hm(exception.start_time) : null,
          end_time: exception.end_time ? hm(exception.end_time) : null,
          reason: nullish(exception.reason),
        })),
        metadata: metadataWithoutConfigId(remote.metadata),
      };
    case 'resources':
      return {
        ...base,
        name: remote.name,
        type: remote.type,
        location: ref('locations', remote.location_id),
        schedule: ref('schedules', remote.schedule_id),
        capacity: remote.capacity,
        attributes: (remote.attributes as Canonical | undefined) ?? {},
        status: remote.status,
        metadata: metadataWithoutConfigId(remote.metadata),
      };
    case 'resourceGroups':
      return {
        ...base,
        name: remote.name,
        selector: nullish(remote.selector),
        allocation_strategy: remote.allocation_strategy,
        resources: ((remote.resource_ids as string[] | undefined) ?? []).map(
          (id) => index.logicalIdOf('resources', id) ?? unmanagedRef(id),
        ),
        metadata: metadataWithoutConfigId(remote.metadata),
      };
    case 'policies':
      return {
        ...base,
        name: remote.name,
        cancellation: (remote.cancellation as Canonical[] | undefined) ?? [],
        reschedule: (remote.reschedule as Canonical[] | undefined) ?? [],
        deposit: nullish(remote.deposit),
        payment_timing: remote.payment_timing,
        payment_deadline: nullish(remote.payment_deadline),
        no_show: nullish(remote.no_show),
        hold_duration_seconds: remote.hold_duration_seconds,
        max_active_bookings_per_customer: nullish(remote.max_active_bookings_per_customer),
        require_customer_confirmation: remote.require_customer_confirmation,
        require_provider_confirmation: remote.require_provider_confirmation,
        auto_start: remote.auto_start,
        auto_complete: remote.auto_complete,
        max_reschedules: nullish(remote.max_reschedules),
        metadata: metadataWithoutConfigId(remote.metadata),
      };
    case 'services':
      return {
        ...base,
        name: remote.name,
        description: nullish(remote.description),
        duration: nullish(remote.duration),
        duration_options: nullish(remote.duration_options),
        duration_range: nullish(remote.duration_range),
        capacity_per_booking: remote.capacity_per_booking,
        buffer_before: remote.buffer_before,
        buffer_after: remote.buffer_after,
        slot_interval: nullish(remote.slot_interval),
        align_to: nullish(remote.align_to),
        price: nullish(remote.price),
        pricing_rules: (remote.pricing_rules as unknown[] | undefined) ?? [],
        policy: ref('policies', remote.policy_id),
        booking_window: nullish(remote.booking_window),
        allow_recurring: remote.allow_recurring,
        allow_multi_day: remote.allow_multi_day,
        buffer_sharing: remote.buffer_sharing,
        allow_split: remote.allow_split,
        requirements: ((remote.requirements as Canonical[] | undefined) ?? []).map(
          (requirement) => ({
            resource: ref('resources', requirement.resource_id),
            group: ref('resourceGroups', requirement.resource_group_id),
            quantity: requirement.quantity,
            consumes: requirement.consumes,
            role: nullish(requirement.role),
          }),
        ),
        metadata: metadataWithoutConfigId(remote.metadata),
      };
  }
}

// --- canonical -> API request body ----------------------------------------------------------

export type ResolveRef = (kind: EntityKind, logicalId: string) => string;

/**
 * The request body of `POST`/`PATCH`, from the canonical form.
 *
 * Every field the canonical form carries is sent, including the ones equal to the API's own
 * default: a `PATCH` that omitted them would leave a previously customised value in place,
 * and the config is meant to be the whole truth about the object.
 */
export function apiBody(
  kind: EntityKind,
  canonical: Canonical,
  configId: string,
  resolve: ResolveRef,
): Record<string, unknown> {
  const metadata = {
    ...((canonical.metadata as Canonical | undefined) ?? {}),
    [CONFIG_ID_KEY]: configId,
  };
  const tenant = 'tenant_id' in canonical ? { tenant_id: canonical.tenant_id } : {};

  switch (kind) {
    case 'locations':
      return {
        name: canonical.name,
        timezone: canonical.timezone,
        address: canonical.address ?? null,
        ...tenant,
        metadata,
      };
    case 'schedules':
      // Calendar exceptions are not part of `PATCH /v1/schedules/{id}`: they have endpoints of
      // their own, and the push applies them separately.
      return {
        name: canonical.name,
        timezone: canonical.timezone ?? null,
        rules: canonical.rules,
        metadata,
      };
    case 'resources':
      return {
        name: canonical.name,
        type: canonical.type,
        location_id: refId('locations', canonical.location, resolve),
        schedule_id: refId('schedules', canonical.schedule, resolve),
        capacity: canonical.capacity,
        attributes: canonical.attributes,
        status: canonical.status,
        ...tenant,
        metadata,
      };
    case 'resourceGroups':
      return {
        name: canonical.name,
        selector: canonical.selector ?? null,
        allocation_strategy: canonical.allocation_strategy,
        resource_ids: ((canonical.resources as string[] | undefined) ?? []).map((id) =>
          resolve('resources', id),
        ),
        metadata,
      };
    case 'policies':
      return {
        name: canonical.name,
        cancellation: canonical.cancellation,
        reschedule: canonical.reschedule,
        deposit: canonical.deposit ?? null,
        payment_timing: canonical.payment_timing,
        payment_deadline: canonical.payment_deadline ?? null,
        no_show: canonical.no_show ?? null,
        hold_duration_seconds: canonical.hold_duration_seconds,
        max_active_bookings_per_customer: canonical.max_active_bookings_per_customer ?? null,
        require_customer_confirmation: canonical.require_customer_confirmation,
        require_provider_confirmation: canonical.require_provider_confirmation,
        auto_start: canonical.auto_start,
        auto_complete: canonical.auto_complete,
        max_reschedules: canonical.max_reschedules ?? null,
        metadata,
      };
    case 'services': {
      const body: Record<string, unknown> = {
        name: canonical.name,
        description: canonical.description ?? null,
        capacity_per_booking: canonical.capacity_per_booking,
        buffer_before: canonical.buffer_before,
        buffer_after: canonical.buffer_after,
        price: canonical.price ?? null,
        pricing_rules: canonical.pricing_rules,
        policy_id: refId('policies', canonical.policy, resolve),
        booking_window: canonical.booking_window ?? null,
        allow_recurring: canonical.allow_recurring,
        allow_multi_day: canonical.allow_multi_day,
        buffer_sharing: canonical.buffer_sharing,
        allow_split: canonical.allow_split,
        requirements: ((canonical.requirements as Canonical[] | undefined) ?? []).map(
          (requirement) => ({
            ...(requirement.resource
              ? { resource_id: resolve('resources', requirement.resource as string) }
              : {}),
            ...(requirement.group
              ? { resource_group_id: resolve('resourceGroups', requirement.group as string) }
              : {}),
            quantity: requirement.quantity,
            consumes: requirement.consumes,
            role: requirement.role ?? null,
          }),
        ),
        ...tenant,
        metadata,
      };
      // Sent unconditionally, `null` included. They are `nullish` in the API schema, which is
      // what lets a push **remove** a grid by taking the field out of the file: while they
      // were `optional` the CLI had to omit them, and a `slot_interval` already stored could
      // never be cleared.
      body.slot_interval = canonical.slot_interval ?? null;
      body.align_to = canonical.align_to ?? null;
      // Exactly one of the three duration forms, as the API's own CHECK requires.
      if (canonical.duration !== null && canonical.duration !== undefined) {
        body.duration = canonical.duration;
      } else if (canonical.duration_options !== null && canonical.duration_options !== undefined) {
        body.duration_options = canonical.duration_options;
      } else if (canonical.duration_range !== null && canonical.duration_range !== undefined) {
        body.duration_range = canonical.duration_range;
      }
      return body;
    }
  }
}

function refId(kind: EntityKind, value: unknown, resolve: ResolveRef): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return resolve(kind, value);
}

// --- comparison ------------------------------------------------------------------------------

/** Key-order independent equality, so a jsonb column that came back reordered is not a diff. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** The names of the fields that differ, in the order they appear in the desired object. */
export function changedFields(desired: Canonical, actual: Canonical): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (stableStringify(value) !== stableStringify(actual[key])) changed.push(key);
  }
  return changed;
}

export function canonicalConfig(
  config: NormalizedConfig,
): Record<EntityKind, Map<string, Canonical>> {
  const build = (
    kind: EntityKind,
    entries: Entry<Record<string, unknown>>[],
  ): Map<string, Canonical> =>
    new Map(entries.map((entry) => [entry.id, canonicalFromConfig(kind, entry)]));
  return {
    locations: build('locations', config.locations),
    schedules: build('schedules', config.schedules),
    resources: build('resources', config.resources),
    resourceGroups: build('resourceGroups', config.resourceGroups),
    policies: build('policies', config.policies),
    services: build('services', config.services),
  };
}
