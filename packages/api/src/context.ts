import type { Database } from '@bookrail/db';
import type { AvailabilityCache } from '@bookrail/engine';
import type { Environment, Logger } from '@bookrail/shared';
import type { Mailer } from './mail/index.js';
import type { RateLimiter } from './rate-limit.js';
import type { UsageCounters } from './usage-counters.js';

export interface AuthContext {
  apiKeyId: string;
  projectId: string;
  environment: Environment;
  kind: 'secret' | 'publishable';
  scopes: string[];
  tenantId: string | null;
}

/** One policy: how fast, and how much of it may arrive at once. */
export interface RateLimitPolicy {
  /** Requests a second, sustained. */
  rate: number;
  /** Requests accepted in one instant, which is also the value of `RateLimit-Limit`. */
  burst: number;
}

export interface RateLimitSettings {
  limiter: RateLimiter;
  /**
   * The policy per environment of the key, not per plan.
   *
   * There are no plans, so there is nothing to read one from; what there is instead is the one
   * distinction that already exists and already means something, which is whether the key is a
   * test key or a live one. A test key belongs to somebody exploring the API, a live key to
   * somebody serving customers with it, and the second deserves the higher ceiling.
   */
  limits: Readonly<Record<Environment, RateLimitPolicy>>;
}

export interface AppDeps {
  /** Connections as the RLS-bound application role. Everything user facing goes here. */
  db: Database;
  /** Superuser connection. Only POST /internal/bootstrap and migrations use it. */
  adminDb: Database;
  logger: Logger;
  /**
   * The availability cache, keyed by (resource, local day). Never optional: a
   * deployment that wants no cache passes `NoAvailabilityCache`, so no call site has to
   * remember that it might be missing.
   */
  cache: AvailabilityCache;
  bootstrapToken: string | undefined;
  /**
   * The 32 bytes of `WEBHOOK_SECRET_KEY`, which encrypt every webhook signing secret at rest.
   * A signing secret has to be reproduced at every delivery to compute the HMAC, so unlike an
   * API key it cannot be stored as a hash; it is encrypted instead, and the key that decrypts
   * it lives in the environment and never in the database.
   *
   * `undefined` means the deployment has not configured one, and the webhook endpoints then
   * answer `500` instead of storing a secret in the clear. Fail closed: a signing secret is
   * the only thing standing between a customer's endpoint and a forged booking.
   */
  webhookSecretKey: Buffer | undefined;
  /**
   * How the confirmation message of a sign up is sent.
   *
   * `undefined` means self service sign up is switched off, and the three `/v1/signups` routes
   * answer `503 signup_disabled` with the address to write to instead. That is deliberate
   * rather than a failure: a deployment with no mail configuration still serves the API, and
   * the website still has something true to say on its sign up page.
   */
  mailer: Mailer | undefined;
  /** Where the confirmation link points. `https://bookrail.dev` in production. */
  siteUrl: string;
  /** The one origin allowed to call `/v1/signups` from a browser. */
  siteOrigin: string;
  /**
   * The per key rate limit, or nothing at all.
   *
   * `undefined` switches the middleware off completely: no Redis call, no header, no refusal.
   * That is what `RATE_LIMIT=off` asks for, and it is the default of a test harness that is
   * measuring something else, because a suite that fires hundreds of requests at one key in a
   * second would otherwise be measuring the limiter.
   */
  rateLimit?: RateLimitSettings;
  /**
   * Where the per project request counters of the daily digest are kept, or nothing.
   *
   * `undefined` means nothing is counted: a deployment with no `REDIS_URL`, and every test
   * that is about something else. The digest then prints that the counts are unavailable
   * rather than printing zero, because an absence and a zero are the two answers a daily
   * report must never confuse (`src/usage-counters.ts`).
   */
  usageCounters?: UsageCounters;
  /**
   * Read `X-Forwarded-For` as the caller's address even when the request arrived over no socket.
   *
   * **Deliberately not readable from the environment**, like `allowPrivateWebhookTargets` and
   * `contractGuard`, and for the same kind of reason: it decides whether a limit counts what the
   * caller says about itself. In a deployment the request always arrives over a socket, and the
   * header is trusted only when that socket is loopback, which is where the reverse proxy is.
   * The one caller with no socket is the API driven in process by a test, which is the only
   * thing that passes this.
   */
  trustForwardedFor?: boolean;
  /**
   * Let webhooks point at loopback and private addresses.
   *
   * **Deliberately not readable from the environment.** A flag that turns the SSRF guard off
   * is a flag that ends up set in production by somebody debugging at two in the morning; this
   * one can only be passed in code, and the only caller that passes it is the test suite, which
   * has to deliver to a `node:http` server on 127.0.0.1.
   */
  allowPrivateWebhookTargets?: boolean;
  /**
   * Mount the contract guard of `src/openapi/contract.ts`, which validates every response
   * against the schema the OpenAPI document declares for it.
   *
   * **Deliberately not readable from the environment**, like the flag above and for a related
   * reason: it is a build-time proof, not a feature. In production it would cost a second full
   * validation of every response to check something the test suite has already checked, and a
   * deployment that turned it on by accident would pay that on every request. The only caller
   * that passes it is `test/harness.ts`.
   */
  contractGuard?: boolean;
}

/**
 * The `Bookrail-Actor` request header.
 *
 * A client may declare **which of our own tools it is**, so that a write made from the MCP
 * server can be told apart from a write made by the customer's own application at equal API
 * key. The CLI declares `cli` and the MCP server `mcp`: the server sets the `BOOKRAIL_ACTOR`
 * variable the CLI reads **last**, so an ambient value cannot make it claim to be something
 * else, and a value outside the list is ignored rather than fatal.
 *
 * **The list is closed, and that is the whole design.** `events` is append-only and the
 * application role has no `UPDATE` on it: a free-text field here would be a string chosen by
 * the caller, written for ever, into the record that says who did what. Four values, validated
 * before anything is written, and an unknown one is a `400 parameter_invalid` rather than a
 * silently ignored header: a client that believes it is being logged has to be right.
 *
 * It is a **claim**, not an identity. Nothing stops a caller from sending `dashboard` while
 * running a shell script; the header says how the request presents itself, and the credential
 * (`actor.id`) stays the thing that was actually authenticated.
 */
export const API_ACTORS = ['mcp', 'cli', 'sdk', 'dashboard'] as const;

export type ApiActor = (typeof API_ACTORS)[number];

export const ACTOR_HEADER = 'Bookrail-Actor';

export interface AppVariables {
  requestId: string;
  apiVersion: string;
  auth: AuthContext;
  /**
   * The value of `Bookrail-Actor`, when the caller sent one. Absent means absent: the `via`
   * field is then not written at all, rather than written as `null`, because "this request did
   * not say" and "this request said nothing" are the same fact and one representation is
   * enough.
   */
  actorVia: ApiActor;
  /** Set when a request ends in an error, so the access log can name the failure. */
  errorCode: string;
  /**
   * Set by a write route the instant its transaction has **committed**, before anything that
   * could still fail (the cache invalidation, the re-read, the serialization).
   *
   * It is what tells the `Idempotency-Key` middleware whether a 5xx means "nothing happened"
   * or "it happened and then the answer got lost". Only the first may release the key; the
   * second must be remembered, or a retry books a second time.
   */
  effectCommitted: boolean;
  /**
   * What the `Idempotency-Key` middleware should **store**, when that is not the response body.
   *
   * There is exactly one endpoint where the two differ, and it is the reason this exists:
   * `POST /v1/webhooks` returns the signing secret in its body, once. The middleware persists
   * the body of every POST of `/v1` in `idempotency_keys.response_body` for 24 hours, so
   * without this the secret sat in the database in the clear, and came back on every replay of
   * the same key, which is not what "shown once" means.
   *
   * A route sets it to the object it is willing to have remembered. Everything else leaves it
   * unset and the middleware clones the response, exactly as before.
   */
  idempotencyResponseBody: unknown;
}

export interface AppEnv {
  Variables: AppVariables;
}
