/**
 * The OpenAPI 3.1 document, built from {@link OPERATIONS} and from the Zod schemas the server
 * actually validates and serializes with.
 *
 * Nothing here is written twice. The request schemas are the ones the routes parse with, the
 * response schemas are the ones the serializers are typed against, and the error responses are
 * derived from each operation's `errorCodes` through `statusForType`, so a code whose type
 * changes moves to a different status in the document without anybody editing it.
 *
 * **Library.** `@asteasolutions/zod-to-openapi` 7.x: it is the converter that targets Zod 3.x
 * (peer `^3.20.2`, ours is 3.24) *and* OpenAPI 3.1, and it carries the metadata on the schema
 * rather than in a parallel table. Its `ZodEffects` handling is what our schemas need: a
 * `.refine()` is transparent, and a `.transform()` in **request** position is described by the
 * schema before the transform, which is exactly right, because the transform is what happens
 * *after* the wire format the document describes (`refId`, `instantSchema`, `ttlSchema`).
 * Where the unwrapping would lose too much (a `refId` is a `string` with a `pattern`, not the
 * UUID it becomes) the schema carries an explicit `.openapi({type, pattern})`.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { CURRENT_API_VERSION, statusForCode, type ErrorType } from '@bookrail/shared';
import { ACTOR_HEADER, API_ACTORS } from '../context.js';
import {
  POLICY_UNAVAILABLE,
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_POLICY_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
  RATE_LIMIT_RESET_HEADER,
  RETRY_AFTER_HEADER,
} from '../middleware/rate-limit.js';
import { IDEMPOTENCY_HEADER_NAME, REPLAYED_HEADER } from './headers.js';
import { z } from '../zod.js';
import { errorSchema, type OpenApiDocument } from '../schemas/responses.js';
import {
  COMMON_ERROR_CODES,
  COMMON_INPUT_ERROR_CODES,
  COMMON_POST_ERROR_CODES,
  ERROR_CODE_TYPES,
  OPERATIONS,
  type OperationDefinition,
} from './registry.js';

/**
 * The version of the Bookrail application this document was generated from.
 *
 * A literal kept in step with the release by hand, exactly like `CLI_VERSION` in
 * `packages/cli/src/version.ts`. The duplication is deliberate: the API version
 * (`info.version`) is a dated contract that changes only for an incompatible change, and the
 * application version changes at every release. Keeping them in two fields is the only way a
 * client can tell "the contract I speak" from "the build that answered me".
 */
export const APP_VERSION = '0.17.0';

export const OPENAPI_VERSION = '3.1.0';

const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  meta: 'The specification itself.',
  project: 'The project a key belongs to.',
  availability: 'What can be booked, and when.',
  locations: 'Physical places, each with a time zone.',
  resources: 'What a booking consumes: a person, a room, a court, a piece of equipment.',
  resource_groups: 'Interchangeable resources, with an allocation strategy.',
  schedules: 'Opening hours and calendar exceptions.',
  services: 'What a customer books, with its durations, buffers, price and requirements.',
  policies: 'Cancellation, reschedule, no-show and confirmation rules.',
  customers: 'The people bookings are made for.',
  holds: 'Capacity taken for a few minutes, before it becomes a booking.',
  bookings: 'The booking and its life cycle.',
  events: 'The append-only log of everything that happened.',
  webhooks: 'Delivery endpoints, their signing secret and their delivery log.',
  signups: 'How a test key comes into being, without a key and without a person.',
};

/** The order tags appear in the document, and therefore in generated documentation. */
const TAG_ORDER: readonly string[] = [
  'meta',
  'signups',
  'project',
  'availability',
  'locations',
  'resources',
  'resource_groups',
  'schedules',
  'services',
  'policies',
  'customers',
  'holds',
  'bookings',
  'events',
  'webhooks',
];

const DESCRIPTION = [
  'Booking infrastructure: availability, holds, bookings, their life cycle, and the events they emit.',
  '',
  'This document is **generated** from the Zod schemas of the server and proved by a contract guard that',
  'validates every response of the test suite against the schema declared here. In case of a disagreement',
  'between this file and any prose documentation, this file is right.',
  '',
  '- Every instant is ISO 8601. Any explicit offset is accepted on input; every instant is returned in UTC.',
  '- Identifiers are prefixed (`bk_`, `res_`, `svc_`, …); the prefix says what the object is.',
  '- Lists are cursored: `?limit=&starting_after=`, never an offset, and never a total.',
  '- Every `POST /v1/...` honours `Idempotency-Key`. The same key within 24 hours replays the same response.',
].join('\n');

// --- Common parameters and headers ------------------------------------------------------------

function commonRequestParameters(registry: OpenAPIRegistry): {
  version: ReturnType<OpenAPIRegistry['registerParameter']>;
  actor: ReturnType<OpenAPIRegistry['registerParameter']>;
  idempotency: ReturnType<OpenAPIRegistry['registerParameter']>;
} {
  const version = registry.registerParameter(
    'BookrailVersion',
    z
      .string()
      .optional()
      .openapi({
        param: { name: 'Bookrail-Version', in: 'header' },
        description: `The dated API version to speak. Defaults to \`${CURRENT_API_VERSION}\`; an unsupported value is a 400.`,
        example: CURRENT_API_VERSION,
      }),
  );
  const actor = registry.registerParameter(
    'BookrailActor',
    z
      .enum(API_ACTORS)
      .optional()
      .openapi({
        param: { name: ACTOR_HEADER, in: 'header' },
        description:
          'Which Bookrail tool the caller is, recorded as `actor.via` on every event the request writes. A closed list: an unknown value is a 400. Absent means the request declared no tool.',
      }),
  );
  const idempotency = registry.registerParameter(
    'IdempotencyKey',
    z
      .string()
      .min(1)
      .max(255)
      .optional()
      .openapi({
        param: { name: IDEMPOTENCY_HEADER_NAME, in: 'header' },
        description:
          'Retry-safety key, 1 to 255 characters. The same key within 24 hours replays the first response, errors included, and never produces a second effect.',
      }),
  );
  return { version, actor, idempotency };
}

/**
 * The response headers, registered once under `components/headers` and referenced from there.
 *
 * Registered rather than written inline because there are seventy-two operations and up to nine
 * responses each: the three counters of the rate limiter inlined everywhere would be some eleven
 * hundred copies of the same four lines in a file a person is expected to read. A `$ref` also
 * says the thing that matters, which is that `RateLimit-Remaining` means the same on every
 * endpoint.
 *
 * The two types are written out here rather than imported from `openapi3-ts`: that package is
 * where the converter gets its OpenAPI types from, but it is the converter's dependency and not
 * ours, and reaching through a package for a type is how a transitive version bump breaks a build
 * that never asked for it. A reference is one field, and a map of them is a map.
 */
type HeaderRef = { $ref: string };
type ResponseHeaders = Record<string, HeaderRef>;

interface HeaderRefs {
  requestId: HeaderRef;
  version: HeaderRef;
  replayed: HeaderRef;
  limit: HeaderRef;
  remaining: HeaderRef;
  reset: HeaderRef;
  policy: HeaderRef;
  retryAfter: HeaderRef;
}

function registerResponseHeaders(registry: OpenAPIRegistry): HeaderRefs {
  const header = (name: string, description: string, required: boolean): HeaderRef =>
    registry.registerComponent('headers', name.replace(/-/g, ''), {
      description,
      required,
      schema: { type: 'string' },
    }).ref;

  return {
    requestId: header(
      'Bookrail-Request-Id',
      'Identifier of this request. Quote it to support.',
      true,
    ),
    version: header('Bookrail-Version', 'The API version this response was produced with.', true),
    replayed: header(
      REPLAYED_HEADER,
      '`true` when the body is the stored answer of an earlier request with the same `Idempotency-Key`.',
      false,
    ),
    limit: header(
      RATE_LIMIT_LIMIT_HEADER,
      'Requests this key may have in flight at one instant: the burst of its policy.',
      false,
    ),
    remaining: header(
      RATE_LIMIT_REMAINING_HEADER,
      'Requests this key may still make right now, as a whole number.',
      false,
    ),
    reset: header(
      RATE_LIMIT_RESET_HEADER,
      'Whole seconds until `RateLimit-Remaining` is back at `RateLimit-Limit`.',
      false,
    ),
    policy: header(
      RATE_LIMIT_POLICY_HEADER,
      `\`${POLICY_UNAVAILABLE}\` when no limit could be applied to this request, because the store that holds the counters did not answer. The three counters are then absent and the request was served.`,
      false,
    ),
    retryAfter: header(
      RETRY_AFTER_HEADER,
      'Whole seconds to wait before sending this request again. At least 1.',
      false,
    ),
  };
}

interface HeaderChoice {
  /** A POST of `/v1`, which may answer with the stored body of an earlier identical request. */
  idempotent?: boolean;
  /** An operation that takes a key, and therefore counts against that key's ceiling. */
  limited?: boolean;
  /** The `429` of an operation that takes a key. */
  retryAfter?: boolean;
}

/** Which of the registered headers a given response carries. */
function responseHeaders(refs: HeaderRefs, choice: HeaderChoice): ResponseHeaders {
  const headers: ResponseHeaders = {
    'Bookrail-Request-Id': refs.requestId,
    'Bookrail-Version': refs.version,
  };
  if (choice.idempotent === true) headers[REPLAYED_HEADER] = refs.replayed;
  if (choice.limited === true) {
    headers[RATE_LIMIT_LIMIT_HEADER] = refs.limit;
    headers[RATE_LIMIT_REMAINING_HEADER] = refs.remaining;
    headers[RATE_LIMIT_RESET_HEADER] = refs.reset;
    headers[RATE_LIMIT_POLICY_HEADER] = refs.policy;
  }
  if (choice.retryAfter === true) headers[RETRY_AFTER_HEADER] = refs.retryAfter;
  return headers;
}

// --- Errors ------------------------------------------------------------------------------------

/** The codes an operation can produce: its own, plus the ones the middleware chain can. */
export function errorCodesOf(operation: OperationDefinition): string[] {
  const codes = new Set<string>(operation.public ? [] : COMMON_ERROR_CODES);
  if (operation.body !== undefined || operation.query !== undefined) {
    for (const code of COMMON_INPUT_ERROR_CODES) codes.add(code);
  }
  if (operation.idempotent === true) for (const code of COMMON_POST_ERROR_CODES) codes.add(code);
  for (const code of operation.errorCodes) codes.add(code);
  return [...codes].sort();
}

function errorResponsesOf(operation: OperationDefinition): Map<number, string[]> {
  const byStatus = new Map<number, string[]>();
  for (const code of errorCodesOf(operation)) {
    const type: ErrorType | undefined = ERROR_CODE_TYPES[code];
    if (type === undefined) {
      throw new Error(
        `Operation ${operation.operationId} declares the undocumented error code "${code}".`,
      );
    }
    const status = statusForCode(code, type);
    const bucket = byStatus.get(status) ?? [];
    bucket.push(code);
    byStatus.set(status, bucket);
  }
  return byStatus;
}

// --- The document ------------------------------------------------------------------------------

function pathParameterSchema(param: { description: string }): z.ZodTypeAny {
  return z.string().openapi({ description: param.description });
}

export function buildOpenApiDocument(
  operations: readonly OperationDefinition[] = OPERATIONS,
): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'sk_test_... / sk_live_...',
    description:
      'A secret API key: `Authorization: Bearer sk_test_...`. Publishable (`pk_`) keys are refused on every endpoint of this document.',
  });

  registry.register('Error', errorSchema);
  const parameters = commonRequestParameters(registry);
  const headerRefs = registerResponseHeaders(registry);

  for (const operation of operations) {
    const headers = operation.public
      ? []
      : [
          parameters.version,
          parameters.actor,
          ...(operation.idempotent === true ? [parameters.idempotency] : []),
        ];

    const params =
      operation.pathParams === undefined
        ? undefined
        : z.object(
            Object.fromEntries(
              operation.pathParams.map((param) => [param.name, pathParameterSchema(param)]),
            ),
          );

    // Every operation that is not `public` is one that takes a key, and therefore one whose
    // responses carry the counters of that key's bucket, the accepted ones included.
    const limited = operation.public !== true;

    const responses: RouteConfig['responses'] = {};
    for (const [status, schema] of Object.entries(operation.responses)) {
      responses[status] = {
        description: successDescription(operation, Number(status)),
        headers: responseHeaders(headerRefs, {
          idempotent: operation.idempotent === true,
          limited,
        }),
        content: { 'application/json': { schema } },
      };
    }
    for (const [status, codes] of [...errorResponsesOf(operation)].sort((a, b) => a[0] - b[0])) {
      responses[String(status)] = {
        description: `Error codes: ${codes.map((code) => `\`${code}\``).join(', ')}.`,
        headers: responseHeaders(headerRefs, { limited, retryAfter: limited && status === 429 }),
        content: { 'application/json': { schema: errorSchema } },
      };
    }

    registry.registerPath({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary,
      ...(operation.description === undefined ? {} : { description: operation.description }),
      tags: [...operation.tags],
      ...(operation.public ? { security: [] } : {}),
      // Read by the SDK generator, which builds one method per operation and skips the ones
      // marked here: an SDK is constructed with a key, and the sign up operations are how a
      // key comes into being.
      ...(operation.sdk === false ? { 'x-bookrail-sdk': false } : {}),
      request: {
        ...(params === undefined ? {} : { params }),
        ...(operation.query === undefined ? {} : { query: operation.query }),
        ...(headers.length === 0 ? {} : { headers }),
        ...(operation.body === undefined
          ? {}
          : {
              body: {
                required: true,
                content: { 'application/json': { schema: operation.body } },
              },
            }),
      },
      responses,
    });
  }

  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Bookrail API',
      version: CURRENT_API_VERSION,
      description: DESCRIPTION,
      'x-bookrail-app-version': APP_VERSION,
    },
    servers: [
      { url: 'https://api.bookrail.dev', description: 'Bookrail cloud.' },
      { url: 'http://localhost:3000', description: 'A local `pnpm dev`, on the default `PORT`.' },
    ],
    security: [{ bearerAuth: [] }],
    tags: tagsOf(operations),
  });

  return canonicalise(document as unknown as Record<string, unknown>);
}

function successDescription(operation: OperationDefinition, status: number): string {
  if (status === 201) return 'Created.';
  if (operation.method === 'delete' || operation.operationId === 'resources.unblock') {
    return 'Deleted.';
  }
  return 'Success.';
}

function tagsOf(
  operations: readonly OperationDefinition[],
): { name: string; description: string }[] {
  const used = new Set(operations.flatMap((operation) => operation.tags));
  return TAG_ORDER.filter((tag) => used.has(tag)).map((name) => ({
    name,
    description: TAG_DESCRIPTIONS[name] ?? '',
  }));
}

/**
 * A deterministic document: `paths` and `components.schemas` sorted by key, empty containers
 * the generator always emits (`webhooks`, an unused `components.parameters`) dropped.
 *
 * Only those two maps are sorted. Sorting everything would put `type` before `properties` and
 * alphabetise the fields of every object, which makes the file unreadable for no gain: the
 * generator already emits properties in the order the schema declares them, which is stable.
 */
function canonicalise(document: Record<string, unknown>): OpenApiDocument {
  const components = { ...(document.components as Record<string, unknown>) };
  for (const key of Object.keys(components)) {
    const value = components[key];
    if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) {
      delete components[key];
      continue;
    }
    if (key === 'schemas' || key === 'parameters' || key === 'headers') {
      components[key] = sortByKey(value as Record<string, unknown>);
    }
  }
  return {
    openapi: document.openapi as '3.1.0',
    info: document.info as Record<string, unknown>,
    servers: document.servers as Record<string, unknown>[],
    tags: document.tags as Record<string, unknown>[],
    security: document.security as Record<string, unknown>[],
    paths: sortByKey(document.paths as Record<string, unknown>),
    components,
  };
}

function sortByKey(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

let cached: OpenApiDocument | null = null;

/**
 * The document, built once per process.
 *
 * `GET /openapi.json` answers from here rather than from the file on disk. Reading the file
 * would mean resolving a path that is `src/../openapi` in development and `dist/../../openapi`
 * once built, and shipping a data file next to the code; generating is a few milliseconds once,
 * the conversion library is already loaded (`common.ts` uses `.openapi()`), and the file on disk
 * is proved identical to this by the freshness test. There is therefore no version of "stale"
 * that this route can serve.
 */
export function openApiDocument(): OpenApiDocument {
  cached ??= buildOpenApiDocument();
  return cached;
}
