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
 * **`payment` and `recurrence`.** Both are in the reference documentation and neither exists yet
 * (payments are a later release, recurrences too). A caller that sends `payment: {mode: "deposit"}`
 * gets a 400 saying it is not supported yet; `payment: {mode: "none"}` is accepted, because that is
 * what the API does today. Silently ignoring either would let an integration believe it had taken a
 * deposit.
 */
import { Hono } from 'hono';
import { and, asc, eq, exists, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { bookingAllocations, bookings, customers, resources, type Transaction } from '@bookrail/db';
import {
  createBooking,
  transition,
  HTTP_TRANSITION_ACTIONS,
  PARAMETERISED_TRANSITION_ACTIONS,
  type TransitionAction,
} from '@bookrail/engine';
import { errors } from '@bookrail/shared';
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

const EXPANDABLE = ['customer', 'allocations.resource'] as const;

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

  return rows.map((row) =>
    serializeBooking(row, allocations.get(row.id) ?? [], {
      ...(customerRows === null
        ? {}
        : {
            customer: row.customerId === null ? null : (customerRows.get(row.customerId) ?? null),
          }),
      ...(resourceRows === undefined ? {} : { resources: resourceRows }),
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
    if (body.payment != null && body.payment.mode !== 'none') {
      throw errors.invalidRequest(
        `payment.mode "${body.payment.mode}" is not yet supported; only "none" is.`,
        'payment.mode',
        'not_yet_supported',
      );
    }

    const customerId = await resolveCustomerId(c, deps, body);

    const result = await createBooking(deps.db, {
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
      // `booking.created` used to carry a NULL actor, which made the single
      // most important event of the system the only one that did not say who wrote it.
      actor: eventActor(c, auth),
    });
    // The transaction has committed: the booking exists. Everything below (the cache
    // invalidation, the re-read, the serialization) can still fail, and a 5xx from here on
    // must **not** release the `Idempotency-Key`, or the retry books a second time.
    c.set('effectCommitted', true);

    await invalidateTouchedDays(deps, result.touchedDays);

    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(bookings).where(eq(bookings.id, result.id)).limit(1);
      const row = rows[0];
      if (!row) throw errors.internal('The booking disappeared right after it was written.');
      return firstRow(await serializePage(tx, [row], new Set()));
    });
    return c.json(payload, 201);
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
      ...params,
    });
    // The transaction has committed. Everything below can still fail and must not release the
    // `Idempotency-Key`.
    c.set('effectCommitted', true);
    await invalidateTouchedDays(deps, result.touchedDays);

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
