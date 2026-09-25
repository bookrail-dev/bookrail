/**
 * The catalogue of Bookrail on its own Stripe account: what is sold, at which price, and the
 * customer portal. The tax is Stripe Tax's.
 *
 * ## Two products, one per plan
 *
 * Pro and Scale are two **products**, «Bookrail Pro» and «Bookrail Scale», each with one monthly
 * price found by its lookup key. One product with two monthly prices is refused by the customer
 * portal («For each product, its price must have unique billing intervals»), so the plan changes
 * are not the portal's: the dashboard makes them (a move up at once, a move down with a
 * subscription schedule at the end of the period), and the portal only manages the card, the
 * invoices, the name, the email and the cancellation. A line of an invoice names its product,
 * so it names the plan. The plan is read from the lookup key of the price, never from its amount.
 *
 * ## The tax: Stripe Tax
 *
 * Bookrail sells to businesses only, at prices VAT excluded (`tax_behavior: exclusive`), and
 * Stripe Tax computes the tax of every checkout, subscription and invoice from the address and
 * the VAT number of the customer: Italian VAT for an Italian business, reverse charge for a
 * business of another member state with a VAT number, nothing outside the Union. Every product
 * carries the tax code of software as a service for business use (`txcd_10103001`). The
 * registrations (the Italian one), the origin address and the default code are settings of the
 * Stripe dashboard, not of this catalogue.
 *
 * Before Stripe Tax there were twenty-eight tax rates here, chosen by country: the setup archives
 * them where they still exist (`metadata.bookrail_tax`).
 */
import {
  PAID_PLAN_IDS,
  PLAN_PRICE_CURRENCY,
  PLAN_PRICES,
  isPaidPlanId,
  type PaidPlanId,
} from '@bookrail/shared';
import type { BillingPrice, StripeBillingClient } from '../stripe/billing-client.js';

/** Software as a service for business use, in Stripe Tax's list of product tax codes. */
export const SAAS_BUSINESS_TAX_CODE = 'txcd_10103001';

/** The product of each plan. Identifiers Bookrail chooses, so they are found without a search. */
export const PLAN_PRODUCT_IDS: Readonly<Record<PaidPlanId, string>> = {
  pro: 'bookrail_pro',
  scale: 'bookrail_scale',
};

/** The single product of the two plans before they were split; the setup archives it. */
export const LEGACY_PLAN_PRODUCT_ID = 'bookrail_plan';

/** The two products of the lines Bookrail adds to an invoice at the end of a month. */
export const OVERAGE_BOOKINGS_PRODUCT_ID = 'bookrail_bookings_over_quota';
export const ORCHESTRATED_PAYMENTS_PRODUCT_ID = 'bookrail_orchestrated_payments';

export const PRODUCTS = [
  {
    id: PLAN_PRODUCT_IDS.pro,
    name: 'Bookrail Pro',
    description: 'Booking infrastructure for developers: the Pro plan, billed monthly.',
  },
  {
    id: PLAN_PRODUCT_IDS.scale,
    name: 'Bookrail Scale',
    description: 'Booking infrastructure for developers: the Scale plan, billed monthly.',
  },
  {
    id: OVERAGE_BOOKINGS_PRODUCT_ID,
    name: 'Bookings over the included quantity',
    description: 'Confirmed live bookings of a month past the quantity the plan includes.',
  },
  {
    id: ORCHESTRATED_PAYMENTS_PRODUCT_ID,
    name: 'Orchestrated payments',
    description: "The price of orchestrating payments: a per mille of the month's paid volume.",
  },
] as const;

/** The lookup key of the monthly price of each paid plan. */
export const PLAN_LOOKUP_KEYS: Readonly<Record<PaidPlanId, string>> = {
  pro: 'bookrail_pro_monthly',
  scale: 'bookrail_scale_monthly',
};

export function planOfLookupKey(key: string | null): PaidPlanId | null {
  for (const plan of PAID_PLAN_IDS) if (PLAN_LOOKUP_KEYS[plan] === key) return plan;
  return null;
}

/** The member states of the European Union, as Stripe writes their countries. */
export const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

export type VatTreatment = 'it_vat' | 'eu_reverse_charge' | 'outside_eu';

/**
 * How an invoice to a business in this country should be taxed, by the country alone. Used only
 * to check what Stripe Tax applied: the treatment of an invoice is the one of its taxes.
 */
export function vatTreatmentOf(country: string | null | undefined): VatTreatment {
  const upper = (country ?? '').toUpperCase();
  if (upper === 'IT') return 'it_vat';
  if ((EU_COUNTRIES as readonly string[]).includes(upper)) return 'eu_reverse_charge';
  return 'outside_eu';
}

/** The metadata key of the tax rates of the catalogue before Stripe Tax, which the setup archives. */
export const LEGACY_TAX_METADATA_KEY = 'bookrail_tax';

/** The metadata of the portal configuration this catalogue manages. */
export const PORTAL_METADATA = { bookrail_portal: 'billing' } as const;

/** What a price of a plan must be, from the one statement of the prices in the code. */
export function planPriceSpec(plan: PaidPlanId): {
  unitAmount: number;
  currency: string;
  interval: 'month';
  taxBehavior: 'exclusive';
  product: string;
  nickname: string;
} {
  return {
    unitAmount: PLAN_PRICES[plan].monthly,
    currency: PLAN_PRICE_CURRENCY,
    interval: 'month',
    taxBehavior: 'exclusive',
    product: PLAN_PRODUCT_IDS[plan],
    nickname: plan === 'pro' ? 'Pro' : 'Scale',
  };
}

/** Does a price of Stripe say what the code says the plan costs? */
export function priceMatches(price: BillingPrice, plan: PaidPlanId): boolean {
  const spec = planPriceSpec(plan);
  return (
    price.active &&
    price.unitAmount === spec.unitAmount &&
    price.currency === spec.currency &&
    price.interval === spec.interval &&
    price.taxBehavior === spec.taxBehavior &&
    price.product === spec.product
  );
}

/** The catalogue as the API reads it at run time. */
export interface Catalog {
  prices: Readonly<Record<PaidPlanId, BillingPrice>>;
  /** Every price id this catalogue knows, and the plan it is. */
  planOfPrice: ReadonlyMap<string, PaidPlanId>;
}

/** The catalogue is missing or does not say what the code says: the setup has not been run. */
export class CatalogIncomplete extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`The Stripe catalogue of Billing is incomplete: ${missing.join(', ')}.`);
    this.name = 'CatalogIncomplete';
  }
}

/** Ten minutes: the catalogue changes when somebody runs the setup, which is rare. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

const cache = new WeakMap<StripeBillingClient, { at: number; catalog: Catalog }>();

/** Forgets what was read, for a test that changes the catalogue in between. */
export function forgetCatalog(client: StripeBillingClient): void {
  cache.delete(client);
}

/**
 * The prices of the two plans, read from Stripe and kept for ten minutes.
 *
 * Refuses with {@link CatalogIncomplete} when a price is missing or says something else than the
 * code: a checkout opened on a wrong price would charge the wrong amount, and the answer to that
 * is to run the setup, not to guess.
 */
export async function resolveCatalog(
  client: StripeBillingClient,
  now: number = Date.now(),
): Promise<Catalog> {
  const cached = cache.get(client);
  if (cached !== undefined && now - cached.at < CATALOG_TTL_MS) return cached.catalog;

  const missing: string[] = [];
  const found = await client.listPrices(PAID_PLAN_IDS.map((plan) => PLAN_LOOKUP_KEYS[plan]));
  const planOfPrice = new Map<string, PaidPlanId>();
  const prices: Partial<Record<PaidPlanId, BillingPrice>> = {};
  for (const price of found) {
    const plan = planOfLookupKey(price.lookupKey);
    if (plan === null) continue;
    planOfPrice.set(price.id, plan);
    if (priceMatches(price, plan)) prices[plan] = price;
  }
  for (const plan of PAID_PLAN_IDS) {
    if (prices[plan] === undefined) missing.push(`the price ${PLAN_LOOKUP_KEYS[plan]}`);
  }
  if (missing.length > 0) throw new CatalogIncomplete(missing);
  const catalog: Catalog = {
    prices: prices as Record<PaidPlanId, BillingPrice>,
    planOfPrice,
  };
  cache.set(client, { at: now, catalog });
  return catalog;
}

/**
 * The plan a price is. Never by its amount: by its lookup key; failing that, by its identifier
 * among the prices this catalogue knows; failing that, by `metadata.bookrail_plan` of the price
 * (which the setup writes on every price it creates) or of its product. The last one is what
 * still names the plan of a price that was replaced by the setup: the replacement takes the
 * lookup key over, and the old price, which subscriptions made before may still be on, keeps its
 * metadata.
 */
export function planOfPrice(
  price: {
    id: string;
    lookupKey: string | null;
    metadata?: Readonly<Record<string, string>>;
    productMetadata?: Readonly<Record<string, string>>;
  } | null,
  catalog: Pick<Catalog, 'planOfPrice'> | null,
): PaidPlanId | null {
  if (price === null) return null;
  const byKey = planOfLookupKey(price.lookupKey);
  if (byKey !== null) return byKey;
  const byId = catalog?.planOfPrice.get(price.id) ?? null;
  if (isPaidPlanId(byId)) return byId;
  const byMetadata = price.metadata?.bookrail_plan ?? price.productMetadata?.bookrail_plan ?? null;
  return isPaidPlanId(byMetadata) ? byMetadata : null;
}
