/**
 * The public types of the SDK, **derived** from the generated specification.
 *
 * Not one shape is written by hand here. Everything is a projection of
 * `src/generated/openapi.ts`, which is itself generated from `packages/api/openapi/openapi.json`,
 * which is generated from the Zod schemas of the server and proved by the contract guard of
 * the API test suite. A field that changes on the server therefore changes here by
 * regeneration; there is no second description of the data to keep in step.
 *
 * If a type an SDK caller needs is missing from this file, it is missing from the
 * specification, and the fix belongs to `packages/api`, not here.
 */
import type { components, operations } from './generated/openapi.js';

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

/** The JSON body an operation accepts, or `never` when it takes none. */
export type BodyOf<Op> = Op extends { requestBody?: { content: { 'application/json': infer B } } }
  ? B
  : never;

/** The query parameters an operation accepts, or `never` when it takes none. */
export type QueryOf<Op> = Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** The path parameters an operation takes. */
export type PathOf<Op> = Op extends { parameters: { path?: infer P } } ? NonNullable<P> : never;

type SuccessStatus = 200 | 201;

/** The JSON body a successful call returns: the union of the declared 2xx bodies. */
export type ResultOf<Op> = Op extends { responses: infer R }
  ? {
      [S in Extract<keyof R, SuccessStatus>]: R[S] extends {
        content: { 'application/json': infer B };
      }
        ? B
        : never;
    }[Extract<keyof R, SuccessStatus>]
  : never;

/** The element type of a cursored list envelope. */
export type ItemOf<L> = L extends { data: (infer T)[] } ? T : never;

/* -------------------------------------------------------------------------- */
/* Objects                                                                     */
/* -------------------------------------------------------------------------- */

export type ApiKey = components['schemas']['ApiKey'];
export type Availability = components['schemas']['Availability'];
export type AvailabilityCheck = components['schemas']['AvailabilityCheck'];
export type AvailabilityNext = components['schemas']['AvailabilityNext'];
export type AvailabilityReason = components['schemas']['AvailabilityReason'];
export type AvailabilitySlot = components['schemas']['AvailabilitySlot'];
export type Booking = components['schemas']['Booking'];
export type BookingAllocation = components['schemas']['BookingAllocation'];
export type Customer = components['schemas']['Customer'];
export type Deleted = components['schemas']['Deleted'];
export type ErrorPayload = components['schemas']['Error'];
export type Event = components['schemas']['Event'];
export type ExplainEntry = components['schemas']['ExplainEntry'];
export type ExplainReason = components['schemas']['ExplainReason'];
export type Hold = components['schemas']['Hold'];
export type HoldCreated = components['schemas']['HoldCreated'];
export type Location = components['schemas']['Location'];
export type OpenApiDocument = components['schemas']['OpenApiDocument'];
export type Policy = components['schemas']['Policy'];
export type Project = components['schemas']['Project'];
export type Resource = components['schemas']['Resource'];
export type ResourceBlock = components['schemas']['ResourceBlock'];
export type ResourceGroup = components['schemas']['ResourceGroup'];
export type ResourceOption = components['schemas']['ResourceOption'];
export type Schedule = components['schemas']['Schedule'];
export type ScheduleException = components['schemas']['ScheduleException'];
export type ScheduleRule = components['schemas']['ScheduleRule'];
export type Service = components['schemas']['Service'];
export type ServiceRequirement = components['schemas']['ServiceRequirement'];
export type Webhook = components['schemas']['Webhook'];
export type WebhookCreated = components['schemas']['WebhookCreated'];
export type WebhookDelivery = components['schemas']['WebhookDelivery'];

/** The four values `Bookrail-Actor` accepts; this package always declares `sdk`. */
export type Actor = components['schemas']['BookrailActor'];

/**
 * The nine error families the API declares: `invalid_request`, `authentication`, `permission`,
 * `not_found`, `conflict`, `rate_limit`, `policy_violation`, `payment_required`, `internal`.
 */
export type ErrorType = components['schemas']['Error']['error']['type'];

/* -------------------------------------------------------------------------- */
/* Parameters, one alias per operation that takes any                          */
/* -------------------------------------------------------------------------- */

export type AvailabilityListParams = BodyOf<operations['availability.search']>;
export type AvailabilityNextParams = QueryOf<operations['availability.next']>;
export type AvailabilityCheckParams = BodyOf<operations['availability.check']>;

export type LocationCreateParams = BodyOf<operations['locations.create']>;
export type LocationUpdateParams = BodyOf<operations['locations.update']>;
export type LocationListParams = QueryOf<operations['locations.list']>;

export type ResourceCreateParams = BodyOf<operations['resources.create']>;
export type ResourceUpdateParams = BodyOf<operations['resources.update']>;
export type ResourceListParams = QueryOf<operations['resources.list']>;
export type ResourceBlockParams = BodyOf<operations['resources.block']>;
export type ResourceUnblockParams = BodyOf<operations['resources.unblock']>;
export type ResourceBlockListParams = QueryOf<operations['resources.blocks.list']>;

export type ResourceGroupCreateParams = BodyOf<operations['resource_groups.create']>;
export type ResourceGroupUpdateParams = BodyOf<operations['resource_groups.update']>;
export type ResourceGroupListParams = QueryOf<operations['resource_groups.list']>;

export type ScheduleCreateParams = BodyOf<operations['schedules.create']>;
export type ScheduleUpdateParams = BodyOf<operations['schedules.update']>;
export type ScheduleListParams = QueryOf<operations['schedules.list']>;
export type ScheduleExceptionCreateParams = BodyOf<operations['schedules.exceptions.create']>;

export type ServiceCreateParams = BodyOf<operations['services.create']>;
export type ServiceUpdateParams = BodyOf<operations['services.update']>;
export type ServiceListParams = QueryOf<operations['services.list']>;

export type PolicyCreateParams = BodyOf<operations['policies.create']>;
export type PolicyUpdateParams = BodyOf<operations['policies.update']>;
export type PolicyListParams = QueryOf<operations['policies.list']>;

export type CustomerCreateParams = BodyOf<operations['customers.create']>;
export type CustomerUpdateParams = BodyOf<operations['customers.update']>;
export type CustomerListParams = QueryOf<operations['customers.list']>;

export type HoldCreateParams = BodyOf<operations['holds.create']>;

export type BookingCreateParams = BodyOf<operations['bookings.create']>;
export type BookingListParams = QueryOf<operations['bookings.list']>;
export type BookingConfirmParams = BodyOf<operations['bookings.confirm']>;
export type BookingCancelParams = BodyOf<operations['bookings.cancel']>;
export type BookingRescheduleParams = BodyOf<operations['bookings.reschedule']>;
export type BookingNoShowParams = BodyOf<operations['bookings.no_show']>;
export type BookingCheckInParams = BodyOf<operations['bookings.check_in']>;
export type BookingCompleteParams = BodyOf<operations['bookings.complete']>;

export type EventListParams = QueryOf<operations['events.list']>;

export type WebhookCreateParams = BodyOf<operations['webhooks.create']>;
export type WebhookUpdateParams = BodyOf<operations['webhooks.update']>;
export type WebhookListParams = QueryOf<operations['webhooks.list']>;
export type WebhookDeliveryListParams = QueryOf<operations['webhooks.deliveries.list']>;
