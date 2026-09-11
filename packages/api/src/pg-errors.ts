import { BookrailError, errors } from '@bookrail/shared';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
}

function asPgError(error: unknown): PgError | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as PgError;
  return typeof candidate.code === 'string' ? candidate : null;
}

/**
 * Turns the Postgres constraints that the API can legitimately hit into the documented error
 * shapes: a `type`, a machine `code`, a human `message`, the offending `param` when there is one,
 * and a `doc_url`. Anything unmapped is rethrown untouched so it surfaces as a 500 rather than
 * being quietly disguised as a client error.
 */
export function translatePgError(error: unknown): BookrailError | null {
  const pg = asPgError(error);
  if (!pg) return null;

  switch (pg.code) {
    // exclusion_violation: occ_no_overlap_cap1 is the capacity-1 double booking guard.
    case '23P01':
      return errors.conflict(
        'The requested period overlaps an existing occupancy on a resource with capacity 1.',
        'slot_unavailable',
      );
    // unique_violation
    case '23505':
      return errors.conflict(
        'A record with the same unique key already exists.',
        'duplicate_record',
      );
    // foreign_key_violation: a reference to an object of another project is simply not there.
    case '23503':
      return errors.invalidRequest(
        'A referenced object does not exist in this project and environment.',
        undefined,
        'parameter_invalid',
      );
    // check_violation
    case '23514':
      return errors.invalidRequest(
        `A database constraint rejected the request${pg.constraint ? ` (${pg.constraint})` : ''}.`,
        undefined,
        'parameter_invalid',
      );
    // not_null_violation
    case '23502':
      return errors.invalidRequest('A required field is missing.', undefined, 'parameter_missing');
    /**
     * The four refusals of the sign up functions (migration 0021).
     *
     * They arrive as SQLSTATE codes chosen for this purpose rather than as messages, so the
     * mapping below is a switch on a value the database guarantees and not a match on prose.
     * Each code names one refusal, so nothing here reads `pg.message`, which would be one
     * translated or reworded string away from silently becoming a 500.
     */
    case 'P0429':
      return new BookrailError(
        'rate_limit',
        'signup_rate_limited',
        'Too many sign up requests for this address or from this caller. Try again tomorrow.',
        undefined,
        'Write to hello@bookrail.dev if you need a key sooner.',
      );
    case 'P0404':
      return new BookrailError(
        'not_found',
        'signup_not_found',
        'That sign up does not exist.',
        undefined,
        'Start again at https://bookrail.dev/signup, or run `bookrail signup`.',
      );
    case 'P0409':
      return new BookrailError(
        'conflict',
        'signup_already_confirmed',
        'That confirmation link has already been used.',
        undefined,
        'The key was already issued. Run `bookrail signup` again for a new one.',
      );
    case 'P0410':
      return new BookrailError(
        'conflict',
        'signup_expired',
        'That confirmation link has expired. A link is good for one hour.',
        undefined,
        'Start again at https://bookrail.dev/signup, or run `bookrail signup`.',
      );
    // insufficient_privilege: e.g. an attempt to UPDATE the append-only events table.
    case '42501':
      return new BookrailError(
        'permission',
        'operation_not_permitted',
        'This operation is not permitted on that object.',
      );
    default:
      return null;
  }
}
