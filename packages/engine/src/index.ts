/**
 * @bookrail/engine: availability computation and booking allocation.
 *
 * `timeline/` holds the pure segment algebra the whole computation rests on, and
 * `schedule/` turns schedule rules, exceptions and blocks into absolute UTC timelines.
 * `availability/` computes the offer from real data and assembles it
 * from the per (resource, local day) cache of `cache/`; `booking/` holds the transaction
 * that takes capacity; `plan/` counts what an account has used of its plan, and refuses a live
 * booking of the free plan past its threshold.
 */
export * from './errors.js';
export * from './timeline/index.js';
export * from './schedule/index.js';
export * from './availability/index.js';
export * from './cache/index.js';
export * from './cache/redis.js';
export * from './booking/index.js';
export * from './plan/usage.js';

export const ENGINE_VERSION = '0.0.0';
