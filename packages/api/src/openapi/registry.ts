/**
 * Every operation of `/v1`, as data.
 *
 * The registry is the single declarative list from which three things are derived and cannot
 * drift apart: the OpenAPI document (`generate.ts`), the contract guard that validates every
 * response of the test suite (`contract.ts`), and the coverage check that refuses an operation
 * no test ever calls. A route added to `app.ts` without an entry here fails
 * `openapi.test.ts` («registry ↔ app»), and an entry here without a route fails it too.
 *
 * ## `operationId`
 *
 * `resource.verb`, dotted, lowercase, with the sub-resource in the middle
 * (`resources.blocks.list`, `webhooks.deliveries.retry`). Dots rather than camelCase because
 * the identifier is a **path** into the SDK (`bookrail.resources.blocks.list(...)`), and the
 * SDK generator can split on `.` to build the namespaces instead of parsing a
 * convention out of a single word. The verbs are the five of the CRUD (`create`, `list`,
 * `get`, `update`, `delete`) plus the name of the action for everything else (`cancel`,
 * `reschedule`, `block`, `test`, `retry`), which is what the CLI and the MCP tools already
 * call them.
 *
 * ## `errorCodes`
 *
 * Only the codes **specific** to the operation. The ones every operation can produce
 * (authentication, the version header, the actor header) and the ones every POST can produce
 * (idempotency, an unparseable body) are added by the generator from {@link COMMON_ERROR_CODES}
 * and {@link COMMON_POST_ERROR_CODES}: repeating them sixty-six times would guarantee that one
 * of the sixty-six eventually falls behind.
 */
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { statusForCode, type ErrorType, type ObjectKind } from '@bookrail/shared';
import { z } from '../zod.js';
import {
  availabilityCheckSchema as availabilityCheckBodySchema,
  availabilityNextQuerySchema,
  availabilityRequestSchema,
  bookingActionSchema,
  bookingCancelSchema,
  bookingCreateSchema,
  bookingListQuerySchema,
  bookingRescheduleSchema,
  customerCreateSchema,
  paymentListQuerySchema,
  customerUpdateSchema,
  holdCreateSchema,
  locationCreateSchema,
  locationUpdateSchema,
  policyCreateSchema,
  policyUpdateSchema,
  resourceBlockListQuerySchema,
  resourceBlockSchema as resourceBlockBodySchema,
  resourceCreateSchema,
  resourceGroupCreateSchema,
  resourceGroupUpdateSchema,
  resourceUnblockSchema,
  resourceUpdateSchema,
  scheduleCreateSchema,
  scheduleExceptionCreateSchema,
  scheduleUpdateSchema,
  serviceCreateSchema,
  serviceUpdateSchema,
  signupClaimSchema,
  signupConfirmSchema,
  signupCreateSchema,
  billingChangeSchema,
  billingCheckoutSchema,
  dashboardKeyCreateSchema,
  dashboardLoginConfirmSchema,
  dashboardLoginSchema as dashboardLoginBodySchema,
  webhookCreateSchema,
  webhookDeliveryListQuerySchema,
  webhookUpdateSchema,
} from '../schemas/index.js';
import { idPattern, instantSchema } from '../schemas/common.js';
import {
  availabilityCheckSchema,
  availabilityNextSchema,
  availabilitySchema,
  bookingCreatedSchema,
  bookingSchema,
  customerSchema,
  billingChangeResponseSchema,
  billingRedirectSchema,
  dashboardAccountSchema,
  dashboardApiKeyCreatedSchema,
  dashboardApiKeySchema,
  dashboardLoginSchema,
  dashboardSessionSchema,
  deletedSchema,
  eventSchema,
  holdCreatedSchema,
  holdSchema,
  listOf,
  locationSchema,
  openApiDocumentSchema,
  paymentSchema,
  policySchema,
  projectSchema,
  resourceBlockSchema,
  resourceGroupSchema,
  resourceSchema,
  scheduleExceptionSchema,
  scheduleSchema,
  serviceSchema,
  signupSchema,
  stripeConnectionSchema,
  stripeConnectLinkSchema,
  stripeWebhookReceiptSchema,
  webhookCreatedSchema,
  webhookDeliverySchema,
  webhookSchema,
} from '../schemas/responses.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../http.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

type RequestConfig = NonNullable<RouteConfig['request']>;
/** What the generator accepts as a query object: a Zod object, or one wrapped in a refinement. */
export type QuerySchema = NonNullable<RequestConfig['query']>;

export interface OperationDefinition {
  readonly method: HttpMethod;
  /** OpenAPI form, with `{id}` rather than Hono's `:id`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** Path parameters, in the order they appear in `path`. */
  readonly pathParams?: readonly { name: string; kind: ObjectKind; description: string }[];
  readonly query?: QuerySchema;
  readonly body?: z.ZodTypeAny;
  /** Status code → the schema of the body at that status. */
  readonly responses: Readonly<Record<number, z.ZodTypeAny>>;
  /** Error codes specific to this operation; the common ones are added by the generator. */
  readonly errorCodes: readonly string[];
  /** Every POST of `/v1` honours `Idempotency-Key`; nothing else reads it. */
  readonly idempotent?: boolean;
  /** Values `expand[]` accepts, when the operation accepts it at all. */
  readonly expand?: readonly string[];
  /**
   * Skips the bearer security requirement: `GET /openapi.json`, the sign up operations, the two
   * dashboard operations that obtain a session, and the Stripe webhook receivers.
   */
  readonly public?: boolean;
  /**
   * Opened by a dashboard session (`Authorization: Bearer bds_...`) instead of an API key.
   *
   * Such an operation has the `dashboardSession` security requirement instead of `bearerAuth`,
   * carries the rate limit headers of its session's bucket but never `Bookrail-Plan-Usage`, and,
   * like a public one, gets none of the error codes the API key middleware chain produces: it
   * lists its own.
   */
  readonly auth?: 'dashboard';
  /**
   * Keep this operation out of the generated SDK.
   *
   * The SDK is constructed with a key, and these three operations are how a key comes into
   * being: a method for them would be a method nobody who has an SDK object can need. The flag
   * travels into the document as `x-bookrail-sdk: false`, so the generator reads it from the
   * specification rather than from a second list somebody has to keep in step.
   */
  readonly sdk?: false;
}

// --- The error taxonomy of the API -----------------------------------------------------------

/**
 * Which `type`, and therefore which HTTP status, each documented code belongs to.
 *
 * Compiled by hand and checked against the source in `openapi.test.ts`: a code produced by the code
 * and missing here, or listed here and produced nowhere, is a failure. `statusForType` of
 * `@bookrail/shared` turns the type into the status, so the two cannot disagree.
 */
export const ERROR_CODE_TYPES: Readonly<Record<string, ErrorType>> = {
  // General: codes that belong to no single family of endpoints
  parameter_missing: 'invalid_request',
  parameter_invalid: 'invalid_request',
  invalid_body: 'invalid_request',
  unsupported_api_version: 'invalid_request',
  invalid_request: 'invalid_request',
  missing_api_key: 'authentication',
  invalid_authorization_header: 'authentication',
  invalid_api_key: 'authentication',
  revoked_api_key: 'authentication',
  resource_missing: 'not_found',
  unknown_endpoint: 'not_found',
  duplicate_record: 'conflict',
  operation_not_permitted: 'permission',
  insufficient_scope: 'permission',
  internal_error: 'internal',
  /**
   * The per key ceiling of the rate limiter, on every operation that takes a key.
   *
   * Listed here rather than in the operation by operation lists below, and added by the generator
   * through `COMMON_ERROR_CODES`, for the same reason as the authentication codes: it is produced
   * by the middleware chain and not by a route, so every authenticated operation can answer it and
   * repeating it seventy times would guarantee that one of the seventy fell behind.
   */
  rate_limited: 'rate_limit',
  /**
   * A guard, not a code a caller can act on. The booking transaction refuses to run on a
   * superuser or `BYPASSRLS` connection (`packages/engine/src/booking/queries.ts`) and says so
   * with this code, which is why it is reported as an internal error.
   */
  privileged_connection: 'internal',
  // Availability: the three availability endpoints
  range_too_large: 'invalid_request',
  invalid_range: 'invalid_request',
  timezone_missing: 'invalid_request',
  service_without_duration: 'invalid_request',
  // Writes: the booking transaction, the hold and booking endpoints, and every POST of `/v1`
  slot_unavailable: 'conflict',
  hold_expired: 'conflict',
  hold_not_active: 'conflict',
  serialization_failure: 'conflict',
  idempotency_key_in_progress: 'conflict',
  idempotency_key_reused: 'invalid_request',
  start_not_on_grid: 'policy_violation',
  min_notice_violated: 'policy_violation',
  outside_booking_window: 'policy_violation',
  customer_limit_reached: 'policy_violation',
  duration_not_offered: 'invalid_request',
  resource_not_eligible: 'invalid_request',
  hold_mismatch: 'invalid_request',
  not_yet_supported: 'invalid_request',
  payload_too_large: 'invalid_request',
  // `internal`, so 500, so Stripe delivers the event again. It is not a caller's mistake and
  // there is no caller to correct: the only integration that sees it is Stripe itself.
  payment_amount_mismatch: 'internal',
  // Transitions: the six booking transition endpoints
  invalid_transition: 'conflict',
  no_show_too_early: 'policy_violation',
  complete_too_early: 'policy_violation',
  max_reschedules_reached: 'policy_violation',
  // Webhooks: the webhook endpoints and the delivery worker
  invalid_webhook_url: 'invalid_request',
  delivery_too_old: 'conflict',
  webhook_disabled: 'conflict',
  /**
   * Sign up: the three endpoints of `/v1/signups`, the only ones with no key in front of them.
   *
   * Three of these carry a status their family does not imply, named in `STATUS_BY_CODE` of
   * `@bookrail/shared`: a link that has been used or has run out is `410 Gone`, a deployment
   * with no mailer is `503`, and a mail server that refused the message is `502`. The family
   * still decides the `type` in the body and the exit code a client maps it to.
   */
  signup_rate_limited: 'rate_limit',
  signup_not_found: 'not_found',
  signup_already_confirmed: 'conflict',
  signup_expired: 'conflict',
  signup_secret_claimed: 'conflict',
  signup_secret_expired: 'conflict',
  signup_disabled: 'internal',
  signup_email_failed: 'internal',
  /**
   * Dashboard: the six endpoints of `/v1/dashboard`, opened by a session and never by a key.
   *
   * Two carry a status their family does not imply, named in `STATUS_BY_CODE`: a link that has
   * run out is `410`, and a deployment with no mailer is `503`. `key_limit_reached` is a `409`:
   * the project already has five active secret keys in that environment.
   */
  dashboard_disabled: 'internal',
  dashboard_login_rate_limited: 'rate_limit',
  dashboard_login_not_found: 'not_found',
  dashboard_login_used: 'conflict',
  dashboard_login_expired: 'conflict',
  dashboard_session_invalid: 'authentication',
  key_limit_reached: 'conflict',
  key_creation_rate_limited: 'rate_limit',
  /**
   * Stripe: the three keyed routes of `/v1/stripe`.
   *
   * Three of the four carry a status their family does not imply, named in `STATUS_BY_CODE` of
   * `@bookrail/shared`. A deployment with no platform credentials is `503`, because the
   * endpoint exists and is not serving; a refusal from Stripe that this API did not expect, and
   * a Stripe that did not answer at all, are both `502`, because this service is fine and the
   * one behind it is not.
   */
  stripe_not_configured: 'internal',
  stripe_already_connected: 'conflict',
  stripe_provider_error: 'internal',
  stripe_unreachable: 'internal',
  /**
   * Payments: the creation with `payment.mode`, the transitions, and the webhook receiver.
   *
   * `stripe_not_connected` is `409` and not `503` on purpose, and the distinction is the one
   * that decides who fixes it: `stripe_not_configured` is about the **deployment** and is
   * somebody else's job, while this one is about **this project** and is fixed by its own owner
   * with the one command the `fix` names.
   *
   * `reschedule_not_supported` is `422` and carries its own code rather than reusing
   * `not_yet_supported`, which is a `400`: one code cannot carry two statuses in this taxonomy,
   * and the two situations are genuinely different. A `recurrence` or an `entitlement` is a
   * field of the request that this build does not implement, which is a bad request. Moving a
   * booking that has money on it is a perfectly well formed request about a state this build
   * cannot yet reconcile, which is a policy violation.
   */
  stripe_not_connected: 'conflict',
  price_missing: 'invalid_request',
  deposit_not_configured: 'invalid_request',
  payment_amount_invalid: 'invalid_request',
  payment_pending: 'conflict',
  reschedule_not_supported: 'policy_violation',
  stripe_signature_invalid: 'invalid_request',
  /**
   * Plans: the free plan's threshold, on the one operation that creates a live booking.
   *
   * `payment_required` and therefore `402`: the request is well formed and the booking would be
   * possible, and what stands in its way is the plan of the account. It always carries a `fix`
   * that says how to move to a paying plan, and `param: "payment.mode"` when it is the included
   * paid volume that a payment would go past rather than the included bookings.
   */
  plan_limit_reached: 'payment_required',
  /**
   * Terms: a sign up, or a checkout from the dashboard, that does not carry both ticks of the
   * terms in force. `400`: the request is well formed, and what is missing is an agreement.
   */
  terms_not_accepted: 'invalid_request',
  /**
   * Billing: the checkout and the portal of the dashboard, and the receiver of the Stripe Billing
   * events. Three carry a status their family does not imply, named in `STATUS_BY_CODE`: a
   * deployment where Billing is switched off, or whose Stripe catalogue is incomplete, is `503`,
   * and a refusal or a silence of Stripe is `502`. `billing_connect_event` is the `400` of an event
   * of a connected account sent to the receiver of the account's own events: a Connect endpoint
   * registered at the wrong URL, made visible.
   */
  billing_not_configured: 'internal',
  billing_provider_error: 'internal',
  billing_unreachable: 'internal',
  subscription_exists: 'conflict',
  plan_is_contract: 'conflict',
  billing_customer_missing: 'conflict',
  billing_connect_event: 'invalid_request',
  // The changes of plan made from the dashboard (the portal no longer makes them), and the
  // invoice a closed subscription left unpaid, which stops a new checkout.
  billing_subscription_missing: 'conflict',
  plan_change_refused: 'conflict',
  invoice_unpaid: 'conflict',
  // An event of the other Stripe mode than the one of the deployment: a configuration mistake,
  // not a bad signature.
  billing_mode_mismatch: 'invalid_request',
};

export function statusOfCode(code: string): number {
  const type = ERROR_CODE_TYPES[code];
  if (type === undefined) throw new Error(`Undocumented error code: ${code}`);
  return statusForCode(code, type);
}

/** Produced by the middleware chain, so reachable from every authenticated operation. */
export const COMMON_ERROR_CODES: readonly string[] = [
  'missing_api_key',
  'invalid_authorization_header',
  'invalid_api_key',
  'revoked_api_key',
  'unsupported_api_version',
  'parameter_invalid',
  'rate_limited',
  'internal_error',
];

/** Produced by the schema parsers, on any operation that reads a body or a query string. */
export const COMMON_INPUT_ERROR_CODES: readonly string[] = [
  'parameter_invalid',
  'parameter_missing',
];

/** Produced by the `Idempotency-Key` middleware and by the body parser, on every POST. */
export const COMMON_POST_ERROR_CODES: readonly string[] = [
  'idempotency_key_reused',
  'idempotency_key_in_progress',
  'invalid_body',
];

/**
 * Documented codes that belong to no single operation.
 *
 * `unknown_endpoint` is the answer to a URL that matches nothing, so it has no operation to be
 * attached to; the others are translations of a Postgres error that any write can hit
 * (`src/pg-errors.ts`) and the two defaults of `errors.*` that no call site overrides yet.
 */
export const GLOBAL_ERROR_CODES: readonly string[] = [
  'unknown_endpoint',
  'duplicate_record',
  'operation_not_permitted',
  'insufficient_scope',
  'invalid_request',
  'privileged_connection',
];

// --- Shared query fragments ------------------------------------------------------------------

/**
 * `limit` and `starting_after`, read by `parseListParams` before any schema runs.
 *
 * Declared here rather than derived: `parseListParams` reads `c.req.query()` directly and
 * validates by hand, and rewriting it to consume a Zod schema would change the parsing, which
 * nothing here does. The two are kept honest by `openapi.test.ts`, which parses the
 * bounds out of this schema and checks them against `DEFAULT_LIST_LIMIT` and `MAX_LIST_LIMIT`.
 */
export function listQuery(cursorKind: ObjectKind) {
  return z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIST_LIMIT)
      .optional()
      .openapi({
        description: `How many objects to return, 1 to ${String(MAX_LIST_LIMIT)}. Defaults to ${String(DEFAULT_LIST_LIMIT)}.`,
        example: DEFAULT_LIST_LIMIT,
      }),
    starting_after: z
      .string()
      .optional()
      .openapi({
        description: 'Cursor: the `id` of the last object of the previous page.',
        pattern: idPattern(cursorKind),
      }),
  });
}

function expandQuery(values: readonly string[]) {
  return z.object({
    'expand[]': z
      .array(z.enum(values as [string, ...string[]]))
      .optional()
      .openapi({
        description: `Related objects to inline. Repeat the parameter, or send a comma separated list. Accepts: ${values.join(', ')}.`,
      }),
  });
}

function merge(...schemas: z.AnyZodObject[]): z.AnyZodObject {
  return schemas.reduce((all, one) => all.merge(one));
}

const ID_PARAM = (kind: ObjectKind, what: string) => [
  { name: 'id', kind, description: `Identifier of the ${what}.` },
];

// --- Error code groups reused across operations ------------------------------------------------

/** Every reference resolved out of the body, and the ceilings, of a hold or a booking. */
const BOOKING_WRITE_CODES: readonly string[] = [
  'parameter_invalid',
  'resource_missing',
  'resource_not_eligible',
  'duration_not_offered',
  'service_without_duration',
  'slot_unavailable',
  'serialization_failure',
  'start_not_on_grid',
  'min_notice_violated',
  'outside_booking_window',
  'customer_limit_reached',
];

const TRANSITION_CODES: readonly string[] = [
  'resource_missing',
  'invalid_transition',
  'no_show_too_early',
  'complete_too_early',
  'serialization_failure',
];

const AVAILABILITY_CODES: readonly string[] = [
  'parameter_invalid',
  'resource_missing',
  'range_too_large',
  'invalid_range',
  'timezone_missing',
  'service_without_duration',
];

// --- The operations --------------------------------------------------------------------------

export const OPERATIONS: readonly OperationDefinition[] = [
  // --- The specification itself ---------------------------------------------------------------
  {
    method: 'get',
    path: '/openapi.json',
    operationId: 'openapi.get',
    summary: 'Fetch this OpenAPI document',
    description:
      'The specification of this API, generated from the same Zod schemas the server validates with. No API key required.',
    tags: ['meta'],
    responses: { 200: openApiDocumentSchema },
    errorCodes: [],
    public: true,
  },

  // --- Sign up --------------------------------------------------------------------------------
  //
  // The only operations of `/v1` with `security: []`, and the only ones kept out of the SDK: an
  // SDK is constructed with a key, and these three are where a key comes from.
  {
    method: 'post',
    path: '/v1/signups',
    operationId: 'signups.create',
    summary: 'Ask for a test key',
    description:
      'Sends a confirmation link to the address. The answer is the same whether or not that address already has an account: the collision is reported at confirmation time, to whoever can read the mailbox. No API key.',
    tags: ['signups'],
    body: signupCreateSchema,
    responses: { 202: signupSchema },
    errorCodes: [
      'terms_not_accepted',
      'signup_rate_limited',
      'signup_disabled',
      'signup_email_failed',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    public: true,
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/signups/confirm',
    operationId: 'signups.confirm',
    summary: 'Confirm a sign up and create the key',
    description:
      'Creates the account, the project and one test key, in one transaction. For `client: "web"` the key is in the response, once. For `client: "cli"` it waits for the terminal to claim it. No API key.',
    tags: ['signups'],
    body: signupConfirmSchema,
    responses: { 200: signupSchema },
    errorCodes: [
      'signup_not_found',
      'signup_already_confirmed',
      'signup_expired',
      'signup_disabled',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    public: true,
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/signups/{id}/claim',
    operationId: 'signups.claim',
    summary: 'Collect the key of a confirmed sign up',
    description:
      'What a waiting terminal polls. Answers `pending` until the link is opened, then the key, once. No API key.',
    tags: ['signups'],
    pathParams: ID_PARAM('signup', 'sign up'),
    body: signupClaimSchema,
    responses: { 200: signupSchema },
    errorCodes: [
      'signup_not_found',
      'signup_secret_claimed',
      'signup_secret_expired',
      'signup_disabled',
      'resource_missing',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    public: true,
    sdk: false,
  },

  // --- Dashboard ------------------------------------------------------------------------------
  //
  // The account's own view, for the dashboard page of the website. Two operations obtain a
  // session and take no credential at all; the other four take the session. None of them takes
  // an API key, and none is in the SDK: a key must not be able to manage keys.
  {
    method: 'post',
    path: '/v1/dashboard/login',
    operationId: 'dashboard.login',
    summary: 'Ask for a dashboard sign in link',
    description:
      'Sends a single use link, valid for fifteen minutes, to the owner address of a self service account. The answer is the same `202` whether or not the address has an account. No API key.',
    tags: ['dashboard'],
    body: dashboardLoginBodySchema,
    responses: { 202: dashboardLoginSchema },
    errorCodes: [
      'dashboard_login_rate_limited',
      'dashboard_disabled',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    public: true,
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/login/confirm',
    operationId: 'dashboard.login.confirm',
    summary: 'Open a dashboard sign in link',
    description:
      'Turns the token of the link into a session of twelve hours, absolute, with no renewal. The session token is in this answer and nowhere else. A link works once. No API key.',
    tags: ['dashboard'],
    body: dashboardLoginConfirmSchema,
    responses: { 200: dashboardSessionSchema },
    errorCodes: [
      'dashboard_login_not_found',
      'dashboard_login_used',
      'dashboard_login_expired',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    public: true,
    sdk: false,
  },
  {
    method: 'get',
    path: '/v1/dashboard/account',
    operationId: 'dashboard.account.get',
    summary: 'Retrieve the account of a dashboard session',
    description:
      "The account, its plan, this month's usage in the shape of `GET /v1/project`, what is accepted and not yet counted, and every project with every key. Never a secret: a key is shown by its prefix.",
    tags: ['dashboard'],
    responses: { 200: dashboardAccountSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'rate_limited',
      'parameter_invalid',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/projects/{id}/keys',
    operationId: 'dashboard.keys.create',
    summary: 'Create a secret key for a project of the account',
    description:
      'A secret key of the environment asked for, with no scopes and no tenant. The key is in this answer once and cannot be shown again. At most five active secret keys per project and environment.',
    tags: ['dashboard'],
    pathParams: ID_PARAM('project', 'project'),
    body: dashboardKeyCreateSchema,
    responses: { 201: dashboardApiKeyCreatedSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'resource_missing',
      'key_limit_reached',
      'key_creation_rate_limited',
      'rate_limited',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'delete',
    path: '/v1/dashboard/keys/{id}',
    operationId: 'dashboard.keys.revoke',
    summary: 'Revoke a key of the account',
    description:
      'The next request made with the key is refused with `401 revoked_api_key`. Revoking the last active key of an environment is allowed. A key already revoked is returned as it is.',
    tags: ['dashboard'],
    pathParams: ID_PARAM('api_key', 'API key'),
    responses: { 200: dashboardApiKeySchema },
    errorCodes: [
      'dashboard_session_invalid',
      'resource_missing',
      'rate_limited',
      'parameter_invalid',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/logout',
    operationId: 'dashboard.logout',
    summary: 'End a dashboard session',
    description: 'The session stops working at once. There is nothing to send in the body.',
    tags: ['dashboard'],
    responses: { 204: z.null() },
    errorCodes: [
      'dashboard_session_invalid',
      'rate_limited',
      'parameter_invalid',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },

  {
    method: 'post',
    path: '/v1/dashboard/billing/checkout',
    operationId: 'dashboard.billing.checkout',
    summary: 'Open a Stripe Checkout for a paid plan',
    description:
      'Returns the URL of a Stripe Checkout Session for Pro or Scale, billed monthly on the first of the month with the first month pro rata, VAT excluded, for businesses (a VAT number or tax id is required where Stripe supports one). An account that has not accepted the terms in force sends `accept_terms` and `approve_clauses`, which are recorded first. The plan changes when Stripe confirms, not here. An account with a subscription already is sent to the portal.',
    tags: ['dashboard'],
    body: billingCheckoutSchema,
    responses: { 200: billingRedirectSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'terms_not_accepted',
      'subscription_exists',
      'invoice_unpaid',
      'plan_is_contract',
      'billing_not_configured',
      'billing_provider_error',
      'billing_unreachable',
      'rate_limited',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/billing/change',
    operationId: 'dashboard.billing.change',
    summary: 'Change between Pro and Scale',
    description:
      'Moves the subscription of the account to the other paid plan. To Scale from Pro at once, the difference paid pro rata on an invoice now. To Pro from Scale on the first of the next month, with a subscription schedule: until then the account stays on Scale, and the move can be cancelled with `POST /v1/dashboard/billing/change/cancel`. The subscription must be active, and a subscription set to end at the end of the period is not moved to Pro.',
    tags: ['dashboard'],
    body: billingChangeSchema,
    responses: { 200: billingChangeResponseSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'billing_subscription_missing',
      'plan_change_refused',
      'plan_is_contract',
      'billing_not_configured',
      'billing_provider_error',
      'billing_unreachable',
      'rate_limited',
      'invalid_body',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/billing/change/cancel',
    operationId: 'dashboard.billing.change.cancel',
    summary: 'Cancel a scheduled move to Pro',
    description:
      'Cancels the move down scheduled for the first of the next month: the subscription stays on Scale (its schedule is released).',
    tags: ['dashboard'],
    responses: { 200: billingChangeResponseSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'billing_subscription_missing',
      'plan_change_refused',
      'billing_not_configured',
      'billing_provider_error',
      'billing_unreachable',
      'rate_limited',
      'parameter_invalid',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },
  {
    method: 'post',
    path: '/v1/dashboard/billing/portal',
    operationId: 'dashboard.billing.portal',
    summary: 'Open the Stripe customer portal',
    description:
      'Returns the URL of a session of the Stripe customer portal: update the card, the name and the email, read the invoices, and cancel at the end of the period. The plan is changed from the dashboard (`POST /v1/dashboard/billing/change`), and the address and the VAT number by writing to Bookrail. Only for an account that has started a checkout.',
    tags: ['dashboard'],
    responses: { 200: billingRedirectSchema },
    errorCodes: [
      'dashboard_session_invalid',
      'billing_customer_missing',
      'billing_not_configured',
      'billing_provider_error',
      'billing_unreachable',
      'rate_limited',
      'parameter_invalid',
      'unsupported_api_version',
      'internal_error',
    ],
    auth: 'dashboard',
    sdk: false,
  },

  // --- Billing --------------------------------------------------------------------------------
  //
  // The receiver of the events of Bookrail's own Stripe account, where the plans are sold. Called
  // by Stripe, not by an integration, and never by a key.
  {
    method: 'post',
    path: '/v1/billing/webhook',
    operationId: 'billing.webhook',
    summary: 'Receive a Stripe Billing event',
    description:
      'Called by Stripe, not by an integration. Verifies `Stripe-Signature` over the raw body with the secret of the endpoint of the account (not a Connect one), records the event once, and applies it: a checkout completed, a subscription created, updated or deleted, a renewal to add the overage to, an invoice paid or failed, the fiscal data of a customer changed. An event of a connected account is refused with `400 billing_connect_event`, an event of the other Stripe mode than the one of the deployment with `400 billing_mode_mismatch`. A redelivery of an event already processed answers `duplicate: true` and does nothing. No API key.',
    tags: ['billing'],
    responses: { 200: stripeWebhookReceiptSchema },
    errorCodes: [
      'stripe_signature_invalid',
      'billing_connect_event',
      'billing_mode_mismatch',
      'billing_not_configured',
      'invalid_body',
      'payload_too_large',
      // A `500` when a handler fails (Stripe did not answer, a write failed): the claim stays
      // unsettled, and the retry is Stripe's.
      'internal_error',
    ],
    public: true,
    sdk: false,
  },

  // --- Project --------------------------------------------------------------------------------
  {
    method: 'get',
    path: '/v1/project',
    operationId: 'project.get',
    summary: 'Retrieve the calling project',
    description:
      'Answers "who am I": the project the API key belongs to, and the attributes of the key itself. The key is the selector, so there is no identifier to pass.',
    tags: ['project'],
    responses: { 200: projectSchema },
    errorCodes: [],
  },

  // --- Stripe ---------------------------------------------------------------------------------
  //
  // Three operations, not four: `GET /v1/stripe/callback` answers an HTML page to a browser
  // with no key and is listed in `UNSPECIFIED_ROUTES` instead.
  {
    method: 'post',
    path: '/v1/stripe/connect',
    operationId: 'stripe.connect',
    summary: 'Start connecting a Stripe account',
    description:
      'Returns a Stripe authorisation link to open in a browser. Nothing is connected until a person authorises there and the browser returns to the callback. The link carries a single use state and works for fifteen minutes.',
    tags: ['stripe'],
    responses: { 201: stripeConnectLinkSchema },
    errorCodes: ['stripe_not_configured', 'stripe_already_connected'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/stripe',
    operationId: 'stripe.get',
    summary: 'Retrieve the Stripe connection',
    description:
      'The account this project charges on, in this environment, and the platform publishable key to initialise Stripe.js with. `charges_enabled` comes from Stripe at request time and is `null` when the account is not connected or when Stripe did not answer in time.',
    tags: ['stripe'],
    responses: { 200: stripeConnectionSchema },
    errorCodes: ['stripe_not_configured'],
  },
  {
    method: 'delete',
    path: '/v1/stripe',
    operationId: 'stripe.disconnect',
    summary: 'Disconnect the Stripe account',
    description:
      "Revokes the platform's access to the connected account and records the connection as disconnected. An account Stripe already considers unlinked is still recorded as disconnected: what is being asked for is the state, not the call.",
    tags: ['stripe'],
    responses: { 200: stripeConnectionSchema },
    errorCodes: [
      'resource_missing',
      'stripe_not_configured',
      'stripe_provider_error',
      'stripe_unreachable',
    ],
  },

  // --- Availability ---------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/availability',
    operationId: 'availability.search',
    summary: 'Search availability over a window',
    tags: ['availability'],
    body: availabilityRequestSchema,
    responses: { 200: availabilitySchema },
    errorCodes: AVAILABILITY_CODES,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/availability/next',
    operationId: 'availability.next',
    summary: 'Find the next bookable slot',
    description:
      'Searches in thirty day windows up to a ninety day horizon, stopping at the first window that contains a slot.',
    tags: ['availability'],
    query: availabilityNextQuerySchema,
    responses: { 200: availabilityNextSchema },
    errorCodes: AVAILABILITY_CODES,
  },
  {
    method: 'post',
    path: '/v1/availability/check',
    operationId: 'availability.check',
    summary: 'Check one precise instant',
    description:
      'Feasibility at that instant, not alignment to the grid: a start the search would not offer still gets structured reasons.',
    tags: ['availability'],
    body: availabilityCheckBodySchema,
    responses: { 200: availabilityCheckSchema },
    errorCodes: AVAILABILITY_CODES,
    idempotent: true,
  },

  // --- Locations ------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/locations',
    operationId: 'locations.create',
    summary: 'Create a location',
    tags: ['locations'],
    body: locationCreateSchema,
    responses: { 201: locationSchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/locations',
    operationId: 'locations.list',
    summary: 'List locations',
    tags: ['locations'],
    query: listQuery('location'),
    responses: { 200: listOf(locationSchema).openapi('LocationList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/locations/{id}',
    operationId: 'locations.get',
    summary: 'Retrieve a location',
    tags: ['locations'],
    pathParams: ID_PARAM('location', 'location'),
    responses: { 200: locationSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'patch',
    path: '/v1/locations/{id}',
    operationId: 'locations.update',
    summary: 'Update a location',
    description:
      'Changing `timezone` moves the open timeline of every resource that has no zone of its own, so it can emit `booking.orphaned`.',
    tags: ['locations'],
    pathParams: ID_PARAM('location', 'location'),
    body: locationUpdateSchema,
    responses: { 200: locationSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/locations/{id}',
    operationId: 'locations.delete',
    summary: 'Delete a location',
    tags: ['locations'],
    pathParams: ID_PARAM('location', 'location'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Resources ------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/resources',
    operationId: 'resources.create',
    summary: 'Create a resource',
    tags: ['resources'],
    body: resourceCreateSchema,
    responses: { 201: resourceSchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/resources',
    operationId: 'resources.list',
    summary: 'List resources',
    tags: ['resources'],
    query: merge(listQuery('resource'), expandQuery(['schedule'])),
    expand: ['schedule'],
    responses: { 200: listOf(resourceSchema).openapi('ResourceList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/resources/{id}',
    operationId: 'resources.get',
    summary: 'Retrieve a resource',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    query: expandQuery(['schedule']),
    expand: ['schedule'],
    responses: { 200: resourceSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'patch',
    path: '/v1/resources/{id}',
    operationId: 'resources.update',
    summary: 'Update a resource',
    description:
      'Touching `capacity`, `status`, `schedule_id` or `location_id` can emit `booking.orphaned` for future bookings the new configuration no longer supports.',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    body: resourceUpdateSchema,
    responses: { 200: resourceSchema },
    // Lowering `capacity` under overlapping occupancies is refused by the database itself
    // (`occ_no_overlap_cap1`, or the capacity trigger), which `pg-errors.ts` translates.
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body', 'slot_unavailable'],
  },
  {
    method: 'delete',
    path: '/v1/resources/{id}',
    operationId: 'resources.delete',
    summary: 'Delete a resource',
    description: 'Soft delete: bookings and occupancies keep referring to the resource.',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'post',
    path: '/v1/resources/{id}/block',
    operationId: 'resources.block',
    summary: 'Block a period of a resource',
    description:
      'Takes the whole capacity of the resource, so a period that is already booked or held answers `409 slot_unavailable`.',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    body: resourceBlockBodySchema,
    responses: { 201: resourceBlockSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'slot_unavailable'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/resources/{id}/blocks',
    operationId: 'resources.blocks.list',
    summary: 'List the blocks of a resource',
    description:
      'Ordered by start, cursored on `(lower(period), id)`. With neither `from` nor `to`, answers the blocks that have not finished yet.',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    query: merge(listQuery('resource_block'), resourceBlockListQuerySchema.innerType()),
    responses: { 200: listOf(resourceBlockSchema).openapi('ResourceBlockList') },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'post',
    path: '/v1/resources/{id}/unblock',
    operationId: 'resources.unblock',
    summary: 'Remove a block',
    tags: ['resources'],
    pathParams: ID_PARAM('resource', 'resource'),
    body: resourceUnblockSchema,
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
    idempotent: true,
  },

  // --- Resource groups ------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/resource_groups',
    operationId: 'resource_groups.create',
    summary: 'Create a resource group',
    tags: ['resource_groups'],
    query: expandQuery(['resources']),
    expand: ['resources'],
    body: resourceGroupCreateSchema,
    responses: { 201: resourceGroupSchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/resource_groups',
    operationId: 'resource_groups.list',
    summary: 'List resource groups',
    tags: ['resource_groups'],
    query: merge(listQuery('resource_group'), expandQuery(['resources'])),
    expand: ['resources'],
    responses: { 200: listOf(resourceGroupSchema).openapi('ResourceGroupList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/resource_groups/{id}',
    operationId: 'resource_groups.get',
    summary: 'Retrieve a resource group',
    tags: ['resource_groups'],
    pathParams: ID_PARAM('resource_group', 'resource group'),
    query: expandQuery(['resources']),
    expand: ['resources'],
    responses: { 200: resourceGroupSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'patch',
    path: '/v1/resource_groups/{id}',
    operationId: 'resource_groups.update',
    summary: 'Update a resource group',
    description: '`resource_ids` replaces the whole membership; omitting it leaves it untouched.',
    tags: ['resource_groups'],
    pathParams: ID_PARAM('resource_group', 'resource group'),
    query: expandQuery(['resources']),
    expand: ['resources'],
    body: resourceGroupUpdateSchema,
    responses: { 200: resourceGroupSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/resource_groups/{id}',
    operationId: 'resource_groups.delete',
    summary: 'Delete a resource group',
    tags: ['resource_groups'],
    pathParams: ID_PARAM('resource_group', 'resource group'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Schedules ------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/schedules',
    operationId: 'schedules.create',
    summary: 'Create a schedule',
    tags: ['schedules'],
    body: scheduleCreateSchema,
    responses: { 201: scheduleSchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/schedules',
    operationId: 'schedules.list',
    summary: 'List schedules',
    tags: ['schedules'],
    query: listQuery('schedule'),
    responses: { 200: listOf(scheduleSchema).openapi('ScheduleList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/schedules/{id}',
    operationId: 'schedules.get',
    summary: 'Retrieve a schedule',
    tags: ['schedules'],
    pathParams: ID_PARAM('schedule', 'schedule'),
    responses: { 200: scheduleSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'patch',
    path: '/v1/schedules/{id}',
    operationId: 'schedules.update',
    summary: 'Update a schedule',
    description:
      '`rules` replaces the whole set. Touching `rules` or `timezone` can emit `booking.orphaned`.',
    tags: ['schedules'],
    pathParams: ID_PARAM('schedule', 'schedule'),
    body: scheduleUpdateSchema,
    responses: { 200: scheduleSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/schedules/{id}',
    operationId: 'schedules.delete',
    summary: 'Delete a schedule',
    tags: ['schedules'],
    pathParams: ID_PARAM('schedule', 'schedule'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'post',
    path: '/v1/schedules/{id}/exceptions',
    operationId: 'schedules.exceptions.create',
    summary: 'Add a calendar exception',
    tags: ['schedules'],
    pathParams: ID_PARAM('schedule', 'schedule'),
    body: scheduleExceptionCreateSchema,
    responses: { 201: scheduleExceptionSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
    idempotent: true,
  },
  {
    method: 'delete',
    path: '/v1/schedules/{id}/exceptions/{eid}',
    operationId: 'schedules.exceptions.delete',
    summary: 'Remove a calendar exception',
    tags: ['schedules'],
    pathParams: [
      { name: 'id', kind: 'schedule', description: 'Identifier of the schedule.' },
      {
        name: 'eid',
        kind: 'schedule_exception',
        description: 'Identifier of the exception.',
      },
    ],
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Services -------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/services',
    operationId: 'services.create',
    summary: 'Create a service',
    tags: ['services'],
    query: expandQuery(['requirements']),
    expand: ['requirements'],
    body: serviceCreateSchema,
    responses: { 201: serviceSchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/services',
    operationId: 'services.list',
    summary: 'List services',
    tags: ['services'],
    query: merge(listQuery('service'), expandQuery(['requirements'])),
    expand: ['requirements'],
    responses: { 200: listOf(serviceSchema).openapi('ServiceList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/services/{id}',
    operationId: 'services.get',
    summary: 'Retrieve a service',
    tags: ['services'],
    pathParams: ID_PARAM('service', 'service'),
    query: expandQuery(['requirements']),
    expand: ['requirements'],
    responses: { 200: serviceSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'patch',
    path: '/v1/services/{id}',
    operationId: 'services.update',
    summary: 'Update a service',
    description: '`requirements` replaces the whole set; omitting it leaves it untouched.',
    tags: ['services'],
    pathParams: ID_PARAM('service', 'service'),
    query: expandQuery(['requirements']),
    expand: ['requirements'],
    body: serviceUpdateSchema,
    responses: { 200: serviceSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/services/{id}',
    operationId: 'services.delete',
    summary: 'Delete a service',
    description: 'Soft delete: past bookings keep pointing at the service they were made for.',
    tags: ['services'],
    pathParams: ID_PARAM('service', 'service'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Policies -------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/policies',
    operationId: 'policies.create',
    summary: 'Create a policy',
    tags: ['policies'],
    body: policyCreateSchema,
    responses: { 201: policySchema },
    errorCodes: ['parameter_invalid', 'parameter_missing'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/policies',
    operationId: 'policies.list',
    summary: 'List policies',
    tags: ['policies'],
    query: listQuery('policy'),
    responses: { 200: listOf(policySchema).openapi('PolicyList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/policies/{id}',
    operationId: 'policies.get',
    summary: 'Retrieve a policy',
    tags: ['policies'],
    pathParams: ID_PARAM('policy', 'policy'),
    responses: { 200: policySchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'patch',
    path: '/v1/policies/{id}',
    operationId: 'policies.update',
    summary: 'Update a policy',
    tags: ['policies'],
    pathParams: ID_PARAM('policy', 'policy'),
    body: policyUpdateSchema,
    responses: { 200: policySchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/policies/{id}',
    operationId: 'policies.delete',
    summary: 'Delete a policy',
    tags: ['policies'],
    pathParams: ID_PARAM('policy', 'policy'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Customers ------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/customers',
    operationId: 'customers.create',
    summary: 'Create or upsert a customer',
    description:
      'With `external_id` the write is an upsert with merge: `201` when the customer is created, `200` when an existing one is updated.',
    tags: ['customers'],
    body: customerCreateSchema,
    responses: { 200: customerSchema, 201: customerSchema },
    errorCodes: ['parameter_invalid'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/customers',
    operationId: 'customers.list',
    summary: 'List customers',
    tags: ['customers'],
    query: merge(
      listQuery('customer'),
      z.object({
        external_id: z
          .string()
          .optional()
          .openapi({ description: 'Exact match on the caller’s own identifier.' }),
      }),
    ),
    responses: { 200: listOf(customerSchema).openapi('CustomerList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/customers/{id}',
    operationId: 'customers.get',
    summary: 'Retrieve a customer',
    tags: ['customers'],
    pathParams: ID_PARAM('customer', 'customer'),
    responses: { 200: customerSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'patch',
    path: '/v1/customers/{id}',
    operationId: 'customers.update',
    summary: 'Update a customer',
    tags: ['customers'],
    pathParams: ID_PARAM('customer', 'customer'),
    body: customerUpdateSchema,
    responses: { 200: customerSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body'],
  },
  {
    method: 'delete',
    path: '/v1/customers/{id}',
    operationId: 'customers.delete',
    summary: 'Delete a customer',
    tags: ['customers'],
    pathParams: ID_PARAM('customer', 'customer'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Holds ----------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/holds',
    operationId: 'holds.create',
    summary: 'Hold a slot',
    description:
      'Takes the capacity for `ttl`, clamped to thirty minutes by the engine. The answer carries neither `metadata` nor the timestamps: they are read back by `GET /v1/holds/{id}`.',
    tags: ['holds'],
    body: holdCreateSchema,
    responses: { 201: holdCreatedSchema },
    errorCodes: BOOKING_WRITE_CODES,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/holds/{id}',
    operationId: 'holds.get',
    summary: 'Retrieve a hold',
    tags: ['holds'],
    pathParams: ID_PARAM('hold', 'hold'),
    responses: { 200: holdSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'delete',
    path: '/v1/holds/{id}',
    operationId: 'holds.release',
    summary: 'Release a hold',
    description:
      'Idempotent: releasing an already released or expired hold is a `200`. Only a hold already converted into a booking answers `409 hold_not_active`.',
    tags: ['holds'],
    pathParams: ID_PARAM('hold', 'hold'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing', 'hold_not_active', 'serialization_failure'],
  },

  // --- Bookings -------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/bookings',
    operationId: 'bookings.create',
    summary: 'Create a booking',
    description:
      'With `hold_id` it converts the hold instead of taking new capacity. `payment.mode` of `deposit` or `full` creates a Stripe PaymentIntent on the connected account and answers with `payment_intent`, whose `client_secret` is returned **once** and is never stored: an idempotent replay answers with the same booking and `client_secret: null`. `payment.mode: "entitlement"`, and any `recurrence`, answer `400 not_yet_supported`. In the live environment of an account on the free plan, a booking past the confirmed live bookings the plan includes this month, or a payment that would take the month past the included paid volume (`param: "payment.mode"`), answers `402 plan_limit_reached` and takes nothing; the test environment is never counted.',
    tags: ['bookings'],
    body: bookingCreateSchema,
    responses: { 201: bookingCreatedSchema },
    errorCodes: [
      ...BOOKING_WRITE_CODES,
      'hold_mismatch',
      'hold_expired',
      'hold_not_active',
      'not_yet_supported',
      'stripe_not_connected',
      'stripe_not_configured',
      'stripe_provider_error',
      'stripe_unreachable',
      'price_missing',
      'deposit_not_configured',
      'payment_amount_invalid',
      'plan_limit_reached',
    ],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/bookings',
    operationId: 'bookings.list',
    summary: 'List bookings',
    description: '`from` and `to` filter on `starts_at`: `from` included, `to` excluded.',
    tags: ['bookings'],
    query: merge(
      listQuery('booking'),
      bookingListQuerySchema.innerType(),
      expandQuery(['customer', 'allocations.resource', 'payments']),
    ),
    expand: ['customer', 'allocations.resource', 'payments'],
    responses: { 200: listOf(bookingSchema).openapi('BookingList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/bookings/{id}',
    operationId: 'bookings.get',
    summary: 'Retrieve a booking',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    query: expandQuery(['customer', 'allocations.resource', 'payments']),
    expand: ['customer', 'allocations.resource', 'payments'],
    responses: { 200: bookingSchema },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/confirm',
    operationId: 'bookings.confirm',
    summary: 'Confirm a booking',
    description:
      'A booking whose payment is still in flight answers `409 payment_pending`: confirming it would tell the customer the slot is theirs while the card may still be refused. Wait for the payment, or cancel the booking.',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingActionSchema,
    responses: { 200: bookingSchema },
    errorCodes: [...TRANSITION_CODES, 'payment_pending'],
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/check_in',
    operationId: 'bookings.check_in',
    summary: 'Check a booking in',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingActionSchema,
    responses: { 200: bookingSchema },
    errorCodes: TRANSITION_CODES,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/complete',
    operationId: 'bookings.complete',
    summary: 'Complete a booking',
    description: 'Allowed from `starts_at` onwards; before that it is `422 complete_too_early`.',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingActionSchema,
    responses: { 200: bookingSchema },
    errorCodes: TRANSITION_CODES,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/no_show',
    operationId: 'bookings.no_show',
    summary: 'Mark a booking as a no-show',
    description:
      'Allowed from `starts_at + policy_snapshot.no_show.grace_minutes` onwards; before that it is `422 no_show_too_early`.',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingActionSchema,
    responses: { 200: bookingSchema },
    errorCodes: TRANSITION_CODES,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/cancel',
    operationId: 'bookings.cancel',
    summary: 'Cancel a booking',
    description:
      '`by` defaults to `customer`. `override_refund_percent` beats every tier, for any `by`. The refund the policy promises is queued as a `payments` row of type `refund` and executed against Stripe by the background worker; `refund_amount_expected` on the booking is what it will add up to.',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingCancelSchema,
    responses: { 200: bookingSchema },
    errorCodes: TRANSITION_CODES,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/bookings/{id}/reschedule',
    operationId: 'bookings.reschedule',
    summary: 'Reschedule a booking',
    description:
      'Answers with the **new** booking. The old one is one `GET` away through `rescheduled_from_booking_id`. An unavailable slot is a `409` and leaves the old booking intact. A booking with a payment attached answers `422 reschedule_not_supported`: moving money to a slot with a different price is not decided yet.',
    tags: ['bookings'],
    pathParams: ID_PARAM('booking', 'booking'),
    body: bookingRescheduleSchema,
    responses: { 200: bookingSchema },
    errorCodes: [
      ...TRANSITION_CODES,
      ...BOOKING_WRITE_CODES,
      'max_reschedules_reached',
      'reschedule_not_supported',
    ],
    idempotent: true,
  },

  // --- Payments -------------------------------------------------------------------------------
  //
  // Two reads and no writes. A payment is created by `POST /v1/bookings` and a refund by a
  // cancellation or by the customer's own Stripe dashboard, and there is deliberately no
  // endpoint that moves money on its own: the money columns of a booking have exactly two
  // writers, the creation and the verified webhook receiver, and an endpoint would be a third.
  {
    method: 'get',
    path: '/v1/payments',
    operationId: 'payments.list',
    summary: 'List payments',
    description:
      'Never calls Stripe, so `client_secret` and `provider_status` are always `null` here. Ask for one payment to get them.',
    tags: ['payments'],
    query: merge(listQuery('payment'), paymentListQuerySchema),
    responses: { 200: listOf(paymentSchema).openapi('PaymentList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/payments/{id}',
    operationId: 'payments.get',
    summary: 'Retrieve a payment',
    description:
      'For a payment that is still `pending` and is not a refund, `client_secret` and `provider_status` are read from Stripe at request time. Both are `null`, and the answer is still a `200`, when Stripe did not answer: everything else here comes from our own row.',
    tags: ['payments'],
    pathParams: ID_PARAM('payment', 'payment'),
    responses: { 200: paymentSchema },
    errorCodes: ['resource_missing', 'stripe_not_configured'],
  },

  // --- The incoming Stripe webhook --------------------------------------------------------------
  //
  // Two paths and not one, so that the signing secret is chosen by the path rather than guessed
  // from the body. **No API key**: the caller is Stripe, and what ties the request to a project
  // is a `Stripe-Signature` over the raw body. `sdk: false` for the same reason the three sign
  // up operations carry it: no holder of an SDK object can ever need to call these.
  ...(['test', 'live'] as const).map((mode) => ({
    method: 'post' as const,
    path: `/v1/stripe/webhook/${mode}`,
    operationId: `stripe.webhook.${mode}`,
    summary: `Receive a Stripe event (${mode} mode)`,
    description:
      'Called by Stripe, not by an integration. Verifies `Stripe-Signature` over the raw body, records the event once, and applies it. A redelivery of an event already processed answers `duplicate: true` and does nothing. A body over one megabyte is refused unread with `413`. An event whose reported amount is not the amount the payment asked for is refused whole with `500`, so that Stripe delivers it again and nothing is recorded in the meantime. No API key.',
    tags: ['stripe'],
    responses: { 200: stripeWebhookReceiptSchema },
    errorCodes: [
      'stripe_signature_invalid',
      'stripe_not_configured',
      'invalid_body',
      'payload_too_large',
      // A `500` on purpose when Stripe reports an amount that is not the one this payment asked
      // for: nothing is written, the claim row stays unprocessed, and the retry is Stripe's.
      'payment_amount_mismatch',
    ],
    public: true,
    sdk: false as const,
  })),

  // --- Events ---------------------------------------------------------------------------------
  {
    method: 'get',
    path: '/v1/events',
    operationId: 'events.list',
    summary: 'List events',
    description:
      'Ordered by `(txid, seq)` and behind the visibility horizon, so a consumer that has read up to a cursor never later finds a row it stepped over. An event is readable only once every write transaction that started before it has ended.',
    tags: ['events'],
    query: merge(
      listQuery('event'),
      z.object({
        type: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .openapi({
            description:
              'Event type. Repeatable: `?type[]=booking.created&type[]=booking.cancelled` is the union. Maximum 50 values.',
          }),
        object_id: z
          .string()
          .optional()
          .openapi({ description: 'Prefixed identifier of the object the event is about.' }),
        from: instantSchema
          .optional()
          .openapi({ description: '`occurred_at` from this instant, included.' }),
        to: instantSchema
          .optional()
          .openapi({ description: '`occurred_at` up to this instant, excluded.' }),
      }),
    ),
    responses: { 200: listOf(eventSchema).openapi('EventList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/events/{id}',
    operationId: 'events.get',
    summary: 'Retrieve an event',
    description: 'Not behind the horizon: the caller already holds the identifier.',
    tags: ['events'],
    pathParams: ID_PARAM('event', 'event'),
    responses: { 200: eventSchema },
    errorCodes: ['resource_missing'],
  },

  // --- Webhooks -------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/v1/webhooks',
    operationId: 'webhooks.create',
    summary: 'Register a webhook endpoint',
    description:
      'The only response that ever carries `secret`. An idempotent replay of the same key answers **without** it.',
    tags: ['webhooks'],
    body: webhookCreateSchema,
    responses: { 201: webhookCreatedSchema },
    errorCodes: ['parameter_invalid', 'invalid_webhook_url'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/webhooks',
    operationId: 'webhooks.list',
    summary: 'List webhook endpoints',
    tags: ['webhooks'],
    query: listQuery('webhook'),
    responses: { 200: listOf(webhookSchema).openapi('WebhookList') },
    errorCodes: ['parameter_invalid'],
  },
  {
    method: 'get',
    path: '/v1/webhooks/{id}',
    operationId: 'webhooks.get',
    summary: 'Retrieve a webhook endpoint',
    tags: ['webhooks'],
    pathParams: ID_PARAM('webhook', 'webhook'),
    responses: { 200: webhookSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'patch',
    path: '/v1/webhooks/{id}',
    operationId: 'webhooks.update',
    summary: 'Update a webhook endpoint',
    description:
      '`status` accepts `active` and `disabled` only: `failing` is an observation of the delivery worker, not a state a customer declares.',
    tags: ['webhooks'],
    pathParams: ID_PARAM('webhook', 'webhook'),
    body: webhookUpdateSchema,
    responses: { 200: webhookSchema },
    errorCodes: ['resource_missing', 'parameter_invalid', 'invalid_body', 'invalid_webhook_url'],
  },
  {
    method: 'delete',
    path: '/v1/webhooks/{id}',
    operationId: 'webhooks.delete',
    summary: 'Delete a webhook endpoint',
    description:
      'Takes the endpoint’s deliveries with it. To stop the traffic and keep the history, set `status: "disabled"`.',
    tags: ['webhooks'],
    pathParams: ID_PARAM('webhook', 'webhook'),
    responses: { 200: deletedSchema },
    errorCodes: ['resource_missing'],
  },
  {
    method: 'post',
    path: '/v1/webhooks/{id}/test',
    operationId: 'webhooks.test',
    summary: 'Send a test delivery',
    description:
      'Delivers synchronously and answers with the delivery, HTTP status and body included. No retry ladder.',
    tags: ['webhooks'],
    pathParams: ID_PARAM('webhook', 'webhook'),
    body: bookingActionSchema,
    responses: { 200: webhookDeliverySchema },
    errorCodes: ['resource_missing', 'webhook_disabled'],
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/webhooks/{id}/deliveries',
    operationId: 'webhooks.deliveries.list',
    summary: 'List the deliveries of an endpoint',
    description:
      'Newest first, unlike every other list: a delivery log answers "what just happened".',
    tags: ['webhooks'],
    pathParams: ID_PARAM('webhook', 'webhook'),
    query: merge(listQuery('webhook_delivery'), webhookDeliveryListQuerySchema),
    responses: { 200: listOf(webhookDeliverySchema).openapi('WebhookDeliveryList') },
    errorCodes: ['resource_missing', 'parameter_invalid'],
  },
  {
    method: 'post',
    path: '/v1/webhooks/{id}/deliveries/{did}/retry',
    operationId: 'webhooks.deliveries.retry',
    summary: 'Replay a delivery',
    description:
      'Puts the delivery back at the front of the queue with `attempt` reset and a fresh ladder. Allowed for thirty days after it was created.',
    tags: ['webhooks'],
    pathParams: [
      { name: 'id', kind: 'webhook', description: 'Identifier of the webhook endpoint.' },
      { name: 'did', kind: 'webhook_delivery', description: 'Identifier of the delivery.' },
    ],
    body: bookingActionSchema,
    responses: { 200: webhookDeliverySchema },
    errorCodes: ['resource_missing', 'webhook_disabled', 'delivery_too_old'],
    idempotent: true,
  },
];

/** Routes of the app that are deliberately outside the public specification. */
/**
 * Mounted routes that are deliberately outside the specification.
 *
 * `/health` and `/internal/bootstrap` are not part of the customer facing API at all.
 * `GET /v1/stripe/callback` is: it is mounted under `/v1` and it is how a Stripe connection
 * comes into being. It is out of the document because of what it answers, which is an HTML page
 * for a person, with no key, in a browser. Describing it as a JSON operation would put in the
 * contract something no SDK can call and no schema can validate, and the contract guard, which
 * parses every declared response as JSON, would record a violation on every single call.
 */
export const UNSPECIFIED_ROUTES: readonly string[] = [
  'GET /health',
  'POST /internal/bootstrap',
  'GET /v1/stripe/callback',
];

/** `POST /v1/x` → the operation, or `undefined`. Keyed on the OpenAPI form of the path. */
const BY_KEY = new Map<string, OperationDefinition>(
  OPERATIONS.map((operation) => [`${operation.method.toUpperCase()} ${operation.path}`, operation]),
);

export function operationFor(method: string, openApiPath: string): OperationDefinition | undefined {
  return BY_KEY.get(`${method.toUpperCase()} ${openApiPath}`);
}

/** Hono spells a path parameter `:id`; OpenAPI spells it `{id}`. */
export function honoPathToOpenApi(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}
