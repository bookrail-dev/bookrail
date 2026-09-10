import { CliError, EXIT, type ExitCode } from '../errors.js';

/**
 * The error envelope the API returns: a machine-readable `type` and `code`, a human `message`,
 * the `param` that is to blame when one field is, a `doc_url`, and the id of the request.
 */
export interface ApiErrorBody {
  type: string;
  code: string;
  message: string;
  param?: string;
  doc_url?: string;
  request_id?: string;
}

/**
 * Exit code per error *type*. The CLI has five codes, defined in `src/errors.ts`: 0 success,
 * 1 user error, 2 authentication or permission, 3 network or service, 4 conflict. This table
 * only ever produces the last four.
 *
 * `policy_violation` (422) is a user error: the caller asked for something the configuration
 * forbids, and re-running the same command will fail the same way, which is exactly what
 * exit 1 means, and not what exit 4 (retry may succeed) means.
 */
const EXIT_BY_TYPE: Record<string, ExitCode> = {
  invalid_request: EXIT.user,
  authentication: EXIT.auth,
  permission: EXIT.auth,
  not_found: EXIT.user,
  conflict: EXIT.conflict,
  rate_limit: EXIT.service,
  policy_violation: EXIT.user,
  payment_required: EXIT.user,
  internal: EXIT.service,
};

/**
 * The operative sentence for each documented error code: what becomes the `fix` field.
 *
 * Everything an agent needs in order to close the loop by itself, a reason and the command that
 * repairs it, lives here rather than in each call site, so a new command inherits the whole
 * table for free.
 */
const FIX_BY_CODE: Record<string, string> = {
  missing_api_key: 'Run `bookrail login`, or set BOOKRAIL_SECRET_KEY.',
  invalid_authorization_header: 'Run `bookrail login` again: the stored key is malformed.',
  invalid_api_key: 'Run `bookrail login` with a valid `sk_test_` or `sk_live_` key.',
  revoked_api_key: 'The key was revoked. Create a new one and run `bookrail login --token ...`.',
  operation_not_permitted:
    'The API key lacks the scope for this call. Use a key with wider scopes.',
  unsupported_api_version:
    'Upgrade the CLI (`npm i -g bookrail@latest`): it is asking for an API version this deployment does not serve.',
  parameter_missing:
    'Add the missing field. Run `bookrail schema <entity> --json` to see every field.',
  parameter_invalid:
    'Fix the field. Run `bookrail schema <entity> --json` to see the accepted values.',
  invalid_body: 'The request body must be valid JSON. Check the file passed to `--file`.',
  resource_missing:
    'Check the id. `bookrail <entity> list --json` shows the ids of this project and environment.',
  unknown_endpoint: 'This build of the API does not serve that endpoint. Run `bookrail doctor`.',
  duplicate_record:
    'An object with the same unique field already exists. Update it instead of creating it.',
  slot_unavailable:
    'The capacity is gone. Run `bookrail availability --service ... --explain` to see what took it.',
  hold_expired: 'Create a new hold and convert it faster, or ask for a longer `ttl`.',
  hold_not_active: 'The hold was already released or converted. Create a new one.',
  serialization_failure: 'Nothing was written. Run the same command again.',
  idempotency_key_in_progress:
    'Another request with the same Idempotency-Key is still running. Retry in a moment.',
  idempotency_key_reused: 'That Idempotency-Key was used for a different request. Use a new one.',
  start_not_on_grid:
    'The instant is not on the slot grid of the service. Take a `start` from `bookrail availability`.',
  min_notice_violated: 'The instant is inside `booking_window.min_notice_minutes` of the service.',
  outside_booking_window: 'The instant is in the past or beyond `booking_window.max_advance_days`.',
  customer_limit_reached: '`policy.max_active_bookings_per_customer` is reached for this customer.',
  duration_not_offered:
    'Use one of the durations the service offers. `bookrail services get <id> --json` lists them.',
  resource_not_eligible: 'That resource is not a candidate of any requirement of the service.',
  hold_mismatch:
    'The hold does not match the service, instant, duration or quantity of the booking.',
  not_yet_supported: 'This build does not implement that field yet. Remove it.',
  service_without_duration:
    'Give the service a `duration`, `duration_options` or `duration_range`.',
  invalid_transition:
    'The booking is not in a state that allows this action. `bookrail bookings get <id> --json` shows the state.',
  no_show_too_early: 'Wait until the start plus the grace period of the policy.',
  complete_too_early: 'A booking cannot be completed before it starts.',
  max_reschedules_reached: '`policy.max_reschedules` is reached for this booking.',
  range_too_large: 'Ask for a narrower window. Ninety days maximum, seven with `--explain`.',
  timezone_missing:
    'A candidate resource has no time zone. Set one on its schedule or on its location.',
  invalid_range: '`to` must be after `from`.',
  invalid_webhook_url: 'The URL must be public and, on live, https.',
  delivery_too_old: 'Deliveries older than thirty days cannot be replayed.',
};

export function apiErrorToCliError(status: number, body: unknown, requestId?: string): CliError {
  const error = extractError(body);
  if (!error) {
    return new CliError('http_error', `The API answered ${status} with an unexpected body.`, {
      fix: 'Run `bookrail doctor --json` to check the API URL and the key.',
      requestId,
      exitCode: status >= 500 ? EXIT.service : EXIT.user,
    });
  }
  const exitCode = EXIT_BY_TYPE[error.type] ?? (status >= 500 ? EXIT.service : EXIT.user);
  return new CliError(error.code, error.message, {
    param: error.param,
    fix: FIX_BY_CODE[error.code],
    requestId: error.request_id ?? requestId,
    docUrl: error.doc_url,
    exitCode,
  });
}

function extractError(body: unknown): ApiErrorBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const wrapper = (body as { error?: unknown }).error;
  if (typeof wrapper !== 'object' || wrapper === null) return null;
  const candidate = wrapper as Partial<ApiErrorBody>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    type: typeof candidate.type === 'string' ? candidate.type : 'internal',
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.param === 'string' ? { param: candidate.param } : {}),
    ...(typeof candidate.doc_url === 'string' ? { doc_url: candidate.doc_url } : {}),
    ...(typeof candidate.request_id === 'string' ? { request_id: candidate.request_id } : {}),
  };
}

export function networkError(baseUrl: string, cause: unknown): CliError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new CliError('network_error', `Could not reach ${baseUrl}: ${reason}`, {
    fix: `Check that the API is reachable, and that BOOKRAIL_API_URL (currently ${baseUrl}) is right. \`bookrail doctor\` checks both.`,
    exitCode: EXIT.service,
  });
}

export function timeoutError(baseUrl: string, timeoutMs: number): CliError {
  return new CliError('timeout', `${baseUrl} did not answer within ${timeoutMs} ms.`, {
    fix: 'Raise the limit with `--timeout <seconds>`, or check the service status.',
    exitCode: EXIT.service,
  });
}
