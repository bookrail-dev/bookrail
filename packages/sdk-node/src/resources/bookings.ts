import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type {
  Booking,
  BookingCreated,
  BookingCancelParams,
  BookingCheckInParams,
  BookingCompleteParams,
  BookingConfirmParams,
  BookingCreateParams,
  BookingListParams,
  BookingNoShowParams,
  BookingRescheduleParams,
} from '../types.js';

/** Bookings, and the six transitions: confirm, cancel, reschedule, check in, no-show, complete. */
export class BookingsResource extends Resource {
  /**
   * Books, or converts a hold when `hold_id` is given.
   *
   * Every POST carries an `Idempotency-Key`, generated here when the caller gives none, and
   * kept identical across the SDK's own retries. Pass your own order id as
   * `{ idempotencyKey }` when the operation has a natural key on your side.
   *
   * With `payment: { mode: 'deposit' | 'full' }` the answer carries `payment_intent`, whose
   * `client_secret` is returned **once** and is stored nowhere: an idempotent replay answers
   * with the same booking and `client_secret: null`, and `payments.retrieve` reads it back from
   * Stripe. The booking is `pending` until the money arrives, and is cancelled automatically at
   * `payment_expires_at` if it never does.
   */
  create(params: BookingCreateParams, options?: RequestOptions): BookrailPromise<BookingCreated> {
    return this.core.request<BookingCreated>({
      method: 'POST',
      path: '/v1/bookings',
      body: params,
      options,
    });
  }

  list(params?: BookingListParams, options?: RequestOptions): PagePromise<Booking> {
    return paginate<Booking>(this.core, {
      method: 'GET',
      path: '/v1/bookings',
      query: params,
      options,
    });
  }

  retrieve(id: string, options?: RequestOptions): BookrailPromise<Booking> {
    return this.core.request<Booking>({
      method: 'GET',
      path: `/v1/bookings/${segment(id)}`,
      options,
    });
  }

  confirm(
    id: string,
    params?: BookingConfirmParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'confirm', params, options);
  }

  cancel(
    id: string,
    params?: BookingCancelParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'cancel', params, options);
  }

  reschedule(
    id: string,
    params: BookingRescheduleParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'reschedule', params, options);
  }

  noShow(
    id: string,
    params?: BookingNoShowParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'no_show', params, options);
  }

  checkIn(
    id: string,
    params?: BookingCheckInParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'check_in', params, options);
  }

  complete(
    id: string,
    params?: BookingCompleteParams,
    options?: RequestOptions,
  ): BookrailPromise<Booking> {
    return this.transition(id, 'complete', params, options);
  }

  private transition(
    id: string,
    action: string,
    params: unknown,
    options: RequestOptions | undefined,
  ): BookrailPromise<Booking> {
    return this.core.request<Booking>({
      method: 'POST',
      path: `/v1/bookings/${segment(id)}/${action}`,
      // The API takes an optional body on five of the six; sending `{}` rather than nothing
      // keeps `Content-Type` consistent and is what its schemas accept.
      body: params ?? {},
      options,
    });
  }
}
