/**
 * Stripe Billing: Bookrail selling its own plans, on its own Stripe account.
 *
 * The same account that is a Connect **platform** for the customers' payments
 * (`client.ts`, always with `Stripe-Account`) is here a **seller**: its own customers, its own
 * subscriptions, its own invoices. This client can do nothing else. No method takes a connected
 * account, and the transport it shares with the Connect client is handed no `stripeAccount` by
 * anything in this file, so a Billing call can never be made "for" a customer's account, and a
 * Connect call cannot be made from here. `billing.test.ts` asserts that no request of this client
 * carries the header.
 *
 * Every answer is reduced to the fields something here acts on, read defensively: the body comes
 * from the network, and a field that is missing or renamed by a later API version becomes `null`
 * rather than a crash, and the caller decides what a `null` means.
 */
import { StripeTransport, type StripeClientOptions } from './client.js';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A list answer of Stripe: `{object: 'list', data: [...], has_more}`. */
function listOf(body: unknown): { data: Record<string, unknown>[]; hasMore: boolean } {
  const object = asObject(body) ?? {};
  return {
    data: asArray(object.data)
      .map(asObject)
      .filter((item): item is Record<string, unknown> => item !== null),
    hasMore: object.has_more === true,
  };
}

/** A price, reduced to what the catalogue and the plan resolution read. */
export interface BillingPrice {
  id: string;
  lookupKey: string | null;
  product: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  taxBehavior: string | null;
  active: boolean;
  /** The metadata of the price, and of its product when the product came expanded. */
  metadata: Record<string, string>;
  productMetadata: Record<string, string>;
}

export function priceOf(value: unknown): BillingPrice | null {
  const body = asObject(value);
  if (body === null) return null;
  const id = asString(body.id);
  if (id === null) return null;
  const recurring = asObject(body.recurring);
  const product =
    typeof body.product === 'string' ? body.product : asString(asObject(body.product)?.id);
  return {
    id,
    lookupKey: asString(body.lookup_key),
    product,
    unitAmount: asNumber(body.unit_amount),
    currency: asString(body.currency),
    interval: recurring === null ? null : asString(recurring.interval),
    taxBehavior: asString(body.tax_behavior),
    active: body.active !== false,
    metadata: stringMap(body.metadata),
    productMetadata: stringMap(asObject(body.product)?.metadata),
  };
}

/** A tax rate, reduced to what the setup reads to archive the rates made before Stripe Tax. */
export interface BillingTaxRate {
  id: string;
  displayName: string | null;
  description: string | null;
  jurisdiction: string | null;
  country: string | null;
  percentage: number | null;
  inclusive: boolean;
  active: boolean;
  metadata: Record<string, string>;
}

function stringMap(value: unknown): Record<string, string> {
  const object = asObject(value) ?? {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) if (typeof item === 'string') out[key] = item;
  return out;
}

function taxRateOf(value: Record<string, unknown>): BillingTaxRate | null {
  const id = asString(value.id);
  if (id === null) return null;
  return {
    id,
    displayName: asString(value.display_name),
    description: asString(value.description),
    jurisdiction: asString(value.jurisdiction),
    country: asString(value.country),
    percentage: asNumber(value.percentage),
    inclusive: value.inclusive === true,
    active: value.active !== false,
    metadata: stringMap(value.metadata),
  };
}

/** A subscription as the plan of an account is decided from. */
export interface BillingSubscription {
  id: string;
  customer: string | null;
  status: string;
  /** The price of the one item this product sells, by its lookup key. */
  price: BillingPrice | null;
  /** The end of the current period, from the item (the field moved there from the subscription). */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, string>;
  /** The id of its one item, which a change of plan replaces the price of. */
  itemId: string | null;
  /** The start of the current period, from the item (Unix seconds). */
  currentPeriodStart: number | null;
  /** The payment method the subscription charges, for an invoice made after it has ended. */
  defaultPaymentMethod: string | null;
  /** When it ended, and when it was cancelled, for a subscription that has (Unix seconds). */
  endedAt: number | null;
  canceledAt: number | null;
  /** The attached schedule, when there is one: a move down at the end of the period. */
  scheduleId: string | null;
  /**
   * The phases of the attached schedule, when there is one: the dashboard attaches one to move a
   * subscription down at the end of the period.
   */
  schedulePhases: { startDate: number | null; priceIds: string[]; lookupKeys: string[] }[];
  /** The status of the attached schedule (`active`, `not_started`, ...), when it came expanded. */
  scheduleStatus: string | null;
  /**
   * Whether the attached schedule is one the dashboard made (its metadata, or the metadata of
   * its phases, name a Bookrail account): only those are released by the code.
   */
  scheduleIsBookrail: boolean;
  /**
   * A change that waits for its payment (`payment_behavior: pending_if_incomplete`): the prices it
   * would put on the items, and when Stripe discards it. `null` when there is none.
   */
  pendingUpdate: { priceIds: string[]; expiresAt: number | null } | null;
  /** The latest invoice, when it came expanded: the one a pending change waits for. */
  latestInvoice: { id: string; status: string | null; hostedInvoiceUrl: string | null } | null;
}

function pendingUpdateOf(value: unknown): BillingSubscription['pendingUpdate'] {
  const pending = asObject(value);
  if (pending === null) return null;
  return {
    priceIds: asArray(pending.subscription_items)
      .map((item) => {
        const price = asObject(item)?.price;
        return typeof price === 'string' ? price : asString(asObject(price)?.id);
      })
      .filter((price): price is string => price !== null),
    expiresAt: asNumber(pending.expires_at),
  };
}

function latestInvoiceOf(value: unknown): BillingSubscription['latestInvoice'] {
  if (typeof value === 'string') return { id: value, status: null, hostedInvoiceUrl: null };
  const invoice = asObject(value);
  const id = asString(invoice?.id);
  if (invoice === null || id === null) return null;
  return {
    id,
    status: asString(invoice.status),
    hostedInvoiceUrl: asString(invoice.hosted_invoice_url),
  };
}

/** A subscription as a list of Stripe answers it: enough to know whether it is still alive. */
export interface BillingSubscriptionSummary {
  id: string;
  status: string;
}

export function subscriptionOf(value: unknown): BillingSubscription | null {
  const body = asObject(value);
  if (body === null) return null;
  const id = asString(body.id);
  if (id === null) return null;
  const items = listOf(body.items).data;
  const first = items[0] ?? {};
  const schedule = asObject(body.schedule);
  const phases = schedule === null ? [] : asArray(schedule.phases).map(asObject);
  return {
    id,
    customer:
      typeof body.customer === 'string' ? body.customer : asString(asObject(body.customer)?.id),
    status: asString(body.status) ?? 'unknown',
    price: priceOf(first.price),
    currentPeriodEnd: asNumber(first.current_period_end) ?? asNumber(body.current_period_end),
    cancelAtPeriodEnd: body.cancel_at_period_end === true || asNumber(body.cancel_at) !== null,
    metadata: stringMap(body.metadata),
    itemId: asString(first.id),
    currentPeriodStart: asNumber(first.current_period_start) ?? asNumber(body.current_period_start),
    defaultPaymentMethod:
      typeof body.default_payment_method === 'string'
        ? body.default_payment_method
        : asString(asObject(body.default_payment_method)?.id),
    endedAt: asNumber(body.ended_at),
    canceledAt: asNumber(body.canceled_at),
    scheduleId: typeof body.schedule === 'string' ? body.schedule : asString(schedule?.id),
    scheduleStatus: asString(schedule?.status),
    scheduleIsBookrail:
      schedule !== null &&
      (stringMap(schedule.metadata).bookrail_account_id !== undefined ||
        phases.some(
          (phase) => phase !== null && stringMap(phase.metadata).bookrail_account_id !== undefined,
        )),
    pendingUpdate: pendingUpdateOf(body.pending_update),
    latestInvoice: latestInvoiceOf(body.latest_invoice),
    schedulePhases: phases
      .filter((phase): phase is Record<string, unknown> => phase !== null)
      .map((phase) => {
        const prices = asArray(phase.items).map((item) => asObject(item)?.price);
        return {
          startDate: asNumber(phase.start_date),
          priceIds: prices
            .map((price) => (typeof price === 'string' ? price : asString(asObject(price)?.id)))
            .filter((price): price is string => price !== null),
          lookupKeys: prices
            .map((price) => asString(asObject(price)?.lookup_key))
            .filter((key): key is string => key !== null),
        };
      }),
  };
}

/** A tax id of a customer, with the verification Stripe ran on it (VIES, for the EU). */
export interface BillingTaxId {
  type: string | null;
  value: string | null;
  country: string | null;
  verification: string | null;
}

/**
 * An invoice line, reduced to what the email for the electronic invoice lists and to what tells
 * a line Bookrail added (its metadata, and the invoice item it came from).
 *
 * The tax is Stripe Tax's: each entry of `taxes` has the amount, the amount it was computed on
 * (`taxable_amount`) and the reason (`taxability_reason`: `standard_rated`, `reverse_charge`,
 * `not_collecting`, ...). The percentage is the amount over the taxable amount, rounded to the
 * hundredth: Stripe computed the amount from it.
 */
export interface BillingInvoiceLine {
  id: string | null;
  description: string | null;
  amount: number;
  taxAmount: number;
  /** `22`, `0`, or `null` when Stripe computed no tax entry for the line. */
  taxPercent: number | null;
  /** The reasons Stripe gave, one per tax entry. */
  taxabilityReasons: string[];
  /**
   * The Tax Rates of the tax entries (`taxes[].tax_rate_details.tax_rate`): Stripe gives their
   * ids, and the percentage is read from each Tax Rate, never divided out of the amounts.
   */
  taxRateIds: string[];
  periodStart: number | null;
  periodEnd: number | null;
  metadata: Record<string, string>;
  /** The invoice item the line came from, for a line Bookrail added. */
  invoiceItem: string | null;
}

/**
 * The percentage of a tax entry from its amount and the amount it was computed on: only a
 * fallback, for an entry whose Tax Rate could not be read. A credit line (a negative taxable
 * amount, «Unused time on ...») has the same percentage as its charge.
 */
export function taxPercentOf(amount: number, taxable: number | null): number | null {
  if (taxable === null || taxable === 0) return amount === 0 ? 0 : null;
  return Math.round((Math.abs(amount) * 10_000) / Math.abs(taxable)) / 100;
}

/** The ids of the Tax Rates of a list of tax entries (`tax_rate_details.tax_rate`). */
export function taxRateIdsOf(taxes: readonly Record<string, unknown>[]): string[] {
  const ids = taxes
    .map((tax) => {
      const rate = asObject(tax.tax_rate_details)?.tax_rate;
      return typeof rate === 'string' ? rate : asString(asObject(rate)?.id);
    })
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

export function invoiceLinesOf(value: unknown): { lines: BillingInvoiceLine[]; hasMore: boolean } {
  const list = listOf(value);
  return {
    hasMore: list.hasMore,
    lines: list.data.map((line) => {
      const taxes = asArray(line.taxes)
        .map(asObject)
        .filter((tax): tax is Record<string, unknown> => tax !== null);
      const period = asObject(line.period);
      const taxAmount = taxes.reduce((sum, tax) => sum + (asNumber(tax.amount) ?? 0), 0);
      const taxable = taxes.reduce<number | null>((sum, tax) => {
        const one = asNumber(tax.taxable_amount);
        return one === null ? sum : (sum ?? 0) + one;
      }, null);
      const details = asObject(asObject(line.parent)?.invoice_item_details);
      return {
        id: asString(line.id),
        description: asString(line.description),
        amount: asNumber(line.amount) ?? 0,
        taxAmount,
        taxPercent: taxes.length === 0 ? null : taxPercentOf(taxAmount, taxable),
        taxabilityReasons: taxes
          .map((tax) => asString(tax.taxability_reason))
          .filter((reason): reason is string => reason !== null),
        taxRateIds: taxRateIdsOf(taxes),
        periodStart: asNumber(period?.start),
        periodEnd: asNumber(period?.end),
        metadata: stringMap(line.metadata),
        invoiceItem:
          typeof details?.invoice_item === 'string'
            ? details.invoice_item
            : asString(asObject(details?.invoice_item)?.id),
      };
    }),
  };
}

/** An invoice as a list of Stripe answers it: enough to show it and to ask for it to be paid. */
export interface BillingInvoiceSummary {
  id: string;
  status: string;
  number: string | null;
  amountDue: number;
  amountRemaining: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  metadata: Record<string, string>;
}

function invoiceSummaryOf(value: Record<string, unknown>): BillingInvoiceSummary | null {
  const id = asString(value.id);
  if (id === null) return null;
  const amountDue = asNumber(value.amount_due) ?? 0;
  return {
    id,
    status: asString(value.status) ?? 'unknown',
    number: asString(value.number),
    amountDue,
    amountRemaining: asNumber(value.amount_remaining) ?? amountDue,
    currency: (asString(value.currency) ?? 'eur').toLowerCase(),
    hostedInvoiceUrl: asString(value.hosted_invoice_url),
    metadata: stringMap(value.metadata),
  };
}

/** A pending invoice item of a customer: one not on an invoice yet. */
export interface BillingPendingItem {
  id: string;
  metadata: Record<string, string>;
}

/** A configuration of the customer portal. */
export interface BillingPortalConfiguration {
  id: string;
  isDefault: boolean;
  active: boolean;
  metadata: Record<string, string>;
  /** The configuration as Stripe answered it, to compare with the one the code wants. */
  raw: Record<string, unknown>;
}

/** The subscription of a schedule, or the one it managed before it was released. */
function scheduleSubscriptionOf(body: Record<string, unknown> | null): string | null {
  for (const field of [body?.subscription, body?.released_subscription]) {
    const id = typeof field === 'string' ? asString(field) : asString(asObject(field)?.id);
    if (id !== null) return id;
  }
  return null;
}

/** The start and end of the current phase of a schedule, or of its first phase. */
function currentPhaseOf(body: Record<string, unknown> | null): {
  phaseStart: number | null;
  phaseEnd: number | null;
} {
  const current = asObject(body?.current_phase) ?? asObject(asArray(body?.phases)[0]);
  return { phaseStart: asNumber(current?.start_date), phaseEnd: asNumber(current?.end_date) };
}

export class StripeBillingClient extends StripeTransport {
  private readonly taxRatePercentages = new Map<string, number>();

  constructor(options: Omit<StripeClientOptions, 'clientId'>) {
    super(options);
  }

  private get(path: string): Promise<unknown> {
    return this.request<unknown>({ method: 'GET', url: `${this.apiBase}${path}` });
  }

  private post(
    path: string,
    form: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.request<unknown>({
      method: 'POST',
      url: `${this.apiBase}${path}`,
      form,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  /**
   * A customer for an account, with an idempotency key derived from the account: two checkouts
   * opened at the same instant create one customer, and the database keeps the first one it is
   * told about.
   */
  async createCustomer(params: {
    idempotencyKey: string;
    email: string | null;
    name: string;
    metadata: Record<string, string>;
  }): Promise<{ id: string }> {
    const body = asObject(
      await this.post(
        '/v1/customers',
        {
          ...(params.email === null ? {} : { email: params.email }),
          name: params.name,
          metadata: params.metadata,
        },
        params.idempotencyKey,
      ),
    );
    const id = asString(body?.id);
    if (id === null || !/^cus_[A-Za-z0-9]+$/.test(id)) {
      throw new Error('Stripe created a customer and did not name it.');
    }
    return { id };
  }

  /** A Checkout Session. The parameters are built, and tested, by `billing/checkout.ts`. */
  async createCheckoutSession(form: Record<string, unknown>): Promise<{ id: string; url: string }> {
    const body = asObject(await this.post('/v1/checkout/sessions', form));
    const id = asString(body?.id);
    const url = asString(body?.url);
    if (id === null || url === null) throw new Error('Stripe opened a checkout without a URL.');
    return { id, url };
  }

  /** A session of the customer portal, for a customer that exists. */
  async createPortalSession(params: {
    customer: string;
    returnUrl: string;
    configuration?: string;
  }): Promise<{ url: string }> {
    const body = asObject(
      await this.post('/v1/billing_portal/sessions', {
        customer: params.customer,
        return_url: params.returnUrl,
        ...(params.configuration === undefined ? {} : { configuration: params.configuration }),
      }),
    );
    const url = asString(body?.url);
    if (url === null) throw new Error('Stripe opened a portal session without a URL.');
    return { url };
  }

  /**
   * A subscription as Stripe holds it **now**, with its schedule and the prices of the phases.
   *
   * The receiver reads the subscription back instead of trusting the object inside the event:
   * Stripe does not promise to deliver events in order, and the state read now is newer than
   * any event about it.
   */
  async retrieveSubscription(id: string): Promise<BillingSubscription> {
    const body = await this.get(
      `/v1/subscriptions/${encodeURIComponent(id)}` +
        '?expand[]=schedule.phases.items.price&expand[]=items.data.price.product',
    );
    const subscription = subscriptionOf(body);
    if (subscription === null) throw new Error('Stripe answered a subscription with no id.');
    return subscription;
  }

  /**
   * Every subscription of a customer, in every status (`status=all`), newest first: whether the
   * customer already has one that is alive, before a second checkout is opened.
   */
  async listSubscriptions(customer: string): Promise<BillingSubscriptionSummary[]> {
    const body = await this.get(
      `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`,
    );
    return listOf(body).data.flatMap((subscription) => {
      const id = asString(subscription.id);
      return id === null ? [] : [{ id, status: asString(subscription.status) ?? 'unknown' }];
    });
  }

  /**
   * `DELETE /v1/subscriptions/{id}`: the subscription ends now, and Stripe says so with an event.
   *
   * `invoice_now` makes a final invoice of what is pending on the customer (the lines Bookrail
   * added for the next invoice); `prorate: false` credits nothing for the rest of the period.
   * Sent in the query string, where every Stripe library puts the parameters of a `DELETE`.
   */
  async cancelSubscription(
    id: string,
    options: { invoiceNow: boolean; prorate: boolean } = { invoiceNow: true, prorate: false },
  ): Promise<{ status: string }> {
    const query = `invoice_now=${String(options.invoiceNow)}&prorate=${String(options.prorate)}`;
    const body = asObject(
      await this.request<unknown>({
        method: 'DELETE',
        url: `${this.apiBase}/v1/subscriptions/${encodeURIComponent(id)}?${query}`,
      }),
    );
    return { status: asString(body?.status) ?? 'unknown' };
  }

  /**
   * Changes the price of the one item of a subscription: a move up, paid pro rata on an invoice
   * now (`proration_behavior: always_invoice`), and applied **only once that invoice is paid**
   * (`payment_behavior: pending_if_incomplete`). When the payment fails, Stripe keeps the change
   * in `pending_update` and the subscription as it was, and the latest invoice (expanded here)
   * is the one to pay. `automatic_tax` is not sent: a pending update does not take it, and the
   * subscription has it from the Checkout.
   */
  async updateSubscriptionPrice(params: {
    subscription: string;
    item: string;
    price: string;
    idempotencyKey: string;
  }): Promise<BillingSubscription> {
    const body = await this.post(
      `/v1/subscriptions/${encodeURIComponent(params.subscription)}`,
      {
        items: [{ id: params.item, price: params.price }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
      },
      params.idempotencyKey,
    );
    const subscription = subscriptionOf(body);
    if (subscription === null) throw new Error('Stripe answered a subscription with no id.');
    return subscription;
  }

  /**
   * A subscription schedule made from a subscription (`from_subscription`): one phase, the
   * current period as it is. Answers its id and the start and end of that phase.
   */
  async createScheduleFromSubscription(
    subscription: string,
    idempotencyKey: string,
  ): Promise<{ id: string; phaseStart: number | null; phaseEnd: number | null }> {
    const body = asObject(
      await this.post(
        '/v1/subscription_schedules',
        { from_subscription: subscription },
        idempotencyKey,
      ),
    );
    const id = asString(body?.id);
    if (id === null) throw new Error('Stripe created a subscription schedule and did not name it.');
    return { id, ...currentPhaseOf(body) };
  }

  /**
   * A schedule: the subscription it manages (or managed, once released: Stripe then empties
   * `subscription` and fills `released_subscription`), its status and its current phase.
   */
  async retrieveSchedule(id: string): Promise<{
    id: string;
    subscription: string | null;
    status: string | null;
    phaseStart: number | null;
    phaseEnd: number | null;
  }> {
    const body = asObject(await this.get(`/v1/subscription_schedules/${encodeURIComponent(id)}`));
    return {
      id,
      subscription: scheduleSubscriptionOf(body),
      status: asString(body?.status),
      ...currentPhaseOf(body),
    };
  }

  /** Replaces the phases of a schedule (every phase to keep is sent: Stripe unsets the rest). */
  async updateSchedule(id: string, form: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/subscription_schedules/${encodeURIComponent(id)}`, form);
  }

  /** Releases a schedule: the subscription goes on as it is, without the phases to come. */
  async releaseSchedule(id: string): Promise<void> {
    await this.post(`/v1/subscription_schedules/${encodeURIComponent(id)}/release`, {});
  }

  /** The subscription a schedule belongs to, or belonged to before it was released. */
  async retrieveScheduleSubscription(id: string): Promise<string | null> {
    return (await this.retrieveSchedule(id)).subscription;
  }

  /**
   * The SdI code or PEC typed in the Checkout Session that created a subscription, read from the
   * session itself (`GET /v1/checkout/sessions?subscription=`): the paid invoice can arrive before
   * the event of the checkout that carries it.
   */
  async checkoutCustomField(subscription: string, key: string): Promise<string | null> {
    const body = await this.get(
      `/v1/checkout/sessions?subscription=${encodeURIComponent(subscription)}&limit=10`,
    );
    for (const session of listOf(body).data) {
      const fields = asArray(session.custom_fields).map(asObject);
      const field = fields.find((candidate) => candidate?.key === key);
      const value = asString(asObject(field?.text)?.value)?.trim() ?? null;
      if (value !== null && value !== '') return value.slice(0, 200);
    }
    return null;
  }

  /**
   * The percentage of a Tax Rate, as it was applied. For a rate Stripe Tax made,
   * `effective_percentage` is the rate actually used (0 for a reverse charge), while `percentage`
   * «includes the statutory tax rate of non-taxable jurisdictions» (the German 19 % of a reverse
   * charge to Germany): the first when there is one, the second otherwise. Tax Rates do not
   * change: each id is read once per process.
   */
  async taxRatePercentage(id: string): Promise<number | null> {
    const known = this.taxRatePercentages.get(id);
    if (known !== undefined) return known;
    const body = asObject(await this.get(`/v1/tax_rates/${encodeURIComponent(id)}`));
    const percentage = asNumber(body?.effective_percentage) ?? asNumber(body?.percentage);
    if (percentage !== null) this.taxRatePercentages.set(id, percentage);
    return percentage;
  }

  /** The open invoices of a customer: what is still to pay. */
  async listOpenInvoices(customer: string): Promise<BillingInvoiceSummary[]> {
    const body = await this.get(
      `/v1/invoices?customer=${encodeURIComponent(customer)}&status=open&limit=100`,
    );
    return listOf(body)
      .data.map(invoiceSummaryOf)
      .filter((invoice): invoice is BillingInvoiceSummary => invoice !== null);
  }

  /** The latest invoices of a customer, in every status, with their metadata. */
  async listInvoices(customer: string): Promise<BillingInvoiceSummary[]> {
    const body = await this.get(`/v1/invoices?customer=${encodeURIComponent(customer)}&limit=100`);
    return listOf(body)
      .data.map(invoiceSummaryOf)
      .filter((invoice): invoice is BillingInvoiceSummary => invoice !== null);
  }

  /** The pending invoice items of a customer, with their metadata. */
  async listPendingInvoiceItems(customer: string): Promise<BillingPendingItem[]> {
    const body = await this.get(
      `/v1/invoiceitems?customer=${encodeURIComponent(customer)}&pending=true&limit=100`,
    );
    return listOf(body).data.flatMap((item) => {
      const id = asString(item.id);
      return id === null ? [] : [{ id, metadata: stringMap(item.metadata) }];
    });
  }

  /** A Checkout Session: `open`, `complete` or `expired`. */
  async retrieveCheckoutSession(
    id: string,
  ): Promise<{ id: string; status: string; subscription: string | null }> {
    const body = asObject(await this.get(`/v1/checkout/sessions/${encodeURIComponent(id)}`));
    const subscription = body?.subscription;
    return {
      id,
      status: asString(body?.status) ?? 'unknown',
      subscription:
        typeof subscription === 'string' ? subscription : asString(asObject(subscription)?.id),
    };
  }

  /** Expires an `open` Checkout Session: nobody can pay it any more. */
  async expireCheckoutSession(id: string): Promise<{ status: string }> {
    const body = asObject(
      await this.post(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}),
    );
    return { status: asString(body?.status) ?? 'unknown' };
  }

  /** An invoice: its status (`draft`, `open`, `paid`, `void`, `uncollectible`). */
  async retrieveInvoice(id: string): Promise<{ id: string; status: string }> {
    const body = asObject(await this.get(`/v1/invoices/${encodeURIComponent(id)}`));
    return { id, status: asString(body?.status) ?? 'unknown' };
  }

  /**
   * An invoice of its own for a customer, made of the pending invoice items
   * (`pending_invoice_items_behavior: include`), advanced and charged by Stripe
   * (`auto_advance`). The last overage of a subscription that has ended goes on one.
   */
  async createInvoice(
    form: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ id: string; status: string }> {
    const body = asObject(await this.post('/v1/invoices', form, idempotencyKey));
    const id = asString(body?.id);
    if (id === null) throw new Error('Stripe created an invoice and did not name it.');
    return { id, status: asString(body?.status) ?? 'unknown' };
  }

  /**
   * An invoice item: on a draft invoice when `invoice` is given, otherwise pending for the next
   * invoice of the customer. The idempotency key is what stops a retry from adding it twice.
   */
  async createInvoiceItem(
    form: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ id: string; invoice: string | null }> {
    const body = asObject(await this.post('/v1/invoiceitems', form, idempotencyKey));
    const id = asString(body?.id);
    if (id === null) throw new Error('Stripe created an invoice item and did not name it.');
    const invoice = body?.invoice;
    return {
      id,
      invoice: typeof invoice === 'string' ? invoice : asString(asObject(invoice)?.id),
    };
  }

  /** Every line of an invoice, for an invoice whose event carried only the first ones. */
  async listInvoiceLines(invoice: string): Promise<BillingInvoiceLine[]> {
    const lines: BillingInvoiceLine[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = after === null ? '' : `&starting_after=${encodeURIComponent(after)}`;
      const body = await this.get(
        `/v1/invoices/${encodeURIComponent(invoice)}/lines?limit=100${query}`,
      );
      const list = listOf(body);
      lines.push(...invoiceLinesOf(body).lines);
      if (!list.hasMore) break;
      after = asString(list.data.at(-1)?.id);
      if (after === null) break;
    }
    return lines;
  }

  /** The tax ids of a customer, with Stripe's verification of each. */
  async listCustomerTaxIds(customer: string): Promise<BillingTaxId[]> {
    const body = await this.get(`/v1/customers/${encodeURIComponent(customer)}/tax_ids?limit=10`);
    return listOf(body).data.map((taxId) => ({
      type: asString(taxId.type),
      value: asString(taxId.value),
      country: asString(taxId.country),
      verification: asString(asObject(taxId.verification)?.status),
    }));
  }

  /** The prices with these lookup keys, active or not. */
  async listPrices(lookupKeys: readonly string[]): Promise<BillingPrice[]> {
    const query = lookupKeys.map((key) => `lookup_keys[]=${encodeURIComponent(key)}`).join('&');
    const body = await this.get(`/v1/prices?limit=100&${query}`);
    return listOf(body)
      .data.map(priceOf)
      .filter((price): price is BillingPrice => price !== null);
  }

  /** Every tax rate of the account, active and archived, a hundred at a time. */
  async listTaxRates(): Promise<BillingTaxRate[]> {
    const rates: BillingTaxRate[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = after === null ? '' : `&starting_after=${encodeURIComponent(after)}`;
      const list = listOf(await this.get(`/v1/tax_rates?limit=100${query}`));
      rates.push(
        ...list.data.map(taxRateOf).filter((rate): rate is BillingTaxRate => rate !== null),
      );
      if (!list.hasMore) break;
      after = asString(list.data.at(-1)?.id);
      if (after === null) break;
    }
    return rates;
  }

  // --- The catalogue, for the setup script only ---------------------------------------------

  /** A product by the identifier Bookrail gives it, or `null` when it does not exist. */
  async retrieveProduct(
    id: string,
  ): Promise<{ id: string; name: string | null; active: boolean; taxCode: string | null } | null> {
    try {
      const body = asObject(await this.get(`/v1/products/${encodeURIComponent(id)}`));
      const taxCode = body?.tax_code;
      return {
        id,
        name: asString(body?.name),
        active: body?.active !== false,
        taxCode: typeof taxCode === 'string' ? taxCode : asString(asObject(taxCode)?.id),
      };
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) return null;
      throw error;
    }
  }

  async createProduct(form: Record<string, unknown>): Promise<{ id: string }> {
    const body = asObject(await this.post('/v1/products', form));
    return { id: asString(body?.id) ?? String(form.id) };
  }

  async updateProduct(id: string, form: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/products/${encodeURIComponent(id)}`, form);
  }

  async createPrice(form: Record<string, unknown>): Promise<BillingPrice> {
    const price = priceOf(await this.post('/v1/prices', form));
    if (price === null) throw new Error('Stripe created a price and did not name it.');
    return price;
  }

  async updatePrice(id: string, form: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/prices/${encodeURIComponent(id)}`, form);
  }

  async createTaxRate(form: Record<string, unknown>): Promise<BillingTaxRate> {
    const rate = taxRateOf(asObject(await this.post('/v1/tax_rates', form)) ?? {});
    if (rate === null) throw new Error('Stripe created a tax rate and did not name it.');
    return rate;
  }

  async updateTaxRate(id: string, form: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/tax_rates/${encodeURIComponent(id)}`, form);
  }

  async listPortalConfigurations(): Promise<BillingPortalConfiguration[]> {
    const body = await this.get('/v1/billing_portal/configurations?limit=100');
    return listOf(body).data.flatMap((configuration) => {
      const id = asString(configuration.id);
      return id === null
        ? []
        : [
            {
              id,
              isDefault: configuration.is_default === true,
              active: configuration.active !== false,
              metadata: stringMap(configuration.metadata),
              raw: configuration,
            },
          ];
    });
  }

  async createPortalConfiguration(form: Record<string, unknown>): Promise<{ id: string }> {
    const body = asObject(await this.post('/v1/billing_portal/configurations', form));
    const id = asString(body?.id);
    if (id === null) throw new Error('Stripe created a portal configuration and did not name it.');
    return { id };
  }

  async updatePortalConfiguration(id: string, form: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/billing_portal/configurations/${encodeURIComponent(id)}`, form);
  }
}
