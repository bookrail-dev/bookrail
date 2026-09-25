/**
 * The Stripe client: a thin thing over the global `fetch`, and no new dependency.
 *
 * ## Why not the `stripe` package
 *
 * Three reasons, and they are the reasons rather than a preference.
 *
 * The whole 009 family needs **seven** calls: exchange an OAuth code, revoke an OAuth grant,
 * create, read and cancel a PaymentIntent, create a refund, read an account. Billing, where
 * Bookrail sells its own plans, adds about as many again (`billing-client.ts`): a customer, a
 * checkout, the portal, a subscription, an invoice item, and the reads of the catalogue. The
 * official package carries a runtime for several hundred endpoints, a resource tree generated
 * from the whole API surface, and its own HTTP stack with its own retry policy and its own
 * telemetry. Twenty calls do not pay for that.
 *
 * The repository has **no runtime HTTP dependency at all**, by decision: webhook delivery, the
 * SDK and the CLI all speak through the global `fetch` of Node 20. A payment client that brought
 * one would be the first, and the first is how a rule stops being one.
 *
 * And a fake Stripe in `node:http`, in process, makes the tests deterministic without a
 * network and without a recorded cassette: the base URLs below are configurable for exactly
 * that, and for nothing else.
 *
 * The cost of the choice is real and is worth naming: no automatic pagination, no typed
 * resource tree, and the API version has to be pinned by hand. The version is pinned in
 * {@link STRIPE_API_VERSION}, once, and every request carries it, so an upgrade is one edit and
 * one test run rather than a package bump whose effects are implicit.
 *
 * ## What never appears in an error
 *
 * Neither error class below carries the platform key, the `Authorization` header or the request
 * body. A Stripe error is reported as its `type`, its `code` and its `message`, plus the
 * `Request-Id` header that support asks for; a transport failure is reported as its class.
 * `stripe.test.ts` asserts this against `message` and `stack` of both.
 */

/**
 * The Stripe API version every request of this build pins.
 *
 * One constant, sent on every call including the OAuth ones. Pinning is what makes the answers
 * of a payment provider a contract rather than a moving target: a field that changes shape in a
 * later version changes nothing here until somebody edits this line and runs the suite.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

export const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com';
export const DEFAULT_STRIPE_CONNECT_BASE = 'https://connect.stripe.com';

/** One call, one attempt, ten seconds. The caller decides whether to try again. */
export const STRIPE_TIMEOUT_MS = 10_000;

/**
 * Stripe answered, and the answer was an error.
 *
 * `status` is the HTTP status, `type` and `code` are Stripe's own, and `requestId` is the
 * `Request-Id` header, which is the one thing Stripe support asks for. Nothing else from the
 * response is kept: a Stripe error body echoes parts of the request, and this object ends up in
 * a log line and in an error message.
 */
export class StripeApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  /**
   * The `status` of the PaymentIntent the refused request was about, when Stripe sent one.
   *
   * A Stripe error body may carry a whole `payment_intent` object beside the message, and for a
   * refusal about an intent that is in the wrong state it does. Its `status` is a documented
   * enum (`succeeded`, `canceled`, ...); the `message` next to it is a sentence written for a
   * human, which Stripe has never promised to keep word for word. A caller that has to tell
   * "already captured" from "already cancelled" reads this field, and falls back to the prose
   * only when the field is absent.
   */
  readonly paymentIntentStatus: string | undefined;

  constructor(options: {
    status: number;
    type: string;
    code?: string | undefined;
    message: string;
    requestId?: string | undefined;
    paymentIntentStatus?: string | undefined;
  }) {
    super(options.message);
    this.name = 'StripeApiError';
    this.status = options.status;
    this.type = options.type;
    this.code = options.code;
    this.requestId = options.requestId;
    this.paymentIntentStatus = options.paymentIntentStatus;
  }
}

/**
 * Stripe did not answer: a refused connection, a DNS failure, or ten seconds of silence.
 *
 * The class of the failure and nothing else. `cause` is deliberately not chained: a
 * `TypeError` from `fetch` prints the URL it was given, and the URL of an OAuth token exchange
 * is not a thing to put in a log next to the reason it failed.
 */
export class StripeUnreachableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Stripe did not answer (${reason}).`);
    this.name = 'StripeUnreachableError';
    this.reason = reason;
  }
}

/** The account as `GET /v1/accounts/{id}` describes it. Informative, never a decision. */
export interface StripeAccount {
  id: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  defaultCurrency: string | null;
  country: string | null;
}

/**
 * A PaymentIntent, reduced to the six fields anything here acts on.
 *
 * `clientSecret` is the only one that must never be written down: it is returned from
 * `POST /v1/bookings` once and read back from Stripe by `GET /v1/payments/{id}`, and it
 * appears in no column, no log line and no `idempotency_keys` row.
 */
export interface StripePaymentIntent {
  id: string;
  /** Stripe's own status: `requires_payment_method`, `processing`, `succeeded`, `canceled`, … */
  status: string;
  amount: number;
  /** How much Stripe has actually collected. Zero until the payment succeeds. */
  amountReceived: number;
  /** Lower case, as Stripe returns it. */
  currency: string;
  clientSecret: string | null;
}

/** A Refund, reduced to what the worker writes back. */
export interface StripeRefund {
  id: string;
  amount: number;
  status: string | null;
}

interface StripePaymentIntentBody {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  amount_received?: unknown;
  currency?: unknown;
  client_secret?: unknown;
}

function paymentIntentOf(body: StripePaymentIntentBody): StripePaymentIntent {
  return {
    id: typeof body.id === 'string' ? body.id : '',
    status: typeof body.status === 'string' ? body.status : 'unknown',
    amount: typeof body.amount === 'number' ? body.amount : 0,
    amountReceived: typeof body.amount_received === 'number' ? body.amount_received : 0,
    currency: typeof body.currency === 'string' ? body.currency : '',
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null,
  };
}

/** What the OAuth token exchange tells us, once the tokens have been dropped. */
export interface StripeOauthResult {
  stripeUserId: string;
  livemode: boolean;
}

export interface StripeClientOptions {
  /** The platform secret key of one environment: `rk_test_`, `sk_test_`, `rk_live_`, `sk_live_`. */
  secretKey: string;
  /**
   * The OAuth `client_id` of the platform, `ca_...`, when the caller will make an OAuth call.
   *
   * Optional because most callers will not. The four PaymentIntent and Refund methods act on a
   * connected account with the platform's secret key plus `Stripe-Account`, and
   * the OAuth `client_id` has nothing to do with them; a webhook receiver or a worker that had
   * to be handed one in order to cancel an intent would be carrying a credential it has no use
   * for. The two OAuth methods refuse outright when it is absent, rather than sending an empty
   * one and reading Stripe's answer to find out.
   */
  clientId?: string;
  apiBase?: string;
  connectBase?: string;
  timeoutMs?: number;
  /** Only a test passes one; everything else uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  /** Absolute URL, built by the caller from one of the two bases. */
  url: string;
  form?: Record<string, unknown>;
  /** `Stripe-Account`: act on behalf of a connected account. */
  stripeAccount?: string;
  idempotencyKey?: string;
}

/**
 * `{metadata: {booking_id: 'bk_1'}, expand: ['a']}` becomes
 * `metadata[booking_id]=bk_1&expand[0]=a`.
 *
 * Stripe's own bracket notation, which is the only form its API accepts for nested values.
 * `undefined` is dropped rather than sent as the string "undefined"; `null` is sent as the
 * empty string, which is how Stripe spells "unset this field".
 */
export function encodeStripeForm(form: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      parts.push(`${encodeURIComponent(prefix)}=`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(`${prefix}[${String(index)}]`, item);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${key}]`, nested);
      }
      return;
    }
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(form)) walk(key, value);
  return parts.join('&');
}

interface StripeErrorBody {
  error?: {
    type?: unknown;
    code?: unknown;
    message?: unknown;
    error_description?: unknown;
    /** The whole PaymentIntent, on an error about one. Read for its `status` and nothing else. */
    payment_intent?: unknown;
  };
  /** The OAuth endpoints answer with a flat `{error, error_description}` instead. */
  error_description?: unknown;
}

/**
 * The wire: one request, the headers every call carries, and the two shapes of error.
 *
 * Shared by the two clients that talk to Stripe with the platform's secret key, and that must
 * never be mistaken for each other: {@link StripeClient}, which acts **for a connected account**
 * of a customer (Connect, with `Stripe-Account`), and `StripeBillingClient`, which acts as
 * Bookrail **selling** its own plans on its own account (Billing, never with `Stripe-Account`).
 * They are two classes and not one with two sets of methods, so that a function handed one cannot
 * call a method of the other.
 */
export class StripeTransport {
  protected readonly secretKey: string;
  protected readonly apiBase: string;
  protected readonly connectBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StripeClientOptions) {
    this.secretKey = options.secretKey;
    this.apiBase = trimSlash(options.apiBase ?? DEFAULT_STRIPE_API_BASE);
    this.connectBase = trimSlash(options.connectBase ?? DEFAULT_STRIPE_CONNECT_BASE);
    this.timeoutMs = options.timeoutMs ?? STRIPE_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One request, one attempt.
   *
   * No retry here on purpose: whether a call may be repeated depends on what it is, and the
   * caller is the only thing that knows. A token exchange must never be repeated (the code is
   * single use); a read may be repeated freely.
   */
  protected async request<T>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
      accept: 'application/json',
    };
    if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (options.stripeAccount !== undefined) headers['stripe-account'] = options.stripeAccount;
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(options.url, {
        method: options.method,
        headers,
        ...(options.form === undefined ? {} : { body: encodeStripeForm(options.form) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The class, never the message: a `fetch` failure prints the URL it was given, and an
      // OAuth URL is not something to copy into a log beside the reason it failed.
      throw new StripeUnreachableError(transportReason(error));
    }

    const text = await response.text().catch(() => '');
    const requestId = response.headers.get('request-id') ?? undefined;

    if (!response.ok) throw this.errorFrom(response.status, text, requestId);

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StripeApiError({
        status: response.status,
        type: 'invalid_response',
        message: 'Stripe answered with a body that is not JSON.',
        requestId,
      });
    }
  }

  private errorFrom(status: number, text: string, requestId: string | undefined): StripeApiError {
    let parsed: StripeErrorBody = {};
    try {
      parsed = JSON.parse(text) as StripeErrorBody;
    } catch {
      // A non JSON error body is reported as the status alone. Echoing the body would be
      // echoing whatever a proxy in the middle decided to write.
      return new StripeApiError({
        status,
        type: 'api_error',
        message: `Stripe answered ${String(status)}.`,
        requestId,
      });
    }
    // `/v1` answers `{error: {type, code, message}}` and the OAuth endpoints answer
    // `{error: "invalid_grant", error_description: "..."}`. Both are read here so that the rest
    // of the code has one shape to reason about.
    const nested = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error : {};
    const flatCode = typeof parsed.error === 'string' ? parsed.error : undefined;
    const type = asString(nested.type) ?? (flatCode === undefined ? 'api_error' : 'oauth_error');
    const code = asString(nested.code) ?? flatCode;
    const message =
      asString(nested.message) ??
      asString(parsed.error_description) ??
      asString(nested.error_description) ??
      `Stripe answered ${String(status)}.`;
    // Stripe attaches the PaymentIntent itself to an error about one. Its `status` is the
    // documented way to know which state refused the call, and it costs one read to keep.
    const intent =
      typeof nested.payment_intent === 'object' && nested.payment_intent !== null
        ? (nested.payment_intent as Record<string, unknown>)
        : undefined;
    const paymentIntentStatus = intent === undefined ? undefined : asString(intent.status);
    return new StripeApiError({ status, type, code, message, requestId, paymentIntentStatus });
  }
}

export class StripeClient extends StripeTransport {
  private readonly clientId: string | undefined;

  constructor(options: StripeClientOptions) {
    super(options);
    this.clientId = options.clientId;
  }

  /**
   * Exchanges the `code` the browser came back with for the account it authorised.
   *
   * The response also carries `access_token`, `refresh_token` and `stripe_publishable_key`.
   * None of the three is returned from here, so nothing above can store one by accident: for a
   * Standard account they are a deprecated second way of doing what the platform key plus
   * `Stripe-Account` already does, and a secret nobody holds is a secret nobody can leak.
   */
  async oauthToken(params: { code: string }): Promise<StripeOauthResult> {
    const body = await this.request<{ stripe_user_id?: unknown; livemode?: unknown }>({
      method: 'POST',
      url: `${this.connectBase}/oauth/token`,
      form: {
        grant_type: 'authorization_code',
        code: params.code,
        client_secret: this.secretKey,
      },
    });
    const stripeUserId = typeof body.stripe_user_id === 'string' ? body.stripe_user_id : '';
    // The shape, not only the presence. This value becomes a `Stripe-Account` header on every
    // later call made for this customer and a row in `payment_provider_connections`, whose
    // `CHECK` says the same thing; refusing it here means the header is never built from
    // something unexpected, whatever a future version of the answer contains.
    if (!/^acct_[A-Za-z0-9]+$/.test(stripeUserId)) {
      throw new StripeApiError({
        status: 502,
        type: 'invalid_response',
        message: 'The authorisation did not name an account.',
      });
    }
    return { stripeUserId, livemode: body.livemode === true };
  }

  /**
   * Revokes the platform's access to a connected account.
   *
   * `invalid_client` and `invalid_grant` mean the link is already gone, which is the state the
   * caller wanted; it is the caller, not this method, that decides to treat them as success,
   * because the same two codes mean something else on a different call.
   */
  async oauthDeauthorize(params: { stripeUserId: string }): Promise<void> {
    const clientId = this.clientId;
    if (clientId === undefined) {
      throw new Error('This Stripe client was built without a client_id and cannot do OAuth.');
    }
    await this.request({
      method: 'POST',
      url: `${this.connectBase}/oauth/deauthorize`,
      form: { client_id: clientId, stripe_user_id: params.stripeUserId },
    });
  }

  /**
   * Reads a connected account.
   *
   * The v1 `Account` object, because that is the shape the OAuth exchange hands back an
   * identifier for. The only field anything acts on is `charges_enabled`, and even that is
   * informative: it is reported by `GET /v1/stripe` so that a customer who authorised but never
   * finished their Stripe onboarding can see why nothing would be charged.
   */
  async retrieveAccount(params: {
    stripeUserId: string;
    /**
     * Read the account **as** the connected account rather than as the platform.
     * `GET /v1/stripe` does not pass it, because reading an account by its identifier needs no
     * such thing. It exists so that the two headers of {@link RequestOptions} have a caller,
     * and therefore a test: `Stripe-Account` and `Idempotency-Key` are what every later call
     * made for a customer will carry, and a header nothing ever sets is a header nothing ever
     * checks.
     */
    stripeAccount?: string;
    idempotencyKey?: string;
  }): Promise<StripeAccount> {
    const body = await this.request<{
      id?: unknown;
      charges_enabled?: unknown;
      details_submitted?: unknown;
      default_currency?: unknown;
      country?: unknown;
    }>({
      method: 'GET',
      url: `${this.apiBase}/v1/accounts/${encodeURIComponent(params.stripeUserId)}`,
      ...(params.stripeAccount === undefined ? {} : { stripeAccount: params.stripeAccount }),
      ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
    });
    return {
      id: typeof body.id === 'string' ? body.id : params.stripeUserId,
      chargesEnabled: body.charges_enabled === true,
      detailsSubmitted: body.details_submitted === true,
      defaultCurrency: typeof body.default_currency === 'string' ? body.default_currency : null,
      country: typeof body.country === 'string' ? body.country : null,
    };
  }

  /**
   * Creates the PaymentIntent a customer's front end will complete.
   *
   * **Direct charge on the connected account**: `Stripe-Account` names it, the platform's own
   * secret key authorises, and the money settles on the customer's balance without passing
   * through Bookrail. There is deliberately no `application_fee_amount`: Bookrail charges for
   * the infrastructure and takes no cut of a booking, expressed as a missing parameter.
   *
   * There is deliberately no `payment_method_types` either. Omitting it (and not asking for
   * `automatic_payment_methods` either) leaves Stripe to offer the methods the **customer's
   * own dashboard** has enabled and that fit the currency and the amount, which is the right
   * default for a platform that knows nothing about its customers' markets: an Italian studio
   * gets cards and Bancontact, a Dutch one gets iDEAL, and neither needed us to know.
   *
   * `idempotencyKey` is the public identifier of the `payments` row, so a retry of this same
   * step after a timeout attaches to the intent the first attempt created rather than creating
   * a second one and charging twice.
   */
  async createPaymentIntent(params: {
    stripeAccount: string;
    idempotencyKey: string;
    amount: number;
    /** ISO 4217, **lower case**: Stripe refuses an upper case currency. */
    currency: string;
    description?: string;
    metadata?: Record<string, string>;
  }): Promise<StripePaymentIntent> {
    const body = await this.request<StripePaymentIntentBody>({
      method: 'POST',
      url: `${this.apiBase}/v1/payment_intents`,
      stripeAccount: params.stripeAccount,
      idempotencyKey: params.idempotencyKey,
      form: {
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        capture_method: 'automatic',
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      },
    });
    return paymentIntentOf(body);
  }

  /**
   * Reads a PaymentIntent, for the `client_secret` and the provider's own status.
   *
   * The one call in this file whose answer is deliberately not stored anywhere: the secret is
   * handed straight to the caller of `GET /v1/payments/{id}` and forgotten.
   */
  async retrievePaymentIntent(params: {
    stripeAccount: string;
    id: string;
  }): Promise<StripePaymentIntent> {
    const body = await this.request<StripePaymentIntentBody>({
      method: 'GET',
      url: `${this.apiBase}/v1/payment_intents/${encodeURIComponent(params.id)}`,
      stripeAccount: params.stripeAccount,
    });
    return paymentIntentOf(body);
  }

  /**
   * Cancels a PaymentIntent that will never be completed.
   *
   * Stripe refuses this on an intent that has already succeeded, with a precise code, and the
   * caller treats the two refusals differently: an intent that is already `canceled` is the
   * state that was asked for, and one that has already succeeded means a
   * `payment_intent.succeeded` is on its way and the money has to go back instead (`jobs/
   * payment-actions.ts`).
   */
  async cancelPaymentIntent(params: {
    stripeAccount: string;
    id: string;
  }): Promise<StripePaymentIntent> {
    const body = await this.request<StripePaymentIntentBody>({
      method: 'POST',
      url: `${this.apiBase}/v1/payment_intents/${encodeURIComponent(params.id)}/cancel`,
      stripeAccount: params.stripeAccount,
      form: {},
    });
    return paymentIntentOf(body);
  }

  /**
   * Refunds part or all of a PaymentIntent.
   *
   * By `payment_intent` rather than by `charge`: the charge is a second identifier we would
   * have to store and keep in step, and Stripe resolves the intent to its charge itself.
   *
   * `idempotencyKey` is the public identifier of the refund row, which is what stops a worker
   * tick that timed out halfway from refunding twice.
   */
  async createRefund(params: {
    stripeAccount: string;
    idempotencyKey: string;
    paymentIntent: string;
    amount: number;
    metadata?: Record<string, string>;
  }): Promise<StripeRefund> {
    const body = await this.request<{
      id?: unknown;
      amount?: unknown;
      status?: unknown;
      payment_intent?: unknown;
    }>({
      method: 'POST',
      url: `${this.apiBase}/v1/refunds`,
      stripeAccount: params.stripeAccount,
      idempotencyKey: params.idempotencyKey,
      form: {
        payment_intent: params.paymentIntent,
        amount: params.amount,
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      },
    });
    return {
      id: typeof body.id === 'string' ? body.id : '',
      amount: typeof body.amount === 'number' ? body.amount : params.amount,
      status: typeof body.status === 'string' ? body.status : null,
    };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** `TimeoutError`, `ECONNREFUSED`, or the name of whatever was thrown. Never its message. */
function transportReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'unknown';
}
