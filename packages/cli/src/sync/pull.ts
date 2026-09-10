import {
  canonicalFromRemote,
  configIdOf,
  pricingRuleToConfig,
  secondsToDuration,
  type Canonical,
  type RemoteObject,
} from '../config/desired.js';
import { numberToDay, type EntityKind } from '../config/schema.js';
import { PUSH_ORDER } from '../config/normalize.js';
import type { RemoteState } from './plan.js';

export interface PulledConfig {
  /** The config object, in the shape `bookrail.config.ts` declares. */
  config: Record<string, unknown>;
  /** Objects that carry no `metadata.config_id` and are therefore not managed yet. */
  adopted: { kind: EntityKind; id: string; config_id: string }[];
}

/**
 * Turns a remote project back into a configuration file.
 *
 * Objects that were pushed from a config keep their logical id (`metadata.config_id`), so
 * `push` then `pull` then `push` is a no-op. Objects created elsewhere (through the API, or
 * by the dashboard) get a logical id derived from their name and are listed in `adopted`:
 * they are **not** managed until a push stamps a `config_id` on them, and pushing the pulled
 * file would create a second copy of each. The caller says so in `next_steps`; adopting them
 * is a separate, explicit command, because nothing is ever adopted by name.
 */
export function pullConfig(state: RemoteState, project?: string): PulledConfig {
  const index = { logicalIdOf: (kind: EntityKind, id: string) => idFor(kind, id) };
  const assigned: Record<EntityKind, Map<string, string>> = {
    locations: new Map(),
    schedules: new Map(),
    resources: new Map(),
    resourceGroups: new Map(),
    policies: new Map(),
    services: new Map(),
  };
  const used: Record<EntityKind, Set<string>> = {
    locations: new Set(),
    schedules: new Set(),
    resources: new Set(),
    resourceGroups: new Set(),
    policies: new Set(),
    services: new Set(),
  };
  const adopted: PulledConfig['adopted'] = [];

  // Pass one: every object gets its logical id, so that a reference can be resolved whatever
  // the order the kinds are rendered in.
  for (const kind of PUSH_ORDER) {
    for (const object of state.objects[kind]) {
      const declared = configIdOf(object);
      const id = declared ?? uniqueSlug(String(object.name ?? kind), used[kind]);
      used[kind].add(id);
      assigned[kind].set(object.id, id);
      if (declared === undefined) adopted.push({ kind, id: object.id, config_id: id });
    }
  }

  function idFor(kind: EntityKind, remoteId: string): string | undefined {
    return assigned[kind].get(remoteId);
  }

  const config: Record<string, unknown> = {};
  if (project !== undefined) config.project = project;

  for (const kind of PUSH_ORDER) {
    const entries = state.objects[kind].map((object) => {
      const canonical = canonicalFromRemote(kind, object, index, false);
      return {
        id: assigned[kind].get(object.id) ?? object.id,
        ...entryFromCanonical(kind, canonical),
      };
    });
    if (entries.length > 0) config[kind] = entries;
  }

  return { config, adopted };
}

/** Drops every value equal to the API default: the file says what the project decided. */
function omitDefaults(
  entry: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    out[key] = value;
  }
  return out;
}

function entryFromCanonical(kind: EntityKind, canonical: Canonical): Record<string, unknown> {
  switch (kind) {
    case 'locations':
      return omitDefaults(
        {
          name: canonical.name,
          timezone: canonical.timezone,
          address: canonical.address,
          metadata: canonical.metadata,
        },
        { address: null, metadata: {} },
      );
    case 'schedules':
      return omitDefaults(
        {
          name: canonical.name,
          timezone: canonical.timezone,
          rules: ((canonical.rules as Canonical[] | undefined) ?? []).map((rule) =>
            omitDefaults(
              {
                days: ((rule.days_of_week as number[] | undefined) ?? []).map(numberToDay),
                from: rule.start_time,
                to: rule.end_time,
                validFrom: rule.valid_from,
                validUntil: rule.valid_until,
              },
              { validFrom: null, validUntil: null },
            ),
          ),
          exceptions: ((canonical.exceptions as Canonical[] | undefined) ?? []).map((exception) =>
            omitDefaults(
              {
                date: exception.date,
                type: exception.type,
                from: exception.start_time,
                to: exception.end_time,
                reason: exception.reason,
              },
              { from: null, to: null, reason: null },
            ),
          ),
          metadata: canonical.metadata,
        },
        { timezone: null, rules: [], exceptions: [], metadata: {} },
      );
    case 'resources':
      return omitDefaults(
        {
          name: canonical.name,
          type: canonical.type,
          location: canonical.location,
          schedule: canonical.schedule,
          capacity: canonical.capacity,
          attributes: canonical.attributes,
          status: canonical.status,
          metadata: canonical.metadata,
        },
        {
          type: 'staff',
          location: null,
          schedule: null,
          capacity: 1,
          attributes: {},
          status: 'active',
          metadata: {},
        },
      );
    case 'resourceGroups':
      return omitDefaults(
        {
          name: canonical.name,
          resources: canonical.resources,
          selector: canonical.selector,
          allocationStrategy: canonical.allocation_strategy,
          metadata: canonical.metadata,
        },
        { resources: [], selector: null, allocationStrategy: 'first_available', metadata: {} },
      );
    case 'policies':
      return omitDefaults(
        {
          name: canonical.name,
          cancellation: ((canonical.cancellation as Canonical[] | undefined) ?? []).map(tier),
          reschedule: ((canonical.reschedule as Canonical[] | undefined) ?? []).map(tier),
          deposit: canonical.deposit,
          paymentTiming: canonical.payment_timing,
          paymentDeadline: canonical.payment_deadline,
          noShow: noShow(canonical.no_show),
          holdDuration:
            canonical.hold_duration_seconds === 600
              ? undefined
              : secondsToDuration(canonical.hold_duration_seconds as number),
          maxActiveBookingsPerCustomer: canonical.max_active_bookings_per_customer,
          requireCustomerConfirmation: canonical.require_customer_confirmation,
          requireProviderConfirmation: canonical.require_provider_confirmation,
          autoStart: canonical.auto_start,
          autoComplete: canonical.auto_complete,
          maxReschedules: canonical.max_reschedules,
          metadata: canonical.metadata,
        },
        {
          cancellation: [],
          reschedule: [],
          deposit: null,
          paymentTiming: 'none',
          paymentDeadline: null,
          noShow: null,
          maxActiveBookingsPerCustomer: null,
          requireCustomerConfirmation: false,
          requireProviderConfirmation: false,
          autoStart: false,
          autoComplete: false,
          maxReschedules: null,
          metadata: {},
        },
      );
    case 'services':
      return omitDefaults(
        {
          name: canonical.name,
          description: canonical.description,
          duration: canonical.duration,
          durationOptions: canonical.duration_options,
          durationRange: canonical.duration_range,
          capacityPerBooking: canonical.capacity_per_booking,
          bufferBefore: canonical.buffer_before,
          bufferAfter: canonical.buffer_after,
          slotInterval: canonical.slot_interval,
          alignTo: canonical.align_to,
          price: canonical.price,
          pricingRules: ((canonical.pricing_rules as unknown[] | undefined) ?? []).map(
            pricingRuleToConfig,
          ),
          policy: canonical.policy,
          bookingWindow: bookingWindow(canonical.booking_window),
          allowRecurring: canonical.allow_recurring,
          allowMultiDay: canonical.allow_multi_day,
          bufferSharing: canonical.buffer_sharing,
          allowSplit: canonical.allow_split,
          requirements: ((canonical.requirements as Canonical[] | undefined) ?? []).map(
            (requirement) =>
              omitDefaults(
                {
                  resource: requirement.resource,
                  group: requirement.group,
                  quantity: requirement.quantity,
                  consumes: requirement.consumes,
                  role: requirement.role,
                },
                { resource: null, group: null, quantity: 1, consumes: 'per_unit', role: null },
              ),
          ),
          metadata: canonical.metadata,
        },
        {
          description: null,
          duration: null,
          durationOptions: null,
          durationRange: null,
          capacityPerBooking: 1,
          bufferBefore: 0,
          bufferAfter: 0,
          slotInterval: null,
          alignTo: null,
          price: null,
          pricingRules: [],
          policy: null,
          bookingWindow: null,
          allowRecurring: false,
          allowMultiDay: false,
          bufferSharing: false,
          allowSplit: false,
          requirements: [],
          metadata: {},
        },
      );
  }
}

function tier(value: Canonical): Record<string, unknown> {
  return omitDefaults(
    { before: value.before, refundPercent: value.refund_percent, fee: value.fee },
    {},
  );
}

function noShow(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const source = value as Record<string, unknown>;
  return omitDefaults(
    {
      chargePercent: source.charge_percent,
      graceMinutes: source.grace_minutes,
      autoMark: source.auto_mark,
      markAfter: source.mark_after,
    },
    {},
  );
}

function bookingWindow(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const source = value as Record<string, unknown>;
  return omitDefaults(
    { minNoticeMinutes: source.min_notice_minutes, maxAdvanceDays: source.max_advance_days },
    {},
  );
}

/** `Campo 1` -> `campo_1`, unique within its kind. */
export function uniqueSlug(name: string, used: Set<string>): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'item';
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type { RemoteObject };
