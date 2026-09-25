/**
 * The version of this package and of the API contract it speaks.
 *
 * Both are constants, not values read from disk at run time: `fs` does not exist on every
 * runtime this package is meant to work on, and a package that reads its own `package.json` at
 * import time pays for it on every cold start. `test/generated.test.ts` compares `SDK_VERSION`
 * with the `version` field of `package.json` and `API_VERSION` with `info.version` of the
 * specification, so neither can drift without a red test.
 */
export const SDK_VERSION = '0.4.0';

/**
 * The dated API version this package speaks, sent as `Bookrail-Version` on every request and
 * equal to `info.version` of the specification. A new version is issued only for a change that
 * breaks compatibility, which is what makes it safe to carry the date as a constant here; the
 * server answers `unsupported_api_version` to any other value.
 */
export const API_VERSION = '2026-09-01';

/** `servers[0].url` of the specification. */
export const DEFAULT_BASE_URL = 'https://api.bookrail.dev';

/** Sent as `User-Agent` on every request. */
export const USER_AGENT = `bookrail-node/${SDK_VERSION}`;
