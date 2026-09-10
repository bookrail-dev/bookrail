/**
 * The specification, checked against itself, against the app, and against the documented error
 * taxonomy.
 *
 * Four things are proved here, and the coverage check of `global-setup.ts` proves a fifth:
 *
 *  1. **freshness**: the file on disk is byte for byte what the generator produces now;
 *  2. **validity**: every `$ref` resolves, every `operationId` is unique, every `{segment}` of
 *     every path is a declared parameter, every operation answers with a schema and with errors;
 *  3. **registry ↔ app**: the operations and the routes Hono actually mounts are the same set;
 *  4. **error codes**: the union of what the registry declares equals the set the API
 *     reference documents, and every code that appears in the source is in one of the two.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statusForType } from '@bookrail/shared';
import { OPENAPI_PATH, renderOpenApiFile } from '../scripts/render.js';
import { buildOpenApiDocument, errorCodesOf, openApiDocument } from '../src/openapi/generate.js';
import {
  COMMON_ERROR_CODES,
  COMMON_INPUT_ERROR_CODES,
  COMMON_POST_ERROR_CODES,
  ERROR_CODE_TYPES,
  GLOBAL_ERROR_CODES,
  honoPathToOpenApi,
  OPERATIONS,
  UNSPECIFIED_ROUTES,
} from '../src/openapi/registry.js';
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_HEADER_NAME } from '../src/openapi/headers.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../src/http.js';
import { createHarness, type Harness } from './harness.js';

interface Document {
  openapi: string;
  info: Record<string, unknown>;
  servers: { url: string }[];
  tags: { name: string }[];
  security: Record<string, unknown>[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    parameters: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

interface Operation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: { name?: string; in?: string; $ref?: string }[];
  responses: Record<string, unknown>;
  security?: unknown[];
}

const onDisk = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Document;

describe('openapi document', () => {
  it('the file on disk is what the generator produces', async () => {
    const rendered = await renderOpenApiFile();
    const actual = readFileSync(OPENAPI_PATH, 'utf8');
    if (actual !== rendered) {
      throw new Error(
        'packages/api/openapi/openapi.json is stale: run `pnpm --filter @bookrail/api openapi`.',
      );
    }
    expect(actual).toBe(rendered);
  });

  it('generation is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });

  it('declares OpenAPI 3.1, the dated API version and the application version', () => {
    expect(onDisk.openapi).toBe('3.1.0');
    expect(onDisk.info.title).toBe('Bookrail API');
    expect(onDisk.info.version).toBe('2026-09-01');
    expect(typeof onDisk.info['x-bookrail-app-version']).toBe('string');
    expect(onDisk.servers.map((server) => server.url)).toEqual([
      'https://api.bookrail.dev',
      'http://localhost:3000',
    ]);
    expect(onDisk.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(onDisk.security).toEqual([{ bearerAuth: [] }]);
  });

  it('every $ref resolves', () => {
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.add(value);
        else walk(value);
      }
    };
    walk(onDisk);
    expect(refs.size).toBeGreaterThan(40);
    for (const ref of refs) {
      const match = /^#\/components\/([a-zA-Z]+)\/(.+)$/.exec(ref);
      expect(match, `unresolvable $ref shape: ${ref}`).not.toBeNull();
      const section = (onDisk.components as unknown as Record<string, Record<string, unknown>>)[
        match![1]!
      ];
      expect(section, `no components.${match![1]!} for ${ref}`).toBeDefined();
      expect(Object.keys(section!), `dangling $ref: ${ref}`).toContain(match![2]);
    }
  });

  it('every component is referenced by something', () => {
    const serialized = JSON.stringify(onDisk);
    for (const name of Object.keys(onDisk.components.schemas)) {
      expect(serialized, `unreferenced schema: ${name}`).toContain(
        `"#/components/schemas/${name}"`,
      );
    }
    for (const name of Object.keys(onDisk.components.parameters)) {
      expect(serialized, `unreferenced parameter: ${name}`).toContain(
        `"#/components/parameters/${name}"`,
      );
    }
  });

  it('every operationId is unique and matches the registry', () => {
    const ids = Object.values(onDisk.paths).flatMap((path) =>
      Object.values(path).map((operation) => operation.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...OPERATIONS.map((o) => o.operationId)].sort());
  });

  it('every path template parameter is declared', () => {
    for (const [path, methods] of Object.entries(onDisk.paths)) {
      const segments = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      for (const [method, operation] of Object.entries(methods)) {
        const declared = (operation.parameters ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name);
        expect(
          [...declared].sort(),
          `${method.toUpperCase()} ${path} declares the wrong path parameters`,
        ).toEqual([...segments].sort());
      }
    }
  });

  it('every operation has a tag, a summary, a success response and error responses', () => {
    for (const [path, methods] of Object.entries(onDisk.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(operation.summary, where).toBeTruthy();
        expect(operation.tags.length, where).toBe(1);
        expect(
          onDisk.tags.map((tag) => tag.name),
          where,
        ).toContain(operation.tags[0]);
        const statuses = Object.keys(operation.responses);
        expect(
          statuses.some((status) => status.startsWith('2')),
          `${where} has no success response`,
        ).toBe(true);
        // `/openapi.json` is unauthenticated and cannot fail in a documented way.
        if (path !== '/openapi.json') {
          expect(
            statuses.some((status) => status.startsWith('4') || status.startsWith('5')),
            `${where} has no error response`,
          ).toBe(true);
        }
      }
    }
  });

  it('only `GET /openapi.json` opts out of the bearer requirement', () => {
    for (const [path, methods] of Object.entries(onDisk.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
        expect(isPublic, `${method.toUpperCase()} ${path}`).toBe(path === '/openapi.json');
      }
    }
  });

  it('every POST of /v1 documents `Idempotency-Key`, and nothing else does', () => {
    expect(IDEMPOTENCY_HEADER_NAME.toLowerCase()).toBe(IDEMPOTENCY_HEADER);
    for (const [path, methods] of Object.entries(onDisk.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const refs = (operation.parameters ?? []).map((parameter) => parameter.$ref);
        const documented = refs.includes('#/components/parameters/IdempotencyKey');
        expect(documented, `${method.toUpperCase()} ${path}`).toBe(
          method === 'post' && path.startsWith('/v1/'),
        );
      }
    }
  });

  it('documents the pagination bounds `parseListParams` enforces', () => {
    // The two are declared, not derived: `parseListParams` reads the query string by hand and
    // nothing here changes the parsing. This is what keeps them from drifting apart.
    const parameter = (onDisk.paths['/v1/locations']!.get!.parameters ?? []).find(
      (candidate) => candidate.name === 'limit',
    ) as { schema: { minimum: number; maximum: number; example: number } } | undefined;
    expect(parameter).toBeDefined();
    expect(parameter!.schema.minimum).toBe(1);
    expect(parameter!.schema.maximum).toBe(MAX_LIST_LIMIT);
    expect(parameter!.schema.example).toBe(DEFAULT_LIST_LIMIT);
  });

  it('covers the 66 operations of /v1, plus itself', () => {
    const operations = Object.values(onDisk.paths).reduce(
      (total, path) => total + Object.keys(path).length,
      0,
    );
    const v1 = OPERATIONS.filter((operation) => operation.path.startsWith('/v1/'));
    expect(v1.length).toBe(66);
    expect(operations).toBe(67);
  });
});

describe('registry ↔ app', () => {
  const harness = createHarness();

  afterAll(async () => {
    await harness.close();
  });

  it('every mounted route is in the registry, and every entry is mounted', () => {
    const mounted = new Set<string>();
    for (const route of harness.app.routes) {
      if (route.method === 'ALL') continue;
      if (route.path === '*' || route.path.endsWith('/*')) continue;
      const key = `${route.method} ${honoPathToOpenApi(route.path)}`;
      if (UNSPECIFIED_ROUTES.includes(key)) continue;
      mounted.add(key);
    }
    const declared = new Set(
      OPERATIONS.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`),
    );
    expect([...mounted].sort()).toEqual([...declared].sort());
  });

  it('names the excluded routes explicitly', () => {
    const paths = harness.app.routes.map((route) => `${route.method} ${route.path}`);
    for (const excluded of UNSPECIFIED_ROUTES) expect(paths).toContain(excluded);
  });
});

describe('error codes', () => {
  /**
   * The codes the API reference documents as existing.
   *
   * Written by hand from that reference, section by section, so that the test compares the
   * specification with the prose rather than with itself. Transcribed as of 2026-09-07.
   */
  const DOCUMENTED_IN_THE_API_REFERENCE: readonly string[] = [
    // General codes
    'parameter_missing',
    'parameter_invalid',
    'invalid_body',
    'unsupported_api_version',
    'missing_api_key',
    'invalid_authorization_header',
    'invalid_api_key',
    'revoked_api_key',
    'resource_missing',
    'unknown_endpoint',
    'duplicate_record',
    'slot_unavailable',
    'operation_not_permitted',
    // Write codes
    'hold_expired',
    'hold_not_active',
    'serialization_failure',
    'idempotency_key_in_progress',
    'idempotency_key_reused',
    'start_not_on_grid',
    'min_notice_violated',
    'outside_booking_window',
    'customer_limit_reached',
    'duration_not_offered',
    'resource_not_eligible',
    'hold_mismatch',
    'not_yet_supported',
    'service_without_duration',
    // Transition codes
    'invalid_transition',
    'no_show_too_early',
    'complete_too_early',
    'max_reschedules_reached',
    // Webhook codes
    'invalid_webhook_url',
    'delivery_too_old',
    'webhook_disabled',
    // Availability codes
    'range_too_large',
    'timezone_missing',
    'invalid_range',
  ];

  /**
   * Codes the source produces that the API reference does **not** name.
   *
   * Every one of them is a known discrepancy between the source and the reference document;
   * the list is here so that the comparison above stays a comparison with the document rather
   * than with itself, and so that a *new* undocumented code still fails the test.
   *
   *  - `internal_error` and `insufficient_scope` are the defaults of `errors.internal()` and
   *    `errors.permission()`; the reference names their types but not the codes.
   *  - `invalid_request` is the default code of `errors.invalidRequest()`, reachable from the
   *    fallbacks of `parseJsonBody`, `parseOptionalJsonBody` and `parseQuery`.
   *  - `privileged_connection` is a `500` the booking transaction raises when it finds itself on
   *    a superuser or `BYPASSRLS` connection (`packages/engine/src/booking/queries.ts`).
   */
  const PRODUCED_BUT_NOT_DOCUMENTED: readonly string[] = [
    'internal_error',
    'insufficient_scope',
    'invalid_request',
    'privileged_connection',
  ];

  const EXPECTED = [
    ...new Set([...DOCUMENTED_IN_THE_API_REFERENCE, ...PRODUCED_BUT_NOT_DOCUMENTED]),
  ].sort();

  it('the union of the registry is exactly what the API reference documents', () => {
    const union = new Set<string>([
      ...COMMON_ERROR_CODES,
      ...COMMON_INPUT_ERROR_CODES,
      ...COMMON_POST_ERROR_CODES,
      ...GLOBAL_ERROR_CODES,
      ...OPERATIONS.flatMap((operation) => operation.errorCodes),
    ]);
    expect([...union].sort()).toEqual(EXPECTED);
  });

  it('every declared code has a type, and therefore a status', () => {
    for (const code of Object.keys(ERROR_CODE_TYPES)) {
      expect(statusForType(ERROR_CODE_TYPES[code]!)).toBeGreaterThanOrEqual(400);
    }
    expect([...Object.keys(ERROR_CODE_TYPES)].sort()).toEqual(EXPECTED);
  });

  it('every code produced by the source is documented', () => {
    const found = codesInSource(['src', '../engine/src', '../shared/src']);
    expect(found.size, 'the scanner found no error codes at all').toBeGreaterThan(20);
    const known = new Set<string>([
      ...EXPECTED,
      // Not an API error code: `/internal/bootstrap` is outside the specification.
      'invalid_bootstrap_token',
    ]);
    const unknown = [...found].filter((code) => !known.has(code));
    expect(unknown, `undocumented error codes in the source: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the generator groups an operation’s codes by the status of their type', () => {
    const create = OPERATIONS.find((operation) => operation.operationId === 'bookings.create')!;
    const codes = errorCodesOf(create);
    expect(codes).toContain('slot_unavailable');
    expect(codes).toContain('missing_api_key');
    expect(codes).toContain('idempotency_key_in_progress');
    const responses = onDisk.paths['/v1/bookings']!.post!.responses;
    expect(Object.keys(responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '404',
      '409',
      '422',
      '500',
    ]);
    expect(JSON.stringify(responses['409'])).toContain('slot_unavailable');
    expect(JSON.stringify(responses['422'])).toContain('start_not_on_grid');
  });
});

describe('GET /openapi.json', () => {
  let harness: Harness;

  beforeAll(() => {
    harness = createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('serves the document without an API key', async () => {
    const response = await harness.call<Document>('GET', '/openapi.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('Bookrail-Request-Id')).toMatch(/^req_/);
    expect(response.body).toEqual(onDisk);
  });

  it('is the same document the file on disk holds', async () => {
    const raw = await harness.app.request('/openapi.json');
    expect(await raw.text()).toBe(JSON.stringify(openApiDocument()));
    expect(JSON.parse(JSON.stringify(openApiDocument()))).toEqual(onDisk);
  });

  it('ignores an API key, valid or not', async () => {
    const response = await harness.call('GET', '/openapi.json', { token: 'sk_test_nonsense' });
    expect(response.status).toBe(200);
  });
});

/**
 * Every error **code** literal in a set of source trees.
 *
 * The code is not always the same argument: `new BookrailError(type, code, …)` puts it second,
 * `errors.invalidRequest(message, param, code)` third, `errors.conflict(message, code, param)`
 * second. So the arguments are split by balanced scanning rather than by a regular expression:
 * a regular expression over the whole call would also collect the `param` names and the types,
 * which is how the first version of this test reported `status` and `conflict` as error codes.
 */
function codesInSource(directories: readonly string[]): Set<string> {
  const CALLS: readonly { open: string; index: number }[] = [
    { open: 'new BookrailError(', index: 1 },
    { open: 'errors.invalidRequest(', index: 2 },
    { open: 'errors.authentication(', index: 1 },
    { open: 'errors.permission(', index: 1 },
    { open: 'errors.conflict(', index: 1 },
  ];
  const codes = new Set<string>();
  for (const directory of directories) {
    for (const file of listTypeScript(directory)) {
      const text = readFileSync(file, 'utf8');
      for (const call of CALLS) {
        let at = text.indexOf(call.open);
        while (at !== -1) {
          const argument = topLevelArgument(text, at + call.open.length, call.index);
          const literal = argument === null ? null : /^'([a-z][a-z0-9_]*)'$/.exec(argument.trim());
          if (literal) codes.add(literal[1]!);
          at = text.indexOf(call.open, at + call.open.length);
        }
      }
    }
  }
  return codes;
}

function listTypeScript(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScript(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The nth argument of a call whose opening parenthesis has just been consumed. */
function topLevelArgument(text: string, from: number, index: number): string | null {
  let depth = 0;
  let current = 0;
  let start = from;
  let quote: string | null = null;
  for (let at = from; at < text.length; at += 1) {
    const character = text[at]!;
    if (quote !== null) {
      if (character === '\\') at += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' && depth === 0) {
      return current === index ? text.slice(start, at) : null;
    } else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      if (current === index) return text.slice(start, at);
      current += 1;
      start = at + 1;
    }
  }
  return null;
}
