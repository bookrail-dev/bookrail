/**
 * Creating, or bringing up to date, the catalogue of Billing on a Stripe account.
 *
 * Run by a person, once on the sandbox and once on the live account, and again whenever a price
 * in the code changes (`infra/billing/setup-stripe-billing.mjs` is the command). **Idempotent**:
 * it finds what it made last time by identifiers and keys it chose itself (the product ids, the
 * lookup keys of the prices, the metadata of the portal configuration), keeps what already says
 * what the code says, and only creates what is missing or different. Two runs in a row create
 * nothing the second time.
 *
 * Stripe does not let a price change: a price whose amount or product is wrong is replaced by a
 * new one that takes over its lookup key (`transfer_lookup_key`), and the old one is archived.
 * Subscriptions that already exist keep the price they were created with, which is how Stripe
 * treats a price change.
 *
 * What it tidies from the catalogue before Stripe Tax and before the two products: the single
 * product of the two plans (`bookrail_plan`) is archived, and so is every tax rate it made
 * (`metadata.bookrail_tax`). It does **not** configure Stripe Tax itself: the registrations, the
 * origin address and the default tax code are settings of the Stripe dashboard, on the checklist.
 *
 * It prints identifiers and nothing else: no key, no secret.
 */
import { PAID_PLAN_IDS, TERMS_URL, type PaidPlanId } from '@bookrail/shared';
import type { StripeBillingClient } from '../stripe/billing-client.js';
import {
  LEGACY_PLAN_PRODUCT_ID,
  LEGACY_TAX_METADATA_KEY,
  PLAN_LOOKUP_KEYS,
  PLAN_PRODUCT_IDS,
  PORTAL_METADATA,
  PRODUCTS,
  SAAS_BUSINESS_TAX_CODE,
  forgetCatalog,
  planOfLookupKey,
  planPriceSpec,
  priceMatches,
} from './catalog.js';

export type SetupAction = 'created' | 'updated' | 'unchanged' | 'replaced' | 'archived';

export interface SetupReport {
  products: { id: string; action: SetupAction }[];
  prices: { plan: PaidPlanId; lookupKey: string; id: string; action: SetupAction }[];
  /** The tax rates of the catalogue before Stripe Tax, archived. */
  taxRates: { key: string; id: string; action: SetupAction }[];
  portal: { id: string; action: SetupAction };
}

/**
 * The configuration of the customer portal, as a form.
 *
 * No plan changes (the dashboard makes them, see `catalog.ts`), and no fiscal data: the tax of a
 * subscription follows the address and the VAT number, so they are changed by writing to
 * Bookrail. The card, the invoices, the name, the email, and the cancellation at the end of the
 * period.
 */
export function portalConfigurationForm(options: { siteUrl: string }): Record<string, unknown> {
  return {
    business_profile: {
      headline: 'Bookrail: your card, invoices and subscription.',
      privacy_policy_url: `${options.siteUrl}/privacy`,
      terms_of_service_url: TERMS_URL,
    },
    default_return_url: `${options.siteUrl}/dashboard/`,
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ['email', 'name'],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
      },
      subscription_update: { enabled: false },
    },
    metadata: { ...PORTAL_METADATA },
  };
}

function productMetadataOf(id: string): Record<string, string> {
  for (const plan of PAID_PLAN_IDS) {
    if (PLAN_PRODUCT_IDS[plan] === id) return { bookrail_plan: plan };
  }
  return {};
}

export async function setupStripeBillingCatalog(
  client: StripeBillingClient,
  options: { siteUrl: string },
): Promise<SetupReport> {
  forgetCatalog(client);
  const report: SetupReport = {
    products: [],
    prices: [],
    taxRates: [],
    portal: { id: '', action: 'unchanged' },
  };

  // --- products --------------------------------------------------------------------------
  for (const product of PRODUCTS) {
    const metadata = productMetadataOf(product.id);
    const existing = await client.retrieveProduct(product.id);
    if (existing === null) {
      await client.createProduct({
        id: product.id,
        name: product.name,
        description: product.description,
        tax_code: SAAS_BUSINESS_TAX_CODE,
        metadata,
      });
      report.products.push({ id: product.id, action: 'created' });
    } else if (
      existing.name !== product.name ||
      !existing.active ||
      existing.taxCode !== SAAS_BUSINESS_TAX_CODE
    ) {
      await client.updateProduct(product.id, {
        name: product.name,
        description: product.description,
        tax_code: SAAS_BUSINESS_TAX_CODE,
        metadata,
        active: true,
      });
      report.products.push({ id: product.id, action: 'updated' });
    } else {
      report.products.push({ id: product.id, action: 'unchanged' });
    }
  }

  // --- the prices of the two plans --------------------------------------------------------
  const found = await client.listPrices(PAID_PLAN_IDS.map((plan) => PLAN_LOOKUP_KEYS[plan]));
  for (const plan of PAID_PLAN_IDS) {
    const lookupKey = PLAN_LOOKUP_KEYS[plan];
    const current = found.find((price) => planOfLookupKey(price.lookupKey) === plan);
    if (current !== undefined && priceMatches(current, plan)) {
      report.prices.push({ plan, lookupKey, id: current.id, action: 'unchanged' });
      continue;
    }
    const spec = planPriceSpec(plan);
    const created = await client.createPrice({
      product: spec.product,
      unit_amount: spec.unitAmount,
      currency: spec.currency,
      recurring: { interval: spec.interval },
      tax_behavior: spec.taxBehavior,
      nickname: spec.nickname,
      lookup_key: lookupKey,
      // Takes the key over from a price that no longer says what the code says (an amount
      // changed, or the price of the single product the two plans had before).
      transfer_lookup_key: true,
      metadata: { bookrail_plan: plan },
    });
    if (current !== undefined) await client.updatePrice(current.id, { active: false });
    report.prices.push({
      plan,
      lookupKey,
      id: created.id,
      action: current === undefined ? 'created' : 'replaced',
    });
  }

  // --- what came before: the single product and the tax rates ---------------------------
  const legacy = await client.retrieveProduct(LEGACY_PLAN_PRODUCT_ID);
  if (legacy !== null && legacy.active) {
    await client.updateProduct(LEGACY_PLAN_PRODUCT_ID, { active: false });
    report.products.push({ id: LEGACY_PLAN_PRODUCT_ID, action: 'archived' });
  }
  for (const rate of await client.listTaxRates()) {
    const key = rate.metadata[LEGACY_TAX_METADATA_KEY];
    if (key === undefined || !rate.active) continue;
    await client.updateTaxRate(rate.id, { active: false });
    report.taxRates.push({ key, id: rate.id, action: 'archived' });
  }

  // --- the customer portal -----------------------------------------------------------------
  const form = portalConfigurationForm({ siteUrl: options.siteUrl });
  const configurations = await client.listPortalConfigurations();
  const existing = configurations.find(
    (configuration) => configuration.metadata.bookrail_portal === PORTAL_METADATA.bookrail_portal,
  );
  if (existing === undefined) {
    const created = await client.createPortalConfiguration(form);
    report.portal = { id: created.id, action: 'created' };
  } else if (existing.active && saysWhatTheFormSays(existing.raw, form)) {
    report.portal = { id: existing.id, action: 'unchanged' };
  } else {
    // A configuration edited by hand in the dashboard, or made by an older setup, is brought back
    // to what the code says.
    await client.updatePortalConfiguration(existing.id, { ...form, active: true });
    report.portal = { id: existing.id, action: 'updated' };
  }

  forgetCatalog(client);
  return report;
}

/**
 * Does an object Stripe answered say everything a form says? Every field of the form must be in
 * the answer with the same value (a list with the same members, in any order); what Stripe adds
 * on its own (defaults, timestamps) does not count. Values are compared as text, the way the form
 * travels.
 */
export function saysWhatTheFormSays(answer: unknown, form: unknown): boolean {
  if (Array.isArray(form)) {
    if (!Array.isArray(answer) || answer.length !== form.length) return false;
    const left = answer.map((value) => JSON.stringify(value)).sort();
    const right = form.map((value) => JSON.stringify(value)).sort();
    return left.every((value, index) => value === right[index]);
  }
  if (typeof form === 'object' && form !== null) {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return false;
    return Object.entries(form).every(([key, value]) =>
      saysWhatTheFormSays((answer as Record<string, unknown>)[key], value),
    );
  }
  return answer !== undefined && answer !== null && String(answer) === String(form);
}

/** The portal configuration this catalogue manages, or `null` before the setup has run. */
export async function portalConfigurationId(client: StripeBillingClient): Promise<string | null> {
  const configurations = await client.listPortalConfigurations();
  return (
    configurations.find(
      (configuration) =>
        configuration.active &&
        configuration.metadata.bookrail_portal === PORTAL_METADATA.bookrail_portal,
    )?.id ?? null
  );
}
