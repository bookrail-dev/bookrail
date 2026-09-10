/**
 * `/v1/webhooks`: the endpoints a customer manages their delivery configuration with.
 *
 * Everything that actually delivers lives in `src/webhooks/`; what lives here is the HTTP
 * contract, plus the three decisions a CRUD over a **secret** has that a CRUD over a location
 * does not:
 *
 *  1. **the secret is shown once.** `POST /v1/webhooks` returns it in the body and no other
 *     endpoint ever does, because `serializeWebhook` has no branch that can emit it. What the
 *     database holds is the ciphertext (AES-256-GCM under `WEBHOOK_SECRET_KEY`,
 *     `src/webhooks/secrets.ts`), encrypted rather than hashed, because unlike an API key a
 *     webhook secret has to be *produced* again on every delivery;
 *  2. **the URL is checked twice.** Here, syntactically, so a customer registering
 *     `http://169.254.169.254/…` is told at creation rather than reading a delivery log full of
 *     the same refusal; and again at delivery, semantically, against what the hostname resolves
 *     to *then* (`src/webhooks/ssrf.ts`);
 *  3. **`POST /{id}/test` delivers synchronously.** The question it answers is "does my endpoint
 *     work", and an answer that arrives through a queue two seconds later, in a different
 *     window, is not the answer. It costs one request that can take up to the ten second
 *     delivery timeout, which is the price of the question.
 */
import { Hono } from 'hono';
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { events, webhookDeliveries, webhooks, type Transaction } from '@bookrail/db';
import { insertEvent } from '@bookrail/engine';
import { encodeId, errors, uuidv7, WEBHOOK_TEST_EVENT } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  deletedEnvelope,
  eventActor,
  firstRow,
  inProject,
  listEnvelope,
  paginate,
  parseJsonBody,
  parseListParams,
  parseOptionalJsonBody,
  parseQuery,
  pathId,
  requireAuth,
} from '../http.js';
import {
  bookingActionSchema,
  webhookCreateSchema,
  webhookDeliveryListQuerySchema,
  webhookUpdateSchema,
} from '../schemas/index.js';
import { serializeWebhook, serializeWebhookDelivery } from '../serialize.js';
import type { WebhookDelivery } from '../schemas/responses.js';
import { deliver } from '../webhooks/deliver.js';
import { webhookPayload } from '../webhooks/dispatch.js';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
} from '../webhooks/secrets.js';
import { ensureOutboxCursor } from '../webhooks/outbox.js';
import { assertWebhookUrl } from '../webhooks/ssrf.js';

/** Unlimited manual replay, for thirty days after the event. */
export const REPLAY_WINDOW_DAYS = 30;

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/**
 * `409 webhook_disabled`.
 *
 * A disabled endpoint stops receiving traffic of every kind; `/test` and `/retry`
 * are traffic, and the delivery worker refuses one too (`webhooks/dispatch.ts`). Re-enabling the
 * endpoint makes both work again, and the deliveries queued meanwhile resume.
 */
function webhookDisabled(): Error {
  return errors.conflict(
    'This webhook endpoint is disabled. Set status to "active" to start delivering again.',
    'webhook_disabled',
    'id',
  );
}

/** The 32 byte key, or the loud failure a deployment that forgot it deserves. */
function requireKey(deps: AppDeps): Buffer {
  if (deps.webhookSecretKey === undefined) {
    throw errors.internal(
      'WEBHOOK_SECRET_KEY is not configured, so webhook signing secrets cannot be stored.',
    );
  }
  return deps.webhookSecretKey;
}

async function loadWebhook(tx: Transaction, id: string): Promise<WebhookRow | undefined> {
  const rows = await tx.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return rows[0];
}

/** Delivery rows plus the type of the event each one carries, in one extra query. */
async function serializeDeliveries(
  tx: Transaction,
  rows: readonly DeliveryRow[],
): Promise<WebhookDelivery[]> {
  if (rows.length === 0) return [];
  const types = new Map<string, string>();
  const ids = [...new Set(rows.map((row) => row.eventId))];
  for (const row of await tx
    .select({ id: events.id, type: events.type })
    .from(events)
    .where(inArray(events.id, ids))) {
    types.set(row.id, row.type);
  }
  return rows.map((row) => serializeWebhookDelivery(row, types.get(row.eventId) ?? null));
}

export function webhooksRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  // Two flags, not one: the port rule and the address rule are separate checks, so a test can
  // relax one and still exercise the other.
  const ssrf = {
    allowPrivateTargets: deps.allowPrivateWebhookTargets === true,
    allowAnyPort: deps.allowPrivateWebhookTargets === true,
  };

  routes.post('/', async (c) => {
    const body = await parseJsonBody(c, webhookCreateSchema);
    const auth = requireAuth(c);
    const key = requireKey(deps);
    // Throws a 400 with `param: "url"`; the message names what is wrong with it.
    const url = assertWebhookUrl(body.url, auth.environment, ssrf);

    const id = uuidv7();
    const secret = generateWebhookSecret();
    const row = await inProject(c, deps, async (tx) => {
      // In the same transaction as the endpoint: the position the outbox will read from is
      // fixed by the commit that makes the endpoint exist, so there is no window in which an
      // endpoint is registered and nothing is watching the log for it. Does nothing when the
      // project already has an endpoint, and therefore a cursor.
      await ensureOutboxCursor(tx, auth.projectId, auth.environment);
      return firstRow(
        await tx
          .insert(webhooks)
          .values({
            id,
            projectId: auth.projectId,
            environment: auth.environment,
            url: url.toString(),
            eventTypes: body.events ?? ['*'],
            // The id is the additional authenticated data, so this ciphertext cannot be moved
            // to another endpoint's row and still decrypt.
            secret: encryptWebhookSecret(secret, key, id),
            status: 'active',
            description: body.description ?? null,
            metadata: body.metadata ?? {},
          })
          .returning(),
      );
    });
    c.set('effectCommitted', true);
    // What the `Idempotency-Key` middleware is allowed to remember: the endpoint **without** its
    // secret. The middleware persists the body of every POST of `/v1` for 24 hours, so without
    // this line the secret would sit in `idempotency_keys.response_body` in the clear and come
    // back on every replay of the key, which is neither "never in the database" nor
    // "shown once".
    c.set('idempotencyResponseBody', serializeWebhook(row));
    // The one and only time the plaintext leaves this process.
    return c.json({ ...serializeWebhook(row), secret }, 201);
  });

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'webhook');
    const rows = await inProject(c, deps, async (tx) =>
      tx
        .select()
        .from(webhooks)
        .where(startingAfter ? gt(webhooks.id, startingAfter) : undefined)
        .orderBy(asc(webhooks.id))
        .limit(limit + 1),
    );
    const { page, hasMore } = paginate(rows, limit);
    return c.json(listEnvelope(page.map(serializeWebhook), hasMore));
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    const row = await inProject(c, deps, (tx) => loadWebhook(tx, id));
    if (!row) throw errors.notFound('webhook', c.req.param('id') ?? '');
    return c.json(serializeWebhook(row));
  });

  routes.patch('/:id', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    const body = await parseJsonBody(c, webhookUpdateSchema);
    const auth = requireAuth(c);

    const patch: Partial<{
      url: string;
      eventTypes: string[];
      status: 'active' | 'disabled' | 'failing';
      description: string | null;
      metadata: Record<string, unknown>;
    }> = {};
    if (body.url !== undefined) {
      patch.url = assertWebhookUrl(body.url, auth.environment, ssrf).toString();
    }
    if (body.events !== undefined) patch.eventTypes = [...body.events];
    if (body.status !== undefined) patch.status = body.status;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    const rows = await inProject(c, deps, async (tx) =>
      tx.update(webhooks).set(patch).where(eq(webhooks.id, id)).returning(),
    );
    const row = rows[0];
    if (!row) throw errors.notFound('webhook', c.req.param('id') ?? '');
    return c.json(serializeWebhook(row));
  });

  /**
   * Deleting an endpoint takes its deliveries with it (`ON DELETE CASCADE`, migration 0005).
   * That is the right reading of the object: the delivery log describes attempts to reach *this*
   * endpoint, and keeping orphaned rows would leave a customer with a log they cannot act on.
   * A customer who wants to stop the traffic and keep the history sets `status: "disabled"`.
   */
  routes.delete('/:id', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    const rows = await inProject(c, deps, async (tx) =>
      tx.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id }),
    );
    if (!rows[0]) throw errors.notFound('webhook', c.req.param('id') ?? '');
    c.set('effectCommitted', true);
    return c.json(deletedEnvelope(c.req.param('id') ?? '', 'webhook'));
  });

  /**
   * A synthetic delivery, sent now.
   *
   * The event is written to `events` like any other, with type `webhook.test`. It could have
   * been synthesised in memory, but then the delivery would have no `event_id` to point at (the
   * foreign key of migration 0005 is not decorative), no row in `GET /v1/events` for the
   * customer to compare against what their endpoint received, and no way to be replayed. The
   * outbox never dispatches a `webhook.*` event, so writing it here does **not** fan it out to
   * every other endpoint of the project.
   */
  routes.post('/:id/test', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    await parseOptionalJsonBody(c, bookingActionSchema);
    const auth = requireAuth(c);
    const key = requireKey(deps);

    const prepared = await inProject(c, deps, async (tx) => {
      const endpoint = await loadWebhook(tx, id);
      if (!endpoint) return null;
      // `disabled` stops the traffic: all of it, this included. A customer who disabled an
      // endpoint because its URL leaked must not be able to send it a signed payload by asking
      // for a test.
      if (endpoint.status === 'disabled') return 'disabled' as const;
      const eventId = await insertEvent(
        tx,
        auth.projectId,
        auth.environment,
        WEBHOOK_TEST_EVENT,
        {
          id: encodeId('webhook', endpoint.id),
          object: 'webhook',
          url: endpoint.url,
          status: endpoint.status,
          message: 'This is a test delivery from Bookrail. No booking was created.',
        },
        { actor: eventActor(c, auth) },
      );
      const deliveryRow = firstRow(
        await tx
          .insert(webhookDeliveries)
          .values({
            id: uuidv7(),
            projectId: auth.projectId,
            environment: auth.environment,
            webhookId: endpoint.id,
            eventId,
            status: 'pending',
            attempt: 1,
            lastAttemptAt: new Date(),
            nextAttemptAt: null,
          })
          .returning(),
      );
      const eventRow = firstRow(
        await tx.select().from(events).where(eq(events.id, eventId)).limit(1),
      );
      return { endpoint, deliveryRow, eventRow };
    });
    if (prepared === null) throw errors.notFound('webhook', c.req.param('id') ?? '');
    if (prepared === 'disabled') throw webhookDisabled();
    c.set('effectCommitted', true);

    const { endpoint, deliveryRow, eventRow } = prepared;
    const attempt = await deliver(
      {
        url: endpoint.url,
        environment: auth.environment,
        secret: decryptWebhookSecret(endpoint.secret, key, endpoint.id),
        body: webhookPayload(eventRow),
        eventId: encodeId('event', eventRow.id),
        webhookId: encodeId('webhook', endpoint.id),
        deliveryId: encodeId('webhook_delivery', deliveryRow.id),
      },
      ssrf,
    );

    // A test delivery is never retried: the caller is standing in front of the answer, and a
    // ladder of retries behind a synchronous request would keep hammering an endpoint the
    // customer is in the middle of fixing.
    const updated = await inProject(c, deps, async (tx) =>
      firstRow(
        await tx
          .update(webhookDeliveries)
          .set({
            status: attempt.ok ? 'succeeded' : 'failed',
            responseStatus: attempt.status,
            responseBody: attempt.responseBody,
            error: attempt.error,
            durationMs: attempt.durationMs,
            deliveredAt: attempt.ok ? new Date() : null,
            nextAttemptAt: null,
          })
          .where(eq(webhookDeliveries.id, deliveryRow.id))
          .returning(),
      ),
    );
    return c.json(serializeWebhookDelivery(updated, WEBHOOK_TEST_EVENT));
  });

  /**
   * The delivery log of one endpoint, newest first.
   *
   * Newest first, unlike every other list here, because a delivery log is read to answer "what
   * just happened" and an ascending cursor would make the interesting page the last one. The
   * cursor still works: `webhook_delivery` ids are UUID v7, so descending by id is descending
   * by creation.
   */
  routes.get('/:id/deliveries', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    const { limit, startingAfter } = parseListParams(c, 'webhook_delivery');
    const filters = parseQuery(c, webhookDeliveryListQuerySchema);

    const payload = await inProject(c, deps, async (tx) => {
      if ((await loadWebhook(tx, id)) === undefined) return null;
      const rows = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.webhookId, id),
            startingAfter ? lt(webhookDeliveries.id, startingAfter) : undefined,
            filters.status ? eq(webhookDeliveries.status, filters.status) : undefined,
            filters.event_id ? eq(webhookDeliveries.eventId, filters.event_id) : undefined,
          ),
        )
        .orderBy(desc(webhookDeliveries.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(await serializeDeliveries(tx, page), hasMore);
    });
    if (payload === null) throw errors.notFound('webhook', c.req.param('id') ?? '');
    return c.json(payload);
  });

  /**
   * Replay: put the delivery back at the front of the queue with a fresh ladder.
   *
   * `attempt` goes back to zero on purpose. A replay is a new decision by a human who has
   * presumably just fixed something, and inheriting the exhausted counter would give it one
   * attempt and no retries: the opposite of what "replay" means.
   */
  routes.post('/:id/deliveries/:did/retry', async (c) => {
    const id = pathId(c, 'webhook', 'webhook');
    const deliveryId = pathId(c, 'webhook_delivery', 'webhook delivery', 'did');
    await parseOptionalJsonBody(c, bookingActionSchema);

    const outcome = await inProject(c, deps, async (tx) => {
      const endpoint = await loadWebhook(tx, id);
      if (endpoint === undefined) return { kind: 'no_webhook' as const };
      // Same reason as `/test`: a replay onto a disabled endpoint is traffic.
      if (endpoint.status === 'disabled') return { kind: 'disabled' as const };
      const existing = (
        await tx
          .select()
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)))
          .limit(1)
      )[0];
      if (existing === undefined) return { kind: 'no_delivery' as const };
      const ageDays = (Date.now() - existing.createdAt.getTime()) / 86_400_000;
      if (ageDays > REPLAY_WINDOW_DAYS) return { kind: 'too_old' as const };
      const row = firstRow(
        await tx
          .update(webhookDeliveries)
          .set({
            status: 'pending',
            attempt: 0,
            nextAttemptAt: new Date(),
            responseStatus: null,
            responseBody: null,
            error: null,
            durationMs: null,
            deliveredAt: null,
          })
          .where(eq(webhookDeliveries.id, deliveryId))
          .returning(),
      );
      return { kind: 'queued' as const, row };
    });

    if (outcome.kind === 'no_webhook') throw errors.notFound('webhook', c.req.param('id') ?? '');
    if (outcome.kind === 'disabled') throw webhookDisabled();
    if (outcome.kind === 'no_delivery') {
      throw errors.notFound('webhook delivery', c.req.param('did') ?? '');
    }
    if (outcome.kind === 'too_old') {
      throw errors.conflict(
        `A delivery may be replayed for ${String(REPLAY_WINDOW_DAYS)} days after it was created.`,
        'delivery_too_old',
        'did',
      );
    }
    c.set('effectCommitted', true);
    return c.json(serializeWebhookDelivery(outcome.row));
  });

  return routes;
}
