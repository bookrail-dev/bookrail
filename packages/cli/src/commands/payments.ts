/**
 * `bookrail payments get|list`: reading the money of a booking from a terminal.
 *
 * Two reads and no writes, which is the whole surface the API offers: a payment is created by
 * `bookrail bookings create --payment`, and a refund by `bookrail bookings cancel`. There is no
 * `payments refund` here because there is no endpoint behind it, and a command that pretended
 * otherwise would be a command that fails at the wrong moment.
 *
 * `get` is the one command in this file that makes the API call Stripe, and it is why
 * `client_secret` is printed in full rather than masked: it is the value a front end needs, the
 * person who asked for it is the one holding the API key, and a secret that is shown as
 * `pi_..._secr…` is a secret nobody can use. It is **not** stored anywhere by Bookrail, so this
 * is the only way to get it back after the creation.
 */
import type { ListEnvelope } from '../api/client.js';
import type { Context } from '../context.js';
import { text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { clientFor, integer } from './helpers.js';

export interface PaymentBody {
  id: string;
  object: 'payment';
  booking_id: string | null;
  type: string;
  status: string;
  amount: number;
  currency: string;
  amount_refunded: number;
  provider: string;
  provider_payment_id: string | null;
  provider_account_id: string;
  parent_payment_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  client_secret: string | null;
  provider_status: string | null;
  environment: string;
  created_at: string | null;
  updated_at: string | null;
}

/** `1500 EUR` rather than `15.00 €`: the API speaks minor units, and so does this. */
function amount(value: number, currency: string): string {
  return `${String(value)} ${currency}`;
}

function paymentHuman(ctx: Context, data: PaymentBody, headline: string): string {
  const rows: string[][] = [
    ['booking', data.booking_id ?? '-'],
    ['type', data.type],
    ['status', data.status],
    ['amount', amount(data.amount, data.currency)],
    ['refunded', amount(data.amount_refunded, data.currency)],
    ['provider', `${data.provider} ${data.provider_payment_id ?? '(no reference yet)'}`],
    ['account', data.provider_account_id],
  ];
  if (data.parent_payment_id !== null) rows.push(['refund of', data.parent_payment_id]);
  if (data.failure_code !== null) {
    rows.push(['last failure', `${data.failure_code}: ${data.failure_message ?? ''}`]);
  }
  if (data.provider_status !== null) rows.push(['provider status', data.provider_status]);
  if (data.client_secret !== null) rows.push(['client_secret', data.client_secret]);
  return [
    `${ctx.presenter.badge()} ${headline} ${data.id} · ${data.status}`,
    renderTable(['field', 'value'], rows),
  ].join('\n');
}

export async function paymentGet(ctx: Context, id: string): Promise<CommandResult> {
  const client = await clientFor(ctx);
  const data = (await client.get<PaymentBody>(`/v1/payments/${encodeURIComponent(id)}`)).data;
  const steps: string[] = [];
  if (data.client_secret !== null) {
    steps.push(
      'Pass these to Stripe.js on your frontend: `loadStripe(publishable_key, { stripeAccount })`, then the client_secret.',
      'Read the publishable key and the account with `bookrail stripe status --json`.',
    );
  }
  if (data.booking_id !== null) {
    steps.push(`Read the booking: \`bookrail bookings get ${data.booking_id} --json\`.`);
  }
  return { data, human: paymentHuman(ctx, data, 'payment'), nextSteps: steps };
}

export interface PaymentListOptions {
  booking?: string;
  status?: string;
  type?: string;
  limit?: string;
  startingAfter?: string;
  all?: boolean;
}

export async function paymentList(
  ctx: Context,
  options: PaymentListOptions,
): Promise<CommandResult> {
  const query: Record<string, string | number | undefined> = {
    booking_id: options.booking,
    status: options.status,
    type: options.type,
  };
  const client = await clientFor(ctx);

  let rows: PaymentBody[];
  let hasMore = false;
  if (options.all === true) {
    rows = await client.listAll<PaymentBody>('/v1/payments', { query });
  } else {
    const limit = integer(options.limit, 'limit', { min: 1, max: 100 });
    const response = await client.get<ListEnvelope<PaymentBody>>('/v1/payments', {
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
        ? `${ctx.presenter.badge()} no payments match.`
        : [
            `${ctx.presenter.badge()} ${String(rows.length)} payment(s)`,
            '',
            renderTable(
              ['id', 'type', 'status', 'amount', 'refunded', 'booking', 'provider ref'],
              rows.map((row) => [
                row.id,
                row.type,
                row.status,
                amount(row.amount, row.currency),
                String(row.amount_refunded),
                truncate(row.booking_id ?? '', 24),
                text(row.provider_payment_id),
              ]),
            ),
            '',
            'A list never asks Stripe anything, so client_secret is always empty here.',
          ].join('\n'),
    nextSteps:
      cursor === null
        ? []
        : [`Next page: \`bookrail payments list --starting-after ${cursor} --json\`.`],
  };
}
