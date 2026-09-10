import { Resource } from './base.js';
import type { RequestOptions } from '../core.js';
import type { BookrailPromise } from '../response.js';
import type {
  Availability,
  AvailabilityCheck,
  AvailabilityCheckParams,
  AvailabilityListParams,
  AvailabilityNext,
  AvailabilityNextParams,
} from '../types.js';

/** Reading availability: a whole window, the next bookable instant, or one exact instant. */
export class AvailabilityResource extends Resource {
  /**
   * `POST /v1/availability`: the slots or the continuous ranges of a window.
   *
   * A POST because the question has a body (requirements, resources, `explain`), not because
   * it changes anything; it is still a read, and it is not idempotency-keyed by the API. The
   * operation is `availability.search` in the specification.
   */
  list(params: AvailabilityListParams, options?: RequestOptions): BookrailPromise<Availability> {
    return this.core.request<Availability>({
      method: 'POST',
      path: '/v1/availability',
      body: params,
      options,
    });
  }

  /** `GET /v1/availability/next`: the first bookable instant from now, or from `from`. */
  next(
    params: AvailabilityNextParams,
    options?: RequestOptions,
  ): BookrailPromise<AvailabilityNext> {
    return this.core.request<AvailabilityNext>({
      method: 'GET',
      path: '/v1/availability/next',
      query: params,
      options,
    });
  }

  /** `POST /v1/availability/check`: is this exact instant bookable, and if not, why. */
  check(
    params: AvailabilityCheckParams,
    options?: RequestOptions,
  ): BookrailPromise<AvailabilityCheck> {
    return this.core.request<AvailabilityCheck>({
      method: 'POST',
      path: '/v1/availability/check',
      body: params,
      options,
    });
  }
}
