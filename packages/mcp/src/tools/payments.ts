import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from '../environment.js';
import { environmentArgument, registerTool } from '../tool.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The customer's own Stripe account, and the money that moves on it.
 *
 * Four tools. Two of them read a payment and there is deliberately no third that **makes** one:
 * a payment is created by `bookrail_booking_create` with a `payment_mode`, and a refund by
 * `bookrail_booking_cancel`, which follows the policy the customer agreed to. An agent that
 * could refund on its own would be an agent that can move somebody's money for a reason the
 * booking does not record.
 *
 * On the connection side there are two, and the missing third one is the point. There is no `bookrail_stripe_disconnect`:
 * ending the link stops a business taking money, an agent has no way to know that this is what
 * somebody meant, and the person who wants it has `bookrail stripe disconnect --yes` in a
 * terminal. A `confirm: true` argument would not fix that, because the confirmation an agent
 * produces is the agent's, not the owner's.
 *
 * `bookrail_stripe_connect` **is** offered, and with `requires_confirmation: false`, which
 * looks surprising for something called "connect" and is not: it changes nothing at all. It
 * mints a single use link and hands it back. Nothing is connected until a human opens that
 * link, signs in to Stripe and authorises there, which is a thing no agent can do and no agent
 * should be able to do. The tool is the agent saying "here is what you have to click".
 */
export function registerPaymentTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_stripe_status',
    title: 'Which Stripe account this project charges on',
    description: [
      'Returns the state of the Stripe connection for this project and environment: whether an account is connected, which one, and whether Stripe is currently letting it take charges.',
      'Use it before telling anybody that payments work, and whenever a payment related call fails for a reason you cannot place.',
      'Returns: `{ status: "connected" | "not_connected" | "disconnected", account_id, publishable_key, charges_enabled, connected_at, disconnected_at }`. `charges_enabled` is null when nothing is connected and also when Stripe did not answer in time: null is not false.',
      'Next: `bookrail_stripe_connect` when nothing is connected. Initialise Stripe.js in the front end with `publishable_key` (the platform key) and `{ stripeAccount: account_id }`.',
    ].join('\n'),
    inputSchema: { environment: environmentArgument },
    annotations: READ,
    async run(_args, ctx) {
      const envelope = await ctx.cli(['stripe', 'status']);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_stripe_connect',
    title: 'Get the link a person has to open to connect a Stripe account',
    description: [
      'Creates a Stripe authorisation link and returns it. It changes nothing: no account is connected until a person opens the link, signs in to Stripe and authorises there.',
      'Use it when `bookrail_stripe_status` says nothing is connected. Show the url to the person you are working with and tell them it stops working at `expires_at`, fifteen minutes later.',
      'Returns: `{ url, expires_at, environment }`.',
      'Next: after they say they have authorised, call `bookrail_stripe_status` to confirm. Never ask anybody for a Stripe secret key: Bookrail neither wants nor stores one.',
    ].join('\n'),
    inputSchema: { environment: environmentArgument },
    // Read-only is false because a row is written (the single use state), and destructive is
    // false because nothing a customer owns changes until a human authorises on Stripe.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(_args, ctx) {
      // `--no-open` because this server has no terminal and no browser to open one in, and
      // `--no-wait` because an agent must not be held for fifteen minutes while somebody
      // clicks: the answer is the link, and the state is read back with the other tool.
      const envelope = await ctx.cli(['stripe', 'connect', '--no-open', '--no-wait']);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        requires_confirmation: false,
        next_steps: [
          'Show the url to the person and ask them to authorise on Stripe.',
          'Call bookrail_stripe_status afterwards to confirm the account is connected.',
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_payment_get',
    title: 'Read one payment, with its client secret',
    description: [
      'Returns one payment or refund of a booking, and, for a payment that is still pending, the `client_secret` and the provider status read from Stripe at request time.',
      'Use it when a front end has lost the `client_secret` that `bookrail_booking_create` returned: Bookrail stores no client secret anywhere, so this is the only way to get one back.',
      'Returns: `{ id, booking_id, type, status, amount, currency, amount_refunded, provider_payment_id, failure_code, failure_message, client_secret, provider_status }`. `client_secret` and `provider_status` are null for a refund, for a payment that is no longer pending, and when Stripe did not answer.',
      'Next: pass `client_secret` to Stripe.js with the `publishable_key` and `account_id` of `bookrail_stripe_status`. Do not print a client secret into a shared log or a chat transcript: treat it as the payment link it is.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      payment_id: z.string().describe('The payment id (`pay_...`).'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli(['payments', 'get', args.payment_id]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_payment_list',
    title: 'List the payments of a booking',
    description: [
      'Lists payments and refunds, filtered by booking, status or type. It never calls Stripe, so `client_secret` is always null here.',
      'Use it to see what a booking has been charged and what has gone back: after a cancellation, the refund the policy promised appears here as a row of type "refund", `pending` until the background worker has sent it to Stripe and `succeeded` once Stripe confirms the money moved.',
      'Returns: a cursor page of payments.',
      'Next: `bookrail_payment_get` on one of them when you need its client secret.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      booking_id: z.string().optional().describe('Only the payments of this booking (`bk_...`).'),
      status: z
        .enum(['pending', 'succeeded', 'failed', 'refunded', 'cancelled'])
        .optional()
        .describe('Only payments in this state.'),
      type: z
        .enum(['deposit', 'full', 'balance', 'no_show_fee', 'refund'])
        .optional()
        .describe('Only payments of this kind.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size. Default 20.'),
      starting_after: z.string().optional().describe('Cursor: the id of the last item read.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'payments',
        'list',
        ...(args.booking_id === undefined ? [] : ['--booking', args.booking_id]),
        ...(args.status === undefined ? [] : ['--status', args.status]),
        ...(args.type === undefined ? [] : ['--type', args.type]),
        ...(args.limit === undefined ? [] : ['--limit', String(args.limit)]),
        ...(args.starting_after === undefined ? [] : ['--starting-after', args.starting_after]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });
}
