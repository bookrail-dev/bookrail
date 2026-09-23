/**
 * `bookrail bookings`: creation, reads, and the six transitions a booking can go through.
 *
 * The transitions are generated from one table rather than written six times: the API mounts
 * `POST /v1/bookings/{id}/{action}` from the engine's own `HTTP_TRANSITION_ACTIONS`, and a CLI
 * that hand-wrote them would be a second list that has to be kept in step with the first. The
 * two that take a body (`cancel`, `reschedule`) are declared separately, which is the same
 * split the API makes.
 *
 * Two commands deserve their own note.
 *
 * **`cancel` is the one destructive action here**, and it follows the rule for all of them: on
 * a terminal it asks, anywhere else it needs `--yes`. The rest of the transitions are not
 * destructive in the same sense (`confirm`, `check-in` and `complete` move a booking forward,
 * and `no-show` is a fact being recorded), and putting a flag in front of them would train an
 * agent to pass `--yes` everywhere, which is how the flag stops meaning anything.
 *
 * **The CLI spells the actions with hyphens** (`no-show`, `check-in`) because that is how a
 * command line reads, and accepts the API's underscored forms as aliases so that an agent
 * copying a name out of the API reference is never wrong.
 */
import type { ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { localTime, money, text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import {
  clientFor,
  confirm,
  customerFields,
  instant,
  integer,
  jsonObject,
  optionalInstant,
  readOptionalBody,
  required,
  type BodyOptions,
  type CustomerOptions,
} from './helpers.js';

/**
 * The state transitions the API exposes, with the command name on the left. `start` is
 * deliberately absent: it is what `auto_start` does, and the API answers
 * `404 unknown_endpoint` for it.
 */
export const TRANSITIONS: { command: string; action: string; aliases: string[] }[] = [
  { command: 'confirm', action: 'confirm', aliases: [] },
  { command: 'check-in', action: 'check_in', aliases: ['check_in', 'checkin'] },
  { command: 'complete', action: 'complete', aliases: [] },
  { command: 'no-show', action: 'no_show', aliases: ['no_show', 'noshow'] },
];

interface BookingBody {
  id: string;
  object: string;
  status: string;
  service_id: string;
  customer_id: string | null;
  hold_id: string | null;
  start: string;
  end: string;
  duration_minutes: number | null;
  timezone: string;
  quantity: number;
  price: unknown;
  amount_paid: number;
  amount_due: number;
  refund_percent: number | null;
  refund_amount_expected: number | null;
  reschedule_count: number;
  rescheduled_from_booking_id: string | null;
  next_transition: string | null;
  next_transition_at: string | null;
  payment_expires_at?: string | null;
  allocations: Record<string, unknown>[];
  environment: string;
  /**
   * Only in the answer of a creation, and only when the booking takes money.
   *
   * `client_secret` is `null` on an idempotent replay, because Bookrail never stores one:
   * `bookrail payments get` reads it back from Stripe instead.
   */
  payment_intent?: {
    id: string;
    client_secret: string | null;
    amount: number;
    currency: string;
    status: string;
    stripe_account: string;
    publishable_key: string;
    payment_id: string;
  } | null;
}

function bookingHuman(ctx: Context, data: BookingBody, headline: string): string {
  const lines = [
    `${ctx.presenter.badge()} ${headline} ${data.id} · ${data.status}`,
    renderTable(
      ['field', 'value'],
      [
        ['service', data.service_id],
        ['start (UTC)', data.start],
        ['local', `${localTime(data.start, data.timezone)} ${data.timezone}`],
        ['end (UTC)', data.end],
        ['duration', `${String(data.duration_minutes ?? '?')} min`],
        ['quantity', String(data.quantity)],
        ['price', money(data.price)],
        ['customer', data.customer_id ?? ''],
        ['hold', data.hold_id ?? ''],
        [
          'next transition',
          data.next_transition === null
            ? ''
            : `${data.next_transition} at ${text(data.next_transition_at)}`,
        ],
        ...(data.refund_percent === null
          ? []
          : [
              [
                'refund',
                `${String(data.refund_percent)}% (${String(data.refund_amount_expected ?? 0)} minor units expected)`,
              ],
            ]),
        ...(data.rescheduled_from_booking_id === null
          ? []
          : [['moved from', data.rescheduled_from_booking_id]]),
      ],
    ),
  ];
  if (data.allocations.length > 0) {
    lines.push(
      '',
      renderTable(
        ['allocation', 'resource', 'role', 'units'],
        data.allocations.map((allocation) => [
          text(allocation.id),
          text(allocation.resource_id),
          text(allocation.role),
          text(allocation.capacity_used),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

function afterSteps(data: BookingBody): string[] {
  const steps = [`Read it back: \`bookrail bookings get ${data.id} --json\`.`];
  if (data.payment_expires_at != null) {
    steps.push(
      `This booking is waiting for its payment and is cancelled at ${data.payment_expires_at} if it never arrives.`,
      `See the payment: \`bookrail payments list --booking ${data.id} --json\`.`,
    );
  } else if (data.status === 'pending') {
    steps.push(`Confirm it: \`bookrail bookings confirm ${data.id}\`.`);
  }
  if (data.status === 'confirmed') {
    steps.push(
      `Move it: \`bookrail bookings reschedule ${data.id} --start <instant>\`.`,
      `Cancel it: \`bookrail bookings cancel ${data.id} --yes\`.`,
    );
  }
  return steps;
}

export interface BookingCreateOptions extends BodyOptions, CustomerOptions {
  service?: string;
  start?: string;
  duration?: string;
  quantity?: string;
  resource?: string[];
  hold?: string;
  notes?: string;
  source?: string;
  metadata?: string;
  /** `none` (default), `deposit` or `full`. */
  payment?: string;
}

export async function bookingCreate(
  ctx: Context,
  options: BookingCreateOptions,
): Promise<CommandResult> {
  const body: Record<string, unknown> = {
    service_id: required(options.service, 'service', 'the service to book'),
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
  if (options.hold !== undefined) body.hold_id = options.hold;
  if (options.payment !== undefined) body.payment = { mode: options.payment };
  if (options.notes !== undefined) body.notes = options.notes;
  if (options.source !== undefined) body.source = options.source;
  const metadata = jsonObject(options.metadata, 'metadata');
  if (metadata !== undefined) body.metadata = metadata;

  const explicit = await readOptionalBody(ctx, options);
  const client = await clientFor(ctx);
  const data = (await client.post<BookingBody>('/v1/bookings', { ...body, ...explicit })).data;

  const intent = data.payment_intent ?? null;
  return {
    data,
    human:
      intent === null
        ? bookingHuman(ctx, data, 'booked')
        : [
            bookingHuman(ctx, data, 'booked'),
            '',
            renderTable(
              ['field', 'value'],
              [
                ['payment', data.payment_intent!.payment_id],
                ['amount', `${String(intent.amount)} ${intent.currency}`],
                ['client_secret', intent.client_secret ?? '(replayed: shown once, at creation)'],
                ['stripe_account', intent.stripe_account],
                ['publishable_key', intent.publishable_key],
              ],
            ),
            '',
            'Pass these to Stripe.js on your frontend.',
          ].join('\n'),
    nextSteps: afterSteps(data),
  };
}

export async function bookingGet(
  ctx: Context,
  id: string,
  options: { expand?: string[] },
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (
    await client.get<BookingBody>(`/v1/bookings/${encodeURIComponent(id)}`, {
      expand: options.expand ?? [],
    })
  ).data;
  return { data, human: bookingHuman(ctx, data, 'booking'), nextSteps: afterSteps(data) };
}

export interface BookingListOptions {
  customer?: string;
  service?: string;
  resource?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: string;
  startingAfter?: string;
  all?: boolean;
  expand?: string[];
}

export async function bookingList(
  ctx: Context,
  options: BookingListOptions,
): Promise<CommandResult> {
  const query: Record<string, string | number | undefined> = {
    customer_id: options.customer,
    service_id: options.service,
    resource_id: options.resource,
    status: options.status,
    from: optionalInstant(options.from, 'from'),
    to: optionalInstant(options.to, 'to'),
  };
  const expand = options.expand ?? [];
  const client = await clientFor(ctx);

  let rows: BookingBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<BookingBody>('/v1/bookings', { query, expand });
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<BookingBody>>('/v1/bookings', {
      expand,
      query: { ...query, limit, starting_after: options.startingAfter },
    });
    rows = response.data.data;
    hasMore = response.data.has_more;
  }

  const cursor = hasMore ? (rows.at(-1)?.id ?? null) : null;
  return {
    data: { object: 'list', data: rows, has_more: hasMore, next_cursor: cursor },
    human:
      rows.length === 0
        ? `${ctx.presenter.badge()} no bookings match.`
        : [
            `${ctx.presenter.badge()} ${rows.length} booking(s)`,
            '',
            renderTable(
              ['id', 'status', 'start (UTC)', 'local', 'min', 'qty', 'service', 'customer'],
              rows.map((row) => [
                row.id,
                row.status,
                row.start,
                localTime(row.start, row.timezone),
                text(row.duration_minutes),
                String(row.quantity),
                truncate(row.service_id, 24),
                truncate(row.customer_id ?? '', 24),
              ]),
            ),
          ].join('\n'),
    nextSteps:
      cursor === null
        ? []
        : [`Next page: \`bookrail bookings list --starting-after ${cursor} --json\`.`],
  };
}

/** The four transitions that take no parameters. */
export async function bookingAction(
  ctx: Context,
  action: string,
  id: string,
): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (
    await client.post<BookingBody>(`/v1/bookings/${encodeURIComponent(id)}/${action}`, {})
  ).data;
  return {
    data,
    human: bookingHuman(ctx, data, action.replace('_', ' ')),
    nextSteps: afterSteps(data),
  };
}

export interface CancelOptions {
  reason?: string;
  by?: string;
  refundPercent?: string;
  yes?: boolean;
}

export async function bookingCancel(
  ctx: Context,
  id: string,
  options: CancelOptions,
): Promise<CommandResult> {
  await confirm(
    ctx,
    `Cancel booking ${id}?`,
    options,
    `Run \`bookrail bookings cancel ${id} --yes\`. A cancellation cannot be undone: a booking that has to come back is created again.`,
  );

  const body: Record<string, unknown> = {};
  if (options.reason !== undefined) body.reason = options.reason;
  if (options.by !== undefined) body.by = options.by;
  const percent = integer(options.refundPercent, 'refund-percent', { min: 0, max: 100 });
  if (percent !== undefined) body.override_refund_percent = percent;

  const client = await clientFor(ctx);
  const data = (
    await client.post<BookingBody>(`/v1/bookings/${encodeURIComponent(id)}/cancel`, body)
  ).data;
  return {
    data,
    human: bookingHuman(ctx, data, 'cancelled'),
    nextSteps: [
      (data.refund_amount_expected ?? 0) > 0
        ? `A refund of ${String(data.refund_amount_expected)} minor units is queued and is sent to Stripe by the background worker: \`bookrail payments list --booking ${data.id} --json\`.`
        : 'The policy promises no refund at this distance from the start, so nothing is queued.',
      `Read it back: \`bookrail bookings get ${data.id} --json\`.`,
    ],
  };
}

export interface RescheduleOptions {
  start?: string;
  resource?: string[];
}

export async function bookingReschedule(
  ctx: Context,
  id: string,
  options: RescheduleOptions,
): Promise<CommandResult> {
  const body: Record<string, unknown> = { start: instant(options.start, 'start') };
  if (options.resource !== undefined && options.resource.length > 0) {
    body.resource_ids = options.resource;
  }
  const client = await clientFor(ctx);
  const data = (
    await client.post<BookingBody>(`/v1/bookings/${encodeURIComponent(id)}/reschedule`, body)
  ).data;
  return {
    data,
    human: bookingHuman(ctx, data, 'rescheduled to'),
    nextSteps: [
      `The answer is the **new** booking (${data.id}); the old one is at \`rescheduled_from_booking_id\` and is now "rescheduled".`,
      `Read it back: \`bookrail bookings get ${data.id} --json\`.`,
    ],
  };
}
