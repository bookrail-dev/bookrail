import { DURATION_PATTERN } from '@bookrail/engine';
import {
  isSubscribableEventType,
  pricingRulesSchema,
  SUBSCRIBABLE_EVENT_TYPES,
} from '@bookrail/shared';
import { z } from '../zod.js';
import {
  currencySchema,
  dateSchema,
  instantSchema,
  metadataSchema,
  nameSchema,
  nonEmptyPatch,
  refId,
  timeOfDaySchema,
  timezoneSchema,
} from './common.js';

export * from './common.js';

// --- Location ---------------------------------------------------------------------------

export const locationCreateSchema = z
  .object({
    name: nameSchema,
    timezone: timezoneSchema,
    address: z.record(z.unknown()).nullish(),
    tenant_id: z.string().min(1).max(200).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const locationUpdateSchema = nonEmptyPatch({
  name: nameSchema.optional(),
  timezone: timezoneSchema.optional(),
  address: z.record(z.unknown()).nullish(),
  tenant_id: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
});

// --- Schedule ---------------------------------------------------------------------------

/**
 * An opening band. `end_time` is deliberately allowed to be **less than or equal to**
 * `start_time`: such a band crosses midnight and ends on the following local day, so
 * `22:00-02:00` is four hours and `00:00-00:00` is the whole day. Migration 0008 dropped the
 * two `CHECK (end_time > start_time)` of 0003 that used to make those bands unstorable.
 */
export const scheduleRuleSchema = z
  .object({
    days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start_time: timeOfDaySchema,
    end_time: timeOfDaySchema,
    valid_from: dateSchema.nullish(),
    valid_until: dateSchema.nullish(),
  })
  .strict();

export const scheduleCreateSchema = z
  .object({
    name: nameSchema,
    timezone: timezoneSchema.nullish(),
    rules: z.array(scheduleRuleSchema).max(100).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const scheduleUpdateSchema = nonEmptyPatch({
  name: nameSchema.optional(),
  timezone: timezoneSchema.nullish(),
  rules: z.array(scheduleRuleSchema).max(100).optional(),
  metadata: metadataSchema.optional(),
});

export const scheduleExceptionCreateSchema = z
  .object({
    date: dateSchema,
    type: z.enum(['closed', 'open']),
    start_time: timeOfDaySchema.nullish(),
    end_time: timeOfDaySchema.nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict()
  // Both times or neither, for `closed` as much as for `open`: a half-specified band has no
  // meaning, and the availability engine rejects it (`packages/engine/src/schedule`).
  .refine((value) => Boolean(value.start_time) === Boolean(value.end_time), {
    message:
      'An exception must provide both start_time and end_time, or neither (which means the whole day).',
    path: ['start_time'],
  })
  .refine((value) => value.type !== 'open' || (value.start_time && value.end_time), {
    message: 'An "open" exception must provide start_time and end_time.',
    path: ['start_time'],
  });

// --- Resource ---------------------------------------------------------------------------

export const resourceCreateSchema = z
  .object({
    name: nameSchema,
    type: z.string().min(1).max(50).optional(),
    location_id: refId('location').nullish(),
    schedule_id: refId('schedule').nullish(),
    capacity: z.number().int().positive().max(100000).optional(),
    attributes: z.record(z.unknown()).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    tenant_id: z.string().min(1).max(200).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const resourceUpdateSchema = nonEmptyPatch({
  name: nameSchema.optional(),
  type: z.string().min(1).max(50).optional(),
  location_id: refId('location').nullish(),
  schedule_id: refId('schedule').nullish(),
  capacity: z.number().int().positive().max(100000).optional(),
  attributes: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  tenant_id: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
});

export const resourceBlockSchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    reason: z.string().max(500).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((value) => value.to > value.from, {
    message: '`to` must be after `from`.',
    path: ['to'],
  });

export const resourceUnblockSchema = z.object({ block_id: refId('resource_block') }).strict();

/**
 * `GET /v1/resources/{id}/blocks?from=&to=`.
 *
 * Not `.strict()`, like every other list query: `limit` and `starting_after` are read by
 * {@link parseListParams} before this runs, and a schema that refused them would refuse the
 * cursor pagination every list has: `?limit=50&starting_after=<id of the last item>`, never
 * an offset.
 */
export const resourceBlockListQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.to > value.from, {
    message: '`to` must be after `from`.',
    path: ['to'],
  });

// --- Resource group ---------------------------------------------------------------------

export const resourceGroupCreateSchema = z
  .object({
    name: nameSchema,
    selector: z.record(z.unknown()).nullish(),
    allocation_strategy: z
      .enum(['least_busy', 'round_robin', 'first_available', 'priority'])
      .optional(),
    resource_ids: z.array(refId('resource')).max(500).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const resourceGroupUpdateSchema = nonEmptyPatch({
  name: nameSchema.optional(),
  selector: z.record(z.unknown()).nullish(),
  allocation_strategy: z
    .enum(['least_busy', 'round_robin', 'first_available', 'priority'])
    .optional(),
  resource_ids: z.array(refId('resource')).max(500).optional(),
  metadata: metadataSchema.optional(),
});

// --- Policy -----------------------------------------------------------------------------

/**
 * One tier of a cancellation or reschedule policy.
 *
 * `before` is validated against the **same** grammar the engine parses (`DURATION_PATTERN` in
 * `@bookrail/engine`), not against a second regex written here: the two had drifted, and a
 * `"90s"` the engine understood was refused by this schema while the engine silently dropped
 * a `"1.5h"` this schema had never seen.
 */
const refundTierSchema = z
  .object({
    before: z
      .string()
      .regex(new RegExp(`^${DURATION_PATTERN}$`), 'Use a duration such as 48h, 30m, 90s or 7d.')
      .openapi({
        description:
          'How long before the start the tier applies, as a duration: seconds, minutes, hours or days.',
        example: '24h',
      }),
    refund_percent: z.number().min(0).max(100).optional(),
    fee: z.number().int().min(0).optional(),
  })
  .strict();

export const policyCreateSchema = z
  .object({
    name: nameSchema,
    cancellation: z.array(refundTierSchema).max(20).optional(),
    reschedule: z.array(refundTierSchema).max(20).optional(),
    deposit: z
      .object({
        type: z.enum(['percent', 'fixed']),
        value: z.number().min(0),
        due: z.enum(['at_booking']).optional(),
      })
      .strict()
      .nullish(),
    payment_timing: z.enum(['at_booking', 'before_start', 'after_service', 'none']).optional(),
    payment_deadline: z.string().max(50).nullish(),
    // `auto_mark` is what turns `grace_minutes` from a rule a human applies into one the
    // background scheduler applies by itself, on its next sweep after the grace period ends.
    no_show: z
      .object({
        charge_percent: z.number().min(0).max(100).optional(),
        grace_minutes: z.number().int().min(0).max(1440).optional(),
        auto_mark: z.boolean().optional(),
        mark_after: z.string().max(50).optional(),
      })
      .strict()
      .nullish(),
    hold_duration_seconds: z.number().int().min(30).max(86400).optional(),
    max_active_bookings_per_customer: z.number().int().positive().nullish(),
    require_customer_confirmation: z.boolean().optional(),
    require_provider_confirmation: z.boolean().optional(),
    // The automatic half of the life cycle. `auto_start` moves a confirmed booking to `in_progress`
    // at its start **without** a check-in, which is what keeps `no_show.auto_mark` able to fire
    // afterwards.
    auto_start: z.boolean().optional(),
    auto_complete: z.boolean().optional(),
    max_reschedules: z.number().int().min(0).max(100).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const policyUpdateSchema = nonEmptyPatch(policyCreateSchema.partial().shape);

// --- Service ----------------------------------------------------------------------------

const serviceRequirementSchema = z
  .object({
    resource_id: refId('resource').optional(),
    resource_group_id: refId('resource_group').optional(),
    quantity: z.number().int().positive().max(1000).optional(),
    // `per_unit` takes `quantity` units of the resource, `whole` takes it entirely whatever
    // the quantity is: an instructor already booked is not half free for somebody else.
    consumes: z.enum(['per_unit', 'whole']).optional(),
    role: z.string().min(1).max(50).nullish(),
  })
  .strict()
  .refine((value) => Boolean(value.resource_id) !== Boolean(value.resource_group_id), {
    message: 'Provide exactly one of resource_id or resource_group_id.',
  });

const serviceCoreShape = {
  name: nameSchema,
  description: z.string().max(5000).nullish(),
  duration: z.number().int().positive().max(525600).optional(),
  duration_options: z.array(z.number().int().positive().max(525600)).min(1).max(20).optional(),
  duration_range: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .strict()
    .optional(),
  capacity_per_booking: z.number().int().positive().max(100000).optional(),
  buffer_before: z.number().int().min(0).max(1440).optional(),
  buffer_after: z.number().int().min(0).max(1440).optional(),
  // `nullish`, not `optional`: the serializer answers `null` for a service without a grid, so
  // a client that reads an object, edits it and writes it back has to be able to send that
  // `null`, and a declarative tool has to be able to **remove** a grid by taking the field out
  // of its file. With `optional` the only way to unset them was a direct SQL update.
  slot_interval: z.number().int().positive().max(1440).nullish(),
  align_to: z.enum(['hour', 'half_hour', 'schedule_start']).nullish(),
  price: z
    .object({ amount: z.number().int().min(0), currency: currencySchema })
    .strict()
    .nullish(),
  // The strict pricing rule schema, shared with the engine and the OpenAPI document
  // (`@bookrail/shared`). It used to be `z.array(z.record(z.unknown()))`: anything object-shaped
  // got in, and nothing ever read it. A rule that a service without a price cannot carry rules is
  // enforced in the route, where the resulting row is known: a `PATCH` may leave the price where it
  // is.
  pricing_rules: pricingRulesSchema.optional(),
  policy_id: refId('policy').nullish(),
  // Minutes and days, not duration strings: the availability engine reads this column
  // directly on every request, and a numeric shape removes a parser (and a whole class of
  // ambiguity) from the hot path.
  booking_window: z
    .object({
      min_notice_minutes: z.number().int().min(0).max(525600).optional(),
      max_advance_days: z.number().int().min(0).max(3650).optional(),
    })
    .strict()
    .nullish(),
  allow_recurring: z.boolean().optional(),
  allow_multi_day: z.boolean().optional(),
  buffer_sharing: z.boolean().optional(),
  allow_split: z.boolean().optional(),
  requirements: z.array(serviceRequirementSchema).max(20).optional(),
  tenant_id: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
};

function exactlyOneDuration(value: {
  duration?: number | undefined;
  duration_options?: number[] | undefined;
  duration_range?: { min: number; max: number } | undefined;
}): boolean {
  const provided =
    Number(value.duration !== undefined) +
    Number(value.duration_options !== undefined) +
    Number(value.duration_range !== undefined);
  return provided === 1;
}

export const serviceCreateSchema = z
  .object(serviceCoreShape)
  .strict()
  .refine(exactlyOneDuration, {
    message: 'Provide exactly one of duration, duration_options or duration_range.',
    path: ['duration'],
  })
  .refine(
    (value) => !value.duration_range || value.duration_range.max >= value.duration_range.min,
    {
      message: 'duration_range.max must be greater than or equal to duration_range.min.',
      path: ['duration_range'],
    },
  );

export const serviceUpdateSchema = nonEmptyPatch({
  ...serviceCoreShape,
  name: nameSchema.optional(),
}).refine(
  (value) =>
    value.duration === undefined &&
    value.duration_options === undefined &&
    value.duration_range === undefined
      ? true
      : exactlyOneDuration(value),
  {
    message: 'Provide exactly one of duration, duration_options or duration_range.',
    path: ['duration'],
  },
);

// --- Customer ---------------------------------------------------------------------------

export const customerCreateSchema = z
  .object({
    external_id: z.string().min(1).max(200).nullish(),
    email: z.string().email().max(320).nullish(),
    phone: z.string().min(3).max(50).nullish(),
    name: z.string().min(1).max(200).nullish(),
    timezone: timezoneSchema.nullish(),
    locale: z.string().min(2).max(20).nullish(),
    tenant_id: z.string().min(1).max(200).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const customerUpdateSchema = nonEmptyPatch({
  external_id: z.string().min(1).max(200).nullish(),
  email: z.string().email().max(320).nullish(),
  phone: z.string().min(3).max(50).nullish(),
  name: z.string().min(1).max(200).nullish(),
  timezone: timezoneSchema.nullish(),
  locale: z.string().min(2).max(20).nullish(),
  tenant_id: z.string().min(1).max(200).nullish(),
  metadata: metadataSchema.optional(),
});

// --- Internal bootstrap -------------------------------------------------------------------

export const bootstrapSchema = z
  .object({
    account_name: nameSchema,
    project_name: nameSchema,
    default_timezone: timezoneSchema.optional(),
    default_currency: currencySchema.optional(),
    tenant_id: z.string().min(1).max(200).nullish(),
    scopes: z.array(z.string().min(1).max(50)).max(50).optional(),
  })
  .strict();

// --- Sign up ------------------------------------------------------------------------------

/**
 * An email address, as strictly as an address can honestly be validated.
 *
 * One `@`, something on the left, and a domain with at least one dot on the right. Nothing
 * further: every regular expression that claims to implement the grammar of an address either
 * rejects valid ones or accepts invalid ones, and the only real test of an address is whether
 * the message arrives, which is exactly what this endpoint is about to do. No library, for the
 * same reason: this is four lines, and the delivery is the check.
 *
 * The value is trimmed and lower cased before it is used, so that two people who type the same
 * address in different cases are one person. The database asserts the same thing with a CHECK,
 * because the uniqueness of an address is a guarantee and a guarantee that depends on the
 * caller having normalised its input is not one.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((value) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value), {
    message: 'Must be an email address, for example you@example.com.',
  })
  .openapi({ type: 'string', format: 'email', example: 'you@example.com' });

export const signupCreateSchema = z
  .object({
    email: emailSchema,
    client: z.enum(['cli', 'web']).openapi({
      description:
        'Where the request came from. `cli` waits for the key on a poll; `web` is handed it in the confirm response.',
    }),
    account_name: nameSchema.optional(),
    project_name: nameSchema.optional(),
    default_timezone: timezoneSchema.optional(),
    default_currency: currencySchema.optional(),
  })
  .strict();

export const signupConfirmSchema = z
  .object({
    token: z.string().min(16).max(200).openapi({
      description: 'The token from the confirmation link, taken out of its `#token=` fragment.',
    }),
  })
  .strict();

export const signupClaimSchema = z
  .object({
    poll_token: z.string().min(16).max(200).openapi({
      description: 'The `poll_token` returned when the sign up was created.',
    }),
  })
  .strict();

// --- Availability -------------------------------------------------------------------------

const quantitySchema = z.number().int().positive().max(100000);
const resourceFilterSchema = z.array(refId('resource')).min(1).max(500);

/**
 * `POST /v1/availability`.
 *
 * `timezone` is presentation only: it is echoed back and used to read the response, never to
 * move the slot grid, which is anchored to the zone of the offer: availability is computed in
 * the resource's own zone and only presented in the one the caller asked for. `explain` is
 * opt-in and expensive, and the route caps its window at seven days.
 */
export const availabilityRequestSchema = z
  .object({
    service_id: refId('service'),
    from: instantSchema,
    to: instantSchema,
    quantity: quantitySchema.optional(),
    resource_ids: resourceFilterSchema.optional(),
    customer_id: refId('customer').nullish(),
    timezone: timezoneSchema.optional(),
    granularity: z.enum(['slots', 'ranges']).optional(),
    explain: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.to > value.from, {
    message: '`to` must be after `from`.',
    path: ['to'],
  });

/** Query string of `GET /v1/availability/next`; every value arrives as text. */
export const availabilityNextQuerySchema = z
  .object({
    service_id: refId('service'),
    from: instantSchema.optional(),
    quantity: z
      .string()
      .regex(/^[1-9]\d{0,5}$/, 'quantity must be a positive integer.')
      .transform(Number)
      .optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

/**
 * `POST /v1/availability/check`: one precise instant, the call a client makes just before
 * confirming. `duration_minutes` picks one of the service's durations; omitting it means the
 * service's own (the shortest, when it offers several).
 */
export const availabilityCheckSchema = z
  .object({
    service_id: refId('service'),
    start: instantSchema,
    duration_minutes: z.number().int().positive().max(525600).optional(),
    quantity: quantitySchema.optional(),
    resource_ids: resourceFilterSchema.optional(),
  })
  .strict();

// --- Hold and Booking ---------------------------------------------------------------------

/**
 * The customer a booking or a hold may carry inline instead of a `customer_id`. Same fields as
 * `POST /v1/customers`, and the same merge semantics; the difference is that here an `email` also
 * **matches** an existing customer, because "the same person booking again" is the common case (see
 * `src/customers.ts`).
 */
export const inlineCustomerSchema = z
  .object({
    external_id: z.string().min(1).max(200).nullish(),
    email: z.string().email().max(320).nullish(),
    phone: z.string().min(3).max(50).nullish(),
    name: z.string().min(1).max(200).nullish(),
    timezone: timezoneSchema.nullish(),
    locale: z.string().min(2).max(20).nullish(),
    tenant_id: z.string().min(1).max(200).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.external_id) || Boolean(value.email) || Boolean(value.phone), {
    message: 'An inline customer needs at least one of external_id, email or phone.',
  });

/**
 * `ttl` in the documented form: `"10m"`, `"600s"`, `"1h"`.
 *
 * A bare number would be ambiguous (seconds? minutes?) and the documented form is a duration
 * string, so that is the only form accepted. The engine clamps the result to the policy's
 * maximum (30 minutes), which is why no upper bound is checked here.
 */
export const ttlSchema = z
  .string()
  .regex(/^([1-9]\d{0,5})([smh])$/, 'Use a duration such as 10m, 600s or 1h.')
  .transform((value) => {
    const match = /^(\d+)([smh])$/.exec(value);
    const amount = Number(match![1]);
    const unit = match![2];
    return unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600;
  })
  .openapi({
    type: 'string',
    pattern: '^([1-9]\\d{0,5})([smh])$',
    description:
      'How long the hold lives, as a duration string (`10m`, `600s`, `1h`). Clamped to 30 minutes by the engine. Defaults to `policy.hold_duration_seconds`.',
    example: '10m',
  });

const bookingCoreShape = {
  service_id: refId('service'),
  start: instantSchema,
  duration_minutes: z.number().int().positive().max(525600).optional(),
  quantity: quantitySchema.optional(),
  resource_ids: resourceFilterSchema.optional(),
  customer_id: refId('customer').nullish(),
  customer: inlineCustomerSchema.optional(),
  notes: z.string().max(5000).nullish(),
  metadata: metadataSchema.optional(),
  source: z.enum(['api', 'widget', 'portal', 'import']).optional(),
};

/** Both ways of naming the customer at once is a contradiction, not a precedence rule. */
function oneCustomerAtMost(value: { customer_id?: string | null; customer?: unknown }): boolean {
  return !(value.customer_id && value.customer !== undefined);
}

export const holdCreateSchema = z
  .object({ ...bookingCoreShape, ttl: ttlSchema.optional() })
  .strict()
  .refine(oneCustomerAtMost, {
    message: 'Provide customer_id or customer, not both.',
    path: ['customer'],
  });

/**
 * `payment` and `recurrence` are accepted by the schema and refused by the route with
 * `not yet supported`, rather than rejected here as unknown fields: the reference
 * documentation lists them, and a caller that sends them deserves to be told they are not
 * implemented yet instead of being told the field does not exist.
 */
export const bookingCreateSchema = z
  .object({
    ...bookingCoreShape,
    hold_id: refId('hold').nullish(),
    payment: z
      .object({
        mode: z.enum(['none', 'deposit', 'full', 'entitlement']),
        entitlement_id: z.string().min(1).max(200).nullish(),
      })
      .strict()
      .nullish(),
    recurrence: z.record(z.unknown()).nullish(),
  })
  .strict()
  .refine(oneCustomerAtMost, {
    message: 'Provide customer_id or customer, not both.',
    path: ['customer'],
  });

/** Filters of `GET /v1/bookings`. Query values are text, so instants are parsed as strings. */
export const bookingListQuerySchema = z
  .object({
    customer_id: refId('customer').optional(),
    resource_id: refId('resource').optional(),
    service_id: refId('service').optional(),
    status: z
      .enum([
        'held',
        'pending',
        'confirmed',
        'in_progress',
        'completed',
        'cancelled',
        'no_show',
        'rescheduled',
      ])
      .optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.to > value.from, {
    message: '`to` must be after `from`.',
    path: ['to'],
  });

// --- Booking transitions -------------------------------------------------------------------

/**
 * `POST /v1/bookings/{id}/cancel`.
 *
 * `by` defaults to `customer`, which is who cancels in the overwhelming majority of cases and
 * the reading that costs the business money if it is wrong in the other direction: a
 * cancellation silently attributed to the provider would refund 100% of everything.
 *
 * `override_refund_percent` beats every tier, for any `by`. It is how a business grants a
 * refund its own policy does not, which is a thing businesses do, and recording it as an
 * override rather than as an invented tier keeps the audit trail honest.
 */
export const bookingCancelSchema = z
  .object({
    reason: z.string().max(1000).nullish(),
    by: z.enum(['customer', 'provider', 'system']).optional(),
    override_refund_percent: z.number().min(0).max(100).nullish(),
  })
  .strict();

/**
 * `POST /v1/bookings/{id}/reschedule`.
 *
 * The duration, the service, the quantity and the customer come from the booking being moved:
 * a reschedule changes **when**, and a request that wanted to change what was booked is a new
 * booking plus a cancellation, which the caller can express exactly.
 */
export const bookingRescheduleSchema = z
  .object({
    start: instantSchema,
    resource_ids: resourceFilterSchema.optional(),
  })
  .strict();

/** `confirm`, `no_show`, `check_in` and `complete` take no parameters. */
export const bookingActionSchema = z.object({}).strict();

/** Filters of `GET /v1/events`. Query values are text. */
/**
 * `type` accepts one value or many.
 *
 * `?type=booking.created` is what it always was; `?type[]=booking.created&type[]=booking.cancelled`
 * is the new form, and both normalise to an array so the route has one shape to filter on. The
 * cap of 50 is the size of the subscribable list plus room: a filter with a thousand values is
 * not a filter, and `IN` lists that big belong to a query nobody meant to write.
 */
const eventTypeFilterSchema = z
  .union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1).max(50)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const eventListQuerySchema = z
  .object({
    type: eventTypeFilterSchema.optional(),
    /** The prefixed identifier of the object the event is about, e.g. `bk_...`. */
    object_id: z.string().min(1).max(100).optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.to > value.from, {
    message: '`to` must be after `from`.',
    path: ['to'],
  });

// --- Webhook -----------------------------------------------------------------

/**
 * The event types an endpoint subscribes to.
 *
 * `["*"]` by default, because that is what an integration wants on day one and because a
 * missing subscription list that meant "nothing" would produce an endpoint that silently
 * receives no traffic. Validated against `SUBSCRIBABLE_EVENT_TYPES` (`@bookrail/shared`), which
 * is every type the API documents, including the ones payments and waitlists will
 * emit, so an integration can register for them before they start arriving. A misspelled type
 * is a 400, never a subscription that quietly matches nothing.
 */
export const webhookEventsSchema = z
  .array(
    z.string().refine(isSubscribableEventType, {
      message: `Unknown event type. Use "*" or one of: ${SUBSCRIBABLE_EVENT_TYPES.join(', ')}.`,
    }),
  )
  .min(1)
  .max(50);

export const webhookCreateSchema = z
  .object({
    url: z.string().min(1).max(2048),
    events: webhookEventsSchema.optional(),
    description: z.string().max(500).nullish(),
    metadata: metadataSchema.optional(),
  })
  .strict();

/**
 * `status` accepts only `active` and `disabled`.
 *
 * `failing` is an observation the delivery worker makes, not a state a customer sets; setting
 * it by hand would say something untrue about an endpoint that is answering. Setting `active`
 * on a `failing` endpoint is how it is taken back into service, and it is the one transition
 * out of `failing` a customer controls (the other is a delivery that succeeds).
 */
export const webhookUpdateSchema = nonEmptyPatch({
  url: z.string().min(1).max(2048).optional(),
  events: webhookEventsSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().max(500).nullish(),
  metadata: metadataSchema.optional(),
});

/** Filters of `GET /v1/webhooks/{id}/deliveries`. */
export const webhookDeliveryListQuerySchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed']).optional(),
  event_id: refId('event').optional(),
});
