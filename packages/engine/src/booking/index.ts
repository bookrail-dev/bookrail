/**
 * The write half of the engine: the transaction that takes capacity away.
 *
 * `availability/` answers "what could be booked"; this answers "and now it is". The two
 * share their reading (the booking transaction calls `loadAvailabilityData` and the same
 * timeline algebra), so that a slot the offer showed and a slot the transaction accepts are
 * decided by one body of code, not two that drift.
 *
 * Everything that writes a row of `occupancies` (here, and in the API) goes through
 * {@link takeOccupancy}: it takes the advisory locks, sweeps the expired holds, verifies the
 * capacity and only then writes. That single door is what makes the invariant a property of
 * the system rather than of whoever wrote the last endpoint.
 */
export * from './types.js';
export * from './allocate.js';
export * from './occupancy.js';
export * from './expire.js';
export * from './policy.js';
export * from './payment.js';
export * from './snapshot.js';
export * from './lifecycle.js';
export * from './orphaned.js';
export { touchedDaysOf } from './touched.js';
export {
  activeBookingCount,
  applicationRoleChecksRun,
  assertApplicationRole,
  insertEvent,
  lockCustomer,
  lockResources,
  peakUsage,
  resourceCapacities,
} from './queries.js';
export { createBooking, createHold, releaseHold, take, DEFAULT_MAX_RETRIES } from './create.js';
