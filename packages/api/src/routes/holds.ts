/**
 * `POST /v1/holds`, `GET /v1/holds/{id}` and `DELETE /v1/holds/{id}`.
 *
 * Thin, like the availability routes and for the same reason: the transaction that actually
 * takes the capacity is `@bookrail/engine` and nothing here reimplements a line
 * of it. What lives here is the HTTP contract (prefixed identifiers in and out, ISO 8601 with
 * an offset in, UTC out, the documented error codes) plus the two obligations a write endpoint
 * has that a read endpoint does not:
 *
 *  1. **the customer.** A caller may send `customer_id`, or the customer inline, and the
 *     inline form has to create or find exactly the row `POST /v1/customers` would
 *     (`src/customers.ts`). It runs in its own transaction, **before** the booking
 *     transaction: the engine's transaction is a critical section holding advisory locks on
 *     every candidate resource, and an upsert inside it would hold those locks across a
 *     write to an unrelated table;
 *  2. **the cache.** The engine returns `touchedDays` and deliberately does not invalidate:
 *     doing it inside the transaction would drop the entry before the row is visible. So the
 *     route does it, after the commit (`src/cache.ts`).
 *
 * `DELETE` is idempotent by design: releasing a hold that is already released, or that has
 * expired, is a 200: the caller wanted the slot free and it is. Only a hold that has already
 * become a booking is a 409 `hold_not_active`, because there the caller's belief about the
 * world is wrong and silently answering "done" would hide a real booking.
 */
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { bookings, holds, locations, occupancies, resources, schedules } from '@bookrail/db';
import { createHold, releaseHold } from '@bookrail/engine';
import { errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import { invalidateTouchedDays } from '../cache.js';
import { assertCustomerExists, upsertCustomer } from '../customers.js';
import {
  deletedEnvelope,
  eventActor,
  inProject,
  parseJsonBody,
  pathId,
  requireAuth,
} from '../http.js';
import { holdCreateSchema } from '../schemas/index.js';
import { serializeHold, serializeHoldRow, type HoldStatus } from '../serialize.js';

/**
 * The state of a hold as a caller must see it, which is not always the state of its row.
 *
 * `holds.status` is flipped to `expired` by the sweep job, which runs every ten seconds; in
 * between, a hold whose `expires_at` has passed still says `active`. It cannot be converted and
 * its capacity is ignored by every read of the engine, so reporting `active` would be reporting
 * something that is not true of anything but the row itself.
 */
function holdStatus(stored: string, expiresAt: Date, now: number): HoldStatus {
  if (stored === 'active' && expiresAt.getTime() <= now) return 'expired';
  return stored as HoldStatus;
}

export function holdsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, holdCreateSchema);
    const auth = requireAuth(c);

    // Resolved before the engine's transaction, and in its own: that transaction holds an
    // advisory lock on every candidate resource of the service, and an upsert into
    // `customers` inside it would hold those locks while writing an unrelated table.
    const inline = body.customer;
    const given = body.customer_id ?? null;
    const customerId =
      inline === undefined
        ? given === null
          ? null
          : await inProject(c, deps, async (tx) => {
              await assertCustomerExists(tx, given);
              return given;
            })
        : (
            await inProject(c, deps, (tx, ctx) =>
              upsertCustomer(tx, ctx, inline, { matchByEmail: true }),
            )
          ).row.id;

    const result = await createHold(deps.db, {
      projectId: auth.projectId,
      environment: auth.environment,
      serviceId: body.service_id,
      start: body.start.getTime(),
      durationMinutes: body.duration_minutes ?? null,
      quantity: body.quantity ?? null,
      resourceIds: body.resource_ids ?? null,
      customerId,
      ttlSeconds: body.ttl ?? null,
      now: Date.now(),
      metadata: body.metadata,
      // `hold.created` used to be written with a NULL actor, so the one
      // event that says a hold exists did not say who made it, while `hold.expired`, written
      // by the sweeper, at least implied the system. The credential travels, `via` included.
      actor: eventActor(c, auth),
    });
    // The capacity is taken and committed. Everything below can still fail, and if it does
    // the `Idempotency-Key` must not be released.
    c.set('effectCommitted', true);

    await invalidateTouchedDays(deps, result.touchedDays);
    return c.json(serializeHold({ ...result, environment: auth.environment }), 201);
  });

  /**
   * `GET /v1/holds/{id}`.
   *
   * Until now a hold was answered once, at creation, and an id that got lost meant waiting for
   * the expiry, which was a known and recorded gap. This is the read, and it answers the three
   * questions that are actually asked of a hold (is it still alive, until when, and what did it
   * become) rather than re-deriving what the creation computed. The fields the table does not
   * store come back `null`; the reasons are in {@link serializeHoldRow}.
   *
   * There is still **no `GET /v1/holds`**: a list of holds is a list of things that expire in
   * ten minutes, and nobody has asked for one.
   *
   * The resources held are read from `occupancies` by `ref_id`, **including the inactive
   * rows**: a released hold still answers which resources it had held, because that is what the
   * caller is asking about when they read a hold that is over. `occupancies` is never deleted
   * for exactly this kind of reason: a row is deactivated, never removed, so it stays as the
   * trace that the capacity was once taken.
   */
  routes.get('/:id', async (c) => {
    const id = pathId(c, 'hold', 'hold');
    const now = Date.now();

    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(holds).where(eq(holds.id, id)).limit(1);
      const row = rows[0];
      // A hold of another project is invisible through RLS, so it lands here as "no row" and
      // leaves as a 404 `resource_missing`, the same answer an id that never existed gets.
      if (row === undefined) return null;

      const held = await tx
        .select({
          resourceId: occupancies.resourceId,
          capacityUsed: occupancies.capacityUsed,
        })
        .from(occupancies)
        .where(and(eq(occupancies.refId, id), eq(occupancies.kind, 'hold')))
        .orderBy(asc(occupancies.resourceId));

      const converted = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.holdId, id))
        .orderBy(asc(bookings.id))
        .limit(1);

      // The zone of the first held resource that has one, which is the same rule the engine
      // uses to pick the grid's alignment: a service whose resources live in different zones
      // gets one grid, the zone of the first candidate that carries one. A hold that holds
      // nothing (impossible today, since the transaction writes the occupancies with the row)
      // would answer `null` rather than invent one.
      const first = held[0];
      const zoneRows =
        first === undefined
          ? []
          : await tx
              .select({
                scheduleTimezone: schedules.timezone,
                locationTimezone: locations.timezone,
              })
              .from(resources)
              .leftJoin(schedules, eq(schedules.id, resources.scheduleId))
              .leftJoin(locations, eq(locations.id, resources.locationId))
              .where(eq(resources.id, first.resourceId))
              .limit(1);
      const zone = zoneRows[0];

      return serializeHoldRow({
        ...row,
        status: holdStatus(row.status, row.expiresAt, now),
        bookingId: converted[0]?.id ?? null,
        timezone: zone?.scheduleTimezone ?? zone?.locationTimezone ?? null,
        allocations: held,
      });
    });

    if (!payload) throw errors.notFound('hold', c.req.param('id') ?? '');
    return c.json(payload);
  });

  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'hold', 'hold');
    const auth = requireAuth(c);
    const result = await releaseHold(deps.db, {
      projectId: auth.projectId,
      environment: auth.environment,
      holdId: id,
      now: Date.now(),
      actor: eventActor(c, auth),
    });
    c.set('effectCommitted', true);
    await invalidateTouchedDays(deps, result.touchedDays);
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'hold'));
  });

  return routes;
}
