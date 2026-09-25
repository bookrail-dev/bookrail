/**
 * `/v1/dashboard`: the account's own view of itself, for the dashboard page of the website.
 *
 * ## Two credentials, two doors
 *
 * Everything else under `/v1` is opened by an API key, and an API key belongs to a **project and
 * an environment**. The dashboard belongs to the **account**, and it does the one thing a key must
 * never do: it creates keys, live ones included. So an API key does not open it (a test key that
 * leaked must not be able to mint a live one), and the credential that does open it does not open
 * anything else: a dashboard session, `bds_...`, is refused by `authenticate` like any string that
 * is not an API key, and an API key presented here is refused like any string that is not a
 * session. The two families are kept apart in `routes/public.ts`.
 *
 * ## How a session comes into being
 *
 * Only through the owner address of a self service account. `POST /login` records the request
 * and, when the address has an account, sends a link with a single use token (`bls_...`) in its
 * fragment; `POST /login/confirm` turns the token into a session of twelve hours, absolute, with
 * no renewal. Both tokens are 32 random bytes; the database holds their SHA-256 and nothing else.
 *
 * ## What an unauthenticated caller cannot learn
 *
 * `POST /login` answers `202` with the same body whether or not the address has an account. The
 * ceilings behind it (five an hour per address, twenty per caller) count every request, so the
 * sixth is refused for a customer and for a stranger alike. And the message is sent **without
 * making the caller wait**: an answer that took the length of an SMTP conversation for a customer
 * and no time at all for a stranger would say the same thing the body is careful not to say. A
 * mail server that refuses is therefore a `warn` line and not an error of the request; the person
 * asks again.
 *
 * ## Nothing here writes to the database directly
 *
 * Like the sign up routes, every read and write is a call to one of the `SECURITY DEFINER`
 * functions of migration 0026, which take the **hash of the session token** and resolve the
 * account inside themselves: no function here accepts an account chosen by the caller. That
 * protects against a programming mistake (a wrong identifier cannot act on another account), not
 * against this process being compromised: the process mints the link token itself, so whoever
 * controls it can open a session for any self service address it knows. The barrier against that
 * is the application role and the isolation of the process, as for the rest of the API.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { ThrottledWarner } from '@bookrail/engine';
import { sql, withAuthContext } from '@bookrail/db';
import {
  BookrailError,
  LEGAL_VERSIONS,
  REQUEST_ID_HEADER,
  encodeId,
  errors,
  planMonthOf,
  planOf,
  uuidv7,
  type Environment,
  type PaidPlanId,
} from '@bookrail/shared';
import { CatalogIncomplete, resolveCatalog } from '../billing/catalog.js';
import { applySubscription } from '../billing/events.js';
import { checkoutSessionForm } from '../billing/checkout.js';
import { isLiveSubscriptionStatus } from '../billing/live.js';
import { StripeApiError } from '../stripe/client.js';
import {
  billingCatalogIncomplete,
  billingNotConfigured,
  billingProviderFailure,
} from '../billing/errors.js';
import { portalConfigurationId } from '../billing/setup.js';
import type { AppDeps, AppEnv, DashboardContext } from '../context.js';
import { parseJsonBody, pathId } from '../http.js';
import { callerHash } from '../caller.js';
import { generateApiKey } from '../keys.js';
import { dashboardLinkMessage } from '../mail/messages.js';
import {
  POLICY_UNAVAILABLE,
  RATE_LIMIT_POLICY_HEADER,
  RETRY_AFTER_HEADER,
  WARN_WINDOW_MS,
  headersOf,
  retryAfterSeconds,
} from '../middleware/rate-limit.js';
import { plansOf } from '../plan.js';
import type { RateLimitDecision } from '../rate-limit.js';
import {
  billingChangeSchema,
  billingCheckoutSchema,
  dashboardKeyCreateSchema,
  dashboardLoginConfirmSchema,
  dashboardLoginSchema,
} from '../schemas/index.js';
import type {
  BillingChangeResponse,
  BillingRedirect,
  DashboardAccount,
  DashboardApiKey,
  DashboardApiKeyCreated,
  DashboardLogin,
  DashboardSession,
} from '../schemas/responses.js';
import { callerAddress } from './signups.js';

export { DASHBOARD_PREFIX, isDashboardPath } from './public.js';

/** The prefix of the single use token in the link. Recognised by the secret scanner. */
export const LINK_TOKEN_PREFIX = 'bls_';

/** The prefix of a session token. Recognised by the secret scanner. */
export const SESSION_TOKEN_PREFIX = 'bds_';

/** `bds_` and 43 characters of base64url: 32 random bytes. Anything else is not a session. */
const SESSION_TOKEN_RE = /^bds_[A-Za-z0-9_-]{43}$/;

/**
 * The ceiling of one session: ten requests a second with bursts of twenty.
 *
 * A person in a browser tab makes a handful of requests a minute; this is room for a page that
 * loads everything at once and still a ceiling on a script that got hold of a session.
 */
export const DASHBOARD_RATE_LIMIT = { rate: 10, burst: 20 } as const;

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The Postgres SQLSTATE of an error, when it is one. */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Runs a call into one definer function and turns its refusals into the documented errors.
 *
 * The mapping is by SQLSTATE and **per call site**: the functions of migration 0026 reuse the
 * codes of the sign up ones (`P0404`, `P0409`, `P0410`, `P0429`), whose global translation in
 * `pg-errors.ts` names the sign up. Each route knows which function it called and says what the
 * code means there, before the global translation can say something else.
 */
async function refusing<T>(
  run: () => Promise<T>,
  meanings: Readonly<Record<string, () => BookrailError>>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const state = sqlState(error);
    const meaning = state === undefined ? undefined : meanings[state];
    if (meaning !== undefined) throw meaning();
    throw error;
  }
}

function disabled(): BookrailError {
  return new BookrailError(
    'internal',
    'dashboard_disabled',
    'The dashboard is not enabled on this deployment: it has no way to send the sign in link.',
    undefined,
    'Write to hello@bookrail.dev.',
  );
}

function invalidSession(): BookrailError {
  return new BookrailError(
    'authentication',
    'dashboard_session_invalid',
    'No live dashboard session. Send `Authorization: Bearer bds_...` from a link opened in the last twelve hours.',
    undefined,
    'Sign in again at https://bookrail.dev/dashboard/. An API key does not open the dashboard.',
  );
}

function loginRateLimited(): BookrailError {
  return new BookrailError(
    'rate_limit',
    'dashboard_login_rate_limited',
    'Too many sign in requests for this address or from this caller. The limit is five an hour per address.',
    undefined,
    'Wait an hour, or use the last link you received: it works for fifteen minutes.',
  );
}

function loginNotFound(): BookrailError {
  return new BookrailError(
    'not_found',
    'dashboard_login_not_found',
    'That sign in link does not exist.',
    undefined,
    'Ask for a new link at https://bookrail.dev/dashboard/.',
  );
}

function loginUsed(): BookrailError {
  return new BookrailError(
    'conflict',
    'dashboard_login_used',
    'That sign in link has already been used. A link works once.',
    undefined,
    'Ask for a new link at https://bookrail.dev/dashboard/.',
  );
}

function loginExpired(): BookrailError {
  return new BookrailError(
    'conflict',
    'dashboard_login_expired',
    'That sign in link has expired. A link works for fifteen minutes.',
    undefined,
    'Ask for a new link at https://bookrail.dev/dashboard/.',
  );
}

function keyCreationRateLimited(): BookrailError {
  return new BookrailError(
    'rate_limit',
    'key_creation_rate_limited',
    'This account has created twenty keys in the last 24 hours, revoked ones included.',
    undefined,
    'Use one of the keys you have, or wait until the oldest of those twenty is a day old.',
  );
}

function termsNotAccepted(): BookrailError {
  return new BookrailError(
    'invalid_request',
    'terms_not_accepted',
    'The terms of service and the data processing agreement in force have not been accepted by this account.',
    'accept_terms',
    'Send accept_terms: true and approve_clauses: true after reading https://bookrail.dev/terms and https://bookrail.dev/dpa.',
  );
}

function subscriptionExists(): BookrailError {
  return new BookrailError(
    'conflict',
    'subscription_exists',
    'This account already has a subscription. A second checkout would make a second one.',
    undefined,
    'Switch between Pro and Scale with POST /v1/dashboard/billing/change (Switch plan in the dashboard); the card, the invoices and the cancellation are in the portal: POST /v1/dashboard/billing/portal, or Manage billing.',
  );
}

function planIsContract(): BookrailError {
  return new BookrailError(
    'conflict',
    'plan_is_contract',
    'This account is on the Enterprise plan, which is a contract and is not bought through the checkout.',
    undefined,
    'Write to hello@bookrail.dev.',
  );
}

function invoiceUnpaid(url: string | null): BookrailError {
  return new BookrailError(
    'conflict',
    'invoice_unpaid',
    'An invoice of this account is still open and unpaid. A new plan can be bought once it is paid.',
    undefined,
    url === null
      ? 'Pay the open invoice from the link in the message Bookrail sent, or write to hello@bookrail.dev.'
      : `Pay the open invoice first: ${url}`,
  );
}

function subscriptionMissing(): BookrailError {
  return new BookrailError(
    'conflict',
    'billing_subscription_missing',
    'This account has no live subscription to change.',
    undefined,
    'Buy a plan first: POST /v1/dashboard/billing/checkout, or Upgrade in the dashboard.',
  );
}

function planChangeRefused(message: string, fix: string): BookrailError {
  return new BookrailError('conflict', 'plan_change_refused', message, undefined, fix);
}

function noBillingCustomer(): BookrailError {
  return new BookrailError(
    'conflict',
    'billing_customer_missing',
    'This account has never started a checkout, so there is no billing portal to open yet.',
    undefined,
    'Choose a plan first: POST /v1/dashboard/billing/checkout, or Upgrade in the dashboard.',
  );
}

/** Fourteen days: the grace of a failed payment, which the database applies as well. */
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;

function keyLimitReached(): BookrailError {
  return new BookrailError(
    'conflict',
    'key_limit_reached',
    'This project already has five active secret keys in that environment.',
    'environment',
    'Revoke a key you no longer use, then create the new one.',
  );
}

/**
 * The headers of cross origin access, for these routes and for nothing else.
 *
 * The dashboard is a page of `bookrail.dev` calling the API on another host, with the session in
 * an `Authorization` header, so the browser asks first. One origin, three methods, two request
 * headers, ten minutes of preflight cache, and `Vary: Origin`. No `Allow-Credentials`: there is
 * no cookie anywhere in this product, and the session travels as a header the page sets itself.
 */
export function dashboardCorsHeaders(siteOrigin: string): Readonly<Record<string, string>> {
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': siteOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

/**
 * Written onto the response after it exists, for the reason `signups.ts` gives: an error is
 * answered with a response the context did not build, and a response without these headers is
 * one the page cannot read.
 *
 * `Cache-Control: no-store` rides with them on every response of these routes: two of them
 * carry a secret (the session token, a new key), and the rest carry an owner address and the
 * list of an account's keys, none of which anything between here and the page should keep.
 */
function cors(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const headers = { ...dashboardCorsHeaders(deps.siteOrigin), 'Cache-Control': 'no-store' };
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      for (const [name, value] of Object.entries(headers)) c.header(name, value);
      return c.body(null, 204);
    }
    await next();
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  };
}

function bearer(c: Context<AppEnv>): string {
  const header = c.req.header('authorization');
  const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (token === undefined || !SESSION_TOKEN_RE.test(token)) throw invalidSession();
  return token;
}

interface ResolveRow {
  [column: string]: unknown;
  session_id: string;
  account_id: string;
  expires_at: string;
}

/**
 * Resolves the session, then applies its ceiling. Mounted on every route but the two that
 * obtain a session.
 *
 * The limit is the GCRA of the per key limiter, on a bucket of its own (`dash:<session id>`), with
 * the same behaviour when the store does not answer: the request goes through and says so with
 * `RateLimit-Policy: unavailable`.
 */
function session(deps: AppDeps, clock: () => number): MiddlewareHandler<AppEnv> {
  const warner = new ThrottledWarner(deps.logger, WARN_WINDOW_MS);
  return async (c, next) => {
    const tokenHash = sha256(bearer(c));
    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<ResolveRow>(sql`
        SELECT session_id, account_id, expires_at::text AS expires_at
          FROM dashboard_session_resolve(${tokenHash}, ${new Date(clock()).toISOString()}::timestamptz)
      `),
    );
    const row = rows[0];
    if (row === undefined) throw invalidSession();
    const context: DashboardContext = {
      sessionId: row.session_id,
      accountId: row.account_id,
      tokenHash,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
    c.set('dashboard', context);

    const settings = deps.rateLimit;
    if (settings === undefined) return next();

    let decision: RateLimitDecision;
    try {
      decision = await settings.limiter.check(
        `dash:${row.session_id}`,
        DASHBOARD_RATE_LIMIT.rate,
        DASHBOARD_RATE_LIMIT.burst,
        Date.now(),
      );
    } catch (error) {
      warner.warn('rate_limiter_degraded', {
        limiter: settings.limiter.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await next();
      } finally {
        c.res.headers.set(RATE_LIMIT_POLICY_HEADER, POLICY_UNAVAILABLE);
      }
      return;
    }

    if (!decision.allowed) {
      const error = errors.rateLimited(
        `A dashboard session may make ${String(DASHBOARD_RATE_LIMIT.rate)} requests per second, with bursts of ${String(DASHBOARD_RATE_LIMIT.burst)}.`,
        'Wait for Retry-After.',
      );
      const requestId = c.get('requestId');
      c.set('errorCode', error.code);
      return new Response(JSON.stringify(error.toPayload(requestId)), {
        status: error.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          [REQUEST_ID_HEADER]: requestId,
          [RETRY_AFTER_HEADER]: String(retryAfterSeconds(decision.retryAfterMs)),
          ...headersOf(decision),
        },
      });
    }

    try {
      await next();
    } finally {
      for (const [name, value] of Object.entries(headersOf(decision))) {
        c.res.headers.set(name, value);
      }
    }
  };
}

/** A key as the overview function returns it, inside its JSON. */
interface KeyJson {
  id: string;
  environment: Environment;
  kind: 'secret' | 'publishable';
  name: string | null;
  prefix: string;
  tenant_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ProjectJson {
  id: string;
  name: string;
  default_timezone: string;
  default_currency: string;
  created_at: string;
  api_keys: KeyJson[];
}

interface OverviewRow {
  [column: string]: unknown;
  account_id: string;
  account_name: string;
  plan: string;
  owner_email: string;
  session_expires_at: string;
  bookings_confirmed: string;
  payment_volume: string;
  currency: string | null;
  bookings_pending: string;
  payment_volume_pending: string;
  projects: ProjectJson[];
}

interface KeyRow {
  [column: string]: unknown;
  id: string;
  environment: Environment;
  kind: 'secret' | 'publishable';
  name: string | null;
  prefix: string;
  tenant_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function instant(value: string): string {
  return new Date(value).toISOString();
}

function nullableInstant(value: string | null): string | null {
  return value === null ? null : instant(value);
}

interface BillingStateRow {
  [column: string]: unknown;
  account_id: string;
  account_name: string;
  owner_email: string | null;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_plan: 'pro' | 'scale' | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  scheduled_plan: 'pro' | 'scale' | null;
  past_due_since: string | null;
  terms_accepted_at: string | null;
  /** `billing_subscription_is_live` of the status: the one definition. */
  subscription_live: boolean | null;
  checkout_session_id: string | null;
  unpaid_invoice_id: string | null;
  unpaid_invoice_number: string | null;
  unpaid_amount_due: string | null;
  unpaid_currency: string | null;
  unpaid_invoice_url: string | null;
}

function serializeKey(key: KeyJson | KeyRow): DashboardApiKey {
  return {
    id: encodeId('api_key', key.id),
    object: 'api_key',
    environment: key.environment,
    kind: key.kind,
    name: key.name,
    prefix: key.prefix,
    tenant_id: key.tenant_id,
    status: key.revoked_at === null ? 'active' : 'revoked',
    created_at: instant(key.created_at),
    last_used_at: key.last_used_at === null ? null : instant(key.last_used_at),
    revoked_at: key.revoked_at === null ? null : instant(key.revoked_at),
  };
}

export function dashboardRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const clock = deps.now ?? Date.now;
  const nowIso = (): string => new Date(clock()).toISOString();
  routes.use('*', cors(deps));

  /**
   * Sends the link without making the caller wait, and says nothing about the outcome to the
   * caller. `send` is called synchronously, before the response exists, so a message that is sent
   * is sent by the time the `202` leaves; only its completion is not awaited.
   */
  function sendLink(to: string, token: string, upgrade: PaidPlanId | undefined): void {
    const mailer = deps.mailer;
    if (mailer === undefined) return;
    const message = dashboardLinkMessage({
      to,
      siteUrl: deps.siteUrl,
      token,
      ...(upgrade === undefined ? {} : { upgrade }),
    });
    mailer.send(message).catch((error) => {
      // The class of the failure and nothing else, for the reason `signups.ts` gives: an SMTP
      // refusal quotes the address.
      const code = (error as { code?: unknown } | null)?.code;
      deps.logger.warn('dashboard_link_email_failed', {
        error_code:
          typeof code === 'string' && code !== ''
            ? code
            : error instanceof Error
              ? error.name
              : 'unknown',
      });
    });
  }

  /** `POST /v1/dashboard/login`: a link, to the owner address, if there is one. */
  routes.post('/login', async (c) => {
    if (deps.mailer === undefined) throw disabled();
    const body = await parseJsonBody(c, dashboardLoginSchema);
    const token = newToken(LINK_TOKEN_PREFIX);

    const { rows } = await refusing(
      () =>
        withAuthContext(deps.db, (tx) =>
          tx.execute<{ send_email: boolean; expires_at: string }>(sql`
            SELECT send_email, expires_at::text AS expires_at FROM dashboard_login_start(
              ${body.email},
              ${sha256(token)},
              ${callerHash(callerAddress(c, deps.trustForwardedFor === true))}
            )
          `),
        ),
      { P0429: loginRateLimited },
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The sign in request could not be recorded.');
    if (row.send_email) sendLink(body.email, token, body.upgrade);

    // The same body whether or not a message is on its way.
    const payload: DashboardLogin = {
      object: 'dashboard_login',
      email: body.email,
      expires_at: instant(row.expires_at),
    };
    return c.json(payload, 202);
  });

  /** `POST /v1/dashboard/login/confirm`: the link was opened. */
  routes.post('/login/confirm', async (c) => {
    const body = await parseJsonBody(c, dashboardLoginConfirmSchema);
    const sessionToken = newToken(SESSION_TOKEN_PREFIX);

    const { rows } = await refusing(
      () =>
        withAuthContext(deps.db, (tx) =>
          tx.execute<{ session_id: string; account_id: string; expires_at: string }>(sql`
            SELECT session_id, account_id, expires_at::text AS expires_at
              FROM dashboard_login_confirm(
                ${sha256(body.token)},
                ${sha256(sessionToken)},
                ${nowIso()}::timestamptz
              )
          `),
        ),
      { P0404: loginNotFound, P0409: loginUsed, P0410: loginExpired },
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The session could not be created.');
    deps.logger.info('dashboard_session_created', {
      account_id: encodeId('account', row.account_id),
    });

    const payload: DashboardSession = {
      object: 'dashboard_session',
      session_token: sessionToken,
      expires_at: instant(row.expires_at),
    };
    return c.json(payload);
  });

  // Every route below needs a live session.
  routes.use('/account', session(deps, clock));
  routes.use('/projects/*', session(deps, clock));
  routes.use('/keys/*', session(deps, clock));
  routes.use('/logout', session(deps, clock));
  routes.use('/billing/*', session(deps, clock));

  /** `GET /v1/dashboard/account`: the account, its plan and usage, its projects and keys. */
  routes.get('/account', async (c) => {
    const dashboard = c.get('dashboard');
    const now = clock();
    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<OverviewRow>(sql`
        SELECT account_id, account_name, plan, owner_email,
               session_expires_at::text AS session_expires_at,
               bookings_confirmed::text AS bookings_confirmed,
               payment_volume::text AS payment_volume,
               currency,
               bookings_pending::text AS bookings_pending,
               payment_volume_pending::text AS payment_volume_pending,
               projects
          FROM dashboard_account_overview(
            ${dashboard.tokenHash},
            ${planMonthOf(now)},
            ${new Date(now).toISOString()}::timestamptz
          )
      `),
    );
    const row = rows[0];
    // Revoked or expired between the middleware and here.
    if (row === undefined) throw invalidSession();

    const state = await billingState(dashboard.tokenHash, now);
    const plan = planOf(row.plan);
    const limits = plansOf(deps)[plan];
    const payload: DashboardAccount = {
      object: 'dashboard_account',
      account: {
        id: encodeId('account', row.account_id),
        object: 'account',
        name: row.account_name,
        plan,
        owner_email: row.owner_email,
      },
      usage: {
        month: planMonthOf(now),
        bookings_confirmed: Number(row.bookings_confirmed),
        bookings_included: limits.bookingsIncluded,
        payment_volume: Number(row.payment_volume),
        payment_volume_included: limits.paymentVolumeIncluded,
        currency: row.currency,
        blocks_at_limit: limits.blocksAtLimit,
      },
      reserved: {
        bookings_pending: Number(row.bookings_pending),
        payment_volume_pending: Number(row.payment_volume_pending),
      },
      projects: row.projects.map((project) => ({
        id: encodeId('project', project.id),
        object: 'project',
        name: project.name,
        default_timezone: project.default_timezone,
        default_currency: project.default_currency,
        created_at: instant(project.created_at),
        api_keys: project.api_keys.map(serializeKey),
      })),
      session: { expires_at: instant(row.session_expires_at) },
      billing:
        state?.stripe_subscription_id === null ||
        state === undefined ||
        state.subscription_plan === null
          ? null
          : {
              status: state.subscription_status as NonNullable<
                DashboardAccount['billing']
              >['status'],
              live: state.subscription_live === true,
              plan: state.subscription_plan,
              current_period_end: nullableInstant(state.current_period_end),
              cancel_at_period_end: state.cancel_at_period_end === true,
              scheduled_plan: state.scheduled_plan,
              past_due_since: nullableInstant(state.past_due_since),
              grace_ends_at:
                state.past_due_since === null
                  ? null
                  : new Date(new Date(state.past_due_since).getTime() + GRACE_MS).toISOString(),
              unpaid_invoice:
                state.unpaid_invoice_id === null
                  ? null
                  : {
                      id: state.unpaid_invoice_id,
                      number: state.unpaid_invoice_number,
                      amount_due: Number(state.unpaid_amount_due ?? 0),
                      currency: state.unpaid_currency ?? 'eur',
                      url: state.unpaid_invoice_url,
                    },
            },
      terms: {
        terms_version: LEGAL_VERSIONS.terms,
        dpa_version: LEGAL_VERSIONS.dpa,
        accepted_at: nullableInstant(state?.terms_accepted_at ?? null),
      },
    };
    return c.json(payload);
  });

  /** The billing state of the session's account, through `billing_account_state`. */
  async function billingState(
    tokenHash: string,
    now: number,
  ): Promise<BillingStateRow | undefined> {
    const { rows } = await withAuthContext(deps.db, (tx) =>
      tx.execute<BillingStateRow>(sql`
        SELECT account_id, account_name, owner_email, plan, stripe_customer_id,
               stripe_subscription_id, subscription_status, subscription_plan,
               current_period_end::text AS current_period_end, cancel_at_period_end,
               scheduled_plan, past_due_since::text AS past_due_since,
               terms_accepted_at::text AS terms_accepted_at, subscription_live,
               checkout_session_id, unpaid_invoice_id, unpaid_invoice_number,
               unpaid_amount_due::text AS unpaid_amount_due, unpaid_currency, unpaid_invoice_url
          FROM billing_account_state(
            ${tokenHash}, ${LEGAL_VERSIONS.terms}, ${LEGAL_VERSIONS.dpa},
            ${new Date(now).toISOString()}::timestamptz
          )
      `),
    );
    return rows[0];
  }

  /**
   * Makes sure nobody can pay a checkout session any more: expired when it is still open.
   * Answers what it was, so that a session already paid can be told apart. A session Stripe no
   * longer knows, or a refusal to expire one that has just changed state, is not an error: the
   * list of subscriptions read before is the net for a payment, and the receiver the last one.
   */
  async function closeCheckoutSession(
    billing: NonNullable<AppDeps['billing']>,
    sessionId: string,
    accountId: string,
  ): Promise<{ status: string; subscription: string | null }> {
    const fields = { account_id: encodeId('account', accountId), session: sessionId };
    try {
      const session = await billing.client.retrieveCheckoutSession(sessionId);
      if (session.status !== 'open') return session;
      await billing.client.expireCheckoutSession(sessionId);
      deps.logger.info('billing_checkout_expired', fields);
      return { status: 'expired', subscription: null };
    } catch (error) {
      if (error instanceof StripeApiError) {
        deps.logger.warn('billing_checkout_expire_refused', {
          ...fields,
          code: error.code ?? null,
        });
        return { status: 'unknown', subscription: null };
      }
      throw billingProviderFailure(error);
    }
  }

  function billingDeps(): NonNullable<AppDeps['billing']> {
    const billing = deps.billing;
    if (billing === undefined || billing === null) throw billingNotConfigured();
    return billing;
  }

  /**
   * `POST /v1/dashboard/billing/checkout`: a Stripe Checkout Session for Pro or Scale.
   *
   * The order: the terms first (an account that has not accepted the versions in force must send
   * both ticks, and they are recorded before anything else happens), then the refusals that need
   * no network (a contract, a subscription already there), then Stripe, outside any transaction:
   * the catalogue, the customer (created once, with an idempotency key of the account, and
   * recorded), and the session.
   */
  routes.post('/billing/checkout', async (c) => {
    const dashboard = c.get('dashboard');
    const billing = billingDeps();
    const body = await parseJsonBody(c, billingCheckoutSchema);
    const now = clock();
    let state = await billingState(dashboard.tokenHash, now);
    if (state === undefined) throw invalidSession();

    if (state.terms_accepted_at === null) {
      if (body.accept_terms !== true || body.approve_clauses !== true) throw termsNotAccepted();
      await refusing(
        () =>
          withAuthContext(deps.db, (tx) =>
            tx.execute(sql`
              SELECT * FROM terms_accept_dashboard(
                ${dashboard.tokenHash}, ${LEGAL_VERSIONS.terms}, ${LEGAL_VERSIONS.dpa},
                ${callerHash(callerAddress(c, deps.trustForwardedFor === true))},
                ${new Date(now).toISOString()}::timestamptz
              )
            `),
          ),
        { P0401: invalidSession },
      );
      deps.logger.info('terms_accepted', {
        account_id: encodeId('account', state.account_id),
        channel: 'dashboard',
        terms_version: LEGAL_VERSIONS.terms,
      });
    }
    if (state.plan === 'enterprise') throw planIsContract();
    if (state.subscription_live === true) throw subscriptionExists();
    if (state.unpaid_invoice_id !== null) throw invoiceUnpaid(state.unpaid_invoice_url);

    let catalog;
    try {
      catalog = await resolveCatalog(billing.client, now);
    } catch (error) {
      if (error instanceof CatalogIncomplete) {
        deps.logger.error('billing_catalog_incomplete', { missing: error.missing.join(', ') });
        throw billingCatalogIncomplete();
      }
      throw billingProviderFailure(error);
    }

    let customer = state.stripe_customer_id;
    /** The subscriptions of the customer Stripe says have ended. */
    let endedAtStripe = new Set<string>();
    if (customer === null) {
      let created: { id: string };
      try {
        created = await billing.client.createCustomer({
          idempotencyKey: `bookrail-customer-${state.account_id}`,
          email: state.owner_email,
          name: state.account_name,
          metadata: { bookrail_account_id: encodeId('account', state.account_id) },
        });
      } catch (error) {
        throw billingProviderFailure(error);
      }
      const { rows } = await refusing(
        () =>
          withAuthContext(deps.db, (tx) =>
            tx.execute<{ billing_customer_bind: string }>(sql`
              SELECT billing_customer_bind(${dashboard.tokenHash}, ${created.id},
                                           ${new Date(now).toISOString()}::timestamptz)
            `),
          ),
        { P0401: invalidSession },
      );
      customer = rows[0]?.billing_customer_bind ?? created.id;
      state = { ...state, stripe_customer_id: customer };
    } else {
      // The database knows a subscription only once its event has arrived. Stripe knows it the
      // moment the checkout is paid: a second checkout opened in between would make a second
      // subscription that takes money too.
      let subscriptions;
      try {
        subscriptions = await billing.client.listSubscriptions(customer);
      } catch (error) {
        throw billingProviderFailure(error);
      }
      const live = subscriptions.find((subscription) =>
        isLiveSubscriptionStatus(subscription.status),
      );
      if (live !== undefined) {
        deps.logger.warn('billing_checkout_refused_live_at_stripe', {
          account_id: encodeId('account', state.account_id),
          subscription: live.id,
          status: live.status,
        });
        throw subscriptionExists();
      }
      // An invoice left open by a subscription closed for non payment: paid first.
      let open;
      try {
        open = (await billing.client.listOpenInvoices(customer)).filter(
          (invoice) => invoice.amountRemaining > 0,
        );
      } catch (error) {
        throw billingProviderFailure(error);
      }
      if (open.length > 0) {
        deps.logger.warn('billing_checkout_refused_unpaid', {
          account_id: encodeId('account', state.account_id),
          invoice: open[0]?.id ?? null,
        });
        throw invoiceUnpaid(open[0]?.hostedInvoiceUrl ?? null);
      }
      endedAtStripe = new Set(
        subscriptions
          .filter((subscription) => !isLiveSubscriptionStatus(subscription.status))
          .map((subscription) => subscription.id),
      );
    }

    // One open checkout per account: the one opened before is expired first, so that a second
    // tab cannot pay a second subscription. A previous one already paid means a subscription is
    // on its way.
    const previous = state.checkout_session_id;
    if (previous !== null) {
      const closed = await closeCheckoutSession(billing, previous, state.account_id);
      // A paid one whose subscription Stripe says has already ended is history, not a payment
      // on its way.
      const ended = closed.subscription !== null && endedAtStripe.has(closed.subscription);
      if (closed.status === 'complete' && !ended) throw subscriptionExists();
    }

    const form = checkoutSessionForm({
      plan: body.plan,
      priceId: catalog.prices[body.plan].id,
      customer,
      accountId: state.account_id,
      siteUrl: deps.siteUrl,
      now,
    });
    let session: { id: string; url: string };
    try {
      session = await billing.client.createCheckoutSession(form);
    } catch (error) {
      throw billingProviderFailure(error);
    }
    const { rows: recorded } = await refusing(
      () =>
        withAuthContext(deps.db, (tx) =>
          tx.execute<{ billing_checkout_record: string | null }>(sql`
            SELECT billing_checkout_record(${dashboard.tokenHash}, ${session.id},
                                           ${new Date(now).toISOString()}::timestamptz)
          `),
        ),
      { P0401: invalidSession },
    );
    // Two tabs at once: the one recorded second expires the other, whichever it is.
    const replaced = recorded[0]?.billing_checkout_record ?? null;
    if (replaced !== null && replaced !== previous) {
      await closeCheckoutSession(billing, replaced, state.account_id);
    }
    deps.logger.info('billing_checkout_opened', {
      account_id: encodeId('account', state.account_id),
      plan: body.plan,
      session: session.id,
    });
    const payload: BillingRedirect = { object: 'billing_checkout', url: session.url };
    return c.json(payload);
  });

  /** Reads the subscription back and applies it now, so that the dashboard shows the change. */
  async function applyNow(billing: NonNullable<AppDeps['billing']>, subscription: string) {
    try {
      await applySubscription(
        {
          db: deps.db,
          logger: deps.logger,
          mailer: deps.mailer,
          billing,
          ...(deps.plans === undefined ? {} : { plans: deps.plans }),
        },
        subscription,
        null,
        null,
        Math.floor(clock() / 1000),
      );
    } catch (error) {
      // The event of Stripe does the same a moment later; the change itself is made.
      deps.logger.warn('billing_change_apply_deferred', {
        subscription,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * `POST /v1/dashboard/billing/change`: Pro to Scale at once, Scale to Pro on the first.
   *
   * The customer portal cannot change plans between two products at the end of a period, so the
   * dashboard does. A move up replaces the price of the item with `always_invoice`: the
   * difference for the rest of the month is invoiced and paid now. A move down makes a
   * subscription schedule from the subscription (`from_subscription`) and gives it two phases:
   * the current one as it is, to the end of the period, then Pro, released after a month; the
   * dashboard shows it through `scheduled_plan`, read from the schedule.
   */
  routes.post('/billing/change', async (c) => {
    const dashboard = c.get('dashboard');
    const billing = billingDeps();
    const body = await parseJsonBody(c, billingChangeSchema);
    const now = clock();
    const state = await billingState(dashboard.tokenHash, now);
    if (state === undefined) throw invalidSession();
    if (state.plan === 'enterprise') throw planIsContract();
    const subscriptionId = state.stripe_subscription_id;
    if (state.subscription_live !== true || subscriptionId === null) throw subscriptionMissing();
    if (state.subscription_status !== 'active' && state.subscription_status !== 'trialing') {
      throw planChangeRefused(
        'The plan cannot change while a payment of the subscription is not settled.',
        'Update the card under Manage billing, then change the plan.',
      );
    }
    if (body.plan === state.subscription_plan) {
      throw state.scheduled_plan === null
        ? planChangeRefused(
            `The subscription is already on ${body.plan === 'pro' ? 'Pro' : 'Scale'}.`,
            'Nothing to change.',
          )
        : planChangeRefused(
            `A move to ${state.scheduled_plan === 'pro' ? 'Pro' : 'Scale'} is scheduled for the end of the period.`,
            'To stay on the current plan, cancel it: POST /v1/dashboard/billing/change/cancel.',
          );
    }
    if (body.plan === 'pro' && state.cancel_at_period_end === true) {
      // A schedule would take over a subscription that is set to end: nothing to move down to.
      throw planChangeRefused(
        'The subscription ends at the end of the period.',
        'To keep it on Pro, resume it under Manage billing, then change the plan.',
      );
    }
    if (body.plan === state.scheduled_plan) {
      throw planChangeRefused(
        'That move is already scheduled for the end of the period.',
        'Nothing to change, or cancel it: POST /v1/dashboard/billing/change/cancel.',
      );
    }

    let effective: 'now' | 'period_end' | 'pending_payment';
    let effectiveAt: number | null;
    let paymentUrl: string | null = null;
    try {
      const catalog = await resolveCatalog(billing.client, now);
      const subscription = await billing.client.retrieveSubscription(subscriptionId);
      const target = catalog.prices[body.plan].id;
      if (body.plan === 'scale') {
        // A leftover schedule would take the subscription back at its next phase.
        if (subscription.scheduleId !== null) {
          await billing.client.releaseSchedule(subscription.scheduleId);
        }
        if (subscription.itemId === null) throw new Error('The subscription has no item.');
        // Applied only once the invoice of the difference is paid (`pending_if_incomplete`): a
        // card that refuses leaves the subscription on Pro, active, and the change waiting.
        const updated = await billing.client.updateSubscriptionPrice({
          subscription: subscriptionId,
          item: subscription.itemId,
          price: target,
          // Two clicks within a minute are one change.
          idempotencyKey: `bookrail-upgrade-${subscriptionId}-${String(Math.floor(now / 60_000))}`,
        });
        if (updated.pendingUpdate !== null) {
          effective = 'pending_payment';
          effectiveAt = null;
          paymentUrl = updated.latestInvoice?.hostedInvoiceUrl ?? null;
        } else {
          effective = 'now';
          effectiveAt = Math.floor(now / 1000);
        }
      } else {
        const current = subscription.price?.id;
        const end = subscription.currentPeriodEnd;
        if (current === undefined || end === null) {
          throw new Error('The subscription has no current period to schedule from.');
        }
        // The first phase starts where the current phase of the schedule starts, as Stripe
        // answers it: a first phase with another start is refused. One schedule per period, even
        // for two clicks at once (the key).
        const schedule =
          subscription.scheduleId === null
            ? await billing.client.createScheduleFromSubscription(
                subscriptionId,
                `bookrail-schedule-${subscriptionId}-${String(end)}`,
              )
            : await billing.client.retrieveSchedule(subscription.scheduleId);
        const scheduleId = schedule.id;
        const start = schedule.phaseStart ?? subscription.currentPeriodStart;
        if (start === null) throw new Error('The schedule has no current phase.');
        const phaseCommon = {
          automatic_tax: { enabled: true },
          proration_behavior: 'none',
          metadata: { bookrail_account_id: encodeId('account', state.account_id) },
        };
        await billing.client.updateSchedule(scheduleId, {
          end_behavior: 'release',
          // The receiver releases a schedule of the dashboard once its last phase has begun.
          metadata: { bookrail_account_id: encodeId('account', state.account_id) },
          phases: [
            {
              items: [{ price: current, quantity: 1 }],
              start_date: start,
              end_date: end,
              ...phaseCommon,
            },
            {
              items: [{ price: target, quantity: 1 }],
              duration: { interval: 'month', interval_count: 1 },
              ...phaseCommon,
            },
          ],
        });
        effective = 'period_end';
        effectiveAt = end;
      }
    } catch (error) {
      if (error instanceof CatalogIncomplete) throw billingCatalogIncomplete();
      // A refusal or a silence of Stripe is a 502; anything else is ours, and a 500.
      throw billingProviderFailure(error);
    }
    await applyNow(billing, subscriptionId);
    deps.logger.info('billing_plan_change_requested', {
      account_id: encodeId('account', state.account_id),
      to: body.plan,
      effective,
    });
    const payload: BillingChangeResponse = {
      object: 'billing_change',
      plan: body.plan,
      effective,
      effective_at: effectiveAt === null ? null : new Date(effectiveAt * 1000).toISOString(),
      payment_url: paymentUrl,
    };
    return c.json(payload);
  });

  /** `POST /v1/dashboard/billing/change/cancel`: the scheduled move to Pro is cancelled. */
  routes.post('/billing/change/cancel', async (c) => {
    const dashboard = c.get('dashboard');
    const billing = billingDeps();
    const now = clock();
    const state = await billingState(dashboard.tokenHash, now);
    if (state === undefined) throw invalidSession();
    const subscriptionId = state.stripe_subscription_id;
    if (state.subscription_live !== true || subscriptionId === null) throw subscriptionMissing();
    if (state.scheduled_plan === null) {
      throw planChangeRefused('No change of plan is scheduled.', 'Nothing to cancel.');
    }
    try {
      const subscription = await billing.client.retrieveSubscription(subscriptionId);
      if (subscription.scheduleId !== null) {
        await billing.client.releaseSchedule(subscription.scheduleId);
      }
    } catch (error) {
      throw billingProviderFailure(error);
    }
    await applyNow(billing, subscriptionId);
    deps.logger.info('billing_plan_change_cancelled', {
      account_id: encodeId('account', state.account_id),
    });
    const payload: BillingChangeResponse = {
      object: 'billing_change',
      plan: (state.subscription_plan ?? 'scale') as BillingChangeResponse['plan'],
      effective: 'now',
      effective_at: new Date(now).toISOString(),
      payment_url: null,
    };
    return c.json(payload);
  });

  /** `POST /v1/dashboard/billing/portal`: the customer portal of Stripe, for an existing customer. */
  routes.post('/billing/portal', async (c) => {
    const dashboard = c.get('dashboard');
    const billing = billingDeps();
    const state = await billingState(dashboard.tokenHash, clock());
    if (state === undefined) throw invalidSession();
    if (state.stripe_customer_id === null) throw noBillingCustomer();
    let url: string;
    try {
      const configuration = await portalConfigurationId(billing.client);
      url = (
        await billing.client.createPortalSession({
          customer: state.stripe_customer_id,
          returnUrl: `${deps.siteUrl.replace(/\/+$/, '')}/dashboard/`,
          ...(configuration === null ? {} : { configuration }),
        })
      ).url;
    } catch (error) {
      throw billingProviderFailure(error);
    }
    const payload: BillingRedirect = { object: 'billing_portal', url };
    return c.json(payload);
  });

  /** `POST /v1/dashboard/projects/{id}/keys`: a new secret key, shown once. */
  routes.post('/projects/:id/keys', async (c) => {
    const dashboard = c.get('dashboard');
    const projectId = pathId(c, 'project', 'project');
    const body = await parseJsonBody(c, dashboardKeyCreateSchema);
    const generated = generateApiKey(body.environment);
    const keyId = uuidv7();

    const { rows } = await refusing(
      () =>
        withAuthContext(deps.db, (tx) =>
          tx.execute<KeyRow>(sql`
            SELECT id, environment, kind, name, prefix, NULL::text AS tenant_id,
                   created_at::text AS created_at, NULL::text AS last_used_at,
                   NULL::text AS revoked_at
              FROM dashboard_key_create(
                ${dashboard.tokenHash},
                ${projectId}::uuid,
                ${body.environment},
                ${keyId}::uuid,
                ${generated.prefix},
                ${generated.keyHash},
                ${body.name ?? `${body.environment} secret key`},
                ${nowIso()}::timestamptz
              )
          `),
        ),
      {
        P0401: invalidSession,
        P0404: () => errors.notFound('project', c.req.param('id') ?? ''),
        P0409: keyLimitReached,
        P0429: keyCreationRateLimited,
      },
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The key could not be created.');
    // The identifiers, never the key: the one line that says a key was minted from the dashboard.
    deps.logger.info('dashboard_key_created', {
      account_id: encodeId('account', dashboard.accountId),
      project_id: encodeId('project', projectId),
      api_key_id: encodeId('api_key', row.id),
      environment: row.environment,
    });

    const payload: DashboardApiKeyCreated = { ...serializeKey(row), secret_key: generated.key };
    return c.json(payload, 201);
  });

  /** `DELETE /v1/dashboard/keys/{id}`: revoke a key. The next request made with it is a 401. */
  routes.delete('/keys/:id', async (c) => {
    const dashboard = c.get('dashboard');
    const keyId = pathId(c, 'api_key', 'API key');

    const { rows } = await refusing(
      () =>
        withAuthContext(deps.db, (tx) =>
          tx.execute<KeyRow>(sql`
            SELECT id, environment, kind, name, prefix, tenant_id,
                   created_at::text AS created_at, last_used_at::text AS last_used_at,
                   revoked_at::text AS revoked_at
              FROM dashboard_key_revoke(
                ${dashboard.tokenHash},
                ${keyId}::uuid,
                ${nowIso()}::timestamptz
              )
          `),
        ),
      {
        P0401: invalidSession,
        P0404: () => errors.notFound('API key', c.req.param('id') ?? ''),
      },
    );
    const row = rows[0];
    if (row === undefined) throw errors.internal('The key could not be revoked.');
    deps.logger.info('dashboard_key_revoked', {
      account_id: encodeId('account', dashboard.accountId),
      api_key_id: encodeId('api_key', row.id),
      environment: row.environment,
    });
    return c.json(serializeKey(row));
  });

  /** `POST /v1/dashboard/logout`: the session ends now. */
  routes.post('/logout', async (c) => {
    const dashboard = c.get('dashboard');
    await withAuthContext(deps.db, (tx) =>
      tx.execute(sql`SELECT dashboard_session_revoke(${dashboard.tokenHash})`),
    );
    return c.body(null, 204);
  });

  return routes;
}
