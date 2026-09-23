/**
 * The paths of `/v1` that carry no API key, in one place.
 *
 * There are three families and there will not be many more. The sign up endpoints are where a
 * key comes from, so requiring one would be a circle. The Stripe OAuth callback is a `GET` that
 * a browser follows after the customer authorised on Stripe's own pages, and a browser has no
 * key to send; what ties that request to a project is the `state` parameter, which is random,
 * single use, hashed at rest and valid for fifteen minutes. The Stripe webhook receiver is
 * called by Stripe's own servers, which have no key either; what ties **that** request to a
 * project is a `Stripe-Signature` over the raw body, verified before anything else is read.
 *
 * All three were once an `if` inside `authenticate` and another inside `idempotency`. They are one
 * predicate now, because an exemption from authentication that exists in two copies is an
 * exemption that will one day exist in one and a half: a family added to the middleware that
 * checks the key and forgotten in the middleware that stores idempotent answers is a bug that
 * nothing would notice.
 *
 * Every entry is an **exact** path or an exact prefix followed by a slash. A bare
 * `startsWith` would exempt `/v1/signupsx` as well, which is how an endpoint loses its key.
 */

/** Exactly `/v1/signups` and what is under it. */
export const SIGNUPS_PREFIX = '/v1/signups';

/** Exactly one path: the browser's return from Stripe. */
export const STRIPE_CALLBACK_PATH = '/v1/stripe/callback';

/**
 * Exactly two paths: the incoming webhook of each mode.
 *
 * Two and not one, so that the signing secret to verify against is decided by the path rather
 * than guessed from the body. They are listed as exact strings for the reason the whole file
 * exists: a `startsWith('/v1/stripe/webhook')` would also exempt `/v1/stripe/webhookx`, which
 * is how an endpoint loses its key.
 */
export const STRIPE_WEBHOOK_PATHS = ['/v1/stripe/webhook/test', '/v1/stripe/webhook/live'] as const;

export function isSignupPath(path: string): boolean {
  return path === SIGNUPS_PREFIX || path.startsWith(`${SIGNUPS_PREFIX}/`);
}

export function isStripeCallbackPath(path: string): boolean {
  return path === STRIPE_CALLBACK_PATH;
}

export function isStripeWebhookPath(path: string): boolean {
  return (STRIPE_WEBHOOK_PATHS as readonly string[]).includes(path);
}

/** True for a path of `/v1` that is served without an API key. */
export function isPublicPath(path: string): boolean {
  return isSignupPath(path) || isStripeCallbackPath(path) || isStripeWebhookPath(path);
}
