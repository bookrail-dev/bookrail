/**
 * The errors of Billing, in one place, so that the dashboard routes and the receiver say the
 * same thing in the same words.
 */
import { BookrailError } from '@bookrail/shared';
import { StripeApiError, StripeUnreachableError } from '../stripe/client.js';

export function billingNotConfigured(): BookrailError {
  return new BookrailError(
    'internal',
    'billing_not_configured',
    'Paid plans cannot be bought on this deployment: Stripe Billing is not configured.',
    undefined,
    'Set BILLING_STRIPE_MODE, STRIPE_BILLING_WEBHOOK_SECRET and the secret key of that mode, and run the setup of the Stripe catalogue. Until then, write to hello@bookrail.dev.',
  );
}

export function billingCatalogIncomplete(): BookrailError {
  return new BookrailError(
    'internal',
    'billing_not_configured',
    'Paid plans cannot be bought yet: the Stripe catalogue of this deployment is incomplete.',
    undefined,
    'Run infra/billing/setup-stripe-billing.mjs for this Stripe mode. Until then, write to hello@bookrail.dev.',
  );
}

/** Turns a failure of a call to Stripe into the `502` a caller can act on, or rethrows. */
export function billingProviderFailure(error: unknown): BookrailError {
  if (error instanceof StripeUnreachableError) {
    return new BookrailError(
      'internal',
      'billing_unreachable',
      'Stripe did not answer in time.',
      undefined,
      'Try again in a minute.',
    );
  }
  if (error instanceof StripeApiError) {
    return new BookrailError(
      'internal',
      'billing_provider_error',
      `Stripe refused the request: ${error.message}`,
      undefined,
      'Try again in a minute. If it keeps failing, write to hello@bookrail.dev with the request id.',
    );
  }
  throw error;
}
