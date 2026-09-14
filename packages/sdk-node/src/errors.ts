/**
 * Every failure this package can produce, as a class you can catch by kind.
 *
 * A failed call answers with one envelope, always the same shape:
 * `{ "error": { "type", "code", "message", "param"?, "doc_url"?, "request_id" } }`. The nine
 * families of `type` come from the specification (`ErrorType`), so the set cannot drift from
 * the API: `invalid_request`, `authentication`, `permission`, `not_found`, `conflict`,
 * `rate_limit`, `policy_violation`, `payment_required`, `internal`. Two more classes exist
 * that the API never sends because they never reach it: a socket that failed, and a webhook
 * signature that did not verify.
 *
 * `instanceof` is the whole point: a caller writes `catch (e) { if (e instanceof
 * BookrailConflictError) … }` and never parses a string.
 */
import type { ErrorPayload, ErrorType } from './types.js';

/** How much of an unexpected body is kept in the message before it is cut. */
const RAW_BODY_LIMIT = 512;

export interface BookrailErrorOptions {
  code: string;
  param?: string | undefined;
  fix?: string | undefined;
  docUrl?: string | undefined;
  requestId?: string | undefined;
  status?: number | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  cause?: unknown;
}

/** The base of every error this package throws. */
export class BookrailError extends Error {
  /** The error family. The nine of the API, plus `connection` and `signature_verification`. */
  readonly type: ErrorType | 'connection' | 'signature_verification';
  /** The machine readable code (`slot_unavailable`, `timeout`, …). */
  readonly code: string;
  /** The field or header the error is about, when the API named one. */
  readonly param: string | undefined;
  /**
   * What to do next, when the API had one thing to say about it.
   *
   * Sent by the errors that are about the state of the deployment or of the caller's budget
   * rather than about the request: a rate limit, a sign up that is switched off, a mail server
   * that refused a message. Absent on everything else, which is most things, because `code` and
   * `message` already say it.
   */
  readonly fix: string | undefined;
  /** Where the documentation explains this error. */
  readonly docUrl: string | undefined;
  /** `Bookrail-Request-Id`; quote it to support. */
  readonly requestId: string | undefined;
  /** The HTTP status, absent when no response was ever received. */
  readonly status: number | undefined;
  /** The response headers, lower-cased, absent when no response was ever received. */
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    type: ErrorType | 'connection' | 'signature_verification',
    message: string,
    options: BookrailErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.type = type;
    this.code = options.code;
    this.param = options.param;
    this.fix = options.fix;
    this.docUrl = options.docUrl;
    this.requestId = options.requestId;
    this.status = options.status;
    this.headers = options.headers;
  }
}

export class BookrailInvalidRequestError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('invalid_request', message, options);
  }
}

export class BookrailAuthenticationError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('authentication', message, options);
  }
}

export class BookrailPermissionError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('permission', message, options);
  }
}

export class BookrailNotFoundError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('not_found', message, options);
  }
}

export class BookrailConflictError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('conflict', message, options);
  }
}

export class BookrailRateLimitError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('rate_limit', message, options);
  }
}

export class BookrailPolicyViolationError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('policy_violation', message, options);
  }
}

export class BookrailPaymentRequiredError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('payment_required', message, options);
  }
}

export class BookrailInternalError extends BookrailError {
  constructor(message: string, options: BookrailErrorOptions) {
    super('internal', message, options);
  }
}

/** The codes {@link BookrailConnectionError} carries. `timeout` and `connection` are retried. */
export type ConnectionErrorCode = 'timeout' | 'aborted' | 'connection';

/**
 * The request never produced a response: DNS, TCP, TLS, a timeout, or an abort.
 *
 * `code: 'aborted'` means **the caller's** `AbortSignal` fired, and is never retried: the
 * caller asked to stop, and a client that answered by trying again would be ignoring them.
 */
export class BookrailConnectionError extends BookrailError {
  declare readonly code: ConnectionErrorCode;

  constructor(message: string, code: ConnectionErrorCode, cause?: unknown) {
    super('connection', message, { code, cause });
  }
}

/** `webhooks.constructEvent` was given a payload the secret does not sign. */
export class BookrailSignatureVerificationError extends BookrailError {
  /** The raw body that failed, so a receiver can log what it rejected. */
  readonly payload: string;
  /** The `Bookrail-Signature` header that failed, `null` when there was none. */
  readonly header: string | null;

  constructor(message: string, payload: string, header: string | null) {
    super('signature_verification', message, { code: 'signature_verification_failed' });
    this.payload = payload;
    this.header = header;
  }
}

const CONSTRUCTORS: Record<
  ErrorType,
  new (message: string, options: BookrailErrorOptions) => BookrailError
> = {
  invalid_request: BookrailInvalidRequestError,
  authentication: BookrailAuthenticationError,
  permission: BookrailPermissionError,
  not_found: BookrailNotFoundError,
  conflict: BookrailConflictError,
  rate_limit: BookrailRateLimitError,
  policy_violation: BookrailPolicyViolationError,
  payment_required: BookrailPaymentRequiredError,
  internal: BookrailInternalError,
};

function isErrorPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const inner = (value as { error: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return false;
  const record = inner as Record<string, unknown>;
  return typeof record['type'] === 'string' && typeof record['code'] === 'string';
}

function truncate(body: string): string {
  return body.length <= RAW_BODY_LIMIT ? body : `${body.slice(0, RAW_BODY_LIMIT)}…`;
}

/**
 * Turns a failed response into the right subclass.
 *
 * A body that is not that envelope (a proxy's HTML, an empty 502, a JSON object of some other
 * shape) becomes a {@link BookrailInternalError} carrying the raw text, truncated. Guessing at
 * a shape we do not recognise would hide the one fact that matters: something between the
 * caller and Bookrail answered instead of Bookrail.
 */
export function errorFromResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
  rawBody: string,
  parsed: unknown,
): BookrailError {
  const requestId = headers['bookrail-request-id'];
  if (isErrorPayload(parsed)) {
    const payload = parsed.error;
    const constructor = CONSTRUCTORS[payload.type] as
      (new (message: string, options: BookrailErrorOptions) => BookrailError) | undefined;
    const options: BookrailErrorOptions = {
      code: payload.code,
      param: payload.param,
      fix: payload.fix,
      docUrl: payload.doc_url,
      requestId: payload.request_id ?? requestId,
      status,
      headers,
    };
    if (constructor === undefined) {
      // A family the specification did not declare when this package was generated. Better a
      // `BookrailError` with the right `type` string than a wrong subclass.
      return new BookrailError(payload.type, payload.message, options);
    }
    return new constructor(payload.message, options);
  }
  return new BookrailInternalError(
    `Bookrail answered ${String(status)} with a body that is not an error envelope: ${truncate(rawBody)}`,
    { code: 'unexpected_response', requestId, status, headers },
  );
}

/** A 2xx whose body is not JSON, or is not the shape the specification declares. */
export function unexpectedBody(
  status: number,
  headers: Readonly<Record<string, string>>,
  rawBody: string,
  what: string,
): BookrailError {
  return new BookrailInternalError(
    `Bookrail answered ${String(status)} with ${what}: ${truncate(rawBody)}`,
    {
      code: 'unexpected_response',
      requestId: headers['bookrail-request-id'],
      status,
      headers,
    },
  );
}
