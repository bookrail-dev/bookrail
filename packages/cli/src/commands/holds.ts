/**
 * `bookrail holds create` and `bookrail holds release`.
 *
 * A hold is the two-phase half of booking: it takes the capacity now and gives the caller a
 * few minutes to collect a payment or a confirmation. Two consequences shape these commands.
 *
 * **`create` is a POST and therefore carries an `Idempotency-Key`** like every other POST of
 * the CLI. That matters more here than almost anywhere else: an agent that retries a hold
 * without one takes the capacity twice and then converts one of the two, leaving the other to
 * expire, which looks, from the outside, exactly like a double booking that healed itself.
 *
 * **`release` does not ask for `--yes`.** Deleting a service is destructive; releasing a hold
 * is the *intended* end of its life (the alternative is waiting ten minutes for the same
 * outcome), and `DELETE /v1/holds/{id}` is idempotent by design: releasing one that is already
 * released, or expired, is a 200. The one case that is not idempotent, a hold already converted
 * into a booking, answers `409 hold_not_active`, which is exactly the confirmation a flag would
 * have been standing in for.
 */
import type { Context } from '../context.js';
import { countdown, localTime, money, text } from '../format.js';
import { renderTable, type CommandResult } from '../output.js';
import {
  clientFor,
  customerFields,
  instant,
  integer,
  jsonObject,
  readOptionalBody,
  required,
  type BodyOptions,
  type CustomerOptions,
} from './helpers.js';

interface HoldBody {
  id: string;
  object: string;
  status: string;
  service_id: string;
  customer_id: string | null;
  /** Only on the read: the booking a converted hold became. */
  booking_id?: string | null;
  start: string;
  end: string;
  duration_minutes: number | null;
  quantity: number;
  timezone: string | null;
  expires_at: string;
  price: unknown;
  allocations: unknown[];
  environment: string;
}

export interface HoldCreateOptions extends BodyOptions, CustomerOptions {
  service?: string;
  start?: string;
  duration?: string;
  quantity?: string;
  resource?: string[];
  ttl?: string;
  metadata?: string;
}

export async function holdCreate(ctx: Context, options: HoldCreateOptions): Promise<CommandResult> {
  const body: Record<string, unknown> = {
    service_id: required(options.service, 'service', 'the service to hold capacity on'),
    start: instant(options.start, 'start'),
    ...customerFields(options),
  };
  const duration = integer(options.duration, 'duration', { min: 1, max: 525600 });
  if (duration !== undefined) body.duration_minutes = duration;
  const quantity = integer(options.quantity, 'quantity', { min: 1, max: 100000 });
  if (quantity !== undefined) body.quantity = quantity;
  if (options.resource !== undefined && options.resource.length > 0) {
    body.resource_ids = options.resource;
  }
  if (options.ttl !== undefined) body.ttl = options.ttl;
  const metadata = jsonObject(options.metadata, 'metadata');
  if (metadata !== undefined) body.metadata = metadata;

  // `--data` / `--file` / `--set` come last, so an agent that already has the whole body can
  // send it and still use the named flags for the parts it knows.
  const explicit = await readOptionalBody(ctx, options);
  const client = await clientFor(ctx);
  const data = (await client.post<HoldBody>('/v1/holds', { ...body, ...explicit })).data;

  return {
    data,
    human: [
      `${ctx.presenter.badge()} held ${data.id} · ${data.start} to ${data.end} (${String(data.duration_minutes ?? '?')} min, quantity ${String(data.quantity)}${money(data.price) === '' ? '' : `, ${money(data.price)}`})`,
      `expires at ${data.expires_at} (in ${countdown(data.expires_at)})`,
      ...(data.allocations.length === 0
        ? []
        : [
            '',
            renderTable(
              ['resource', 'role', 'units'],
              data.allocations.map((allocation) => {
                const row = allocation as Record<string, unknown>;
                return [text(row.resource_id), text(row.role), text(row.capacity_used)];
              }),
            ),
          ]),
    ].join('\n'),
    nextSteps: [
      `Convert it: \`bookrail bookings create --service ${data.service_id} --start ${data.start} --hold ${data.id} --customer-email you@example.com --json\`.`,
      `Give it back: \`bookrail holds release ${data.id} --json\`.`,
    ],
  };
}

/**
 * `bookrail holds get <id>`.
 *
 * `status` is the field this command exists for: `active`, `released`, `expired` or
 * `converted`, plus `booking_id` when the hold became one. A hold that is `expired` is not a
 * failure to report: it is the answer to "can I still convert this", and the answer is no.
 *
 * `price` comes back `null` here and non-null from `holds create`: the price of a hold is not
 * stored, it is computed at creation and frozen only when the hold becomes a booking. The
 * table says so rather than showing an empty cell that looks like zero.
 */
export async function holdGet(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.get<HoldBody>(`/v1/holds/${encodeURIComponent(id)}`)).data;
  const alive = data.status === 'active';
  return {
    data,
    human: [
      `${ctx.presenter.badge()} ${data.id} is ${data.status}${data.booking_id == null ? '' : ` → ${data.booking_id}`}`,
      '',
      renderTable(
        ['field', 'value'],
        [
          ['status', data.status],
          ['service', data.service_id],
          ['customer', text(data.customer_id)],
          ['booking', text(data.booking_id ?? null)],
          ['start', `${data.start}  (${localTime(data.start, data.timezone)})`],
          ['end', `${data.end}  (${localTime(data.end, data.timezone)})`],
          ['quantity', String(data.quantity)],
          [
            'expires at',
            alive ? `${data.expires_at} (in ${countdown(data.expires_at)})` : data.expires_at,
          ],
          ['price', 'not recorded on a hold'],
          [
            'resources',
            data.allocations
              .map((allocation) => text((allocation as Record<string, unknown>).resource_id))
              .join(', '),
          ],
        ],
      ),
    ].join('\n'),
    nextSteps: alive
      ? [
          `Convert it: \`bookrail bookings create --service ${data.service_id} --start ${data.start} --hold ${data.id} --customer-email you@example.com --json\`.`,
          `Give it back: \`bookrail holds release ${data.id} --json\`.`,
        ]
      : data.booking_id == null
        ? ['This hold is over: the capacity is free again. Create a new one to take it back.']
        : [`Read what it became: \`bookrail bookings get ${data.booking_id} --json\`.`],
  };
}

export async function holdRelease(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (
    await client.delete<{ id: string; object: string; deleted: boolean }>(
      `/v1/holds/${encodeURIComponent(id)}`,
    )
  ).data;
  return {
    data,
    human: `${ctx.presenter.badge()} released ${data.id}: the capacity is free again.`,
    nextSteps: ['Releasing a hold twice is a success, not an error: the slot is free either way.'],
  };
}
