/**
 * The paths of `/v1` that carry no API key, in one place.
 *
 * There are five families, and each new one has had to explain why an API key is the wrong
 * credential for it. The sign up endpoints are where a key comes from, so requiring one would be
 * a circle. The dashboard endpoints are where keys are **managed**, live ones included, so an API
 * key must not open them: a test key that leaked must not be able to mint a live one. They carry
 * a credential of their own instead, a dashboard session (`bds_...`) obtained from a link sent to
 * the owner address of the account, checked by the dashboard router and by nothing else. The
 * Stripe OAuth callback is a `GET` that a browser follows after the customer authorised on
 * Stripe's own pages, and a browser has no key to send; what ties that request to a project is the `state` parameter, which is random,
 * single use, hashed at rest and valid for fifteen minutes. The Stripe webhook receiver is
 * called by Stripe's own servers, which have no key either; what ties **that** request to a
 * project is a `Stripe-Signature` over the raw body, verified before anything else is read. The
 * Billing receiver is called by Stripe too, about Bookrail's own customers rather than about a
 * connected account, and proves itself the same way with a secret of its own; it touches no
 * project data, and what it changes (the plan of an account) it changes through definer
 * functions after the signature has passed.
 *
 * The first three were once an `if` inside `authenticate` and another inside `idempotency`. They
 * are one predicate now, because an exemption from authentication that exists in two copies is an
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

/**
 * Exactly `/v1/dashboard` and what is under it.
 *
 * Exempt from the API key, from the per key rate limit and from `Idempotency-Key`, and **not**
 * exempt from authentication: the dashboard router checks a session of its own on every route
 * but the two that obtain one, and limits by session instead of by key.
 */
export const DASHBOARD_PREFIX = '/v1/dashboard';

/**
 * Exactly one path: the receiver of the Stripe Billing events of the Bookrail account itself.
 *
 * Not under `/v1/stripe/`: those are the receivers of the connected accounts, with their own
 * secrets, and a path next to them would invite registering one for the other.
 */
export const BILLING_WEBHOOK_PATH = '/v1/billing/webhook';

export function isSignupPath(path: string): boolean {
  return path === SIGNUPS_PREFIX || path.startsWith(`${SIGNUPS_PREFIX}/`);
}

export function isStripeCallbackPath(path: string): boolean {
  return path === STRIPE_CALLBACK_PATH;
}

export function isStripeWebhookPath(path: string): boolean {
  return (STRIPE_WEBHOOK_PATHS as readonly string[]).includes(path);
}

export function isBillingWebhookPath(path: string): boolean {
  return path === BILLING_WEBHOOK_PATH;
}

export function isDashboardPath(path: string): boolean {
  return path === DASHBOARD_PREFIX || path.startsWith(`${DASHBOARD_PREFIX}/`);
}

/** True for a path of `/v1` that is served without an API key. */
export function isPublicPath(path: string): boolean {
  return (
    isSignupPath(path) ||
    isDashboardPath(path) ||
    isStripeCallbackPath(path) ||
    isStripeWebhookPath(path) ||
    isBillingWebhookPath(path)
  );
}
