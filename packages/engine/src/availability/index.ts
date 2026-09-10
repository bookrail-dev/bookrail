/**
 * Availability: the pure computation (`compute.ts`) and the Postgres read that feeds it
 * (`load.ts`).
 *
 * The two are deliberately separate. `loadAvailabilityData` is the only function of the
 * engine that touches a database, and `computeAvailability` is a function of its result and
 * of the query alone, which is what lets the regression suite build a scenario by hand and
 * assert the answer without a server, and what lets a cache sit between them.
 *
 * Instants are epoch milliseconds everywhere. The public API speaks ISO 8601; that conversion,
 * like the prefixing of identifiers, belongs to the API.
 */
export * from './compute.js';
export * from './pricing.js';
export * from './load.js';
export * from './cached.js';
