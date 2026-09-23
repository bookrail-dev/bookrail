import {
  encodeId,
  priceRuleOfRow,
  type Environment,
  type PriceRuleRef,
  type PricingRule,
} from '@bookrail/shared';
import type {
  AvailabilityResult,
  AvailabilitySlot,
  ExplainEntry,
  ResourceOption,
} from '@bookrail/engine';
import type {
  bookings,
  customers,
  events,
  locations,
  payments,
  policies,
  resourceGroups,
  resources,
  scheduleExceptions,
  scheduleRules,
  schedules,
  serviceRequirements,
  services,
  webhookDeliveries,
  webhooks,
} from '@bookrail/db';
import type {
  Availability,
  AvailabilitySlot as AvailabilitySlotView,
  Booking,
  BookingAllocation,
  Customer,
  Event,
  ExplainEntry as ExplainEntryView,
  Hold,
  HoldCreated,
  Location,
  Payment,
  Policy,
  Resource,
  ResourceBlock,
  ResourceGroup,
  ResourceOption as ResourceOptionView,
  Schedule,
  ScheduleException,
  ScheduleRule,
  Service,
  ServiceRequirement,
  Webhook,
  WebhookDelivery,
} from './schemas/responses.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

/**
 * A free-form JSON value, as it comes out of a `jsonb` column.
 *
 * Every response has a schema and every serializer is typed against it, so
 * this type survives only where the column really is a free record: `metadata`, `attributes`,
 * `address`, `selector`, the stored policy and pricing blobs, `event.data`. Drizzle types a
 * `jsonb` column as `unknown`, so the two helpers below are the **only** place a cast happens:
 * the write path validates these values as records (`metadataSchema`, `z.record(z.unknown())`)
 * and nothing between the two touches them.
 */
export type JsonObject = Record<string, unknown>;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toMetadata(value: unknown): JsonObject {
  return (value ?? {}) as JsonObject;
}

/** {@link toMetadata} for a nullable column: `null` stays `null`. */
function toJsonObjectOrNull(value: unknown): JsonObject | null {
  return value === null || value === undefined ? null : (value as JsonObject);
}

/** {@link toMetadata} for a `jsonb` column holding an array of objects. */
function toJsonArray(value: unknown): JsonObject[] {
  return (value ?? []) as JsonObject[];
}

/**
 * `services.pricing_rules` on the way out.
 *
 * Cast rather than re-parsed, like every other `jsonb` column: the **write** path validates the
 * rules strictly, so what is in the column is what the schema allows, and re-parsing on read
 * would let a row written before that schema come back reshaped, which would break the one
 * property `push`/`pull` depends on, that reading a service and writing it back is the
 * identity.
 */
function toPricingRules(value: unknown): PricingRule[] {
  return (value ?? []) as PricingRule[];
}

/** `09:00:00` from Postgres becomes `09:00` when the seconds are zero: easier to read, lossless. */
function timeOfDay(value: string | null): string | null {
  if (!value) return null;
  return value.endsWith(':00') && value.length === 8 ? value.slice(0, 5) : value;
}

export function serializeLocation(row: Row<typeof locations>): Location {
  return {
    id: encodeId('location', row.id),
    object: 'location',
    name: row.name,
    timezone: row.timezone,
    address: toJsonObjectOrNull(row.address),
    tenant_id: row.tenantId,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function serializeScheduleRule(row: Row<typeof scheduleRules>): ScheduleRule {
  return {
    id: encodeId('schedule_rule', row.id),
    object: 'schedule_rule',
    schedule_id: encodeId('schedule', row.scheduleId),
    days_of_week: row.daysOfWeek,
    start_time: timeOfDay(row.startTime),
    end_time: timeOfDay(row.endTime),
    valid_from: row.validFrom,
    valid_until: row.validUntil,
  };
}

export function serializeScheduleException(row: Row<typeof scheduleExceptions>): ScheduleException {
  return {
    id: encodeId('schedule_exception', row.id),
    object: 'schedule_exception',
    schedule_id: encodeId('schedule', row.scheduleId),
    date: row.date,
    type: row.type,
    start_time: timeOfDay(row.startTime),
    end_time: timeOfDay(row.endTime),
    reason: row.reason,
  };
}

export function serializeSchedule(
  row: Row<typeof schedules>,
  rules: Row<typeof scheduleRules>[],
  exceptions: Row<typeof scheduleExceptions>[],
): Schedule {
  return {
    id: encodeId('schedule', row.id),
    object: 'schedule',
    name: row.name,
    timezone: row.timezone,
    rules: rules.map(serializeScheduleRule),
    exceptions: exceptions.map(serializeScheduleException),
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export interface ResourceExpansions {
  schedule?: Row<typeof schedules> | null;
  scheduleRules?: Row<typeof scheduleRules>[];
  scheduleExceptions?: Row<typeof scheduleExceptions>[];
}

export function serializeResource(
  row: Row<typeof resources>,
  expansions: ResourceExpansions = {},
): Resource {
  const object: Resource = {
    id: encodeId('resource', row.id),
    object: 'resource',
    name: row.name,
    type: row.type,
    location_id: row.locationId ? encodeId('location', row.locationId) : null,
    schedule_id: row.scheduleId ? encodeId('schedule', row.scheduleId) : null,
    capacity: row.capacity,
    attributes: toMetadata(row.attributes),
    status: row.status,
    tenant_id: row.tenantId,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  if ('schedule' in expansions) {
    object.schedule = expansions.schedule
      ? serializeSchedule(
          expansions.schedule,
          expansions.scheduleRules ?? [],
          expansions.scheduleExceptions ?? [],
        )
      : null;
  }
  return object;
}

export interface ResourceBlockRow {
  id: string;
  resourceId: string;
  from: Date;
  to: Date;
  reason: string | null;
  metadata: unknown;
  environment: Environment;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeResourceBlock(row: ResourceBlockRow): ResourceBlock {
  return {
    id: encodeId('resource_block', row.id),
    object: 'resource_block',
    resource_id: encodeId('resource', row.resourceId),
    from: iso(row.from),
    to: iso(row.to),
    reason: row.reason,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function serializeResourceGroup(
  row: Row<typeof resourceGroups>,
  memberIds: string[],
  expandedResources?: Row<typeof resources>[],
): ResourceGroup {
  const object: ResourceGroup = {
    id: encodeId('resource_group', row.id),
    object: 'resource_group',
    name: row.name,
    selector: toJsonObjectOrNull(row.selector),
    allocation_strategy: row.allocationStrategy,
    resource_ids: memberIds.map((id) => encodeId('resource', id)),
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  if (expandedResources) {
    object.resources = expandedResources.map((r) => serializeResource(r));
  }
  return object;
}

export function serializePolicy(row: Row<typeof policies>): Policy {
  return {
    id: encodeId('policy', row.id),
    object: 'policy',
    name: row.name,
    cancellation: toJsonArray(row.cancellation),
    reschedule: toJsonArray(row.reschedule),
    deposit: toJsonObjectOrNull(row.deposit),
    payment_timing: row.paymentTiming,
    payment_deadline: row.paymentDeadline,
    no_show: toJsonObjectOrNull(row.noShow),
    hold_duration_seconds: row.holdDurationSeconds,
    max_active_bookings_per_customer: row.maxActiveBookingsPerCustomer,
    require_customer_confirmation: row.requireCustomerConfirmation,
    require_provider_confirmation: row.requireProviderConfirmation,
    auto_start: row.autoStart,
    auto_complete: row.autoComplete,
    max_reschedules: row.maxReschedules,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function serializeServiceRequirement(
  row: Row<typeof serviceRequirements>,
): ServiceRequirement {
  return {
    id: encodeId('service_requirement', row.id),
    object: 'service_requirement',
    service_id: encodeId('service', row.serviceId),
    resource_id: row.resourceId ? encodeId('resource', row.resourceId) : null,
    resource_group_id: row.resourceGroupId ? encodeId('resource_group', row.resourceGroupId) : null,
    quantity: row.quantity,
    consumes: row.consumes,
    role: row.role,
  };
}

export function serializeService(
  row: Row<typeof services>,
  requirementIds: string[],
  expandedRequirements?: Row<typeof serviceRequirements>[],
): Service {
  const object: Service = {
    id: encodeId('service', row.id),
    object: 'service',
    name: row.name,
    description: row.description,
    duration: row.durationMinutes,
    duration_options: row.durationOptions,
    duration_range:
      row.durationMinMinutes !== null && row.durationMaxMinutes !== null
        ? { min: row.durationMinMinutes, max: row.durationMaxMinutes }
        : null,
    capacity_per_booking: row.capacityPerBooking,
    buffer_before: row.bufferBeforeMinutes,
    buffer_after: row.bufferAfterMinutes,
    slot_interval: row.slotIntervalMinutes,
    align_to: row.alignTo,
    price:
      row.priceAmount !== null && row.priceCurrency !== null
        ? { amount: row.priceAmount, currency: row.priceCurrency }
        : null,
    pricing_rules: toPricingRules(row.pricingRules),
    policy_id: row.policyId ? encodeId('policy', row.policyId) : null,
    booking_window: toJsonObjectOrNull(row.bookingWindow),
    allow_recurring: row.allowRecurring,
    allow_multi_day: row.allowMultiDay,
    buffer_sharing: row.bufferSharing,
    allow_split: row.allowSplit,
    requirement_ids: requirementIds.map((id) => encodeId('service_requirement', id)),
    tenant_id: row.tenantId,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  if (expandedRequirements) {
    object.requirements = expandedRequirements.map(serializeServiceRequirement);
  }
  return object;
}

export function serializeCustomer(row: Row<typeof customers>): Customer {
  return {
    id: encodeId('customer', row.id),
    object: 'customer',
    external_id: row.externalId,
    email: row.email,
    phone: row.phone,
    name: row.name,
    timezone: row.timezone,
    locale: row.locale,
    tenant_id: row.tenantId,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

// --- Hold and Booking ---------------------------------------------------------------------

const MINUTE_MS = 60_000;

function durationMinutes(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MINUTE_MS);
}

export interface AllocationView {
  id?: string | undefined;
  resourceId: string;
  role: string | null;
  capacityUsed: number;
}

function serializeAllocation(
  allocation: AllocationView,
  resource?: Row<typeof resources> | null,
): BookingAllocation {
  const object: BookingAllocation = {
    object: 'booking_allocation',
    resource_id: encodeId('resource', allocation.resourceId),
    role: allocation.role,
    capacity_used: allocation.capacityUsed,
  };
  if (allocation.id !== undefined) object.id = encodeId('booking_allocation', allocation.id);
  if (resource !== undefined) object.resource = resource ? serializeResource(resource) : null;
  return object;
}

/**
 * A hold, built from what the engine returns rather than re-read from the database.
 *
 * `holds` stores neither the price nor the role of each allocation: the price is not frozen
 * until the booking exists, and a role is a property of the requirement, not of the occupancy.
 * The creation therefore answers with what the engine computed, and {@link serializeHoldRow}
 * (the read path) answers `null` for exactly those two fields and for nothing
 * else. The two functions live next to each other so the asymmetry is visible; it is a
 * property of the table, not an oversight.
 */
export function serializeHold(result: {
  id: string;
  serviceId: string;
  customerId: string | null;
  start: number;
  end: number;
  durationMinutes: number;
  quantity: number;
  timezone: string;
  expiresAt: number | null;
  price: { amount: number; currency: string } | null;
  priceRule: PriceRuleRef | null;
  allocations: readonly { resourceId: string; role: string | null; capacityUsed: number }[];
  environment: Environment;
}): HoldCreated {
  return {
    id: encodeId('hold', result.id),
    object: 'hold',
    status: 'active',
    service_id: encodeId('service', result.serviceId),
    customer_id: result.customerId === null ? null : encodeId('customer', result.customerId),
    start: new Date(result.start).toISOString(),
    end: new Date(result.end).toISOString(),
    duration_minutes: result.durationMinutes,
    quantity: result.quantity,
    timezone: result.timezone,
    expires_at: result.expiresAt === null ? null : new Date(result.expiresAt).toISOString(),
    price: result.price,
    price_rule: result.priceRule,
    allocations: result.allocations.map((allocation) => serializeAllocation(allocation)),
    environment: result.environment,
  };
}

/** The four states of a hold. `active` is the only one a hold can leave. */
export type HoldStatus = 'active' | 'released' | 'expired' | 'converted';

/**
 * A hold read back from its row (`GET /v1/holds/{id}`).
 *
 * Same object type as {@link serializeHold} and the same field names, with two fields that the
 * table cannot answer and does not pretend to:
 *
 *  - **`price` is `null`.** A hold's price is computed at creation and frozen only when the
 *    hold becomes a booking; `holds` has no price column. Recomputing it here from the service
 *    would answer a *different* question (what it would cost now) and would quietly change
 *    between two reads of the same hold. `null` says "not recorded", which is true.
 *  - **`allocations[].role` is `null`.** A role belongs to the requirement that asked for the
 *    resource, and an occupancy records the resource, not the reason.
 *
 * **`status` is computed, not copied.** A hold whose `expires_at` has passed is `expired` even
 * while its row still says `active`, because the sweeper runs every ten seconds and a hold that
 * can no longer be converted must not be reported as one that can. Everything else is the
 * column.
 */
export function serializeHoldRow(row: {
  id: string;
  serviceId: string;
  customerId: string | null;
  status: HoldStatus;
  startsAt: Date;
  endsAt: Date;
  quantity: number;
  expiresAt: Date;
  timezone: string | null;
  bookingId: string | null;
  environment: Environment;
  allocations: readonly { resourceId: string; capacityUsed: number }[];
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Hold {
  return {
    id: encodeId('hold', row.id),
    object: 'hold',
    status: row.status,
    service_id: encodeId('service', row.serviceId),
    customer_id: row.customerId === null ? null : encodeId('customer', row.customerId),
    booking_id: row.bookingId === null ? null : encodeId('booking', row.bookingId),
    start: iso(row.startsAt),
    end: iso(row.endsAt),
    duration_minutes: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000),
    quantity: row.quantity,
    timezone: row.timezone,
    expires_at: iso(row.expiresAt),
    price: null,
    price_rule: null,
    allocations: row.allocations.map((allocation) =>
      serializeAllocation({ ...allocation, role: null }),
    ),
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export interface BookingExpansions {
  customer?: Row<typeof customers> | null;
  /** Resources of the allocations, by bare id, when `expand[]=allocations.resource`. */
  resources?: Map<string, Row<typeof resources>>;
  /** Payments of this booking, oldest first, when `expand[]=payments`. */
  payments?: readonly Row<typeof payments>[];
}

/**
 * A booking, from the row and its allocations.
 *
 * `POST /v1/bookings` re-reads what it wrote and comes through here as well, so the object a
 * client receives from the creation and the one it receives from `GET /v1/bookings/{id}` are
 * produced by one function and cannot drift apart.
 */
export function serializeBooking(
  row: Row<typeof bookings>,
  allocations: readonly AllocationView[],
  expansions: BookingExpansions = {},
): Booking {
  const object: Booking = {
    id: encodeId('booking', row.id),
    object: 'booking',
    status: row.status,
    service_id: encodeId('service', row.serviceId),
    customer_id: row.customerId === null ? null : encodeId('customer', row.customerId),
    hold_id: row.holdId === null ? null : encodeId('hold', row.holdId),
    start: iso(row.startsAt),
    end: iso(row.endsAt),
    duration_minutes: durationMinutes(row.startsAt, row.endsAt),
    timezone: row.timezone,
    quantity: row.quantity,
    price:
      row.priceAmount === null || row.currency === null
        ? null
        : { amount: row.priceAmount, currency: row.currency },
    price_rule: priceRuleOfRow(row.priceRule),
    amount_paid: row.amountPaid,
    amount_due: row.amountDue,
    amount_refunded: row.amountRefunded,
    policy_snapshot: toJsonObjectOrNull(row.policySnapshot),
    source: row.source,
    notes: row.notes,
    // The life cycle, as the engine writes it. `refund_percent` comes back from Postgres as a
    // `numeric` string (exact, which a float is not) and is exposed as a number because a
    // percentage between 0 and 100 has no precision to lose.
    cancelled_by: row.cancelledBy,
    cancellation_reason: row.cancellationReason,
    refund_percent: row.refundPercent === null ? null : Number(row.refundPercent),
    refund_amount_expected: row.refundAmountExpected,
    no_show_charge_expected: row.noShowChargeExpected,
    reschedule_fee_expected: row.rescheduleFeeExpected,
    reschedule_count: row.rescheduleCount,
    rescheduled_from_booking_id:
      row.rescheduledFromBookingId === null
        ? null
        : encodeId('booking', row.rescheduledFromBookingId),
    rescheduled_to_booking_id:
      row.rescheduledToBookingId === null ? null : encodeId('booking', row.rescheduledToBookingId),
    confirmed_at: iso(row.confirmedAt),
    checked_in_at: iso(row.checkedInAt),
    cancelled_at: iso(row.cancelledAt),
    completed_at: iso(row.completedAt),
    no_show_at: iso(row.noShowAt),
    rescheduled_at: iso(row.rescheduledAt),
    next_transition: row.nextTransition ?? null,
    next_transition_at: iso(row.nextTransitionAt),
    payment_expires_at: iso(row.paymentExpiresAt),
    allocations: allocations.map((allocation) =>
      serializeAllocation(
        allocation,
        expansions.resources === undefined
          ? undefined
          : (expansions.resources.get(allocation.resourceId) ?? null),
      ),
    ),
    tenant_id: row.tenantId,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  if ('customer' in expansions) {
    object.customer = expansions.customer ? serializeCustomer(expansions.customer) : null;
  }
  if (expansions.payments !== undefined) {
    // No `client_secret` and no `provider_status`: an expansion of a booking makes no call to
    // Stripe. A caller that wants either asks `GET /v1/payments/{id}` for one payment, which
    // is one round trip it has chosen to pay for.
    object.payments = expansions.payments.map((payment) => serializePayment(payment, {}));
  }
  return object;
}

/**
 * A payment, from its row.
 *
 * `clientSecret` and `providerStatus` are passed in rather than read here, for the reason
 * `serializeConnection` takes `chargesEnabled` rather than fetching it: a serializer that made
 * an HTTP request would make every list of payments a list of round trips. They are `null`
 * everywhere except in `GET /v1/payments/{id}`, which asks Stripe for one payment.
 */
export function serializePayment(
  row: Row<typeof payments>,
  live: { clientSecret?: string | null; providerStatus?: string | null },
): Payment {
  return {
    id: encodeId('payment', row.id),
    object: 'payment',
    booking_id: row.bookingId === null ? null : encodeId('booking', row.bookingId),
    type: row.type,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    amount_refunded: row.amountRefunded,
    provider: 'stripe',
    provider_payment_id: row.providerPaymentId,
    provider_account_id: row.providerAccountId,
    parent_payment_id:
      row.parentPaymentId === null ? null : encodeId('payment', row.parentPaymentId),
    failure_code: row.failureCode,
    failure_message: row.failureMessage,
    client_secret: live.clientSecret ?? null,
    provider_status: live.providerStatus ?? null,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

// --- Availability -------------------------------------------------------------------------

/**
 * The availability response.
 *
 * Every instant the API returns is UTC, which is the rule everywhere, and `timezone` says which
 * wall clock the caller asked to read them on. `resource_options` carries the prefixed
 * identifiers and the units each resource contributes, which is exactly what a client needs to
 * force the same allocation on the booking.
 *
 * `granularity: 'ranges'`: a range may legitimately end past the requested `to` (a thirty
 * day rental starting on the last day of the window has to be able to run its course), so
 * `end` is capped at `to` while `max_duration_minutes` keeps the real maximum. A client that
 * needs the untruncated end asks for a wider window.
 */
export function serializeAvailabilitySlot(
  slot: AvailabilitySlot,
  options: { truncateEndAt?: number } = {},
): AvailabilitySlotView {
  const end =
    options.truncateEndAt === undefined ? slot.end : Math.min(slot.end, options.truncateEndAt);
  const object: AvailabilitySlotView = {
    object: 'availability_slot',
    start: new Date(slot.start).toISOString(),
    end: new Date(end).toISOString(),
    duration_minutes: slot.durationMinutes,
    available_capacity: slot.availableCapacity,
    price:
      slot.price === null ? null : { amount: slot.price.amount, currency: slot.price.currency },
    price_rule: slot.priceRule,
    resource_options: slot.resourceOptions.map(serializeResourceOption),
  };
  if (slot.minDurationMinutes !== undefined) object.min_duration_minutes = slot.minDurationMinutes;
  if (slot.maxDurationMinutes !== undefined) object.max_duration_minutes = slot.maxDurationMinutes;
  return object;
}

export function serializeResourceOption(option: ResourceOption): ResourceOptionView {
  return {
    resources: option.resources.map((allocation) => ({
      resource_id: encodeId('resource', allocation.resourceId),
      role: allocation.role,
      capacity_used: allocation.capacityUsed,
    })),
  };
}

/** One structured `explain` reason. `ref_id` is left bare: it names a booking, hold, block or
 *  exception, and which of the four it is is exactly what `code` says. */
export function serializeExplainEntry(entry: ExplainEntry): ExplainEntryView {
  return {
    at: new Date(entry.at).toISOString(),
    reasons: entry.reasons.map((reason) => {
      const object: ExplainEntryView['reasons'][number] = {
        code: reason.code,
        message: reason.detail,
      };
      if (reason.resourceId !== undefined) {
        object.resource_id = encodeId('resource', reason.resourceId);
      }
      if (reason.refId !== undefined) object.ref_id = reason.refId;
      return object;
    }),
  };
}

export interface AvailabilityEnvelopeOptions {
  serviceId: string;
  timezone: string;
  granularity: 'slots' | 'ranges';
  /** Requested `to`; ranges are truncated to it. */
  truncateEndAt?: number;
}

export function serializeAvailability(
  result: AvailabilityResult,
  options: AvailabilityEnvelopeOptions,
): Availability {
  const object: Availability = {
    object: 'availability',
    service_id: encodeId('service', options.serviceId),
    timezone: options.timezone,
    granularity: options.granularity,
    slots: result.slots.map((slot) =>
      serializeAvailabilitySlot(
        slot,
        options.granularity === 'ranges' && options.truncateEndAt !== undefined
          ? { truncateEndAt: options.truncateEndAt }
          : {},
      ),
    ),
    next_available:
      result.nextAvailable === null ? null : new Date(result.nextAvailable).toISOString(),
  };
  if (result.reason !== undefined) {
    object.reason = { code: result.reason.code, message: result.reason.detail };
  }
  if (result.explain !== undefined) {
    object.explain = result.explain.map(serializeExplainEntry);
    object.explain_notes = (result.explainNotes ?? []).map((note) => ({
      code: note.code,
      message: note.detail,
      index: note.index,
    }));
    object.explain_truncated = result.truncated === true;
  }
  return object;
}

// --- Events -------------------------------------------------------------------------------

/**
 * One event, in the shape a webhook delivery carries byte for byte.
 *
 * The envelope is the same one a webhook delivery will carry: a client that
 * polls `GET /v1/events` and a client that receives a webhook must be able to use the same
 * parser, or the two halves of the same API would need two.
 *
 * `data.object` is the snapshot the engine wrote and `data.previous` the fields that changed:
 * two columns of `events`, one object here. `seq` is exposed because it is what the cursor
 * orders on; it is a **global** sequence, so a project's values have arbitrary gaps and it
 * must not be read as a count of anything.
 */
export function serializeEvent(row: Row<typeof events>): Event {
  return {
    id: encodeId('event', row.id),
    object: 'event',
    type: row.type,
    occurred_at: iso(row.occurredAt),
    api_version: row.apiVersion,
    seq: Number(row.seq),
    actor: toJsonObjectOrNull(row.actor),
    data: {
      object: toJsonObjectOrNull(row.data),
      previous: toJsonObjectOrNull(row.previous),
    },
    environment: row.environment,
    created_at: iso(row.createdAt),
  };
}

// --- Webhook -------------------------------------------------------------------

/**
 * A webhook endpoint.
 *
 * The signing secret is **never** here. It is returned once, by `POST /v1/webhooks`, which
 * adds the field to this object itself; a serializer that could emit it would eventually emit
 * it from `GET`, and a secret that can be re-read is a secret that ends up in a screenshot.
 *
 * `events` is the subscription list, not the log: `["*"]` means everything, including types
 * that did not exist when the endpoint was registered.
 */
export function serializeWebhook(row: Row<typeof webhooks>): Webhook {
  return {
    id: encodeId('webhook', row.id),
    object: 'webhook',
    url: row.url,
    events: row.eventTypes,
    status: row.status,
    description: row.description,
    metadata: toMetadata(row.metadata),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

/**
 * One delivery, with the outcome of its **last** attempt.
 *
 * `attempt` is how many have been started, `next_attempt_at` when the next one is due. The retry
 * ladder, `WEBHOOK_RETRY_DELAYS_SECONDS` in `webhooks/dispatch.ts`, lives in that column and
 * nowhere else, so what the customer reads here is the same schedule the worker enforces rather
 * than a description of it. `event_type` is joined in because a delivery log without it forces a
 * second request per row to be readable at all.
 */
export function serializeWebhookDelivery(
  row: Row<typeof webhookDeliveries>,
  eventType?: string | null,
): WebhookDelivery {
  const object: WebhookDelivery = {
    id: encodeId('webhook_delivery', row.id),
    object: 'webhook_delivery',
    webhook_id: encodeId('webhook', row.webhookId),
    event_id: encodeId('event', row.eventId),
    status: row.status,
    attempt: row.attempt,
    response_status: row.responseStatus,
    response_body: row.responseBody,
    error: row.error,
    duration_ms: row.durationMs,
    scheduled_at: iso(row.scheduledAt),
    last_attempt_at: iso(row.lastAttemptAt),
    next_attempt_at: iso(row.nextAttemptAt),
    /** Set only while an attempt is in flight; `next_attempt_at` stays the rung of the ladder. */
    leased_until: iso(row.leasedUntil),
    delivered_at: iso(row.deliveredAt),
    environment: row.environment,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
  if (eventType !== undefined) object.event_type = eventType;
  return object;
}
