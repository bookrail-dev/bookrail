/**
 * Getting a Stripe client for one environment, from one place.
 *
 * Five things now talk to Stripe: the three `/v1/stripe` connection routes, the creation of
 * a booking, `GET /v1/payments/{id}`, the webhook receiver and the worker. Each of them has to
 * answer the same two questions first, and answer them the same way: is this deployment a
 * Connect platform in this environment at all, and which secret key does it act with. A second
 * copy of that answer is how a deployment ends up charging in test with a live key.
 *
 * **Nothing built here can do OAuth.** These clients are handed the platform's secret key and
 * nothing else: every payment call acts on a connected account with `Stripe-Account`, and the
 * OAuth `client_id` is of no use to a webhook receiver or to a worker cancelling an intent.
 * `routes/stripe.ts` keeps its own factory, which passes the `client_id` its two OAuth calls
 * need. A credential a caller has no use for is a credential it cannot leak.
 */
import type { Environment } from '@bookrail/shared';
import type { StripeEnvironmentConfig, StripePlatformConfig } from '../config.js';
import { stripeNotConfigured } from '../routes/stripe.js';
import { StripeClient } from './client.js';

export interface StripePlatform {
  readonly config: StripePlatformConfig;
  readonly environmentConfig: StripeEnvironmentConfig;
  readonly client: StripeClient;
}

/**
 * The platform configuration of one environment, or the 503 that says there is none.
 *
 * The same `503 stripe_not_configured` the `/v1/stripe` routes answer, with the same `fix`
 * naming the variables to set: a deployment that has not been made a platform must say so in
 * one voice, whichever endpoint is asked.
 */
export function stripePlatform(
  config: StripePlatformConfig | null | undefined,
  environment: Environment,
): StripePlatform {
  if (config === undefined || config === null) throw stripeNotConfigured(environment);
  const environmentConfig = config.environments[environment];
  if (environmentConfig === null) throw stripeNotConfigured(environment);
  return {
    config,
    environmentConfig,
    client: new StripeClient({
      secretKey: environmentConfig.secretKey,
      apiBase: config.apiBase,
      connectBase: config.connectBase,
    }),
  };
}

/**
 * The signing secret of the incoming webhook endpoint of one environment, or `null`.
 *
 * `null` is a deployment whose keys are configured and whose endpoint has not been registered
 * in the Stripe dashboard yet. That is a real and temporary state, not a fault: the receiver
 * answers `503` on that path and everything else about the environment works.
 */
export function stripeWebhookSecret(
  config: StripePlatformConfig | null | undefined,
  environment: Environment,
): string | null {
  return config?.webhookSecrets[environment] ?? null;
}
