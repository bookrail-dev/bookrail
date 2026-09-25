/**
 * The Billing dependencies of a process, from its configuration.
 *
 * One client per process, built once: the catalogue it reads is cached per client, so a process
 * that built a new one per request would read the catalogue from Stripe on every checkout.
 */
import type { BillingConfig } from '../config.js';
import type { BillingDeps } from '../context.js';
import { StripeBillingClient } from '../stripe/billing-client.js';

export function createBillingDeps(config: BillingConfig | null): BillingDeps | null {
  if (config === null) return null;
  return {
    mode: config.mode,
    client: new StripeBillingClient({ secretKey: config.secretKey, apiBase: config.apiBase }),
    webhookSecret: config.webhookSecret,
    invoiceTo: config.invoiceTo,
  };
}
