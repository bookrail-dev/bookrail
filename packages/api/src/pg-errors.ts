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
