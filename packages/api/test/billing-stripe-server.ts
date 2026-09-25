/**
 * A fake of Stripe Billing on 127.0.0.1, in this process, over a real socket.
 *
 * The same principle as `stripe-server.ts`, for the other use of the same Stripe account: no
 * mocked `fetch`, so what is proved is that the client speaks the wire protocol (the bracket
 * encoding, `Stripe-Version`, `Idempotency-Key`, and **no** `Stripe-Account` on any request of
 * Billing). It keeps the objects it is asked to create, so that a second run of the catalogue
 * setup finds what the first one made, and so that an invoice item added twice with the same
 * `Idempotency-Key` is one item.
 *
 * The subscriptions and the invoices are the test's to set: Stripe makes them from a checkout and
 * from the calendar, and the test plays both.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface BillingRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  form: Record<string, unknown>;
}

type StripeObject = Record<string, unknown> & { id: string };

export interface FakeBillingStripe {
  url: string;
  requests: BillingRequest[];
  customers: Map<string, StripeObject>;
  products: Map<string, StripeObject>;
  prices: Map<string, StripeObject>;
  taxRates: Map<string, StripeObject>;
  portalConfigurations: Map<string, StripeObject>;
  checkoutSessions: StripeObject[];
  subscriptions: Map<string, StripeObject>;
  invoices: Map<string, StripeObject & { status: string }>;
  invoiceItems: Map<string, StripeObject>;
  /** The tax ids of each customer, with their verification. */
  taxIds: Map<string, { type: string; value: string; country: string; verification: string }[]>;
  /** The requests of one method and path. */
  of(method: string, path: string): BillingRequest[];
  /** The next request of this method and path is answered with this error, once. */
  failNext(method: string, path: string, status: number, error: Record<string, unknown>): void;
  /** Plays a customer paying a checkout session: it becomes `complete`. */
  completeSession(id: string, subscription?: string): void;
  /** Stripe deleting a draft invoice (an invoice can be deleted while it is a draft). */
  deleteInvoice(id: string): void;
  /** An open invoice of a customer, as a renewal that was never paid leaves it. */
  openInvoice(customer: string, options: { amount: number; number?: string }): string;
  /** The subscription schedules made through the API, by id. */
  schedules: Map<string, StripeObject>;
  /**
   * The card of this subscription refuses the next payment: a move up with
   * `pending_if_incomplete` stays pending, with an open invoice to pay.
   */
  declineNextPayment(subscription: string): void;
  /** A subscription as Stripe would hold it, on a price of the catalogue by lookup key. */
  setSubscription(options: {
    id: string;
    customer: string;
    lookupKey: string;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd?: boolean;
    metadata?: Record<string, string>;
    scheduleNextLookupKey?: string | null;
    /** The start of the current period; a month before its end when not given. */
    currentPeriodStart?: number;
    endedAt?: number | null;
    canceledAt?: number | null;
    defaultPaymentMethod?: string | null;
    /** `cancel_at`, as the portal writes it when it cancels (with `cancel_at_period_end: false`). */
    cancelAt?: number | null;
  }): StripeObject;
  /** A draft invoice of a customer, which invoice items can be added to until it is finalized. */
  draftInvoice(customer: string): string;
  finalize(invoice: string): void;
  close(): Promise<void>;
}

/** `a[b][0][c]=x` → `{a: {b: [{c: 'x'}]}}`. The inverse of `encodeStripeForm`. */
export function parseStripeForm(body: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> | unknown[] = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[index + 1] ?? '');
      const container = node as Record<string, unknown>;
      if (last) {
        container[part] = value;
        return;
      }
      if (container[part] === undefined) container[part] = nextIsIndex ? [] : {};
      node = container[part] as Record<string, unknown>;
    });
  }
  return root;
}

function list(data: unknown[], hasMore = false): Record<string, unknown> {
  return { object: 'list', data, has_more: hasMore };
}

function invalid(message: string): { status: number; body: unknown } {
  return { status: 400, body: { error: { type: 'invalid_request_error', message } } };
}

function missing(what: string, id: string): { status: number; body: unknown } {
  return {
    status: 404,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No such ${what}: '${id}'`,
      },
    },
  };
}

export async function startFakeBillingStripe(): Promise<FakeBillingStripe> {
  const requests: BillingRequest[] = [];
  const customers = new Map<string, StripeObject>();
  const products = new Map<string, StripeObject>();
  const prices = new Map<string, StripeObject>();
  const taxRates = new Map<string, StripeObject>();
  const portalConfigurations = new Map<string, StripeObject>();
  const checkoutSessions: StripeObject[] = [];
  const subscriptions = new Map<string, StripeObject>();
  const invoices = new Map<string, StripeObject & { status: string }>();
  const invoiceItems = new Map<string, StripeObject>();
  const schedules = new Map<string, StripeObject>();
  const declining = new Set<string>();
  const taxIds = new Map<
    string,
    { type: string; value: string; country: string; verification: string }[]
  >();
  /**
   * Stripe's own idempotency: the same key answers the same object, and the same key with other
   * parameters is refused with an `idempotency_error`.
   */
  const byKey = new Map<string, { status: number; body: unknown; form: string }>();
  const failures = new Map<string, { status: number; error: Record<string, unknown> }>();
  let counter = 0;
  // Unique across the fakes of one run, which share one database: a customer id is UNIQUE there.
  const instance = randomBytes(4).toString('hex');
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}_Fake${instance}${String(counter).padStart(6, '0')}`;
  };

  const priceByLookupKey = (key: string): StripeObject | undefined =>
    [...prices.values()].find((price) => price.lookup_key === key);

  const PORTAL_CUSTOMER_UPDATES = ['address', 'email', 'name', 'phone', 'shipping', 'tax_id'];

  /**
   * What Stripe refuses in a portal configuration. The one the sandbox answered on 24 September
   * 2026, «For each product, its price must have unique billing intervals» (one product with a
   * monthly Pro and a monthly Scale), and what the reference of the parameters says: the
   * `allowed_updates` of a customer, `always_invoice` on a cancellation, and a headline longer
   * than sixty characters (answered on 25 September 2026).
   */
  function portalRefusal(form: Record<string, unknown>): { status: number; body: unknown } | null {
    const headline = (form.business_profile as { headline?: unknown } | undefined)?.headline;
    if (typeof headline === 'string' && headline.length > 60) {
      // Answered by the sandbox on 25 September 2026.
      return invalid(`Invalid string: ${headline}; must be at most 60 characters`);
    }
    const features = (form.features ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const allowed = (features.customer_update?.allowed_updates ?? []) as string[];
    const unknown = allowed.find((value) => !PORTAL_CUSTOMER_UPDATES.includes(value));
    if (unknown !== undefined) {
      return invalid(`Invalid features[customer_update][allowed_updates]: ${unknown}`);
    }
    if (features.subscription_cancel?.proration_behavior === 'always_invoice') {
      return invalid('features[subscription_cancel][proration_behavior] cannot be always_invoice.');
    }
    const products = (features.subscription_update?.products ?? []) as Record<string, unknown>[];
    for (const entry of products) {
      const intervals = ((entry.prices ?? []) as string[]).map((id) => {
        const price = prices.get(id);
        if (price === undefined) return `missing:${id}`;
        return (price.recurring as { interval?: string } | null)?.interval ?? 'one_time';
      });
      if (new Set(intervals).size !== intervals.length) {
        return invalid('For each product, its price must have unique billing intervals.');
      }
    }
    return null;
  }

  /**
   * What Stripe refuses in the phases of a subscription schedule, from the reference of the
   * pinned version: the first phase says when it starts, a phase ends by `end_date` or by
   * `duration` and never both, and `iterations`, which the reference no longer lists, is unknown.
   */
  function phasesRefusal(
    phases: Record<string, unknown>[],
  ): { status: number; body: unknown } | null {
    for (const [index, phase] of phases.entries()) {
      if (phase.iterations !== undefined) {
        return invalid(`Received unknown parameter: phases[${String(index)}][iterations]`);
      }
      if (phase.end_date !== undefined && phase.duration !== undefined) {
        return invalid(`phases[${String(index)}]: end_date and duration cannot both be set.`);
      }
      if (((phase.items ?? []) as unknown[]).length === 0) {
        return invalid(`Missing required param: phases[${String(index)}][items].`);
      }
    }
    if (phases.length > 0 && phases[0]?.start_date === undefined) {
      return invalid('phases[0][start_date] must be set on the first phase.');
    }
    return null;
  }

  function handle(request: BillingRequest): { status: number; body: unknown } {
    const { method, path, form, query } = request;
    const key = request.headers['idempotency-key'];
    const formJson = JSON.stringify(form);
    const remembered = key === undefined ? undefined : byKey.get(`${method} ${path} ${key}`);
    if (remembered !== undefined) {
      if (remembered.form !== formJson) {
        return {
          status: 400,
          body: {
            error: {
              type: 'idempotency_error',
              message:
                'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            },
          },
        };
      }
      return { status: remembered.status, body: remembered.body };
    }
    const failure = failures.get(`${method} ${path}`);
    if (failure !== undefined) {
      failures.delete(`${method} ${path}`);
      const body = { error: failure.error };
      // Stripe keeps under the key the answer of a request that began executing, a `500`
      // included: a retry with the same key gets the same `500` back for 24 hours. A `400` of
      // validation is not kept.
      if (key !== undefined && failure.status >= 500) {
        byKey.set(`${method} ${path} ${key}`, { status: failure.status, body, form: formJson });
      }
      return { status: failure.status, body };
    }
    const remember = (body: unknown): { status: number; body: unknown } => {
      if (key !== undefined)
        byKey.set(`${method} ${path} ${key}`, { status: 200, body, form: formJson });
      return { status: 200, body };
    };

    // --- customers ---------------------------------------------------------------------
    if (method === 'POST' && path === '/v1/customers') {
      const customer = { id: next('cus'), object: 'customer', ...form };
      customers.set(customer.id, customer);
      return remember(customer);
    }
    let match = /^\/v1\/customers\/([^/]+)\/tax_ids$/.exec(path);
    if (method === 'GET' && match !== null) {
      const ids = taxIds.get(match[1] ?? '') ?? [];
      return {
        status: 200,
        body: list(
          ids.map((taxId, index) => ({
            id: `txi_Fake${String(index)}`,
            object: 'tax_id',
            type: taxId.type,
            value: taxId.value,
            country: taxId.country,
            verification: { status: taxId.verification },
          })),
        ),
      };
    }

    // --- checkout and portal ---------------------------------------------------------------
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      // What the documentation of the parameters says, checked the way Stripe checks it.
      const data = (form.subscription_data ?? {}) as Record<string, unknown>;
      // What the sandbox answered on 24 September 2026 with the pinned version.
      const items = (form.line_items ?? []) as Record<string, unknown>[];
      if (items.some((item) => item.dynamic_tax_rates !== undefined)) {
        return invalid('Received unknown parameter: line_items[0][dynamic_tax_rates]');
      }
      const automaticTax = (form.automatic_tax ?? {}) as Record<string, unknown>;
      const taxIds = (form.tax_id_collection ?? {}) as Record<string, unknown>;
      const update = (form.customer_update ?? {}) as Record<string, unknown>;
      if (form.customer_update !== undefined && form.customer === undefined) {
        // «Can only be provided when `customer` is provided.»
        return invalid('customer_update can only be used with customer.');
      }
      if (automaticTax.enabled === 'true') {
        // Stripe Tax computes the tax, and a fixed rate on a line would say otherwise.
        if (items.some((item) => item.tax_rates !== undefined)) {
          return invalid(
            'line_items[0][tax_rates] cannot be used with automatic_tax[enabled]=true.',
          );
        }
        // An existing customer is taxed from its saved address unless Checkout may write the
        // one typed there (`customer_update[address]=auto`); the customers Bookrail creates have
        // none, and Stripe refuses a session it could not tax.
        const saved = customers.get(String(form.customer ?? ''));
        if (
          form.customer !== undefined &&
          (saved === undefined || saved.address === undefined) &&
          update.address !== 'auto' &&
          update.shipping !== 'auto'
        ) {
          return invalid(
            'Automatic tax calculation in Checkout requires a valid address on the Customer. Set customer_update[address] to auto.',
          );
        }
      }
      if (taxIds.enabled === 'true' && form.customer !== undefined && update.name !== 'auto') {
        // The legal name typed with the tax id is saved on the customer only with this.
        return invalid(
          'tax_id_collection with an existing customer requires customer_update[name] to be auto.',
        );
      }
      if (
        data.billing_cycle_anchor !== undefined &&
        data.billing_cycle_anchor_config !== undefined
      ) {
        return invalid(
          'billing_cycle_anchor and billing_cycle_anchor_config are mutually exclusive.',
        );
      }
      const now = Math.floor(Date.now() / 1000);
      if (data.billing_cycle_anchor !== undefined) {
        const anchor = Number(data.billing_cycle_anchor);
        if (!(anchor > now) || anchor > now + 31 * 86_400) {
          return invalid(
            'billing_cycle_anchor must be a future timestamp within the first billing period.',
          );
        }
      }
      if (form.expires_at !== undefined) {
        const expires = Number(form.expires_at);
        if (expires < now + 30 * 60 - 5 || expires > now + 24 * 3600 + 5) {
          return invalid('expires_at must be between 30 minutes and 24 hours from now.');
        }
      }
      const id = next('cs_test');
      const session = {
        id,
        object: 'checkout.session',
        status: 'open',
        url: `https://checkout.stripe.test/c/pay/${id}`,
        form,
      };
      checkoutSessions.push(session);
      return remember(session);
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const subscription = query.get('subscription');
      return {
        status: 200,
        body: list(
          checkoutSessions.filter(
            (session) => subscription === null || session.subscription === subscription,
          ),
        ),
      };
    }
    match = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    if (match !== null) {
      const session = checkoutSessions.find((candidate) => candidate.id === match?.[1]);
      if (session === undefined) return missing('checkout.session', match[1] ?? '');
      if (method === 'GET') return { status: 200, body: session };
      if (method === 'POST' && match[2] === '/expire') {
        if (session.status !== 'open') {
          return invalid(`Only Checkout Sessions with a status in ["open"] can be expired.`);
        }
        session.status = 'expired';
        return remember(session);
      }
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      const id = next('bps');
      return remember({
        id,
        object: 'billing_portal.session',
        url: `https://billing.stripe.test/p/session/${id}`,
        form,
      });
    }
    if (path === '/v1/billing_portal/configurations' && method === 'GET') {
      return { status: 200, body: list([...portalConfigurations.values()]) };
    }
    if (path === '/v1/billing_portal/configurations' && method === 'POST') {
      const refused = portalRefusal(form);
      if (refused !== null) return refused;
      const configuration = {
        id: next('bpc'),
        object: 'billing_portal.configuration',
        active: true,
        is_default: false,
        ...form,
      };
      portalConfigurations.set(configuration.id, configuration);
      return remember(configuration);
    }
    match = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(path);
    if (method === 'POST' && match !== null) {
      const existing = portalConfigurations.get(match[1] ?? '');
      if (existing === undefined) return missing('configuration', match[1] ?? '');
      const refused = portalRefusal(form);
      if (refused !== null) return refused;
      Object.assign(existing, form, { active: form.active !== 'false' });
      return remember(existing);
    }

    // --- products, prices, tax rates -----------------------------------------------------------
    match = /^\/v1\/products\/([^/]+)$/.exec(path);
    if (match !== null) {
      const product = products.get(match[1] ?? '');
      if (product === undefined) return missing('product', match[1] ?? '');
      if (method === 'POST') Object.assign(product, form, { active: form.active !== 'false' });
      return { status: 200, body: product };
    }
    if (
      method === 'POST' &&
      (path === '/v1/products' || path.startsWith('/v1/products/')) &&
      form.tax_code !== undefined &&
      !/^txcd_\d{8}$/.test(String(form.tax_code))
    ) {
      return invalid(`No such tax code: '${String(form.tax_code)}'`);
    }
    if (method === 'POST' && path === '/v1/products') {
      const id = String(form.id ?? next('prod'));
      if (products.has(id)) {
        return {
          status: 400,
          body: {
            error: {
              type: 'invalid_request_error',
              code: 'resource_already_exists',
              message: 'Product already exists.',
            },
          },
        };
      }
      const product = { object: 'product', active: true, ...form, id };
      products.set(id, product);
      return remember(product);
    }
    if (method === 'GET' && path === '/v1/prices') {
      const keys = query.getAll('lookup_keys[]');
      return {
        status: 200,
        body: list([...prices.values()].filter((price) => keys.includes(String(price.lookup_key)))),
      };
    }
    if (method === 'POST' && path === '/v1/prices') {
      const lookupKey = typeof form.lookup_key === 'string' ? form.lookup_key : null;
      const holder = lookupKey === null ? undefined : priceByLookupKey(lookupKey);
      if (holder !== undefined) {
        if (form.transfer_lookup_key !== 'true') {
          return {
            status: 400,
            body: {
              error: {
                type: 'invalid_request_error',
                message: 'A price with this lookup_key already exists.',
              },
            },
          };
        }
        holder.lookup_key = null;
      }
      const recurring = form.recurring as Record<string, string> | undefined;
      const price = {
        id: next('price'),
        object: 'price',
        active: true,
        product: form.product,
        unit_amount: Number(form.unit_amount),
        currency: form.currency,
        recurring: recurring === undefined ? null : { interval: recurring.interval },
        tax_behavior: form.tax_behavior,
        nickname: form.nickname,
        lookup_key: lookupKey,
        metadata: form.metadata ?? {},
      };
      prices.set(price.id, price);
      return remember(price);
    }
    match = /^\/v1\/prices\/([^/]+)$/.exec(path);
    if (method === 'POST' && match !== null) {
      const price = prices.get(match[1] ?? '');
      if (price === undefined) return missing('price', match[1] ?? '');
      if (form.active !== undefined) price.active = form.active !== 'false';
      return remember(price);
    }
    if (method === 'GET' && path === '/v1/tax_rates') {
      const all = [...taxRates.values()];
      const after = query.get('starting_after');
      const start = after === null ? 0 : all.findIndex((rate) => rate.id === after) + 1;
      const limit = Number(query.get('limit') ?? '10');
      const page = all.slice(start, start + limit);
      return { status: 200, body: list(page, start + limit < all.length) };
    }
    if (method === 'POST' && path === '/v1/tax_rates') {
      const rate = {
        id: next('txr'),
        object: 'tax_rate',
        active: true,
        display_name: form.display_name,
        description: form.description ?? null,
        jurisdiction: form.jurisdiction ?? null,
        country: form.country ?? null,
        percentage: Number(form.percentage),
        inclusive: form.inclusive === 'true',
        metadata: form.metadata ?? {},
      };
      taxRates.set(rate.id, rate);
      return remember(rate);
    }
    match = /^\/v1\/tax_rates\/([^/]+)$/.exec(path);
    if (method === 'GET' && match !== null) {
      const rate = taxRates.get(match[1] ?? '');
      return rate === undefined ? missing('tax_rate', match[1] ?? '') : { status: 200, body: rate };
    }
    if (method === 'POST' && match !== null) {
      const rate = taxRates.get(match[1] ?? '');
      if (rate === undefined) return missing('tax_rate', match[1] ?? '');
      for (const field of ['display_name', 'description', 'jurisdiction'] as const) {
        if (form[field] !== undefined) rate[field] = form[field];
      }
      if (form.active !== undefined) rate.active = form.active !== 'false';
      return remember(rate);
    }

    // --- subscriptions -------------------------------------------------------------------------
    if (method === 'GET' && path === '/v1/subscriptions') {
      const customer = query.get('customer');
      const status = query.get('status');
      return {
        status: 200,
        body: list(
          [...subscriptions.values()].filter(
            (subscription) =>
              subscription.customer === customer &&
              (status === 'all' || subscription.status !== 'canceled'),
          ),
        ),
      };
    }
    match = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (match !== null) {
      const subscription = subscriptions.get(match[1] ?? '');
      if (subscription === undefined) return missing('subscription', match[1] ?? '');
      if (method === 'POST') {
        // A change of the price of the item, as the dashboard makes a move up.
        const pending = form.payment_behavior === 'pending_if_incomplete';
        if (pending && form.automatic_tax !== undefined) {
          // «Pending updates only support attributes that control proration behavior or
          // generate new invoices»: automatic_tax is not among them.
          return invalid(
            'automatic_tax is not supported with payment_behavior=pending_if_incomplete.',
          );
        }
        const changes = (form.items ?? []) as Record<string, string>[];
        const item = (subscription.items as { data: Record<string, unknown>[] }).data[0];
        const invoiceId = next('in');
        const declined = declining.has(subscription.id);
        declining.delete(subscription.id);
        const invoice = {
          id: invoiceId,
          object: 'invoice',
          customer: subscription.customer,
          subscription: subscription.id,
          billing_reason: 'subscription_update',
          status: declined ? 'open' : 'paid',
          amount_due: 5041,
          amount_remaining: declined ? 5041 : 0,
          currency: 'eur',
          hosted_invoice_url: `https://invoice.stripe.test/i/${invoiceId}`,
        };
        invoices.set(invoiceId, invoice);
        for (const change of changes) {
          const price = prices.get(change.price ?? '');
          if (price === undefined) return missing('price', change.price ?? '');
          if (declined && pending) continue;
          if (item !== undefined && item.id === change.id) item.price = price;
        }
        subscription.pending_update =
          declined && pending
            ? {
                expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
                subscription_items: changes.map((change) => ({
                  id: change.id,
                  price: change.price,
                })),
              }
            : null;
        if (declined && !pending) subscription.status = 'past_due';
        const expand = ([] as unknown[]).concat(form.expand ?? []);
        return remember({
          ...subscription,
          latest_invoice: expand.includes('latest_invoice') ? invoice : invoiceId,
        });
      }
      if (method === 'DELETE') {
        if (subscription.status === 'canceled') return missing('subscription', subscription.id);
        subscription.status = 'canceled';
        subscription.ended_at = Math.floor(Date.now() / 1000);
        return remember(subscription);
      }
      return { status: 200, body: subscription };
    }

    // --- subscription schedules -------------------------------------------------------------------
    if (method === 'POST' && path === '/v1/subscription_schedules') {
      const subscription = subscriptions.get(String(form.from_subscription));
      if (subscription === undefined)
        return missing('subscription', String(form.from_subscription));
      if (subscription.schedule !== null && subscription.schedule !== undefined) {
        return invalid(
          `You cannot migrate a subscription that is already attached to a schedule: ${subscription.id}.`,
        );
      }
      const item = (subscription.items as { data: Record<string, unknown>[] }).data[0] ?? {};
      const schedule: StripeObject = {
        id: next('sub_sched'),
        object: 'subscription_schedule',
        subscription: subscription.id,
        released_subscription: null,
        status: 'active',
        metadata: {},
        current_phase: {
          start_date: item.current_period_start,
          end_date: item.current_period_end,
        },
        phases: [
          {
            start_date: item.current_period_start,
            end_date: item.current_period_end,
            items: [{ price: item.price }],
          },
        ],
      };
      schedules.set(schedule.id, schedule);
      subscription.schedule = schedule;
      return remember(schedule);
    }
    match = /^\/v1\/subscription_schedules\/([^/]+)(\/release)?$/.exec(path);
    if (match !== null) {
      const schedule = schedules.get(match[1] ?? '');
      if (schedule === undefined) return missing('subscription_schedule', match[1] ?? '');
      const subscription = subscriptions.get(String(schedule.subscription));
      if (method === 'GET') return { status: 200, body: schedule };
      if (method === 'POST' && match[2] === '/release') {
        if (schedule.status !== 'active' && schedule.status !== 'not_started') {
          return invalid(
            `You cannot release a subscription schedule that is ${String(schedule.status)}.`,
          );
        }
        // A released schedule no longer names its subscription: `released_subscription` does.
        schedule.status = 'released';
        schedule.released_subscription = schedule.subscription;
        schedule.subscription = null;
        schedule.current_phase = null;
        if (subscription !== undefined) subscription.schedule = null;
        return remember(schedule);
      }
      if (method === 'POST') {
        const phases = (form.phases ?? []) as Record<string, unknown>[];
        const refused = phasesRefusal(phases);
        if (refused !== null) return refused;
        const current = schedule.current_phase as { start_date?: unknown } | null | undefined;
        if (
          phases.length > 0 &&
          current?.start_date !== undefined &&
          Number(phases[0]?.start_date) !== Number(current.start_date)
        ) {
          // The phase under way cannot move its start.
          return invalid('The start_date of the current phase cannot be changed.');
        }
        if (form.metadata !== undefined) schedule.metadata = form.metadata;
        let start: number | null = null;
        schedule.phases = phases.map((phase) => {
          const items = (phase.items ?? []) as Record<string, string>[];
          const startDate = phase.start_date === undefined ? start : Number(phase.start_date);
          const endDate = phase.end_date === undefined ? null : Number(phase.end_date);
          start = endDate;
          return {
            start_date: startDate,
            end_date: endDate,
            items: items.map((entry) => ({ price: prices.get(entry.price ?? '') ?? entry.price })),
            automatic_tax: phase.automatic_tax,
            metadata: phase.metadata ?? {},
          };
        });
        schedule.end_behavior = form.end_behavior;
        if (subscription !== undefined) subscription.schedule = schedule;
        return remember(schedule);
      }
    }

    // --- invoices ------------------------------------------------------------------------------
    if (method === 'GET' && path === '/v1/invoices') {
      const customer = query.get('customer');
      const status = query.get('status');
      return {
        status: 200,
        body: list(
          [...invoices.values()].filter(
            (invoice) =>
              invoice.customer === customer && (status === null || invoice.status === status),
          ),
        ),
      };
    }
    match = /^\/v1\/invoices\/([^/]+)\/lines$/.exec(path);
    if (method === 'GET' && match !== null) {
      const invoiceId = match[1] ?? '';
      if (!invoices.has(invoiceId)) return missing('invoice', invoiceId);
      return {
        status: 200,
        body: list(
          [...invoiceItems.values()]
            .filter((item) => item.invoice === invoiceId)
            .map((item) => ({
              id: `il_${item.id}`,
              object: 'line_item',
              description: item.description ?? null,
              amount: 0,
              metadata: item.metadata ?? {},
              parent: {
                type: 'invoice_item_details',
                invoice_item_details: { invoice_item: item.id },
              },
              taxes: [],
            })),
        ),
      };
    }
    if (method === 'GET' && path === '/v1/invoiceitems') {
      const customer = query.get('customer');
      const pending = query.get('pending') === 'true';
      return {
        status: 200,
        body: list(
          [...invoiceItems.values()].filter(
            (item) => item.customer === customer && (!pending || item.invoice === null),
          ),
        ),
      };
    }
    match = /^\/v1\/invoices\/([^/]+)$/.exec(path);
    if (method === 'GET' && match !== null) {
      const invoice = invoices.get(match[1] ?? '');
      if (invoice === undefined) return missing('invoice', match[1] ?? '');
      return { status: 200, body: invoice };
    }
    if (method === 'POST' && path === '/v1/invoices') {
      const id = next('in');
      const customer = String(form.customer);
      const invoice = {
        id,
        object: 'invoice',
        customer,
        status: form.auto_advance === 'true' ? 'open' : 'draft',
        ...form,
      };
      invoices.set(id, invoice);
      // `pending_invoice_items_behavior: include` takes every pending item of the customer.
      if (form.pending_invoice_items_behavior === 'include') {
        for (const item of invoiceItems.values()) {
          if (item.customer === customer && item.invoice === null) item.invoice = id;
        }
      }
      return remember(invoice);
    }
    if (method === 'POST' && path === '/v1/invoiceitems') {
      const priceData = form.price_data as Record<string, unknown> | undefined;
      if (
        priceData !== undefined &&
        (priceData.product === undefined || priceData.currency === undefined)
      ) {
        return invalid('Missing required param: price_data[product] or price_data[currency].');
      }
      const invoiceId = typeof form.invoice === 'string' ? form.invoice : null;
      if (invoiceId !== null) {
        const invoice = invoices.get(invoiceId);
        if (invoice === undefined) return missing('invoice', invoiceId);
        if (invoice.status !== 'draft') {
          return {
            status: 400,
            body: {
              error: {
                type: 'invalid_request_error',
                code: 'invoice_not_editable',
                message: `You can only add invoice items to draft invoices. ${invoiceId} is ${invoice.status}.`,
              },
            },
          };
        }
      }
      const item = { id: next('ii'), object: 'invoiceitem', invoice: invoiceId, ...form };
      invoiceItems.set(item.id, item);
      return remember(item);
    }

    return {
      status: 404,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'url_invalid',
          message: `No such path: ${method} ${path}`,
        },
      },
    };
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : (value ?? '');
      }
      const url = new URL(request.url ?? '/', 'http://fake');
      const recorded: BillingRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers,
        form: parseStripeForm(body),
      };
      requests.push(recorded);
      const answer = handle(recorded);
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        'request-id': 'req_fake_billing',
      });
      response.end(JSON.stringify(answer.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    customers,
    products,
    prices,
    taxRates,
    portalConfigurations,
    checkoutSessions,
    subscriptions,
    invoices,
    invoiceItems,
    taxIds,
    of(method: string, path: string) {
      return requests.filter((request) => request.method === method && request.path === path);
    },
    failNext(method, path, status, error) {
      failures.set(`${method} ${path}`, { status, error });
    },
    completeSession(id, subscription) {
      const session = checkoutSessions.find((candidate) => candidate.id === id);
      if (session === undefined) throw new Error(`no fake checkout session ${id}`);
      session.status = 'complete';
      if (subscription !== undefined) session.subscription = subscription;
    },
    deleteInvoice(id) {
      invoices.delete(id);
    },
    setSubscription(options) {
      const price = priceByLookupKey(options.lookupKey);
      if (price === undefined) throw new Error(`no price with lookup key ${options.lookupKey}`);
      const nextPrice =
        options.scheduleNextLookupKey === undefined || options.scheduleNextLookupKey === null
          ? null
          : priceByLookupKey(options.scheduleNextLookupKey);
      const previous = subscriptions.get(options.id);
      const subscription: StripeObject = {
        id: options.id,
        object: 'subscription',
        customer: options.customer,
        status: options.status,
        cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
        cancel_at: options.cancelAt ?? null,
        pending_update: null,
        ended_at: options.endedAt ?? null,
        canceled_at: options.canceledAt ?? null,
        default_payment_method: options.defaultPaymentMethod ?? null,
        default_tax_rates: [],
        metadata: options.metadata ?? {},
        items: list([
          {
            id: `si_${options.id}`,
            price,
            current_period_start:
              options.currentPeriodStart ?? options.currentPeriodEnd - 2_592_000,
            current_period_end: options.currentPeriodEnd,
            tax_rates: [],
          },
        ]),
        // A schedule the dashboard made stays until the test says otherwise.
        schedule:
          nextPrice === null || nextPrice === undefined
            ? (previous?.schedule ?? null)
            : {
                id: `sub_sched_${options.id}`,
                phases: [
                  { start_date: options.currentPeriodEnd - 2_600_000, items: [{ price }] },
                  { start_date: options.currentPeriodEnd, items: [{ price: nextPrice }] },
                ],
              },
      };
      subscriptions.set(options.id, subscription);
      return subscription;
    },
    openInvoice(customer, options) {
      const id = next('in');
      invoices.set(id, {
        id,
        object: 'invoice',
        customer,
        status: 'open',
        number: options.number ?? null,
        currency: 'eur',
        amount_due: options.amount,
        amount_remaining: options.amount,
        hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
      });
      return id;
    },
    schedules,
    declineNextPayment(subscription) {
      declining.add(subscription);
    },
    draftInvoice(customer: string) {
      const id = next('in');
      invoices.set(id, { id, object: 'invoice', customer, status: 'draft' });
      return id;
    },
    finalize(invoice: string) {
      const found = invoices.get(invoice);
      if (found === undefined) throw new Error(`no fake invoice ${invoice}`);
      found.status = 'open';
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
