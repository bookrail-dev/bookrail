/**
 * `@bookrail/node`: the Bookrail SDK for TypeScript.
 *
 * ```ts
 * import Bookrail from '@bookrail/node';
 *
 * const bookrail = new Bookrail(process.env.BOOKRAIL_SECRET_KEY!);
 *
 * const { slots } = await bookrail.availability.list({
 *   service_id: 'svc_…',
 *   from: '2026-09-08T00:00:00+02:00',
 *   to: '2026-09-15T00:00:00+02:00',
 * });
 *
 * const booking = await bookrail.bookings.create(
 *   {
 *     service_id: 'svc_…',
 *     start: slots[0].start,
 *     customer: { email: 'anna@example.com', name: 'Anna' },
 *   },
 *   { idempotencyKey: orderId },
 * );
 * ```
 *
 * The field names are the **API's own**, in `snake_case`, and the instants are ISO 8601 with an
 * explicit offset. A renaming layer would be one more place to get it wrong, would make the API
 * reference unusable next to the SDK, and would have to be reinvented in every other language.
 * Methods and namespaces are `camelCase`, because those are ours.
 *
 * ESM only. Node 20.10 or newer, Deno, Bun, and edge runtimes.
 */
import { BookrailCore, type RequestOptions, type BookrailOptions } from './core.js';
import { AvailabilityResource } from './resources/availability.js';
import { BookingsResource } from './resources/bookings.js';
import { CustomersResource } from './resources/customers.js';
import { EventsResource } from './resources/events.js';
import { HoldsResource } from './resources/holds.js';
import { LocationsResource } from './resources/locations.js';
import { OpenApiResource } from './resources/openapi.js';
import { PoliciesResource } from './resources/policies.js';
import { ProjectResource } from './resources/project.js';
import { ResourceGroupsResource } from './resources/resource-groups.js';
import { ResourcesResource } from './resources/resources.js';
import { SchedulesResource } from './resources/schedules.js';
import { ServicesResource } from './resources/services.js';
import { WebhooksResource } from './resources/webhooks.js';

export class Bookrail {
  /** `test` or `live`, decided by the prefix of the key. Never by a flag. */
  readonly environment: 'test' | 'live';
  /** Where this client sends its requests. */
  readonly baseUrl: string;
  /** The value of `Bookrail-Version` on every request. */
  readonly apiVersion: string;

  readonly project: ProjectResource;
  readonly availability: AvailabilityResource;
  readonly locations: LocationsResource;
  readonly resources: ResourcesResource;
  readonly resourceGroups: ResourceGroupsResource;
  readonly schedules: SchedulesResource;
  readonly services: ServicesResource;
  readonly policies: PoliciesResource;
  readonly customers: CustomersResource;
  readonly holds: HoldsResource;
  readonly bookings: BookingsResource;
  readonly events: EventsResource;
  readonly webhooks: WebhooksResource;
  /** `GET /openapi.json`: the contract of this installation, no key needed. */
  readonly openapi: OpenApiResource;

  constructor(secretKey: string, options: BookrailOptions = {}) {
    const core = new BookrailCore(secretKey, options);
    this.environment = core.environment;
    this.baseUrl = core.baseUrl;
    this.apiVersion = core.apiVersion;

    this.project = new ProjectResource(core);
    this.availability = new AvailabilityResource(core);
    this.locations = new LocationsResource(core);
    this.resources = new ResourcesResource(core);
    this.resourceGroups = new ResourceGroupsResource(core);
    this.schedules = new SchedulesResource(core);
    this.services = new ServicesResource(core);
    this.policies = new PoliciesResource(core);
    this.customers = new CustomersResource(core);
    this.holds = new HoldsResource(core);
    this.bookings = new BookingsResource(core);
    this.events = new EventsResource(core);
    this.webhooks = new WebhooksResource(core);
    this.openapi = new OpenApiResource(core);
  }
}

export default Bookrail;

export {
  BookrailCore,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  RETRY_INITIAL_MS,
  RETRY_JITTER,
  RETRY_MAX_MS,
  RETRYABLE_CONFLICT_CODES,
  type FetchLike,
  type RequestOptions,
  type SleepLike,
  type BookrailOptions,
} from './core.js';
export {
  BookrailAuthenticationError,
  BookrailConflictError,
  BookrailConnectionError,
  BookrailError,
  BookrailInternalError,
  BookrailInvalidRequestError,
  BookrailNotFoundError,
  BookrailPaymentRequiredError,
  BookrailPermissionError,
  BookrailPolicyViolationError,
  BookrailRateLimitError,
  BookrailSignatureVerificationError,
  type ConnectionErrorCode,
  type BookrailErrorOptions,
} from './errors.js';
export { Page, PagePromise, type ListEnvelope } from './pagination.js';
export { BookrailPromise, type ResponseInfo, type WithResponse } from './response.js';
export { API_VERSION, DEFAULT_BASE_URL, SDK_VERSION, USER_AGENT } from './version.js';
export * from './types.js';

export { AvailabilityResource } from './resources/availability.js';
export { BookingsResource } from './resources/bookings.js';
export { CustomersResource } from './resources/customers.js';
export { EventsResource } from './resources/events.js';
export { HoldsResource } from './resources/holds.js';
export { LocationsResource } from './resources/locations.js';
export { OpenApiResource } from './resources/openapi.js';
export { PoliciesResource } from './resources/policies.js';
export { ProjectResource } from './resources/project.js';
export { ResourceGroupsResource } from './resources/resource-groups.js';
export { ResourceBlocksResource, ResourcesResource } from './resources/resources.js';
export { ScheduleExceptionsResource, SchedulesResource } from './resources/schedules.js';
export { ServicesResource } from './resources/services.js';
export { WebhookDeliveriesResource, WebhooksResource } from './resources/webhooks.js';
export type { components, operations, paths } from './generated/openapi.js';

/** Re-exported so a `RequestOptions` can be named without a second import. */
export type BookrailRequestOptions = RequestOptions;
