/**
 * `POST /v1/bookings`, `GET /v1/bookings/{id}`, `GET /v1/bookings`.
 *
 * The creation is the engine's transaction (with `hold_id` it converts a hold instead of taking
 * new capacity), and this route adds only what HTTP owes: the customer, inline or by id; the
 * two documented-but-unimplemented fields refused explicitly rather than ignored; the response
 * rebuilt from the row that was actually written; and the availability cache dropped for the
 * days the write touched.
 *
 * **Why the response is re-read.** The engine already returns everything the response needs,
 * and building it from there would save a query. It is built from the `bookings` row and its
 * `booking_allocations` instead, so that the object returned by the creation and the object
 * returned by `GET /v1/bookings/{id}` come out of one serializer. Two serializers for one
 * resource is how a `status` or an `amount_due` ends up meaning two things.
 *
 * **`recurrence`** is in the reference documentation and does not exist: a caller that sends one
 * gets a 400 saying so, because silently ignoring it would let an integration believe it had
 * created a series. The same is true of `payment.mode: "entitlement"`.
 *
 * ## The payment, and why it is three steps and not one
 *
 * `payment.mode` of `deposit` or `full` makes the creation a sequence, and the order is the
 * whole design:
 *
 * 1. **before the transaction**, the two checks that can be made without it: is this deployment
 *    a Stripe platform in this environment, and has this project connected an account. Both are
 *    a single read each, and failing here costs no advisory lock at all;
 * 2. **the transaction**, which freezes the price, computes the amount from it, writes the
 *    booking as `pending` with its deadline and writes the `payments` row with no intent yet.
 *    The amount is computed here and not earlier because a pricing rule decides the price and
 *    the frozen price is the only honest input;
 * 3. **after the commit**, the call to Stripe. Never inside: that transaction holds an advisory
 *    lock on every candidate resource of the service, and ten seconds of somebody else's
 *    network inside those locks is ten seconds in which nobody can book that resource.
 *
 * If step 3 fails the booking is cancelled immediately, which releases the capacity and emits
 * `booking.cancelled`, and the caller gets a `502` naming the booking that no longer exists. If
 * even that fails, nothing is stranded for longer than the payment deadline: the scheduler
 * expires it.
 */
import { Hono } from 'hono';
import { and, asc, eq, exists, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  bookingAllocations,
  bookings,
  customers,
  payments,
  paymentProviderConnections,
  resources,
  type Transaction,
} from '@bookrail/db';
import {
  claimReachedWarnings,
  createBooking,
  stripeNotConnected,
  transition,
  HTTP_TRANSITION_ACTIONS,
  PARAMETERISED_TRANSITION_ACTIONS,
  type CreateBookingResult,
  type TransitionAction,
} from '@bookrail/engine';
import { BookrailError, encodeId, errors, type Environment } from '@bookrail/shared';
import { StripeApiError, StripeUnreachableError } from '../stripe/client.js';
import { stripePlatform } from '../stripe/platform.js';
import { stripeProviderError, stripeUnreachable } from './stripe.js';
import { sendPlanWarnings } from '../plan.js';
import type { AppDeps, AppEnv, AuthContext } from '../context.js';
import { invalidateTouchedDays } from '../cache.js';
import { assertCustomerExists, upsertCustomer } from '../customers.js';
import {
  eventActor,
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseExpand,
  parseJsonBody,
  parseListParams,
  parseOptionalJsonBody,
  parseQuery,
  pathId,
  requireAuth,
} from '../http.js';
import {
  bookingActionSchema,
  bookingCancelSchema,
  bookingCreateSchema,
  bookingListQuerySchema,
  bookingRescheduleSchema,
} from '../schemas/index.js';
import { serializeBooking, type AllocationView } from '../serialize.js';
import type { Booking } from '../schemas/responses.js';

const EXPANDABLE = ['customer', 'allocations.resource', 'payments'] as const;

/** Stripe caps a PaymentIntent `description` at this; the value is built, so it is capped here. */
const MAX_DESCRIPTION = 200;

type BookingRow = typeof bookings.$inferSelect;

async function allocationsOf(
  tx: Transaction,
  bookingIds: readonly string[],
): Promise<Map<string, AllocationView[]>> {
  const byBooking = new Map<string, AllocationView[]>();
  if (bookingIds.length === 0) return byBooking;
  const rows = await tx
    .select()
    .from(bookingAllocations)
    .where(inArray(bookingAllocations.bookingId, [...bookingIds]))
    .orderBy(asc(bookingAllocations.id));
  for (const row of rows) {
    const list = byBooking.get(row.bookingId) ?? [];
    list.push({
      id: row.id,
      resourceId: row.resourceId,
      role: row.role,
      capacityUsed: row.capacityUsed,
    });
    byBooking.set(row.bookingId, list);
  }
  return byBooking;
}

/** Serializes a page of bookings, resolving the requested expansions in one query each. */
async function serializePage(
  tx: Transaction,
  rows: readonly BookingRow[],
  expand: Set<string>,
): Promise<Booking[]> {
  const allocations = await allocationsOf(
    tx,
    rows.map((row) => row.id),
  );

  let customerRows: Map<string, typeof customers.$inferSelect> | null = null;
  if (expand.has('customer')) {
    const ids = [...new Set(rows.map((row) => row.customerId).filter((id) => id !== null))];
    customerRows = new Map();
    if (ids.length > 0) {
      for (const row of await tx.select().from(customers).where(inArray(customers.id, ids))) {
        customerRows.set(row.id, row);
      }
    }
  }

  let resourceRows: Map<string, typeof resources.$inferSelect> | undefined;
  if (expand.has('allocations.resource')) {
    const ids = [
      ...new Set([...allocations.values()].flat().map((allocation) => allocation.resourceId)),
    ];
    resourceRows = new Map();
    if (ids.length > 0) {
      for (const row of await tx.select().from(resources).where(inArray(resources.id, ids))) {
        resourceRows.set(row.id, row);
      }
    }
  }

  let paymentRows: Map<string, (typeof payments.$inferSelect)[]> | undefined;
  if (expand.has('payments')) {
    paymentRows = new Map();
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      const found = await tx
        .select()
        .from(payments)
        .where(inArray(payments.bookingId, ids))
        .orderBy(asc(payments.createdAt), asc(payments.id));
      for (const row of found) {
        if (row.bookingId === null) continue;
        const list = paymentRows.get(row.bookingId) ?? [];
        list.push(row);
        paymentRows.set(row.bookingId, list);
      }
    }
  }

  return rows.map((row) =>
    serializeBooking(row, allocations.get(row.id) ?? [], {
      ...(customerRows === null
        ? {}
        : {
            customer: row.customerId === null ? null : (customerRows.get(row.customerId) ?? null),
          }),
      ...(resourceRows === undefined ? {} : { resources: resourceRows }),
      ...(paymentRows === undefined ? {} : { payments: paymentRows.get(row.id) ?? [] }),
    }),
  );
}

/**
 * The customer the write will be attributed to.
 *
 * Resolved **before** the booking transaction and in its own transaction, on purpose: the
 * engine's transaction holds an advisory lock on every candidate resource of the service, and
 * an upsert into `customers` inside it would hold those locks while writing an unrelated
 * table. The cost of getting it wrong is measured in milliseconds of contention per booking,
 * which is exactly the kind of thing that only shows up in production.
 */
async function resolveCustomerId(
  c: Parameters<typeof inProject>[0],
  deps: AppDeps,
  body: { customer_id?: string | null | undefined; customer?: Record<string, unknown> | undefined },
): Promise<string | null> {
  const inline = body.customer;
  if (inline === undefined) {
    const given = body.customer_id ?? null;
    if (given === null) return null;
    // Checked here rather than left to the foreign key: a customer of another project has to
    // answer `404 resource_missing` like every other reference in this body.
    await inProject(c, deps, (tx) => assertCustomerExists(tx, given));
    return given;
  }
  const result = await inProject(c, deps, (tx, auth: AuthContext) =>
    upsertCustomer(tx, auth, inline, { matchByEmail: true }),
  );
  return result.row.id;
}

/**
 * The `acct_...` this project charges on, or the error that says why it cannot charge.
 *
 * Two refusals, and they are different problems for different people: `503
 * stripe_not_configured` is about the **deployment** and is fixed by whoever runs it, and `409
 * stripe_not_connected` is about the **project** and is fixed by its own owner with one
 * command, which the `fix` names.
 *
 * A connection in state `disconnected` is not a connection: the row exists because the project
 * connected once, and charging on an account whose authorisation has been revoked would fail at
 * Stripe with a worse message than this one.
 */
async function connectedAccount(
  c: Parameters<typeof inProject>[0],
  deps: AppDeps,
  environment: Environment,
): Promise<string> {
  // Throws `503 stripe_not_configured` when this deployment is not a platform here.
  stripePlatform(deps.stripe, environment);
  const row = await inProject(c, deps, async (tx, auth) => {
    const rows = await tx
      .select()
      .from(paymentProviderConnections)
      .where(
        and(
          eq(paymentProviderConnections.projectId, auth.projectId),
          eq(paymentProviderConnections.environment, environment),
          eq(paymentProviderConnections.provider, 'stripe'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
  if (row === null || row.status !== 'connected') {
    throw stripeNotConnected(
      `This project has no Stripe account connected in the ${environment} environment, so it cannot take a payment.`,
    );
  }
  return row.providerAccountId;
}

/**
 * Leaves a payment whose intent may or may not exist queued for the worker to settle.
 *
 * The row keeps `pending`, because that is the honest word for "we do not know", and it carries
 * `cancel_intent` with `pending_action_next_at` set to now so the next tick picks it up.
 * `failure_code` is `unreachable`, which is what tells the worker that the intent identifier is
 * missing because the answer was lost rather than because nothing was ever created.
 */
async function queueUnknownIntentCancellation(
  c: Parameters<typeof inProject>[0],
  deps: AppDeps,
  paymentId: string,
): Promise<void> {
  const now = new Date();
  await inProject(c, deps, (tx) =>
    tx
      .update(payments)
      .set({
        status: 'pending',
        failureCode: 'unreachable',
        failureMessage: 'Stripe did not answer, so it is not known whether the intent exists.',
        pendingAction: 'cancel_intent',
        pendingActionAttempts: 0,
        pendingActionNextAt: now,
        pendingActionError: null,
        updatedAt: now,
      })
      .where(eq(payments.id, paymentId)),
  );
}

/**
 * Creates the PaymentIntent, writes its identifier back, and builds what the front end needs.
 *
 * **Outside every transaction**, and after the commit. The `Idempotency-Key` sent to Stripe is
 * the public identifier of the `payments` row, so a retry of this same step (a timeout, a
 * process restarted between the commit and here) attaches to the intent the first attempt
 * created instead of creating a second one and charging the customer twice.
 *
 * When Stripe refuses or does not answer, the booking is cancelled at once: it holds capacity
 * that nobody is going to pay for, and leaving it to the deadline would hold a slot off the
 * market for half an hour for a failure that is already known. The caller receives a `502`
 * whose message names the booking, so that a client that had already read the identifier out of
 * an earlier log knows it is gone.
 */
async function createIntent(
  c: Parameters<typeof inProject>[0],
  deps: AppDeps,
  auth: AuthContext,
  result: CreateBookingResult,
): Promise<Record<string, unknown> | null> {
  const payment = result.payment;
  if (payment === null) return null;
  const { client, environmentConfig } = stripePlatform(deps.stripe, auth.environment);
  const paymentId = encodeId('payment', payment.id);
  const bookingId = encodeId('booking', result.id);

  const serviceName = await inProject(c, deps, async (tx) => {
    const rows = await tx.execute<{ name: string }>(
      sql`SELECT name FROM services WHERE id = ${result.serviceId}`,
    );
    return rows.rows[0]?.name ?? 'service';
  });

  try {
    const intent = await client.createPaymentIntent({
      stripeAccount: payment.providerAccountId,
      idempotencyKey: paymentId,
      amount: payment.amount,
      currency: payment.currency,
      description: `Booking ${bookingId}: ${serviceName}`.slice(0, MAX_DESCRIPTION),
      metadata: {
        bookrail_booking_id: bookingId,
        bookrail_payment_id: paymentId,
        bookrail_project_id: encodeId('project', auth.projectId),
        bookrail_environment: auth.environment,
      },
    });
    await inProject(c, deps, (tx) =>
      tx
        .update(payments)
        .set({ providerPaymentId: intent.id, updatedAt: new Date() })
        .where(eq(payments.id, payment.id)),
    );
    return {
      id: intent.id,
      client_secret: intent.clientSecret,
      amount: payment.amount,
      currency: payment.currency,
      status: intent.status,
      stripe_account: payment.providerAccountId,
      publishable_key: environmentConfig.publishableKey,
      payment_id: paymentId,
    };
  } catch (error) {
    if (!(error instanceof StripeApiError) && !(error instanceof StripeUnreachableError))
      throw error;
    const code = error instanceof StripeApiError ? error.type : error.reason;
    // Stripe refused, or Stripe never answered, and the two are not the same fact.
    //
    // A refusal is an answer: no intent exists, and the row is closed `failed`. A timeout is
    // the absence of one, and the intent may very well have been created on the other side. In
    // that case it would sit open on the customer's account until Stripe expired it by itself:
    // nobody can pay it, because the `client_secret` never left this process, but it is litter
    // in somebody else's dashboard. So the row is left `pending` with the cancellation queued,
    // and the worker replays the creation under the same `Idempotency-Key` to find out which
    // of the two worlds is the real one.
    const unreachable = error instanceof StripeUnreachableError;
    deps.logger.warn('stripe_payment_intent_failed', {
      project_id: encodeId('project', auth.projectId),
      environment: auth.environment,
      booking_id: bookingId,
      payment_id: paymentId,
      error_code: code,
      outcome_known: !unreachable,
    });
    if (!unreachable) {
      await inProject(c, deps, (tx) =>
        tx
          .update(payments)
          .set({
            status: 'failed',
            failureCode: code.slice(0, 100),
            failureMessage: 'The payment could not be started.',
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id)),
      );
    }
    try {
      const cancelled = await transition(deps.db, {
        projectId: auth.projectId,
        environment: auth.environment,
        bookingId: result.id,
        action: 'cancel',
        by: 'system',
        reason: 'payment_intent_failed',
        actor: { type: 'system', id: null },
        now: Date.now(),
      });
      await invalidateTouchedDays(deps, cancelled.touchedDays);
      // After the cancellation, never before: the transition's own sweep closes a `pending`
      // payment that carries no intent identifier, which is exactly the shape of this row, and
      // writing the queue first would only have it cleared again a line later.
      if (unreachable) await queueUnknownIntentCancellation(c, deps, payment.id);
    } catch (cancelError) {
      // Said out loud at `error`, because it is the one branch that leaves something behind: a
      // `pending` booking holding a slot for a payment that will never be started. Nothing is
      // stranded past its deadline, though, because `payment_expires_at` is already on the row
      // and the scheduler will fire `expire_payment` at it.
      deps.logger.error('stripe_payment_intent_rollback_failed', {
        booking_id: bookingId,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
    }
    // The same two errors `/v1/stripe` answers, with one sentence added: the caller has to know
    // that the booking it asked for does not exist, or it will go looking for it.
    const failure =
      error instanceof StripeUnreachableError ? stripeUnreachable() : stripeProviderError(error);
    throw new BookrailError(
      failure.type,
      failure.code,
      `${failure.message} Booking ${bookingId} was cancelled and its slot released.`,
      failure.param,
      failure.fix,
    );
  }
}

/**
 * `createBooking`, and on the free plan's `402` for the bookings, the warnings the account has
 * reached and nobody has claimed.
 *
 * The transaction that refused has rolled back, so whatever it could have claimed went with it.
 * An account can reach its threshold through two increments on two projects at the same instant,
 * each of which saw the total without the other: neither claims the 100 %, and after the
 * threshold nothing increments again. So the refusal claims it, in a short transaction of its
 * own, and the email goes out like any other. `plan_usage_warning_claim` is idempotent: a warning
 * already sent is not sent twice. A refusal for the paid volume (`param: payment.mode`) is not
 * about the bookings and claims nothing.
 */
async function createBookingOrClaim(
  deps: AppDeps,
  auth: AuthContext,
  input: Parameters<typeof createBooking>[1],
): Promise<CreateBookingResult> {
  try {
    return await createBooking(deps.db, input);
  } catch (error) {
    if (
      error instanceof BookrailError &&
      error.code === 'plan_limit_reached' &&
      error.param === undefined
    ) {
      try {
        sendPlanWarnings(
          deps,
          await claimReachedWarnings(deps.db, {
            projectId: auth.projectId,
            environment: auth.environment,
            now: input.now,
            ...(deps.plans === undefined ? {} : { plans: deps.plans }),
          }),
        );
      } catch (claimError) {
        // The answer is the 402 either way: a warning that could not be claimed now is claimed
        // by the next refusal, and says so in the log.
        deps.logger.warn('plan_usage_warning_claim_failed', {
          project_id: encodeId('project', auth.projectId),
          error: claimError instanceof Error ? claimError.message : String(claimError),
        });
      }
    }
    throw error;
  }
}

export function bookingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, bookingCreateSchema);
    const auth = requireAuth(c);

    if (body.recurrence != null) {
      throw errors.invalidRequest(
        'Recurring bookings are not yet supported.',
        'recurrence',
        'not_yet_supported',
      );
    }
    const mode = body.payment?.mode ?? 'none';
    if (mode === 'entitlement') {
      throw errors.invalidRequest(
        'payment.mode "entitlement" is not yet supported.',
        'payment.mode',
        'not_yet_supported',
      );
    }

    // Step 1: the two questions that can be answered without the transaction. A project whose
    // account is not connected, or a deployment that is not a platform, is a request that could
    // never have worked, and it must not take an advisory lock to find that out.
    const paying = mode === 'deposit' || mode === 'full';
    const account = paying ? await connectedAccount(c, deps, auth.environment) : null;

    const customerId = await resolveCustomerId(c, deps, body);

    const result = await createBookingOrClaim(deps, auth, {
      projectId: auth.projectId,
      environment: auth.environment,
      serviceId: body.service_id,
      start: body.start.getTime(),
      durationMinutes: body.duration_minutes ?? null,
      quantity: body.quantity ?? null,
      resourceIds: body.resource_ids ?? null,
      customerId,
      kind: 'booking',
      holdId: body.hold_id ?? null,
      now: Date.now(),
      source: body.source,
      notes: body.notes ?? null,
      metadata: body.metadata,
      ...(deps.plans === undefined ? {} : { plans: deps.plans }),
      // `booking.created` used to carry a NULL actor, which made the single
      // most important event of the system the only one that did not say who wrote it.
      actor: eventActor(c, auth),
      ...(account === null || !paying
        ? {}
        : {
            payment: {
              mode,
              providerAccountId: account,
              timeoutMs: deps.paymentTimeoutMinutes * 60_000,
            },
          }),
    });
    // The transaction has committed: the booking exists. Everything below (the cache
    // invalidation, the re-read, the serialization) can still fail, and a 5xx from here on
    // must **not** release the `Idempotency-Key`, or the retry books a second time.
    c.set('effectCommitted', true);

    await invalidateTouchedDays(deps, result.touchedDays);
    // The usage warnings this booking claimed, mailed after the commit and not waited for.
    sendPlanWarnings(deps, result.planWarnings);

    // Step 3: Stripe, outside every transaction. On failure this throws, after having cancelled
    // the booking it could not collect for.
    const intent = await createIntent(c, deps, auth, result);

    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(bookings).where(eq(bookings.id, result.id)).limit(1);
      const row = rows[0];
      if (!row) throw errors.internal('The booking disappeared right after it was written.');
      return firstRow(await serializePage(tx, [row], new Set()));
    });
    const created = { ...payload, payment_intent: intent };
    // What the `Idempotency-Key` middleware is allowed to remember: the same object with the
    // secret taken out. The middleware stores the response body of every POST of `/v1` for
    // twenty-four hours, and a `client_secret` that is stored and replayed is not a secret
    // handed over once, it is a secret written down. Same mechanism, same reason, as
    // `POST /v1/webhooks` and its signing secret.
    c.set(
      'idempotencyResponseBody',
      intent === null
        ? created
        : { ...created, payment_intent: { ...intent, client_secret: null } },
    );
    return c.json(created, 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'booking');
    const expand = parseExpand(c, EXPANDABLE);
    const filters = parseQuery(c, bookingListQuerySchema);

    const payload = await inProject(c, deps, async (tx) => {
      // The resource filter is a correlated EXISTS, not a JOIN and not a list of ids: a JOIN
      // would return a booking twice when it holds two allocations on the same resource, and
      // materialising the ids into an `IN` grows without a ceiling and breaks past the bind
      // parameter limit on a busy resource.
      const onResource =
        filters.resource_id === undefined
          ? undefined
          : exists(
              tx
                .select({ one: sql`1` })
                .from(bookingAllocations)
                .where(
                  and(
                    eq(bookingAllocations.bookingId, bookings.id),
                    eq(bookingAllocations.resourceId, filters.resource_id),
                  ),
                ),
            );

      const rows = await tx
        .select()
        .from(bookings)
        .where(
          and(
            startingAfter ? gt(bookings.id, startingAfter) : undefined,
            filters.customer_id ? eq(bookings.customerId, filters.customer_id) : undefined,
            filters.service_id ? eq(bookings.serviceId, filters.service_id) : undefined,
            filters.status ? eq(bookings.status, filters.status) : undefined,
            filters.from ? gte(bookings.startsAt, filters.from) : undefined,
            filters.to ? lt(bookings.startsAt, filters.to) : undefined,
            onResource,
          ),
        )
        .orderBy(asc(bookings.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(await serializePage(tx, page, expand), hasMore);
    });

    return c.json(payload);
  });

  // --- Transitions ---------------------------------------------------------------------------
  //
  // Six endpoints, one engine call. Everything that decides whether the move is legal, what it
  // costs and which event it writes lives in `@bookrail/engine`'s `lifecycle.ts`; what lives
  // here is what HTTP owes: the body, the prefixed identifiers, `effectCommitted` the instant
  // the transaction returns, the cache invalidation on the days the write touched, and the
  // booking re-read through the one serializer every other booking response uses.
  //
  // `Idempotency-Key` needs nothing here: the middleware already covers every
  // POST of `/v1`, and a repeated `cancel` therefore replays its stored answer instead of
  // reaching a booking that is now `cancelled` and answering `409 invalid_transition`.
  async function applyAction(
    c: Parameters<typeof requireAuth>[0],
    action: TransitionAction,
    params: {
      reason?: string | null;
      by?: 'customer' | 'provider' | 'system';
      overrideRefundPercent?: number | null;
      start?: number;
      resourceIds?: readonly string[] | null;
    },
  ): Promise<Booking> {
    const id = pathId(c, 'booking', 'booking');
    const auth = requireAuth(c);
    const result = await transition(deps.db, {
      projectId: auth.projectId,
      environment: auth.environment,
      bookingId: id,
      action,
      // The actor is the credential that called, not the person it acted for: `cancel`
      // records the latter in `cancelled_by`, and conflating the two would make the audit
      // trail say a customer did something an integration did on their behalf. `via` (the tool
      // the caller declared with `Bookrail-Actor`) travels with it, whole: the engine spreads
      // the object instead of rebuilding it from two named fields.
      actor: eventActor(c, auth),
      now: Date.now(),
      ...(deps.plans === undefined ? {} : { plans: deps.plans }),
      ...params,
    });
    // The transaction has committed. Everything below can still fail and must not release the
    // `Idempotency-Key`.
    c.set('effectCommitted', true);
    await invalidateTouchedDays(deps, result.touchedDays);
    sendPlanWarnings(deps, result.planWarnings);

    // A reschedule answers with the booking that now holds the slot: it is the object the
    // caller will act on next, and the one it closed is one `GET` away through
    // `rescheduled_from_booking_id`.
    const subject = result.newBookingId ?? result.bookingId;
    return inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(bookings).where(eq(bookings.id, subject)).limit(1);
      const row = rows[0];
      if (!row) throw errors.internal('The booking disappeared right after it was written.');
      return firstRow(await serializePage(tx, [row], new Set()));
    });
  }

  // Generated from `HTTP_TRANSITION_ACTIONS`, minus the two that take parameters and are
  // mounted by hand below. The engine owns the list of actions HTTP exposes, and the test
  // `mounts exactly the actions the engine says are public` compares the two sets, so
  // adding an action to the engine without a route, or a route the engine does not sanction,
  // fails the suite instead of being discovered by a customer.
  const parameterised = new Set<string>(PARAMETERISED_TRANSITION_ACTIONS);
  for (const action of HTTP_TRANSITION_ACTIONS) {
    if (parameterised.has(action)) continue;
    routes.post(`/:id/${action}`, async (c) => {
      await parseOptionalJsonBody(c, bookingActionSchema);
      return c.json(await applyAction(c, action, {}));
    });
  }

  routes.post('/:id/cancel', async (c) => {
    const body = await parseOptionalJsonBody(c, bookingCancelSchema);
    return c.json(
      await applyAction(c, 'cancel', {
        reason: body.reason ?? null,
        by: body.by ?? 'customer',
        overrideRefundPercent: body.override_refund_percent ?? null,
      }),
    );
  });

  routes.post('/:id/reschedule', async (c) => {
    const body = await parseJsonBody(c, bookingRescheduleSchema);
    return c.json(
      await applyAction(c, 'reschedule', {
        start: body.start.getTime(),
        resourceIds: body.resource_ids ?? null,
      }),
    );
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'booking', 'booking');
    const expand = parseExpand(c, EXPANDABLE);
    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(bookings).where(eq(bookings.id, id)).limit(1);
      if (rows.length === 0) return null;
      return (await serializePage(tx, rows, expand))[0] ?? null;
    });
    if (!payload) throw errors.notFound('booking', c.req.param('id') ?? '');
    return c.json(payload);
  });

  return routes;
}
