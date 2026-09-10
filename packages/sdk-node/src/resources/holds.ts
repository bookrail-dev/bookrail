import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import type { BookrailPromise } from '../response.js';
import type { Deleted, Hold, HoldCreateParams, HoldCreated } from '../types.js';

/**
 * Holds: capacity taken for a short while, then converted into a booking or released.
 *
 * The two shapes are not an accident of this package: the API answers a **different object**
 * on creation and on read (the read has `booking_id`, `metadata` and the timestamps; the
 * creation has a price the read cannot give back), and the specification declares both. The
 * SDK does not paper over it.
 */
export class HoldsResource extends Resource {
  create(params: HoldCreateParams, options?: RequestOptions): BookrailPromise<HoldCreated> {
    return this.core.request<HoldCreated>({
      method: 'POST',
      path: '/v1/holds',
      body: params,
      options,
    });
  }

  /** Is this hold still convertible, and what did it become. */
  retrieve(id: string, options?: RequestOptions): BookrailPromise<Hold> {
    return this.core.request<Hold>({ method: 'GET', path: `/v1/holds/${segment(id)}`, options });
  }

  /** Gives the capacity back. Idempotent; a converted hold answers `409 hold_not_active`. */
  release(id: string, options?: RequestOptions): BookrailPromise<Deleted> {
    return this.core.request<Deleted>({
      method: 'DELETE',
      path: `/v1/holds/${segment(id)}`,
      options,
    });
  }
}
