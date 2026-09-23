/**
 * One Zod schema per object the API **returns**.
 *
 * Until this file existed the shape of a response lived only in `serialize.ts`, whose return
 * type was `Record<string, unknown>`, and in whatever a test happened to assert. That is not a
 * contract: a field could be renamed, dropped or added and nothing outside the tests that named
 * it would notice. Here the shape is a value: the serializers are typed against it
 * (`serializeLocation(...): Location`), the OpenAPI document is generated from it, and the
 * contract guard of `src/openapi/contract.ts` validates every response of the test suite
 * against it.
 *
 * Three rules hold everywhere:
 *
 *  1. **`.strict()`.** A field the server emits and the schema does not know about is a failure
 *     of the guard, not a field quietly missing from the specification. It is what keeps the
 *     document complete instead of merely plausible.
 *  2. **Instants are strings.** Every instant in a response is UTC ISO 8601 with `Z`, which is
 *     the rule for every output of the API, so `instantOutSchema` (`format: date-time` in the
 *     document) is the type, never a `Date`.
 *  3. **The code is the truth.** These schemas describe what `serialize.ts` emits today. Where
 *     that differs from the reference documentation, the difference is reported, not silently
 *     reconciled here.
 *
 * The free-form JSON columns (`metadata`, `attributes`, `address`, `selector`,
 * `policy_snapshot`, `event.data`) are records of unknown: they are opaque `jsonb` that the read
 * path does not re-validate, and pretending otherwise in the document would promise a shape the
 * server does not enforce on the way out. `pricing_rules` left that list: the write path
 * validates it strictly, so the document can state its shape and mean it.
 */
import { pricingRulesSchema } from '@bookrail/shared';
import { API_ACTORS } from '../context.js';
import { z } from '../zod.js';
import { instantOutSchema, metadataSchema, objectId } from './common.js';

/** An opaque JSON object: `metadata`, `attributes`, `address`, `selector`. */
const jsonObjectSchema = z.record(z.unknown());

const environmentSchema = z
  .enum(['test', 'live'])
  .openapi({ description: 'The environment of the API key that created the object.' });

const tenantIdSchema = z
  .string()
  .nullable()
  .openapi({ description: 'Optional tenant this object belongs to, for multi-tenant customers.' });

const priceSchema = z
  .object({ amount: z.number().int(), currency: z.string() })
  .strict()
  .openapi({ description: 'Amount in the minor unit of the currency (cents for EUR).' });

/**
 * Which `services.pricing_rules` entry produced a price, or `null` for the flat service price.
 *
 * `index` is the position in the column as it was written, holes included: a stored rule the
 * strict schema refuses keeps its place so this pointer never renumbers itself.
 *
 * Inlined rather than registered as a named component, exactly like {@link priceSchema}: a
 * registered schema that is used through `.nullable()` has the nullability (and the first
 * `description` it meets) baked into the component itself, which would make `PriceRule` say
 * "or null" everywhere and carry one call site's wording at all of them.
 */
const priceRuleSchema = z
  .object({
    index: z.number().int().openapi({ description: 'Position in `service.pricing_rules`.' }),
    label: z.string().nullable().openapi({ description: 'The rule label, when it has one.' }),
  })
  .strict();

// --- Location ------------------------------------------------------------------------------

export const locationSchema = z
  .object({
    id: objectId('location'),
    object: z.literal('location'),
    name: z.string(),
    timezone: z.string(),
    address: jsonObjectSchema.nullable(),
    tenant_id: tenantIdSchema,
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Location');

export type Location = z.infer<typeof locationSchema>;

// --- Schedule ------------------------------------------------------------------------------

export const scheduleRuleSchema = z
  .object({
    id: objectId('schedule_rule'),
    object: z.literal('schedule_rule'),
    schedule_id: objectId('schedule'),
    days_of_week: z.array(z.number().int().min(0).max(6)),
    start_time: z.string().nullable(),
    end_time: z.string().nullable(),
    valid_from: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .strict()
  .openapi('ScheduleRule');

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const scheduleExceptionSchema = z
  .object({
    id: objectId('schedule_exception'),
    object: z.literal('schedule_exception'),
    schedule_id: objectId('schedule'),
    date: z.string(),
    type: z.enum(['closed', 'open']),
    start_time: z.string().nullable(),
    end_time: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict()
  .openapi('ScheduleException');

export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;

export const scheduleSchema = z
  .object({
    id: objectId('schedule'),
    object: z.literal('schedule'),
    name: z.string(),
    timezone: z.string().nullable(),
    rules: z.array(scheduleRuleSchema),
    exceptions: z.array(scheduleExceptionSchema),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Schedule');

export type Schedule = z.infer<typeof scheduleSchema>;

// --- Resource ------------------------------------------------------------------------------

export const resourceSchema = z
  .object({
    id: objectId('resource'),
    object: z.literal('resource'),
    name: z.string(),
    type: z.string(),
    location_id: objectId('location').nullable(),
    schedule_id: objectId('schedule').nullable(),
    capacity: z.number().int(),
    attributes: jsonObjectSchema,
    status: z.enum(['active', 'inactive']),
    tenant_id: tenantIdSchema,
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
    schedule: scheduleSchema.nullable().optional().openapi({
      description: 'Present only with `expand[]=schedule`. `null` when the resource has none.',
    }),
  })
  .strict()
  .openapi('Resource');

export type Resource = z.infer<typeof resourceSchema>;

export const resourceBlockSchema = z
  .object({
    id: objectId('resource_block'),
    object: z.literal('resource_block'),
    resource_id: objectId('resource'),
    from: instantOutSchema.nullable(),
    to: instantOutSchema.nullable(),
    reason: z.string().nullable(),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('ResourceBlock');

export type ResourceBlock = z.infer<typeof resourceBlockSchema>;

export const resourceGroupSchema = z
  .object({
    id: objectId('resource_group'),
    object: z.literal('resource_group'),
    name: z.string(),
    selector: jsonObjectSchema.nullable(),
    allocation_strategy: z.enum(['least_busy', 'round_robin', 'first_available', 'priority']),
    resource_ids: z.array(objectId('resource')),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
    resources: z
      .array(resourceSchema)
      .optional()
      .openapi({ description: 'Present only with `expand[]=resources`.' }),
  })
  .strict()
  .openapi('ResourceGroup');

export type ResourceGroup = z.infer<typeof resourceGroupSchema>;

// --- Policy --------------------------------------------------------------------------------

export const policySchema = z
  .object({
    id: objectId('policy'),
    object: z.literal('policy'),
    name: z.string(),
    cancellation: z.array(jsonObjectSchema).openapi({
      description:
        'Refund tiers, as stored: `{ before, refund_percent?, fee? }`. An empty list refunds nothing.',
    }),
    reschedule: z
      .array(jsonObjectSchema)
      .openapi({ description: 'Reschedule fee tiers, as stored.' }),
    deposit: jsonObjectSchema
      .nullable()
      .openapi({ description: 'Deposit rule, as stored. `null` when unset.' }),
    payment_timing: z.enum(['at_booking', 'before_start', 'after_service', 'none']),
    payment_deadline: z.string().nullable(),
    no_show: jsonObjectSchema
      .nullable()
      .openapi({ description: 'No-show rule, as stored. `null` when unset.' }),
    hold_duration_seconds: z.number().int(),
    max_active_bookings_per_customer: z.number().int().nullable(),
    require_customer_confirmation: z.boolean(),
    require_provider_confirmation: z.boolean(),
    auto_start: z.boolean(),
    auto_complete: z.boolean(),
    max_reschedules: z.number().int().nullable(),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Policy');

export type Policy = z.infer<typeof policySchema>;

// --- Service -------------------------------------------------------------------------------

export const serviceRequirementSchema = z
  .object({
    id: objectId('service_requirement'),
    object: z.literal('service_requirement'),
    service_id: objectId('service'),
    resource_id: objectId('resource').nullable(),
    resource_group_id: objectId('resource_group').nullable(),
    quantity: z.number().int(),
    consumes: z.enum(['per_unit', 'whole']),
    role: z.string().nullable(),
  })
  .strict()
  .openapi('ServiceRequirement');

export type ServiceRequirement = z.infer<typeof serviceRequirementSchema>;

export const serviceSchema = z
  .object({
    id: objectId('service'),
    object: z.literal('service'),
    name: z.string(),
    description: z.string().nullable(),
    duration: z.number().int().nullable(),
    duration_options: z.array(z.number().int()).nullable(),
    duration_range: z.object({ min: z.number().int(), max: z.number().int() }).strict().nullable(),
    capacity_per_booking: z.number().int(),
    buffer_before: z.number().int(),
    buffer_after: z.number().int(),
    slot_interval: z.number().int().nullable(),
    align_to: z.enum(['hour', 'half_hour', 'schedule_start']).nullable(),
    price: priceSchema.nullable(),
    pricing_rules: pricingRulesSchema.openapi({
      description:
        'Evaluated in order for every slot and frozen on the booking: the first rule whose `when` matches replaces the flat `price`. Empty means the flat price always applies.',
    }),
    policy_id: objectId('policy').nullable(),
    booking_window: jsonObjectSchema
      .nullable()
      .openapi({ description: '`{ min_notice_minutes?, max_advance_days? }`, as stored.' }),
    allow_recurring: z.boolean(),
    allow_multi_day: z.boolean(),
    buffer_sharing: z.boolean(),
    allow_split: z.boolean(),
    requirement_ids: z.array(objectId('service_requirement')),
    tenant_id: tenantIdSchema,
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
    requirements: z
      .array(serviceRequirementSchema)
      .optional()
      .openapi({ description: 'Present only with `expand[]=requirements`.' }),
  })
  .strict()
  .openapi('Service');

export type Service = z.infer<typeof serviceSchema>;

// --- Customer ------------------------------------------------------------------------------

export const customerSchema = z
  .object({
    id: objectId('customer'),
    object: z.literal('customer'),
    external_id: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    name: z.string().nullable(),
    timezone: z.string().nullable(),
    locale: z.string().nullable(),
    tenant_id: tenantIdSchema,
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Customer');

export type Customer = z.infer<typeof customerSchema>;

// --- Payment -------------------------------------------------------------------------------

/**
 * A `payments` row, as `GET /v1/payments/{id}` and `GET /v1/payments` return it.
 *
 * `client_secret` and `provider_status` come from Stripe at request time, and only for a
 * payment that is still `pending` and is not itself a refund: everything else here is ours.
 * Both are `null` when Stripe did not answer, and the response is still a `200`, for the reason
 * `charges_enabled` of `GET /v1/stripe` is: a provider having a slow minute must not turn a
 * read of our own rows into a failure. The list never asks Stripe at all.
 */
export const paymentSchema = z
  .object({
    id: objectId('payment'),
    object: z.literal('payment'),
    booking_id: objectId('booking').nullable(),
    type: z.enum(['deposit', 'full', 'balance', 'no_show_fee', 'refund']),
    status: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'cancelled']).openapi({
      description:
        '`pending` covers every Stripe state that is not final: `requires_payment_method`, `requires_action`, `processing`. Read `provider_status` for the detail.',
    }),
    amount: z.number().int(),
    currency: z.string(),
    amount_refunded: z.number().int().openapi({
      description: 'How much of this payment has come back, cumulative.',
    }),
    provider: z.literal('stripe'),
    provider_payment_id: z.string().nullable().openapi({
      description: '`pi_...` for a payment, `re_...` for a refund. `null` until Stripe answered.',
    }),
    provider_account_id: z.string().openapi({ example: 'acct_1234567890' }),
    parent_payment_id: objectId('payment').nullable().openapi({
      description: 'For a refund: the payment it gives back.',
    }),
    failure_code: z.string().nullable(),
    failure_message: z.string().nullable(),
    client_secret: z.string().nullable().openapi({
      description:
        'Read from Stripe, only for a pending payment. `null` on a list, on a refund, and when Stripe did not answer.',
    }),
    provider_status: z.string().nullable().openapi({
      description: "Stripe's own status for the intent, read at request time. `null` as above.",
    }),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Payment');

export type Payment = z.infer<typeof paymentSchema>;

// --- Hold and Booking ----------------------------------------------------------------------

export const bookingAllocationSchema = z
  .object({
    object: z.literal('booking_allocation'),
    resource_id: objectId('resource'),
    role: z.string().nullable(),
    capacity_used: z.number().int(),
    id: objectId('booking_allocation').optional().openapi({
      description: 'Present on a booking allocation, absent on the allocations of a hold.',
    }),
    resource: resourceSchema.nullable().optional().openapi({
      description: 'Present only with `expand[]=allocations.resource`.',
    }),
  })
  .strict()
  .openapi('BookingAllocation');

export type BookingAllocation = z.infer<typeof bookingAllocationSchema>;

export const holdStatusSchema = z.enum(['active', 'released', 'expired', 'converted']);

/**
 * The hold `POST /v1/holds` answers with: what the engine computed, before there is a row to
 * read back. It carries neither `metadata` nor the timestamps, and its `timezone` is always
 * known: the resources have just been chosen. The documented contract carries the same two
 * shapes.
 */
export const holdCreatedSchema = z
  .object({
    id: objectId('hold'),
    object: z.literal('hold'),
    status: holdStatusSchema,
    service_id: objectId('service'),
    customer_id: objectId('customer').nullable(),
    start: instantOutSchema,
    end: instantOutSchema,
    duration_minutes: z.number().int(),
    quantity: z.number().int(),
    timezone: z.string(),
    expires_at: instantOutSchema.nullable(),
    price: priceSchema.nullable(),
    price_rule: priceRuleSchema.nullable().openapi({
      description:
        'Which `service.pricing_rules` entry made this quote. A hold is not a sale: the booking recomputes it at conversion.',
    }),
    allocations: z.array(bookingAllocationSchema),
    environment: environmentSchema,
  })
  .strict()
  .openapi('HoldCreated');

export type HoldCreated = z.infer<typeof holdCreatedSchema>;

/** The hold `GET /v1/holds/{id}` reads back from its row. */
export const holdSchema = z
  .object({
    id: objectId('hold'),
    object: z.literal('hold'),
    status: holdStatusSchema.openapi({
      description:
        'Computed, not copied: a hold whose `expires_at` has passed is `expired` even while its row still says `active`.',
    }),
    service_id: objectId('service'),
    customer_id: objectId('customer').nullable(),
    booking_id: objectId('booking').nullable(),
    start: instantOutSchema.nullable(),
    end: instantOutSchema.nullable(),
    duration_minutes: z.number().int(),
    quantity: z.number().int(),
    timezone: z.string().nullable(),
    expires_at: instantOutSchema.nullable(),
    price: priceSchema
      .nullable()
      .openapi({ description: 'Always `null` on read: `holds` has no price column.' }),
    price_rule: priceRuleSchema
      .nullable()
      .openapi({ description: 'Always `null` on read, for the same reason as `price`.' }),
    allocations: z.array(bookingAllocationSchema),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Hold');

export type Hold = z.infer<typeof holdSchema>;

export const bookingStatusSchema = z.enum([
  'held',
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
]);

export const bookingSchema = z
  .object({
    id: objectId('booking'),
    object: z.literal('booking'),
    status: bookingStatusSchema,
    service_id: objectId('service'),
    customer_id: objectId('customer').nullable(),
    hold_id: objectId('hold').nullable(),
    start: instantOutSchema.nullable(),
    end: instantOutSchema.nullable(),
    duration_minutes: z.number().int(),
    timezone: z.string(),
    quantity: z.number().int(),
    price: priceSchema.nullable(),
    price_rule: priceRuleSchema.nullable().openapi({
      description:
        'Which `service.pricing_rules` entry priced this booking, frozen at creation. `null` when the flat service price applied.',
    }),
    amount_paid: z.number().int(),
    amount_due: z.number().int(),
    amount_refunded: z.number().int(),
    policy_snapshot: jsonObjectSchema.nullable().openapi({
      description: 'The policy frozen at creation, as stored. `null` when the service had none.',
    }),
    source: z.enum(['api', 'widget', 'portal', 'import']),
    notes: z.string().nullable(),
    cancelled_by: z.enum(['customer', 'provider', 'system']).nullable(),
    cancellation_reason: z.string().nullable(),
    refund_percent: z.number().nullable(),
    refund_amount_expected: z.number().int().nullable(),
    no_show_charge_expected: z.number().int().nullable(),
    reschedule_fee_expected: z.number().int().nullable(),
    reschedule_count: z.number().int(),
    rescheduled_from_booking_id: objectId('booking').nullable(),
    rescheduled_to_booking_id: objectId('booking').nullable(),
    confirmed_at: instantOutSchema.nullable(),
    checked_in_at: instantOutSchema.nullable(),
    cancelled_at: instantOutSchema.nullable(),
    completed_at: instantOutSchema.nullable(),
    no_show_at: instantOutSchema.nullable(),
    rescheduled_at: instantOutSchema.nullable(),
    next_transition: z.enum(['start', 'complete', 'no_show', 'expire_payment']).nullable(),
    next_transition_at: instantOutSchema.nullable(),
    payment_expires_at: instantOutSchema.nullable().openapi({
      description:
        'When a booking waiting for its payment is cancelled and its slot released. `null` on every booking that is not waiting for money.',
    }),
    allocations: z.array(bookingAllocationSchema),
    tenant_id: tenantIdSchema,
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
    customer: customerSchema.nullable().optional().openapi({
      description: 'Present only with `expand[]=customer`.',
    }),
    payments: z.array(paymentSchema).optional().openapi({
      description:
        'Present only with `expand[]=payments`: every payment and refund of this booking, oldest first. Never carries a `client_secret`: an expansion makes no call to Stripe.',
    }),
  })
  .strict()
  .openapi('Booking');

export type Booking = z.infer<typeof bookingSchema>;

/**
 * What a front end needs to complete a payment, returned **once** by `POST /v1/bookings`.
 *
 * `client_secret` is the one value in this API that is neither stored nor replayed. It is not
 * in a column (migration 0024 deliberately has no `provider_client_secret`), not in a log line,
 * and not in `idempotency_keys`: the creation nominates a copy of this object with
 * `client_secret: null` for the idempotency middleware to remember, so a replay of the same
 * `Idempotency-Key` answers with the same booking and a null secret. A caller that lost it
 * reads it again from `GET /v1/payments/{id}`, which fetches it from Stripe.
 */
export const paymentIntentSchema = z
  .object({
    id: z.string().openapi({ description: 'The Stripe PaymentIntent.', example: 'pi_3Abc' }),
    client_secret: z.string().nullable().openapi({
      description:
        'Pass it to Stripe.js. Returned once, here; `null` on an idempotent replay, because it is never stored.',
    }),
    amount: z.number().int(),
    currency: z.string().openapi({ description: 'ISO 4217, upper case, as the booking froze it.' }),
    status: z.string().openapi({ description: "Stripe's own status for the intent." }),
    stripe_account: z.string().openapi({
      description: 'The connected account the intent lives on. Pass it as `stripeAccount`.',
      example: 'acct_1234567890',
    }),
    publishable_key: z.string().openapi({
      description: "The **platform's** publishable key. Initialise Stripe.js with it.",
      example: 'pk_test_1234567890',
    }),
    payment_id: objectId('payment').openapi({
      description: 'The Bookrail payment this intent belongs to.',
    }),
  })
  .strict()
  .openapi('PaymentIntent');

export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

/**
 * The answer of `POST /v1/bookings`: a booking, plus the intent when one was created.
 *
 * A schema of its own rather than a nullable field on `Booking`, and the difference matters to
 * whoever reads the specification: a `GET /v1/bookings/{id}` can never carry a `client_secret`,
 * and a `Booking` that declared the field would be promising one everywhere and delivering it
 * in one place. It also keeps the event payloads alone: `booking.created` carries a `booking`,
 * and a field that existed only in an HTTP response has no business in a snapshot.
 *
 * `payment_intent` is always present and `null` for `payment.mode: "none"`, which is every
 * booking that takes no money: absent and null are two answers, and one of them is enough.
 */
export const bookingCreatedSchema = bookingSchema
  .extend({
    payment_intent: paymentIntentSchema.nullable().openapi({
      description: 'Present and `null` when the booking takes no payment.',
    }),
  })
  .strict()
  .openapi('BookingCreated');

export type BookingCreated = z.infer<typeof bookingCreatedSchema>;

// --- Availability --------------------------------------------------------------------------

export const resourceOptionSchema = z
  .object({
    resources: z.array(
      z
        .object({
          resource_id: objectId('resource'),
          role: z.string().nullable(),
          capacity_used: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi('ResourceOption');

export type ResourceOption = z.infer<typeof resourceOptionSchema>;

export const availabilitySlotSchema = z
  .object({
    object: z.literal('availability_slot'),
    start: instantOutSchema,
    end: instantOutSchema,
    duration_minutes: z
      .number()
      .int()
      .nullable()
      .openapi({ description: '`null` for a `ranges` entry.' }),
    available_capacity: z.number().int(),
    price: priceSchema.nullable(),
    price_rule: priceRuleSchema.nullable().openapi({
      description:
        'Which `service.pricing_rules` entry produced `price`. `null` when the flat service price applied. For a `ranges` entry it is the rule of the shortest booking starting at `start`.',
    }),
    resource_options: z.array(resourceOptionSchema),
    min_duration_minutes: z
      .number()
      .int()
      .optional()
      .openapi({ description: '`ranges` only: shortest bookable length inside the interval.' }),
    max_duration_minutes: z.number().int().optional().openapi({
      description: '`ranges` only: longest bookable length; may exceed `end - start`.',
    }),
  })
  .strict()
  .openapi('AvailabilitySlot');

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

export const explainReasonSchema = z
  .object({
    code: z.enum([
      'outside_schedule',
      'exception_closed',
      'blocked',
      'occupied',
      'buffer',
      'min_notice',
      'max_advance',
      'capacity',
      'customer_limit',
    ]),
    message: z.string(),
    resource_id: objectId('resource').optional(),
    ref_id: z.string().optional().openapi({
      description:
        'Bare identifier of the booking, hold, block or exception responsible; `code` says which.',
    }),
  })
  .strict()
  .openapi('ExplainReason');

export type ExplainReason = z.infer<typeof explainReasonSchema>;

export const explainEntrySchema = z
  .object({ at: instantOutSchema, reasons: z.array(explainReasonSchema) })
  .strict()
  .openapi('ExplainEntry');

export type ExplainEntry = z.infer<typeof explainEntrySchema>;

export const explainNoteSchema = z
  .object({
    code: z.enum(['pricing_rule_ignored']),
    message: z.string(),
    index: z.number().int().openapi({
      description: 'Position in `service.pricing_rules` of the rule the note is about.',
    }),
  })
  .strict()
  .openapi('ExplainNote');

export type ExplainNote = z.infer<typeof explainNoteSchema>;

const availabilityReasonSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict()
  .openapi('AvailabilityReason');

export const availabilitySchema = z
  .object({
    object: z.literal('availability'),
    service_id: objectId('service'),
    timezone: z.string(),
    granularity: z.enum(['slots', 'ranges']),
    slots: z.array(availabilitySlotSchema),
    next_available: instantOutSchema.nullable(),
    reason: availabilityReasonSchema.optional().openapi({
      description:
        'Present when the window is well formed but no slot can exist for a reason that covers all of it, e.g. `customer_limit_reached`.',
    }),
    explain: z
      .array(explainEntrySchema)
      .optional()
      .openapi({ description: 'Present only with `explain: true`.' }),
    explain_notes: z.array(explainNoteSchema).optional().openapi({
      description:
        'Present only with `explain: true`. What the engine had to ignore to answer, with no instant of its own: today only `pricing_rule_ignored`, a stored pricing rule the strict schema refuses.',
    }),
    explain_truncated: z
      .boolean()
      .optional()
      .openapi({ description: 'Present only with `explain: true`.' }),
  })
  .strict()
  .openapi('Availability');

export type Availability = z.infer<typeof availabilitySchema>;

export const availabilityNextSchema = z
  .object({
    object: z.literal('availability_next'),
    service_id: objectId('service'),
    timezone: z.string(),
    next_available: instantOutSchema.nullable(),
    slot: availabilitySlotSchema.nullable(),
    searched_through: instantOutSchema,
  })
  .strict()
  .openapi('AvailabilityNext');

export type AvailabilityNext = z.infer<typeof availabilityNextSchema>;

export const availabilityCheckSchema = z
  .object({
    object: z.literal('availability_check'),
    service_id: objectId('service'),
    start: instantOutSchema,
    duration_minutes: z.number().int().nullable(),
    available: z.boolean(),
    available_capacity: z.number().int(),
    price: priceSchema.nullable(),
    price_rule: priceRuleSchema.nullable().openapi({
      description: 'Which `service.pricing_rules` entry produced `price`, if any.',
    }),
    resource_options: z.array(resourceOptionSchema),
    reasons: z
      .array(explainReasonSchema)
      .optional()
      .openapi({ description: 'Present only when `available` is false.' }),
    reason: availabilityReasonSchema.optional(),
  })
  .strict()
  .openapi('AvailabilityCheck');

export type AvailabilityCheck = z.infer<typeof availabilityCheckSchema>;

// --- Event ---------------------------------------------------------------------------------

export const eventSchema = z
  .object({
    id: objectId('event'),
    object: z.literal('event'),
    type: z.string(),
    occurred_at: instantOutSchema.nullable(),
    api_version: z.string(),
    seq: z.number().int().openapi({
      description:
        'Position in the global event sequence. Not a count: a project’s values have arbitrary gaps.',
    }),
    actor: jsonObjectSchema.nullable().openapi({
      description:
        '`{type: "api", id: "key_...", via?: "mcp"|"cli"|"sdk"|"dashboard"}` for an HTTP write, `{type: "system", id: null}` for an automatic transition, `null` when nobody declared one.',
    }),
    data: z
      .object({
        object: jsonObjectSchema
          .nullable()
          .openapi({ description: 'Snapshot of the object after the change.' }),
        previous: jsonObjectSchema
          .nullable()
          .openapi({ description: 'The fields that changed, or `null` for a creation.' }),
      })
      .strict(),
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Event');

export type Event = z.infer<typeof eventSchema>;

// --- Webhook -------------------------------------------------------------------------------

export const webhookSchema = z
  .object({
    id: objectId('webhook'),
    object: z.literal('webhook'),
    url: z.string(),
    events: z.array(z.string()).openapi({
      description: 'Subscribed event types. `["*"]` means everything, future types included.',
    }),
    status: z.enum(['active', 'failing', 'disabled']),
    description: z.string().nullable(),
    metadata: metadataSchema,
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
  })
  .strict()
  .openapi('Webhook');

export type Webhook = z.infer<typeof webhookSchema>;

/**
 * `POST /v1/webhooks` only: the signing secret, returned once and never again.
 *
 * `secret` is **optional** because an idempotent replay of the same `Idempotency-Key` answers `201`
 * with the endpoint and **without** it: the first response is the once, a replay is not, and what
 * the middleware stores for twenty-four hours is the object without the secret. A client that reads
 * `secret` on a replay would find nothing, which is the truth, and the type says so.
 */
export const webhookCreatedSchema = webhookSchema
  .extend({
    secret: z.string().optional().openapi({
      description:
        'The signing secret, shown **once**, in the answer to the request that created the endpoint. Absent from an idempotent replay, and from every other response.',
      example: 'whsec_...',
    }),
  })
  .strict()
  .openapi('WebhookCreated');

export type WebhookCreated = z.infer<typeof webhookCreatedSchema>;

export const webhookDeliverySchema = z
  .object({
    id: objectId('webhook_delivery'),
    object: z.literal('webhook_delivery'),
    webhook_id: objectId('webhook'),
    event_id: objectId('event'),
    status: z.enum(['pending', 'succeeded', 'failed']),
    attempt: z.number().int().openapi({ description: 'Attempts started, not attempts left.' }),
    response_status: z.number().int().nullable(),
    response_body: z.string().nullable(),
    error: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    scheduled_at: instantOutSchema.nullable(),
    last_attempt_at: instantOutSchema.nullable(),
    next_attempt_at: instantOutSchema.nullable(),
    leased_until: instantOutSchema.nullable().openapi({
      description: 'Set only while an attempt is in flight; `next_attempt_at` stays the ladder.',
    }),
    delivered_at: instantOutSchema.nullable(),
    environment: environmentSchema,
    created_at: instantOutSchema.nullable(),
    updated_at: instantOutSchema.nullable(),
    event_type: z.string().nullable().optional().openapi({
      description:
        'Type of the event this delivery carries. Joined in by the listing and by `/test`; absent from the answer of `/retry`.',
    }),
  })
  .strict()
  .openapi('WebhookDelivery');

export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

// --- Project -------------------------------------------------------------------------------

export const apiKeySchema = z
  .object({
    id: objectId('api_key'),
    object: z.literal('api_key'),
    kind: z.enum(['secret', 'publishable']),
    environment: environmentSchema,
    scopes: z.array(z.string()).openapi({
      description: 'Stored, not yet enforced. An empty list means no restriction.',
    }),
    tenant_id: tenantIdSchema,
  })
  .strict()
  .openapi('ApiKey');

export type ApiKey = z.infer<typeof apiKeySchema>;

export const projectSchema = z
  .object({
    id: objectId('project'),
    object: z.literal('project'),
    name: z.string(),
    environment: environmentSchema,
    api_version: z.string(),
    default_timezone: z.string(),
    default_currency: z.string(),
    api_key: apiKeySchema,
    created_at: instantOutSchema,
  })
  .strict()
  .openapi('Project');

export type Project = z.infer<typeof projectSchema>;

// --- Envelopes -----------------------------------------------------------------------------

/**
 * `{"object":"list","data":[...],"has_more":true}`, the shape of every list, with a cursor and
 * no total.
 *
 * Built per element type rather than registered once as a generic: OpenAPI has no generics, so
 * the document carries one `…List` component per resource and the SDK gets an exact type.
 */
export function listOf<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      has_more: z.boolean(),
    })
    .strict();
}

export const deletedSchema = z
  .object({
    id: z.string(),
    object: z.string().openapi({ description: 'The kind of object that was deleted.' }),
    deleted: z.literal(true),
  })
  .strict()
  .openapi('Deleted');

export type Deleted = z.infer<typeof deletedSchema>;

/**
 * `ErrorPayload` of `@bookrail/shared`: a `type`, a machine `code`, a human `message`, the
 * offending `param` when one field is to blame, a `doc_url`, and the `request_id`.
 */
// --- Sign up -----------------------------------------------------------------------------

/**
 * What the three sign up endpoints answer with.
 *
 * One schema for all three, with everything past `status` optional, because the three answers
 * are three stages of the same object and a client that follows the flow reads the same fields
 * in the same places. What is present depends on how far the sign up has got:
 *
 *   * `pending`      the link has been sent and nothing exists yet. `expires_at` says until when.
 *   * `confirmed`    the account, the project and the key exist. The key itself is in
 *                    `secret_key` for a browser, and `delivered_to: "cli"` for a terminal, which
 *                    collects it from its own poll.
 *   * `claimed`      the key has been handed over. It is never shown a second time.
 *   * `email_taken`  the address already has a self service account. Nothing was created.
 *   * `expired`      the hour ran out before anybody opened the link.
 *
 * `secret_key` appears in exactly two responses in the life of a sign up, and never twice for
 * the same one: the confirm of a browser, or the first successful claim of a terminal.
 */
export const signupSchema = z
  .object({
    id: objectId('signup'),
    object: z.literal('signup'),
    status: z.enum(['pending', 'confirmed', 'claimed', 'email_taken', 'expired']),
    email: z
      .string()
      .optional()
      .openapi({ description: 'Echoed back so a client can show where the message went.' }),
    expires_at: instantOutSchema
      .optional()
      .openapi({ description: 'When the confirmation link stops working.' }),
    poll_token: z.string().optional().openapi({
      description:
        'Only for `client: "cli"`, and only in the answer that created the sign up: the token the terminal claims its key with.',
    }),
    delivered_to: z.literal('cli').optional().openapi({
      description: 'Present when the key went to a waiting terminal instead of into this response.',
    }),
    account: z
      .object({ id: objectId('account'), object: z.literal('account'), name: z.string() })
      .strict()
      .optional(),
    project: z
      .object({
        id: objectId('project'),
        object: z.literal('project'),
        name: z.string(),
        default_timezone: z.string(),
        default_currency: z.string(),
      })
      .strict()
      .optional(),
    api_key: z
      .object({
        id: objectId('api_key'),
        object: z.literal('api_key'),
        environment: z.literal('test'),
        kind: z.literal('secret'),
        prefix: z.string(),
      })
      .strict()
      .optional(),
    secret_key: z.string().optional().openapi({
      description:
        'The test key, in clear text. Shown **once**: in the confirm of a browser, or in the first successful claim of a terminal. It is stored as a SHA-256 hash and cannot be shown again.',
      example: 'sk_test_...',
    }),
  })
  .strict()
  .openapi('Signup');

export type Signup = z.infer<typeof signupSchema>;

export const errorSchema = z
  .object({
    error: z
      .object({
        type: z.enum([
          'invalid_request',
          'authentication',
          'permission',
          'not_found',
          'conflict',
          'rate_limit',
          'policy_violation',
          'payment_required',
          'internal',
        ]),
        code: z.string().openapi({
          description:
            'Machine readable code. The set is per operation; each response below lists the ones it can produce.',
        }),
        message: z.string(),
        param: z
          .string()
          .optional()
          .openapi({ description: 'The field or header the error is about, when there is one.' }),
        fix: z.string().optional().openapi({
          description:
            'What to do next, when there is one thing to do. Present on the errors that are about the state of the deployment rather than about the request.',
        }),
        doc_url: z.string(),
        request_id: z.string(),
      })
      .strict(),
  })
  .strict()
  .openapi('Error');

export type ErrorResponse = z.infer<typeof errorSchema>;

// --- Stripe -------------------------------------------------------------------------------

/**
 * `GET /v1/stripe` and `DELETE /v1/stripe`: which Stripe account this project charges on.
 *
 * `status` has three values and they are three different situations. `not_connected` means no
 * authorisation was ever completed for this project and environment; `disconnected` means one
 * was and is not in force any more, either because the customer ran `bookrail stripe
 * disconnect` or because Stripe told us the account was unlinked; `connected` is the only one
 * where a charge can be made.
 *
 * `publishable_key` is the **platform's**, not the connected account's, because that is how
 * Stripe.js works for a direct charge: the front end initialises with the platform's
 * publishable key and `stripeAccount: account_id`. It is returned whatever the status is, as
 * long as the deployment has credentials for the environment, because a front end can be
 * written before the account is linked.
 *
 * `charges_enabled` is read from Stripe at request time and only while `connected`. It is
 * `null` when the status is anything else, and also when Stripe did not answer in time: the
 * field is informative, the rest of the object comes from our own database, and a payment
 * provider having a slow minute is not a reason for this endpoint to fail.
 */
export const stripeConnectionSchema = z
  .object({
    object: z.literal('stripe_connection'),
    status: z.enum(['connected', 'not_connected', 'disconnected']),
    environment: environmentSchema,
    id: objectId('payment_provider_connection').nullable().openapi({
      description: 'The connection object, or `null` when this project never connected one.',
    }),
    account_id: z
      .string()
      .nullable()
      .openapi({ description: 'The Stripe account, `acct_...`.', example: 'acct_1234567890' }),
    publishable_key: z.string().nullable().openapi({
      description:
        "The **platform's** publishable key for this environment. Initialise Stripe.js with it and `stripeAccount: account_id`.",
      example: 'pk_test_1234567890',
    }),
    connected_at: instantOutSchema.nullable(),
    disconnected_at: instantOutSchema.nullable(),
    disconnect_reason: z
      .enum(['user', 'deauthorized'])
      .nullable()
      .openapi({ description: 'Who ended the link: this API, or Stripe.' }),
    charges_enabled: z.boolean().nullable().openapi({
      description:
        'What Stripe says about the connected account right now. `null` while not connected, and `null` when Stripe did not answer in time.',
    }),
    webhook_configured: z.boolean().openapi({
      description:
        'Whether this deployment holds the signing secret of the incoming Stripe webhook endpoint for this environment. `false` means payments can be started and no payment will ever be confirmed, because nothing would be listening.',
    }),
  })
  .strict()
  .openapi('StripeConnection');

export type StripeConnection = z.infer<typeof stripeConnectionSchema>;

/**
 * `POST /v1/stripe/connect`: the authorisation link to open in a browser.
 *
 * Nothing is connected when this is returned, and nothing will be until a person authorises on
 * Stripe's own pages and the browser comes back to the callback. The link carries a single use
 * `state` and stops working at `expires_at`, fifteen minutes later.
 */
export const stripeConnectLinkSchema = z
  .object({
    object: z.literal('stripe_connect_link'),
    url: z.string().openapi({
      description: 'Open it in a browser. It authorises one account, once.',
      example: 'https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_...',
    }),
    expires_at: instantOutSchema,
    environment: environmentSchema,
  })
  .strict()
  .openapi('StripeConnectLink');

export type StripeConnectLink = z.infer<typeof stripeConnectLinkSchema>;

/**
 * What the incoming Stripe webhook answers.
 *
 * Two fields and nothing else, because the sender is another company's retry loop and the only
 * thing it acts on is the status code. `duplicate` is there for the person reading a Stripe
 * dashboard: a redelivery that was recognised as one says so, instead of looking identical to
 * a delivery that did work.
 */
export const stripeWebhookReceiptSchema = z
  .object({
    received: z.literal(true),
    duplicate: z.literal(true).optional().openapi({
      description: 'Present only when this event had already been processed. Nothing was done.',
    }),
  })
  .strict()
  .openapi('StripeWebhookReceipt');

export type StripeWebhookReceipt = z.infer<typeof stripeWebhookReceiptSchema>;

// --- The specification itself ----------------------------------------------------------------

/** What `GET /openapi.json` answers with. */
export const openApiDocumentSchema = z
  .object({
    openapi: z.literal('3.1.0'),
    info: z.record(z.unknown()),
    servers: z.array(z.record(z.unknown())),
    tags: z.array(z.record(z.unknown())),
    security: z.array(z.record(z.unknown())),
    paths: z.record(z.unknown()),
    components: z.record(z.unknown()),
  })
  .strict()
  .openapi('OpenApiDocument');

export type OpenApiDocument = z.infer<typeof openApiDocumentSchema>;

/** The closed list of `Bookrail-Actor` values, for the request header parameter. */
export const actorHeaderSchema = z.enum(API_ACTORS);
