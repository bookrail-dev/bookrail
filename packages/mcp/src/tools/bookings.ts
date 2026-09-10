import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Workspace } from '../environment.js';
import { confirmArgument, environmentArgument, needsConfirmation, registerTool } from '../tool.js';

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  // Every POST the command layer makes carries an `Idempotency-Key`, so a retried call is the
  // same call within the 24 hour window and not a second booking.
  idempotentHint: true,
  openWorldHint: true,
} as const;

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const customerShape = {
  customer_id: z
    .string()
    .optional()
    .describe('An existing customer (`cus_...`). Mutually exclusive with the customer_* fields.'),
  customer_email: z.string().optional().describe('Creates or finds a customer by email.'),
  customer_name: z.string().optional().describe('Only with customer_email / phone / external_id.'),
  customer_phone: z.string().optional().describe('Creates or finds a customer by phone.'),
  customer_external_id: z.string().optional().describe('Your own identifier for the customer.'),
};

function customerFlags(args: {
  customer_id?: string;
  customer_email?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_external_id?: string;
}): string[] {
  return [
    ...(args.customer_id === undefined ? [] : ['--customer', args.customer_id]),
    ...(args.customer_email === undefined ? [] : ['--customer-email', args.customer_email]),
    ...(args.customer_name === undefined ? [] : ['--customer-name', args.customer_name]),
    ...(args.customer_phone === undefined ? [] : ['--customer-phone', args.customer_phone]),
    ...(args.customer_external_id === undefined
      ? []
      : ['--customer-external-id', args.customer_external_id]),
  ];
}

const TRANSITIONS = ['confirm', 'check_in', 'complete', 'no_show'] as const;

export function registerBookingTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_hold_create',
    title: 'Hold capacity for a few minutes',
    description: [
      "Takes the capacity for an instant and keeps it for the policy's hold duration (ten minutes by default), so you can collect a payment or a confirmation without racing anyone else.",
      'Use it in any flow where something happens between choosing a slot and committing to it. Skip it and call `bookrail_booking_create` directly when nothing happens in between.',
      'Returns: `{ id, status, start, end, expires_at, quantity, price, allocations }`.',
      'Next: `bookrail_booking_create` with `hold_id` to convert it, or `bookrail_hold_release` to give it back.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: z.string().describe('The service id (`svc_...`).'),
      start: z.string().describe('ISO 8601 instant with an explicit offset.'),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Required when the service offers several durations.'),
      quantity: z.number().int().min(1).optional().describe('How many units. Default 1.'),
      resource_ids: z.array(z.string()).optional().describe('Pin specific resources.'),
      ttl: z.string().optional().describe('How long to hold it, e.g. "10m". Default: the policy.'),
      metadata: z.record(z.unknown()).optional().describe('Your own key/value pairs.'),
      ...customerShape,
    },
    annotations: WRITE,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'holds',
        'create',
        '--service',
        args.service_id,
        '--start',
        args.start,
        ...(args.duration_minutes === undefined
          ? []
          : ['--duration', String(args.duration_minutes)]),
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
        ...(args.ttl === undefined ? [] : ['--ttl', args.ttl]),
        ...(args.metadata === undefined ? [] : ['--metadata', JSON.stringify(args.metadata)]),
        ...(args.resource_ids ?? []).flatMap((id) => ['--resource', id]),
        ...customerFlags(args),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_hold_get',
    title: 'Read one hold',
    description: [
      'Returns one hold and, above all, its status: `active` (still convertible), `released`, `expired`, or `converted`, with `booking_id` when it became a booking.',
      'Use it when a flow was interrupted and you do not know whether the hold you took is still yours, and before retrying a conversion that failed: a hold that is `expired` will never convert, and the answer is to take a new one.',
      'Returns: `{ id, status, service_id, start, end, expires_at, booking_id, allocations }`. `price` is null on a read: a hold has no stored price, only a booking freezes one.',
      'Next: `bookrail_booking_create` with `hold_id` while it is active; `bookrail_availability` once it is not.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      hold_id: z.string().describe('The hold id (`hold_...`).'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli(['holds', 'get', args.hold_id]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_hold_release',
    title: 'Give a hold back',
    description: [
      'Releases a hold and frees the capacity immediately, instead of waiting for it to expire.',
      "Use it as soon as a flow is abandoned. It needs no confirmation: `DELETE /v1/holds/{id}` is idempotent and releasing is the intended end of a hold's life. A hold already converted into a booking answers 409 `hold_not_active`.",
      'Returns: `{ id, deleted: true }`.',
      'Next: nothing. Releasing twice is a success, not an error.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      hold_id: z.string().describe('The hold id (`hold_...`).'),
    },
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, ctx) {
      const envelope = await ctx.cli(['holds', 'release', args.hold_id]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_booking_create',
    title: 'Create a booking',
    description: [
      'Creates a booking, optionally by converting a hold. The capacity is taken inside one database transaction, so two simultaneous requests for the last seat cannot both succeed: the loser gets `slot_unavailable` (409).',
      'Use it after `bookrail_availability` or `bookrail_availability_check`. Pass `hold_id` when you held the slot first: converting a hold cannot fail for capacity.',
      'Returns: the booking `{ id, status, start, end, price, allocations, next_transition }`.',
      'Next: `bookrail_booking_get` to close the loop; `bookrail_booking_confirm` when the status is "pending".',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: z.string().describe('The service id (`svc_...`).'),
      start: z.string().describe('ISO 8601 instant with an explicit offset.'),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Required when the service offers several durations.'),
      quantity: z.number().int().min(1).optional().describe('How many units. Default 1.'),
      hold_id: z.string().optional().describe('Convert this hold instead of taking new capacity.'),
      resource_ids: z.array(z.string()).optional().describe('Pin specific resources.'),
      notes: z.string().optional().describe('Free text kept on the booking.'),
      source: z
        .enum(['api', 'widget', 'portal', 'import'])
        .optional()
        .describe('Where the booking came from. Default "api".'),
      metadata: z.record(z.unknown()).optional().describe('Your own key/value pairs.'),
      ...customerShape,
    },
    annotations: WRITE,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'bookings',
        'create',
        '--service',
        args.service_id,
        '--start',
        args.start,
        ...(args.duration_minutes === undefined
          ? []
          : ['--duration', String(args.duration_minutes)]),
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
        ...(args.hold_id === undefined ? [] : ['--hold', args.hold_id]),
        ...(args.notes === undefined ? [] : ['--notes', args.notes]),
        ...(args.source === undefined ? [] : ['--source', args.source]),
        ...(args.metadata === undefined ? [] : ['--metadata', JSON.stringify(args.metadata)]),
        ...(args.resource_ids ?? []).flatMap((id) => ['--resource', id]),
        ...customerFlags(args),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_booking_get',
    title: 'Read one booking',
    description: [
      'Returns one booking with its status, times, price, refund expectation, allocations and the transition scheduled for it.',
      'Use it after every write, to close the loop on what actually happened.',
      'Returns: the booking object.',
      'Next: the transition the `next_transition` field names, or `bookrail_booking_cancel`.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      booking_id: z.string().describe('The booking id (`bk_...`).'),
      expand: z
        .array(z.enum(['customer', 'allocations.resource']))
        .optional()
        .describe('Include the linked objects inline instead of just their ids.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'bookings',
        'get',
        args.booking_id,
        ...(args.expand ?? []).flatMap((value) => ['--expand', value]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_booking_list',
    title: 'List bookings',
    description: [
      'Lists bookings, filtered by customer, service, resource, status or time window, with cursor pagination.',
      'Use it to answer "what is on the calendar" and to find a booking whose id you do not have.',
      'Returns: `{ data: [...], has_more, next_cursor }`. Pass `next_cursor` back as `starting_after` for the next page.',
      'Next: `bookrail_booking_get` on one of them.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      customer_id: z.string().optional(),
      service_id: z.string().optional(),
      resource_id: z.string().optional(),
      status: z
        .string()
        .optional()
        .describe('pending, confirmed, in_progress, completed, cancelled, no_show, rescheduled.'),
      from: z.string().optional().describe('ISO 8601 instant with an offset.'),
      to: z.string().optional().describe('ISO 8601 instant with an offset.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100.'),
      starting_after: z.string().optional().describe('Cursor: the id of the last row you saw.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'bookings',
        'list',
        ...(args.customer_id === undefined ? [] : ['--customer', args.customer_id]),
        ...(args.service_id === undefined ? [] : ['--service', args.service_id]),
        ...(args.resource_id === undefined ? [] : ['--resource', args.resource_id]),
        ...(args.status === undefined ? [] : ['--status', args.status]),
        ...(args.from === undefined ? [] : ['--from', args.from]),
        ...(args.to === undefined ? [] : ['--to', args.to]),
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

  registerTool(server, workspace, {
    name: 'bookrail_booking_transition',
    title: 'Move a booking forward',
    description: [
      'Applies one of the four forward transitions of a booking: `confirm`, `check_in`, `complete`, `no_show`. Each is checked against the state matrix; an illegal transition is a 409 that names the current status.',
      'Use it to record what happened. `no_show` is a fact being recorded, not a cancellation: to cancel, use `bookrail_booking_cancel`.',
      'Returns: the booking after the transition.',
      'Next: `bookrail_booking_get`, or the transition its `next_transition` names.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      booking_id: z.string().describe('The booking id (`bk_...`).'),
      action: z.enum(TRANSITIONS).describe('Which transition to apply.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
    async run(args, ctx) {
      const envelope = await ctx.cli(['bookings', args.action, args.booking_id]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_booking_cancel',
    title: 'Cancel a booking',
    description: [
      'Cancels a booking, releases its capacity and computes the refund the frozen policy snapshot entitles the customer to.',
      'IRREVERSIBLE: a cancelled booking does not come back, it is created again. So without `confirm: true` this tool returns the booking as it stands today plus `requires_confirmation: true`, and changes nothing.',
      'Returns: the cancelled booking, with `refund_percent` and `refund_amount_expected`. Payments do not exist yet, so the refund is an expectation, not a movement.',
      'Next: `bookrail_booking_get` to read it back.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      booking_id: z.string().describe('The booking id (`bk_...`).'),
      reason: z.string().optional().describe('Free text kept on the booking.'),
      by: z
        .enum(['customer', 'provider', 'system'])
        .optional()
        .describe('Who wanted the cancellation. It decides which policy ladder applies.'),
      refund_percent: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Override the percentage the policy would compute.'),
      confirm: confirmArgument,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, ctx) {
      if (args.confirm !== true) {
        const current = await ctx.cli(['bookings', 'get', args.booking_id]);
        return needsConfirmation(ctx.environment, current.data, [
          'Nothing was cancelled. Check `preview.status`, `preview.start` and `preview.customer_id`, then call again with confirm: true.',
          'A cancellation cannot be undone: a booking that has to come back is created again.',
        ]);
      }
      const envelope = await ctx.cli([
        'bookings',
        'cancel',
        args.booking_id,
        '--yes',
        ...(args.reason === undefined ? [] : ['--reason', args.reason]),
        ...(args.by === undefined ? [] : ['--by', args.by]),
        ...(args.refund_percent === undefined
          ? []
          : ['--refund-percent', String(args.refund_percent)]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_booking_reschedule',
    title: 'Move a booking to another instant',
    description: [
      'Moves a booking to a new instant. The answer is the NEW booking; the old one becomes "rescheduled" and is reachable at `rescheduled_from_booking_id`.',
      'Use it instead of cancel-and-rebook: rescheduling keeps the link, counts against `max_reschedules`, and applies the reschedule ladder of the policy rather than the cancellation one.',
      'Returns: the new booking.',
      'Next: `bookrail_booking_get` on the returned `id`.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      booking_id: z.string().describe('The booking to move (`bk_...`).'),
      start: z.string().describe('The new instant, ISO 8601 with an explicit offset.'),
      resource_ids: z
        .array(z.string())
        .optional()
        .describe('Pin specific resources for the new slot.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'bookings',
        'reschedule',
        args.booking_id,
        '--start',
        args.start,
        ...(args.resource_ids ?? []).flatMap((id) => ['--resource', id]),
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
