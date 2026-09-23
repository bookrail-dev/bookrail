/**
 * `/v1/stripe`: how a customer's own Stripe account gets attached to their project.
 *
 * Bookrail is a Connect platform of the SaaS kind. The customer stays the merchant: charges are
 * made directly on their account, Stripe carries the risk and bills them its fees, and Bookrail
 * takes nothing and holds nothing. What that costs, in code, is this file: an OAuth round trip
 * whose whole job is to learn one string, `acct_...`, and write it down next to a project.
 *
 * **No key of the customer's ever enters Bookrail.** Not here, not in a column, not in a log.
 * The authorisation answers with an access token and a refresh token alongside the account
 * identifier, and both are dropped in `stripe/client.ts` before this file can see them: for a
 * Standard account they are a deprecated second way of doing what the platform key plus
 * `Stripe-Account` already does, so storing one would mean holding somebody else's secret for
 * nothing.
 *
 * ## The three authenticated routes, and the one that is not
 *
 * `POST /connect`, `GET /` and `DELETE /` take a secret key like every other route of `/v1`.
 * `GET /callback` cannot: it is followed by a browser returning from Stripe's own pages, and a
 * browser has no key. What ties that request to a project is the `state` parameter and nothing
 * else, which is why the state is 32 random bytes, stored only as a SHA-256, valid for fifteen
 * minutes, and consumed by a single `DELETE ... RETURNING` inside a `SECURITY DEFINER`
 * function. Somebody who intercepts an authorisation `code` cannot attach the account it
 * authorises to a project of their choosing, because they would also need a state that was
 * issued to that project and not yet used.
 *
 * ## The callback answers a person, not a program
 *
 * So it answers HTML, and it is the only thing in this API that does. The pages are plain text
 * in a minimal document, with no asset, no script and a `Content-Security-Policy` that forbids
 * loading anything at all. They are deliberately out of the OpenAPI registry
 * (`UNSPECIFIED_ROUTES`): a specification that described an HTML page as part of the JSON
 * contract would be describing something no SDK can call.
 *
 * ## What happens when Stripe does not answer
 *
 * The state has already been consumed by then, and it stays consumed. The page says so and says
 * to run `bookrail stripe connect` again, which issues a new one. The alternative, putting the
 * state back, would mean a state that survives an unknown number of uses, and the whole value
 * of a state is that it survives exactly one.
 */
import { Hono, type Context } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  paymentProviderConnections,
  withAuthContext,
  withProjectContext,
  type Transaction,
} from '@bookrail/db';
import { BookrailError, encodeId, uuidv7, type Environment } from '@bookrail/shared';
import { insertEvent } from '@bookrail/engine';
import type { StripeEnvironmentConfig, StripePlatformConfig } from '../config.js';
import type { AppDeps, AppEnv } from '../context.js';
import { eventActor, inProject, requireAuth } from '../http.js';
import type { StripeConnection, StripeConnectLink } from '../schemas/responses.js';
import { StripeApiError, StripeClient, StripeUnreachableError } from '../stripe/client.js';
import { stripeWebhookSecret } from '../stripe/platform.js';

/** How long an authorisation link works. Long enough to walk to a browser, short enough to expire. */
export const STRIPE_STATE_TTL_MS = 15 * 60 * 1000;

/** The scope a Standard account authorisation asks for: charge and read on its behalf. */
const OAUTH_SCOPE = 'read_write';

/** The only provider this build knows. The column is generic; the code is not, yet. */
const PROVIDER = 'stripe';

export function stripeNotConfigured(environment: Environment): BookrailError {
  const suffix = environment.toUpperCase();
  return new BookrailError(
    'internal',
    'stripe_not_configured',
    'Bookrail is not configured for Stripe payments in this environment.',
    undefined,
    `Set STRIPE_CLIENT_ID_${suffix}, STRIPE_SECRET_KEY_${suffix} and ` +
      `STRIPE_PUBLISHABLE_KEY_${suffix} on the deployment, then restart the API and the worker.`,
  );
}

function alreadyConnected(): BookrailError {
  return new BookrailError(
    'conflict',
    'stripe_already_connected',
    'This project already has a Stripe account connected in this environment.',
    undefined,
    'Run `bookrail stripe disconnect --yes` first, then connect again.',
  );
}

function noConnection(environment: Environment): BookrailError {
  return new BookrailError(
    'not_found',
    'resource_missing',
    `No Stripe account is connected to this project in the ${environment} environment.`,
    undefined,
    'Run `bookrail stripe connect` to connect one.',
  );
}

/**
 * Stripe refused, and the refusal was not one this route expects.
 *
 * The message carries Stripe's own `type` and `code` and nothing else of the answer: an error
 * body from Stripe echoes parts of the request that produced it, and this string ends up in a
 * log line, in a CLI output and possibly in a support ticket.
 */
export function stripeProviderError(error: StripeApiError): BookrailError {
  const code = error.code === undefined ? error.type : `${error.type}/${error.code}`;
  return new BookrailError(
    'internal',
    'stripe_provider_error',
    `Stripe refused the request (${code}).`,
    undefined,
    'Nothing was changed. Try again; if it keeps happening, quote the request id to support.',
  );
}

export function stripeUnreachable(): BookrailError {
  return new BookrailError(
    'internal',
    'stripe_unreachable',
    'Stripe did not answer in time.',
    undefined,
    'Nothing was changed. Try again in a minute.',
  );
}

/** SHA-256 of the clear text state, as the 32 bytes the `bytea` column holds. */
function stateHash(state: string): Buffer {
  return createHash('sha256').update(state, 'utf8').digest();
}

/** The subset of the connection row that the serializer and the routes need. */
interface ConnectionRow {
  id: string;
  providerAccountId: string;
  status: 'connected' | 'disconnected';
  connectedAt: Date;
  disconnectedAt: Date | null;
  disconnectReason: 'user' | 'deauthorized' | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The connection as `GET /v1/stripe` and `DELETE /v1/stripe` return it.
 *
 * `chargesEnabled` is passed in rather than read here: it comes from Stripe, and a serializer
 * has no business making an HTTP request.
 */
export function serializeConnection(options: {
  row: ConnectionRow | null;
  environment: Environment;
  publishableKey: string | null;
  chargesEnabled: boolean | null;
  /**
   * Whether this deployment holds the signing secret of the incoming Stripe webhook endpoint of
   * this environment.
   *
   * A property of the **deployment**, not of the connection, and reported next to the
   * connection because that is where somebody looking for it would look: a project whose
   * account is connected and whose deployment has no webhook secret can start payments and will
   * never see one confirmed, because nothing is listening for the event that confirms them.
   * `bookrail doctor` reads it.
   */
  webhookConfigured: boolean;
}): StripeConnection {
  const { row, environment, publishableKey } = options;
  if (row === null) {
    return {
      object: 'stripe_connection',
      status: 'not_connected',
      environment,
      id: null,
      account_id: null,
      publishable_key: publishableKey,
      connected_at: null,
      disconnected_at: null,
      disconnect_reason: null,
      charges_enabled: null,
      webhook_configured: options.webhookConfigured,
    };
  }
  return {
    object: 'stripe_connection',
    status: row.status === 'connected' ? 'connected' : 'disconnected',
    environment,
    id: encodeId('payment_provider_connection', row.id),
    account_id: row.providerAccountId,
    publishable_key: publishableKey,
    connected_at: row.connectedAt.toISOString(),
    disconnected_at: iso(row.disconnectedAt),
    disconnect_reason: row.disconnectReason,
    charges_enabled: row.status === 'connected' ? options.chargesEnabled : null,
    webhook_configured: options.webhookConfigured,
  };
}

/**
 * The `data.object` of `stripe.connected` and `stripe.disconnected`.
 *
 * The platform's publishable key is in the API response because a front end needs it, and is
 * **not** in the event: an event is delivered to a customer's own endpoint over the network,
 * and a value nothing there has to use has no reason to travel.
 */
function connectionEventData(connection: StripeConnection): Record<string, unknown> {
  // `webhook_configured` goes the same way and for the same reason: it is a fact about this
  // deployment's environment file, not about the customer's connection, and an event delivered
  // over the public network has no business carrying one.
  const {
    publishable_key: _publishableKey,
    webhook_configured: _webhookConfigured,
    ...rest
  } = connection;
  return rest;
}

export function stripeRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /** The platform configuration of one environment, or the 503 that says there is none. */
  function platform(environment: Environment): {
    config: StripePlatformConfig;
    environmentConfig: StripeEnvironmentConfig;
    client: StripeClient;
  } {
    const config = deps.stripe;
    if (config === undefined || config === null) throw stripeNotConfigured(environment);
    const environmentConfig = config.environments[environment];
    if (environmentConfig === null) throw stripeNotConfigured(environment);
    return {
      config,
      environmentConfig,
      client: new StripeClient({
        secretKey: environmentConfig.secretKey,
        clientId: environmentConfig.clientId,
        apiBase: config.apiBase,
        connectBase: config.connectBase,
      }),
    };
  }

  /** The platform's publishable key for an environment, or `null` when there is none. */
  function publishableKeyOf(environment: Environment): string | null {
    return deps.stripe?.environments[environment]?.publishableKey ?? null;
  }

  /** Does this deployment hold the incoming webhook secret of that environment? */
  function webhookConfiguredIn(environment: Environment): boolean {
    return stripeWebhookSecret(deps.stripe, environment) !== null;
  }

  /**
   * `POST /v1/stripe/connect`: mint a state and hand back the authorisation URL.
   *
   * It honours `Idempotency-Key` like every POST of `/v1`, which means the middleware stores
   * this body, URL and clear text `state` included, for twenty-four hours. That is considered
   * and accepted rather than overlooked. Unlike a webhook signing secret, which is the only
   * thing standing between a customer's endpoint and a forged payload, this state can do one
   * thing and one only: attach an account to **this** project, the project whose own
   * `idempotency_keys` rows these are, and only within its fifteen minutes. A caller who can
   * read them is a caller who could have asked for a fresh link anyway.
   */
  routes.post('/connect', async (c) => {
    const auth = requireAuth(c);
    const { config, environmentConfig } = platform(auth.environment);

    const expiresAt = new Date(Date.now() + STRIPE_STATE_TTL_MS);
    const state = randomBytes(32).toString('base64url');

    await inProject(c, deps, async (tx) => {
      const existing = await loadConnection(tx, auth.projectId, auth.environment);
      // Refused rather than replaced: a project that is already charging on one account and
      // silently starts charging on another is the worst outcome this endpoint could have.
      if (existing?.status === 'connected') throw alreadyConnected();
      await tx.execute(sql`
        INSERT INTO stripe_oauth_states (id, project_id, environment, state_hash, api_key_id,
                                         expires_at)
        VALUES (${uuidv7()}::uuid, ${auth.projectId}::uuid, ${auth.environment},
                ${stateHash(state)}, ${auth.apiKeyId}::uuid,
                ${expiresAt.toISOString()}::timestamptz)
      `);
    });
    c.set('effectCommitted', true);

    const url = new URL(`${config.connectBase}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    // The `client_id` of **this** environment: a Stripe OAuth application is itself live or
    // test, and it is the application that decides the `livemode` of the authorisation it
    // produces. One shared `ca_` would make one of the two environments impossible to connect.
    url.searchParams.set('client_id', environmentConfig.clientId);
    url.searchParams.set('scope', OAUTH_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', config.redirectUrl);

    const payload: StripeConnectLink = {
      object: 'stripe_connect_link',
      url: url.toString(),
      expires_at: expiresAt.toISOString(),
      environment: auth.environment,
    };
    return c.json(payload, 201);
  });

  /**
   * `GET /v1/stripe/callback`: the browser comes back from Stripe.
   *
   * **No API key**, so everything below is written as if the caller were hostile, because it
   * might be. The order matters: the state is checked and consumed before the `code` is used
   * for anything at all, so a request carrying a valid code and no state costs one page and
   * writes nothing.
   */
  routes.get('/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    const oauthError = c.req.query('error') ?? '';

    // 1. A state that is not even the right shape is refused before the database is touched.
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(state)) {
      return page(c, 400, 'That link is not valid', [
        'The address you followed carries no usable state parameter.',
        'Run `bookrail stripe connect` again to get a fresh link.',
      ]);
    }

    // 2. Consumed here, once, whatever happens next.
    const claimed = (
      await withAuthContext(deps.db, (tx) =>
        tx.execute<{ project_id: string; environment: Environment; api_key_id: string }>(
          sql`SELECT project_id, environment, api_key_id
                FROM stripe_oauth_state_claim(${stateHash(state)})`,
        ),
      )
    ).rows[0];
    if (claimed === undefined) {
      return page(c, 400, 'That link has expired or has already been used', [
        'An authorisation link works once, and for fifteen minutes.',
        'Run `bookrail stripe connect` again to get a fresh one.',
      ]);
    }
    const projectId = claimed.project_id;
    const environment = claimed.environment;

    // 3. The customer said no on Stripe's pages. Nothing to write, and nothing went wrong.
    if (oauthError !== '') {
      return page(c, 200, 'Nothing was connected', [
        'The authorisation was not granted, so no Stripe account was attached to this project.',
        'Run `bookrail stripe connect` again if you change your mind.',
      ]);
    }

    if (code === '') {
      return page(c, 400, 'That link is not valid', [
        'Stripe sent no authorisation code back.',
        'Run `bookrail stripe connect` again to get a fresh link.',
      ]);
    }

    // The credentials could have been taken off the deployment between the `POST /connect` and
    // this request. Answered as a page, like every other outcome here: this route talks to a
    // person in a browser, and the JSON envelope the three keyed routes produce would be the
    // wrong thing to show them.
    let client;
    try {
      client = platform(environment).client;
    } catch {
      return page(c, 502, 'Stripe is not configured on this deployment', [
        'The authorisation could not be completed, and nothing was changed.',
        'Whoever runs this deployment has to configure its Stripe credentials.',
      ]);
    }

    let authorised;
    try {
      authorised = await client.oauthToken({ code });
    } catch (error) {
      if (!(error instanceof StripeApiError) && !(error instanceof StripeUnreachableError)) {
        throw error;
      }
      deps.logger.warn('stripe_oauth_exchange_failed', {
        project_id: encodeId('project', projectId),
        environment,
        error_code: error instanceof StripeApiError ? error.type : error.reason,
      });
      return page(c, 502, 'Stripe could not be reached', [
        'The authorisation could not be completed, and nothing was changed.',
        'Run `bookrail stripe connect` again to try once more.',
      ]);
    }

    // 4. An authorisation granted in the wrong mode is a mistake with consequences: a live
    //    project charging a test account takes no money, and a test project charging a live one
    //    takes real money. The database refuses the row too (`CHECK (livemode = ...)`); this is
    //    where the person is told why.
    if (authorised.livemode !== (environment === 'live')) {
      return page(c, 400, 'That account was authorised in the wrong mode', [
        `This link was for the ${environment} environment, and Stripe authorised the other one.`,
        environment === 'live'
          ? 'Leave test mode in your Stripe dashboard and run `bookrail stripe connect --live` again.'
          : 'Switch your Stripe dashboard into test mode and run `bookrail stripe connect` again.',
      ]);
    }

    const written = await withProjectContext(deps.db, { projectId, environment }, async (tx) => {
      const now = new Date();
      // `DO UPDATE ... WHERE status = 'disconnected'` is what makes the refusal of
      // `POST /connect` real rather than advisory. Without the guard, two links minted while a
      // project had no connection could be authorised one after the other and the second would
      // silently move the project's money to another account; so could a link held by somebody
      // whose key was revoked in the meantime. The row is only ever written when there is
      // nothing live to overwrite, and zero rows back is a refusal, not a retry.
      const written = await tx
        .insert(paymentProviderConnections)
        .values({
          id: uuidv7(),
          projectId,
          environment,
          provider: PROVIDER,
          providerAccountId: authorised.stripeUserId,
          status: 'connected',
          connectedAt: now,
          // What Stripe said, not what we expected: the check of the previous step has already
          // compared the two, and writing back the verified value keeps the `CHECK` of the
          // migration a second net instead of a tautology.
          livemode: authorised.livemode,
        })
        // A project that disconnected and comes back reuses its row: one connection per
        // project, environment and provider, for ever.
        .onConflictDoUpdate({
          target: [
            paymentProviderConnections.projectId,
            paymentProviderConnections.environment,
            paymentProviderConnections.provider,
          ],
          set: {
            providerAccountId: authorised.stripeUserId,
            status: 'connected',
            connectedAt: now,
            disconnectedAt: null,
            disconnectReason: null,
            livemode: authorised.livemode,
            updatedAt: now,
          },
          setWhere: eq(paymentProviderConnections.status, 'disconnected'),
        })
        .returning();

      const row = written[0];
      if (row === undefined) {
        // Nothing was written, so nothing is said in the event log either: the project is
        // already connected, and this is a link that arrived too late to matter.
        const existing = await loadConnection(tx, projectId, environment);
        return { refused: existing?.providerAccountId ?? 'another account' } as const;
      }

      // Every other link of this project and environment dies here. One that stayed redeemable
      // after a connection exists could do nothing useful and could do the harm above.
      await tx.execute(sql`
        DELETE FROM stripe_oauth_states
         WHERE project_id = ${projectId}::uuid AND environment = ${environment}
      `);

      const connection = serializeConnection({
        row,
        environment,
        publishableKey: publishableKeyOf(environment),
        chargesEnabled: null,
        webhookConfigured: webhookConfiguredIn(environment),
      });
      // The actor is the key that asked for the link, carried here by the state row: the
      // browser that completed the flow has no credential of its own, and an event that said
      // `system` would be claiming nobody asked for this.
      await insertEvent(
        tx,
        projectId,
        environment,
        'stripe.connected',
        connectionEventData(connection),
        {
          actor: { type: 'api', id: encodeId('api_key', claimed.api_key_id) },
        },
      );
      const project = await tx.execute<{ name: string }>(
        sql`SELECT name FROM projects WHERE id = ${projectId}::uuid`,
      );
      return {
        refused: null,
        connection,
        projectName: project.rows[0]?.name ?? 'Your project',
      } as const;
    });

    if (written.refused !== null) {
      return page(c, 409, 'This project is already connected', [
        `It is connected to ${written.refused}, and nothing was changed.`,
        'Run `bookrail stripe disconnect --yes` first if you meant to change account.',
      ]);
    }

    return page(c, 200, 'Stripe is connected', [
      `${written.projectName} (${environment}) will charge on ${written.connection.account_id ?? ''}.`,
      'You can close this tab.',
      'Run `bookrail stripe status` in your terminal to see it from there.',
    ]);
  });

  /** `GET /v1/stripe`: the state of the link, plus what Stripe says about the account. */
  routes.get('/', async (c) => {
    const auth = requireAuth(c);
    const { client } = platform(auth.environment);

    const row = await inProject(c, deps, (tx) =>
      loadConnection(tx, auth.projectId, auth.environment),
    );

    let chargesEnabled: boolean | null = null;
    if (row?.status === 'connected') {
      try {
        chargesEnabled = (await client.retrieveAccount({ stripeUserId: row.providerAccountId }))
          .chargesEnabled;
      } catch (error) {
        // The field is informative and the rest of the answer comes from our own database, so a
        // provider having a slow minute must not turn a read into a failure. `null` and `false`
        // are two different answers and the schema says which is which.
        if (!(error instanceof StripeApiError) && !(error instanceof StripeUnreachableError)) {
          throw error;
        }
        deps.logger.warn('stripe_account_read_failed', {
          project_id: encodeId('project', auth.projectId),
          environment: auth.environment,
          error_code: error instanceof StripeApiError ? error.type : error.reason,
        });
      }
    }

    return c.json(
      serializeConnection({
        row,
        environment: auth.environment,
        publishableKey: publishableKeyOf(auth.environment),
        chargesEnabled,
        webhookConfigured: webhookConfiguredIn(auth.environment),
      }),
    );
  });

  /**
   * `DELETE /v1/stripe`: end the link.
   *
   * Stripe is told first, because what is being asked for is that the platform's access be
   * gone, and **only a refusal that means it is already gone is treated as success**. On
   * `/oauth/deauthorize` that is `invalid_grant`, which Stripe's OAuth reference does not
   * actually list for this endpoint; `invalid_client`, which it does list, covers four
   * different things and only one of them ("`stripe_user_id` doesn't exist or isn't connected
   * to your application") is the harmless one. The other three are a wrong `client_id`, a key
   * of the wrong mode, and an account Stripe refuses to disconnect, and in every one of them
   * the platform keeps its access to the customer's account. Writing `disconnected` on any of
   * those would tell a customer they had revoked something they had not, so they are a
   * `502 stripe_provider_error` and a `warn` line, and nothing is written.
   *
   * Stripe gives no stable `error_description` to tell the four apart, so they are not told
   * apart. The cost is named in the report and in the debt: a customer who revoked from their
   * own Stripe dashboard cannot make this endpoint agree with reality until the incoming
   * webhook exists.
   */
  routes.delete('/', async (c) => {
    const auth = requireAuth(c);
    const { client } = platform(auth.environment);

    const existing = await inProject(c, deps, (tx) =>
      loadConnection(tx, auth.projectId, auth.environment),
    );
    if (existing === null || existing.status !== 'connected') throw noConnection(auth.environment);

    try {
      await client.oauthDeauthorize({ stripeUserId: existing.providerAccountId });
    } catch (error) {
      if (error instanceof StripeUnreachableError) throw stripeUnreachable();
      if (!(error instanceof StripeApiError)) throw error;
      if (error.code !== 'invalid_grant') {
        // The one path that used to be completely silent. It is the path an operator has to be
        // able to read, because it is the one where our record and Stripe's disagree.
        deps.logger.warn('stripe_deauthorize_refused', {
          project_id: encodeId('project', auth.projectId),
          environment: auth.environment,
          error_type: error.type,
          error_code: error.code ?? 'none',
          request_id: error.requestId ?? 'none',
        });
        throw stripeProviderError(error);
      }
    }

    const connection = await inProject(c, deps, async (tx, authContext) => {
      const now = new Date();
      // The read above and this write are two transactions (a call to Stripe cannot sit inside
      // one), so the row can have moved in between: a callback can have reconnected the very
      // same row. The guard is the whole difference between marking a revocation and marking
      // somebody else's fresh connection as revoked.
      const updated = await tx
        .update(paymentProviderConnections)
        .set({
          status: 'disconnected',
          disconnectedAt: now,
          disconnectReason: 'user',
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentProviderConnections.id, existing.id),
            eq(paymentProviderConnections.status, 'connected'),
            eq(paymentProviderConnections.providerAccountId, existing.providerAccountId),
          ),
        )
        .returning();
      const row = updated[0];
      if (row === undefined) return null;

      const serialized = serializeConnection({
        row,
        environment: authContext.environment,
        publishableKey: publishableKeyOf(authContext.environment),
        chargesEnabled: null,
        webhookConfigured: webhookConfiguredIn(authContext.environment),
      });
      await insertEvent(
        tx,
        authContext.projectId,
        authContext.environment,
        'stripe.disconnected',
        connectionEventData(serialized),
        { actor: eventActor(c, authContext) },
      );
      return serialized;
    });
    if (connection === null) throw noConnection(auth.environment);
    c.set('effectCommitted', true);

    return c.json(connection);
  });

  return routes;
}

/** The one connection of a project and environment, or `null`. */
async function loadConnection(
  tx: Transaction,
  projectId: string,
  environment: Environment,
): Promise<ConnectionRow | null> {
  const rows = await tx
    .select()
    .from(paymentProviderConnections)
    .where(
      and(
        eq(paymentProviderConnections.projectId, projectId),
        eq(paymentProviderConnections.environment, environment),
        eq(paymentProviderConnections.provider, PROVIDER),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The only HTML this API serves: one heading, a few sentences, nothing else.
 *
 * No stylesheet, no script, no image, no font, and a `Content-Security-Policy` that allows none
 * of them. The page is read once, by a person who has just authorised a payment account, and
 * the smallest thing that says what happened is also the thing with nothing in it to get wrong.
 *
 * `Referrer-Policy` is here rather than left to nginx: the query string of this URL carries an
 * authorisation code, and it must not travel in a `Referer` header to anywhere at all.
 */
function page(
  c: Context<AppEnv>,
  status: 200 | 400 | 409 | 502,
  heading: string,
  paragraphs: readonly string[],
): Response {
  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(heading)}</title>`,
    '<style>body{font:16px/1.6 system-ui,sans-serif;margin:0 auto;padding:3rem 1.5rem;' +
      'max-width:34rem}h1{font-size:1.4rem;margin:0 0 1rem}</style>',
    '</head><body>',
    `<h1>${escapeHtml(heading)}</h1>`,
    ...paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`),
    '</body></html>',
  ].join('');
  return c.body(body, status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
}

/**
 * Safe in both HTML contexts, not only the one used today.
 *
 * Every value interpolated below lands in text content, never in an attribute, so the
 * apostrophe is not needed for anything that exists now. It is escaped anyway: the day somebody
 * puts one of these values inside `attribute='...'` the function has to already be right, and
 * one more `replaceAll` is cheaper than remembering.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
