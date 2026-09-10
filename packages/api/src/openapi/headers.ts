/**
 * The canonical spelling of the two idempotency headers, for the specification.
 *
 * HTTP header names are case insensitive and the middleware reads `idempotency-key`, which is
 * the lowercase form Hono normalises to. A document has to print **one** spelling, and the one
 * a reader expects is the RFC casing, so it lives here rather than being typed again at the
 * call site, and `openapi.test.ts` checks that lowercasing it gives back the string the
 * middleware actually reads.
 */
import { IDEMPOTENCY_HEADER, REPLAYED_HEADER } from '../middleware/idempotency.js';

export const IDEMPOTENCY_HEADER_NAME = 'Idempotency-Key';

export { IDEMPOTENCY_HEADER, REPLAYED_HEADER };
