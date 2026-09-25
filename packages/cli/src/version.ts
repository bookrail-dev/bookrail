/**
 * Version of the CLI and of the API contract it speaks.
 *
 * `API_VERSION` is copied from `@bookrail/shared` on purpose instead of imported: the published
 * `bookrail` package must install with no workspace dependency at all, and a dated API version
 * changes only for an incompatible change, so the copy is cheap to keep honest. `bookrail doctor`
 * compares this constant with what the server answers, so a drift is reported rather than
 * silently tolerated.
 */
export const CLI_VERSION = '0.4.0';

/** The API is versioned by date, sent as the `Bookrail-Version` header on every request. */
export const API_VERSION = '2026-09-01';

export const DEFAULT_API_URL = 'https://api.bookrail.dev';

export const ENVIRONMENTS = ['test', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
