/**
 * `GET /v1/payments/{id}` and `GET /v1/payments`: reading the money of a booking.
 *
 * Two reads and nothing else. There is deliberately **no** `POST /v1/payments` and no
 * `POST /v1/payments/{id}/refund` in this release: a payment comes into existence only as part
 * of creating a booking, and a refund only as a consequence of cancelling one or of somebody
 * pressing refund in the Stripe dashboard. Both of those are decisions with a reason attached,
 * recorded on the booking; an endpoint that moved money on its own would be a fourth way for
 * `amount_refunded` to change, and the invariant this release rests on is that there are two:
 * the creation of a booking, and the webhook receiver after a verified signature.
 *
 * ## The one call to Stripe, and where it is not made
 *
 * `GET /v1/payments/{id}` asks Stripe for the intent, and only when there is something to ask
 * about: the row is not a refund, it is still `pending`, and an intent was actually created.
 * What comes back is the `client_secret`, which is how a front end that lost the one from
 * `POST /v1/bookings` gets it again, and `provider_status`, which is the detail our five
 * statuses deliberately flatten (`requires_action` and `processing` are both `pending` here).
 *
 * If Stripe does not answer, the response is still a `200` with both fields `null`. Everything
 * else in it is ours, read from our own row, and a payment provider having a slow minute must
 * not turn a read of our own database into a failure. It is the same rule `charges_enabled` of
 * `GET /v1/stripe` follows.
 *
 * The **list** never calls Stripe at all, and neither does `expand[]=payments` on a booking: a
 * page of twenty payments would be twenty round trips to another company's API inside one
 * request. A caller that wants a secret asks for one payment.
 */
import { Hono } from 'hono';
import { and, asc, eq, gt } from 'drizzle-orm';
import { payments } from '@bookrail/db';
import { encodeId, errors } from '@bookrail/shared';
import type { AppDeps, AppEnv } from '../context.js';
import {
  inProject,
  listEnvelope,
  paginate,
  parseListParams,
  parseQuery,
  pathId,
  requireAuth,
} from '../http.js';
import { paymentListQuerySchema } from '../schemas/index.js';
import { serializePayment } from '../serialize.js';
import { StripeApiError, StripeUnreachableError } from '../stripe/client.js';
import { stripePlatform } from '../stripe/platform.js';

export function paymentsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', async (c) => {
    const { limit, startingAfter } = parseListParams(c, 'payment');
    const filters = parseQuery(c, paymentListQuerySchema);

    const payload = await inProject(c, deps, async (tx) => {
      const rows = await tx
        .select()
        .from(payments)
        .where(
          and(
            startingAfter ? gt(payments.id, startingAfter) : undefined,
            filters.booking_id ? eq(payments.bookingId, filters.booking_id) : undefined,
            filters.status ? eq(payments.status, filters.status) : undefined,
            filters.type ? eq(payments.type, filters.type) : undefined,
          ),
        )
        .orderBy(asc(payments.id))
        .limit(limit + 1);
      const { page, hasMore } = paginate(rows, limit);
      return listEnvelope(
        page.map((row) => serializePayment(row, {})),
        hasMore,
      );
    });

    return c.json(payload);
  });

  routes.get('/:id', async (c) => {
    const id = pathId(c, 'payment', 'payment');
    const auth = requireAuth(c);

    const row = await inProject(c, deps, async (tx) => {
      const rows = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
      return rows[0] ?? null;
    });
    // A payment of another project is invisible through RLS and reaches here as "not there",
    // which is the same answer, deliberately: neither confirms that anything exists.
    if (row === null) throw errors.notFound('payment', c.req.param('id') ?? '');

    let clientSecret: string | null = null;
    let providerStatus: string | null = null;
    const askable =
      row.type !== 'refund' && row.status === 'pending' && row.providerPaymentId !== null;
    if (askable) {
      try {
        const { client } = stripePlatform(deps.stripe, auth.environment);
        const intent = await client.retrievePaymentIntent({
          stripeAccount: row.providerAccountId,
          id: row.providerPaymentId!,
        });
        clientSecret = intent.clientSecret;
        providerStatus = intent.status;
      } catch (error) {
        if (!(error instanceof StripeApiError) && !(error instanceof StripeUnreachableError)) {
          throw error;
        }
        // Both fields stay null and the answer stays a 200. The log line carries the class of
        // the failure and the identifiers, and never the secret it was trying to fetch.
        deps.logger.warn('stripe_payment_intent_read_failed', {
          project_id: encodeId('project', auth.projectId),
          environment: auth.environment,
          payment_id: encodeId('payment', row.id),
          error_code: error instanceof StripeApiError ? error.type : error.reason,
        });
      }
    }

    return c.json(serializePayment(row, { clientSecret, providerStatus }));
  });

  return routes;
}
