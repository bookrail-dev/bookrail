/**
 * `bookrail.stripe`: the Stripe account a project's charges are made on.
 *
 * Bookrail is a Connect platform of the SaaS kind, so the account belongs to the customer and
 * not to Bookrail: `connect()` returns a link that a **person** has to open, and nothing is
 * connected until they authorise on Stripe's own pages. There is no method that takes a Stripe
 * key, because no Stripe key of a customer's is ever sent to Bookrail.
 *
 * ```ts
 * const link = await bookrail.stripe.connect();
 * console.log(`Open ${link.url} before ${link.expires_at}`);
 *
 * const connection = await bookrail.stripe.retrieve();
 * if (connection.status === 'connected' && connection.charges_enabled === true) {
 *   // Initialise Stripe.js with connection.publishable_key and
 *   // { stripeAccount: connection.account_id }.
 * }
 * ```
 */
import { Resource } from './base.js';
import type { RequestOptions } from '../core.js';
import type { BookrailPromise } from '../response.js';
import type { StripeConnection, StripeConnectLink } from '../types.js';

export class StripeResource extends Resource {
  /**
   * Starts an authorisation and returns the link to open.
   *
   * `409 stripe_already_connected` when an account is connected in this environment already:
   * disconnect first rather than swapping the account a project charges on in silence.
   */
  connect(options?: RequestOptions): BookrailPromise<StripeConnectLink> {
    return this.core.request<StripeConnectLink>({
      method: 'POST',
      path: '/v1/stripe/connect',
      options,
    });
  }

  /** The state of the link in this environment. Answers for a project that never connected too. */
  retrieve(options?: RequestOptions): BookrailPromise<StripeConnection> {
    return this.core.request<StripeConnection>({ method: 'GET', path: '/v1/stripe', options });
  }

  /**
   * Revokes the platform's access and records the connection as disconnected.
   *
   * `404 resource_missing` when there is nothing connected to disconnect.
   */
  disconnect(options?: RequestOptions): BookrailPromise<StripeConnection> {
    return this.core.request<StripeConnection>({ method: 'DELETE', path: '/v1/stripe', options });
  }
}
