/**
 * `bookrail.payments`: the money of a booking, read.
 *
 * Two methods, and no third one that moves money. A payment comes into existence as part of
 * `bookings.create({ payment: { mode: 'deposit' } })`, and a refund as a consequence of
 * `bookings.cancel(...)`, which follows the policy the customer agreed to. There is no
 * `payments.create` and no `payments.refund` in this release, because there is no endpoint
 * behind either: `bookings.amount_paid`, `amount_due` and `amount_refunded` change in exactly
 * two places, and an SDK method would suggest a third.
 *
 * ```ts
 * const booking = await bookrail.bookings.create({
 *   service_id: 'svc_...',
 *   start: '2026-10-05T09:00:00+02:00',
 *   payment: { mode: 'deposit' },
 * });
 * // `payment_intent.client_secret` is returned once and stored nowhere. If you lose it:
 * const payment = await bookrail.payments.retrieve(booking.payment_intent!.payment_id);
 * // payment.client_secret is read from Stripe, for as long as the payment is pending.
 * ```
 */
import { Resource, segment } from './base.js';
import type { RequestOptions } from '../core.js';
import { paginate, type PagePromise } from '../pagination.js';
import type { BookrailPromise } from '../response.js';
import type { Payment, PaymentListParams } from '../types.js';

export class PaymentsResource extends Resource {
  /**
   * One payment, with its `client_secret` when it is still open.
   *
   * This is the one call in the SDK that makes the API talk to Stripe, and only when the
   * payment is `pending` and is not a refund. If Stripe does not answer, `client_secret` and
   * `provider_status` come back `null` and everything else is still there: a payment provider
   * having a slow minute does not turn a read of your own data into a failure.
   */
  retrieve(id: string, options?: RequestOptions): BookrailPromise<Payment> {
    return this.core.request<Payment>({
      method: 'GET',
      path: `/v1/payments/${segment(id)}`,
      options,
    });
  }

  /** A cursored list. It never calls Stripe, so `client_secret` is always `null` here. */
  list(params?: PaymentListParams, options?: RequestOptions): PagePromise<Payment> {
    return paginate<Payment>(this.core, {
      method: 'GET',
      path: '/v1/payments',
      query: params,
      options,
    });
  }
}
