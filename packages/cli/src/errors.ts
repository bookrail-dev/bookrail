/**
 * The one error type every command throws.
 *
 * The output contract has two halves and this type fixes both: the JSON body
 * `{ code, message, param?, doc_url, fix? }` and the exit code below. `fix` is an operative
 * sentence (the thing an agent runs next), and an error that does not say how to recover is not
 * a finished error, so it is a constructor argument rather than an afterthought.
 */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** User error: bad input, invalid config, a missing required value. */
  user: 1,
  /** Authentication or permission. */
  auth: 2,
  /** Network or service failure, including 5xx and rate limits. */
  service: 3,
  /** Conflict: the state changed under the caller (slot taken, hold expired, ...). */
  conflict: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const DOC_BASE_URL = 'https://bookrail.dev/docs/errors';

export interface CliErrorBody {
  code: string;
  message: string;
  param?: string;
  doc_url: string;
  fix?: string;
  /** `Bookrail-Request-Id` of the failed call, when the failure came from the API. */
  request_id?: string;
}

export interface CliErrorOptions {
  param?: string | undefined;
  fix?: string | undefined;
  requestId?: string | undefined;
  docUrl?: string | undefined;
  exitCode?: ExitCode;
}

export class CliError extends Error {
  readonly code: string;
  readonly param: string | undefined;
  readonly fix: string | undefined;
  readonly requestId: string | undefined;
  readonly docUrl: string;
  readonly exitCode: ExitCode;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.param = options.param;
    this.fix = options.fix;
    this.requestId = options.requestId;
    this.docUrl = options.docUrl ?? `${DOC_BASE_URL}#${code}`;
    this.exitCode = options.exitCode ?? EXIT.user;
  }

  toBody(): CliErrorBody {
    const body: CliErrorBody = {
      code: this.code,
      message: this.message,
      doc_url: this.docUrl,
    };
    if (this.param !== undefined) body.param = this.param;
    if (this.fix !== undefined) body.fix = this.fix;
    if (this.requestId !== undefined) body.request_id = this.requestId;
    return body;
  }
}

/** A required input that no flag supplied and no prompt may ask for. */
export function missingInput(what: string, fix: string): CliError {
  return new CliError('missing_input', what, { fix, exitCode: EXIT.user });
}
