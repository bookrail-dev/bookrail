/**
 * The Checkout Session of a paid plan, as a form: a pure function, so that every parameter can be
 * read in one place and asserted in a test without a network.
 *
 * What it asks of Stripe, and why:
 *
 * - `mode: subscription` on the customer of the account, created beforehand (so that its name is
 *   the account's and its identifier is recorded before anything is paid), with
 *   `customer_update` so that the billing address and the legal name typed in Checkout are saved
 *   onto it: the next invoices are addressed with them, and Stripe Tax computes their tax from
 *   that address and the VAT number (it needs `customer_update.address: auto` to use the address
 *   typed here rather than an older one).
 * - `client_reference_id`: the account, which the receiver verifies against the customer.
 * - `billing_address_collection: required` and `tax_id_collection` required where Stripe supports
 *   it: Bookrail sells to businesses only, and the address decides the tax.
 * - `automatic_tax.enabled`: Stripe Tax computes the tax of the checkout and of the subscription it
 *   creates (Italian VAT, reverse charge with a VAT number of another member state, nothing
 *   outside the Union), from the tax code of the product and the `exclusive` tax behaviour of the
 *   price (see `catalog.ts`).
 * - `subscription_data.billing_cycle_anchor_config`: the first of the month at 00:00:00 UTC, with
 *   the first month pro rata. Every subscription renews on the first, so the included quantity
 *   and the overage line up with the calendar month the usage counter keeps. The configuration,
 *   and not a timestamp: Stripe computes it when the subscription is created, that is when the
 *   customer pays, as the next first of a month at midnight UTC, so it is never in the past
 *   however long the page stayed open, and never more than one period ahead, which Stripe
 *   requires of a timestamp ("a future UNIX timestamp within the first billing period") and which
 *   a timestamp computed from the expiry of the session would break on the last day of a month.
 * - `expires_at`: twenty-three hours and fifty-five minutes after the session is opened, written
 *   out rather than left to the default, so that the life of a session is a number in this file,
 *   and short of the twenty-four hours Stripe allows by a margin for the clocks.
 * - `consent_collection.terms_of_service: required`, with the terms and the DPA linked in the text
 *   next to the box: the business has accepted them in the dashboard already, and accepts them
 *   again at the moment it pays.
 * - one optional custom field for the SdI recipient code or the PEC address of an Italian company,
 *   which the electronic invoice needs.
 */
import { DPA_URL, TERMS_URL, encodeId, type PaidPlanId } from '@bookrail/shared';

/** The key of the custom field. Stripe wants it alphanumeric. */
export const SDI_FIELD_KEY = 'sdiorpec';
export const SDI_FIELD_LABEL = 'SdI recipient code or PEC (Italian companies)';

/** Midnight UTC of the first day of the month after the one `now` is in. */
export function firstOfNextMonthUtc(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/**
 * How long a Checkout Session can be paid: twenty-three hours and fifty-five minutes. Stripe
 * allows up to twenty-four hours after it **creates** the session, measured by its clock; `now`
 * is taken at the start of the request by ours, so five minutes are left for a request that takes
 * a moment and a clock a little ahead.
 */
export const CHECKOUT_SESSION_LIFETIME_S = 24 * 60 * 60 - 5 * 60;

/**
 * The renewal instant of a subscription created at `paidAt`, as Stripe computes it from
 * `billing_cycle_anchor_config` {day_of_month: 1, hour: 0, minute: 0, second: 0}: the next first
 * of a month at midnight UTC. A pure function so that the edges of a month can be tested: a
 * session opened on the last day at 23:40 and paid after midnight renews on the first of the
 * month after, and its first period is the pro rata of one month at most.
 */
export function renewalAnchorOf(paidAt: number): number {
  return firstOfNextMonthUtc(paidAt);
}

export interface CheckoutInput {
  plan: PaidPlanId;
  priceId: string;
  customer: string;
  /** The account, as a UUID. */
  accountId: string;
  siteUrl: string;
  now: number;
}

export function checkoutSessionForm(input: CheckoutInput): Record<string, unknown> {
  const site = input.siteUrl.replace(/\/+$/, '');
  const account = encodeId('account', input.accountId);
  return {
    mode: 'subscription',
    customer: input.customer,
    customer_update: { address: 'auto', name: 'auto' },
    client_reference_id: account,
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true, required: 'if_supported' },
    automatic_tax: { enabled: true },
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: {
      billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
      proration_behavior: 'create_prorations',
      metadata: { bookrail_account_id: account, bookrail_plan: input.plan },
    },
    custom_fields: [
      {
        key: SDI_FIELD_KEY,
        label: { type: 'custom', custom: SDI_FIELD_LABEL },
        type: 'text',
        optional: true,
        text: { maximum_length: 100 },
      },
    ],
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I accept the [Terms of Service](${TERMS_URL}) and the [Data Processing Agreement](${DPA_URL}) on behalf of my business.`,
      },
    },
    metadata: { bookrail_account_id: account, bookrail_plan: input.plan },
    expires_at: Math.floor(input.now / 1000) + CHECKOUT_SESSION_LIFETIME_S,
    success_url: `${site}/dashboard/?checkout=success`,
    cancel_url: `${site}/dashboard/?checkout=cancel`,
  };
}
