/**
 * The nine error families of the API. Each one maps to one HTTP status, in `STATUS_BY_TYPE`,
 * and a handful of named codes override that status in {@link STATUS_BY_CODE}.
 */
export const ERROR_TYPES = [
  'invalid_request',
  'authentication',
  'permission',
  'not_found',
  'conflict',
  'rate_limit',
  'policy_violation',
  'payment_required',
  'internal',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

const STATUS_BY_TYPE: Record<ErrorType, number> = {
  invalid_request: 400,
  authentication: 401,
  permission: 403,
  not_found: 404,
  conflict: 409,
  rate_limit: 429,
  policy_violation: 422,
  payment_required: 402,
  internal: 500,
};

export const DOC_BASE_URL = 'https://bookrail.dev/docs/errors';

/**
 * Codes whose HTTP status is not the one their family implies.
 *
 * The nine families cover nine statuses, and they cover every error the booking API can
 * produce. The sign up endpoints produce three that they cannot express: a confirmation link
 * that has been used or has run out is `410 Gone` and not `409 Conflict` (the resource was
 * there and is deliberately no longer), a deployment with no mailer is `503` (the endpoint
 * exists and is temporarily not serving), and a mail server that refused the message is `502`
 * (this service is fine, the one behind it is not).
 *
 * The Stripe connection endpoints add three of the same shape. A deployment with no platform
 * credentials is `503` (the endpoint exists and is not serving), and the two ways a call to
 * Stripe can fail, a refusal we did not expect and no answer at all, are `502` (this service is
 * fine, the one behind it is not).
 *
 * The family still decides everything else: the `type` in the body, the exit code a client
 * maps it to, and the way it reads in the reference. Only the status is overridden, by name,
 * in one table, so that the server and the specification cannot disagree about it.
 */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  signup_expired: 410,
  signup_secret_claimed: 410,
  signup_secret_expired: 410,
  signup_disabled: 503,
  signup_email_failed: 502,
  stripe_not_configured: 503,
  stripe_provider_error: 502,
  stripe_unreachable: 502,
  payload_too_large: 413,
};

export interface ErrorBody {
  type: ErrorType;
  code: string;
  message: string;
  param?: string;
  /**
   * The operative sentence: what the caller should do next, when there is one thing to do.
   *
   * Most errors are self explanatory from `code` and `message`, and carry none. The ones that
   * are about the state of the deployment rather than about the request carry one, because
   * "write to this address" or "try again in a minute" is not something a client can derive
   * from a code it has never seen.
   */
  fix?: string;
  doc_url: string;
  request_id: string;
}

export interface ErrorPayload {
  error: ErrorBody;
}

export class BookrailError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly param: string | undefined;
  readonly fix: string | undefined;
  readonly status: number;

  constructor(type: ErrorType, code: string, message: string, param?: string, fix?: string) {
    super(message);
    this.name = 'BookrailError';
    this.type = type;
    this.code = code;
    this.param = param;
    this.fix = fix;
    this.status = statusForCode(code, type);
  }

  toPayload(requestId: string): ErrorPayload {
    const body: ErrorBody = {
      type: this.type,
      code: this.code,
      message: this.message,
      doc_url: `${DOC_BASE_URL}#${this.code}`,
      request_id: requestId,
    };
    if (this.param !== undefined) body.param = this.param;
    if (this.fix !== undefined) body.fix = this.fix;
    return { error: body };
  }
}

export function statusForType(type: ErrorType): number {
  return STATUS_BY_TYPE[type];
}

/** The status of a code: the one its family implies, unless {@link STATUS_BY_CODE} names it. */
export function statusForCode(code: string, type: ErrorType): number {
  return STATUS_BY_CODE[code] ?? STATUS_BY_TYPE[type];
}

export const errors = {
  invalidRequest(message: string, param?: string, code = 'invalid_request'): BookrailError {
    return new BookrailError('invalid_request', code, message, param);
  },
  authentication(message: string, code = 'invalid_api_key'): BookrailError {
    return new BookrailError('authentication', code, message);
  },
  permission(message: string, code = 'insufficient_scope'): BookrailError {
    return new BookrailError('permission', code, message);
  },
  notFound(objectName: string, id: string): BookrailError {
    return new BookrailError('not_found', 'resource_missing', `No such ${objectName}: ${id}`, 'id');
  },
  conflict(message: string, code: string, param?: string): BookrailError {
    return new BookrailError('conflict', code, message, param);
  },
  /**
   * Too many requests from one API key.
   *
   * The one error of this family that the booking API itself produces: the sign up endpoints have
   * `signup_rate_limited`, which is about an address and a mailbox, while this one is about a
   * credential. It always carries a `fix`, because "wait" is exactly the kind of instruction a
   * client cannot derive from a code it has never seen, and the response carries `Retry-After` so
   * that the wait is a number and not a guess.
   */
  rateLimited(message: string, fix: string): BookrailError {
    return new BookrailError('rate_limit', 'rate_limited', message, undefined, fix);
  },
  internal(message = 'An unexpected error occurred.'): BookrailError {
    return new BookrailError('internal', 'internal_error', message);
  },
};
