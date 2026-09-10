/** The nine error families of the API. Each one maps to one HTTP status, in `STATUS_BY_TYPE`. */
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

export interface ErrorBody {
  type: ErrorType;
  code: string;
  message: string;
  param?: string;
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
  readonly status: number;

  constructor(type: ErrorType, code: string, message: string, param?: string) {
    super(message);
    this.name = 'BookrailError';
    this.type = type;
    this.code = code;
    this.param = param;
    this.status = STATUS_BY_TYPE[type];
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
    return { error: body };
  }
}

export function statusForType(type: ErrorType): number {
  return STATUS_BY_TYPE[type];
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
  internal(message = 'An unexpected error occurred.'): BookrailError {
    return new BookrailError('internal', 'internal_error', message);
  },
};
