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
import { CURRENT_API_VERSION, statusForType, type ErrorType } from '@bookrail/shared';
import { ACTOR_HEADER, API_ACTORS } from '../context.js';
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
export const APP_VERSION = '0.16.0';

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
};

/** The order tags appear in the document, and therefore in generated documentation. */
const TAG_ORDER: readonly string[] = [
  'meta',
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

/** Headers every response carries, plus the one only a POST can carry. */
function responseHeaders(idempotent: boolean): z.AnyZodObject {
  const base = z.object({
    'Bookrail-Request-Id': z
      .string()
      .openapi({ description: 'Identifier of this request. Quote it to support.' }),
    'Bookrail-Version': z
      .string()
      .openapi({ description: 'The API version this response was produced with.' }),
  });
  if (!idempotent) return base;
  return base.extend({
    [REPLAYED_HEADER]: z.string().optional().openapi({
      description:
        '`true` when the body is the stored answer of an earlier request with the same `Idempotency-Key`.',
    }),
  });
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
    const status = statusForType(type);
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

    const responses: RouteConfig['responses'] = {};
    for (const [status, schema] of Object.entries(operation.responses)) {
      responses[status] = {
        description: successDescription(operation, Number(status)),
        headers: responseHeaders(operation.idempotent === true),
        content: { 'application/json': { schema } },
      };
    }
    for (const [status, codes] of [...errorResponsesOf(operation)].sort((a, b) => a[0] - b[0])) {
      responses[String(status)] = {
        description: `Error codes: ${codes.map((code) => `\`${code}\``).join(', ')}.`,
        headers: responseHeaders(false),
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
    if (key === 'schemas' || key === 'parameters') {
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
