import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Workspace } from '../environment.js';
import { environmentArgument, registerTool } from '../tool.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const instant = (what: string) =>
  z
    .string()
    .describe(
      `${what} as an ISO 8601 instant with an explicit offset, e.g. "2026-09-08T07:00:00Z" or "2026-09-08T09:00:00+02:00". A bare date is refused: midnight is not the same instant in every time zone.`,
    );

const serviceArgument = z
  .string()
  .describe('The service id (`svc_...`). Get it from bookrail_objects_list with kind "services".');

const resourceArgument = z
  .array(z.string())
  .optional()
  .describe('Restrict to these resource ids (`res_...`). Omit to let the group allocate.');

/**
 * The four availability tools. They are the ones an agent calls most, and the only ones whose
 * answer it is expected to feed straight into the next call.
 */
export function registerAvailabilityTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_availability',
    title: 'What is bookable in a window',
    description: [
      'Returns every bookable instant for a service between two instants, with duration, remaining capacity, price and the resource combinations that could serve it.',
      'Use it before creating a hold or a booking. With `explain: true` it also returns, for every candidate instant that is NOT bookable, the structured reasons why, which is the fastest way to understand a model that is not doing what you expect.',
      'Window: at most 90 days, 7 with `explain`.',
      'Returns: `{ service_id, timezone, granularity, slots: [{ start, end, duration_minutes, available_capacity, price, price_rule, resource_options }], next_available, explain? }`. Instants out are UTC.',
      '`price` is the price of that slot, not necessarily the flat price of the service: if the service carries `pricing_rules`, the first rule whose `when` matches decides, and `price_rule` is `{ index, label }` naming it, or null when the flat price applied. It is the price the booking will freeze.',
      'Next: `bookrail_hold_create` to take the capacity for a few minutes, or `bookrail_booking_create` to book directly.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: serviceArgument,
      from: instant('Start of the window'),
      to: instant('End of the window'),
      quantity: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How many units, e.g. seats. Default 1.'),
      timezone: z
        .string()
        .optional()
        .describe('IANA zone for the presented times, e.g. "Europe/Rome".'),
      resource_ids: resourceArgument,
      customer_id: z.string().optional().describe("Apply this customer's entitlements and limits."),
      granularity: z
        .enum(['slots', 'ranges'])
        .optional()
        .describe(
          '"slots" (default) for discrete starts, "ranges" for continuous bookable intervals.',
        ),
      explain: z
        .boolean()
        .default(false)
        .describe(
          'Also return why each rejected instant was rejected. Limits the window to 7 days.',
        ),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'availability',
        '--service',
        args.service_id,
        '--from',
        args.from,
        '--to',
        args.to,
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
        ...(args.timezone === undefined ? [] : ['--tz', args.timezone]),
        ...(args.customer_id === undefined ? [] : ['--customer', args.customer_id]),
        ...(args.granularity === undefined ? [] : ['--granularity', args.granularity]),
        ...(args.resource_ids ?? []).flatMap((id) => ['--resource', id]),
        ...(args.explain ? ['--explain'] : []),
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
    name: 'bookrail_availability_next',
    title: 'The first bookable instant',
    description: [
      'Returns the first instant a service can be booked at, searched in 30-day windows up to 90 days ahead.',
      'Use it when you need *an* instant rather than a window: a smoke test after a push, or the default a user is offered.',
      'Returns: `{ next_available, slot, searched_through, timezone }`. `next_available` is null when nothing is bookable in 90 days.',
      'Next: `bookrail_availability_check` on that instant, then `bookrail_hold_create` or `bookrail_booking_create`.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: serviceArgument,
      from: instant('Where to start searching').optional(),
      quantity: z.number().int().min(1).optional().describe('How many units. Default 1.'),
      timezone: z.string().optional().describe('IANA zone for the presented times.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'availability',
        'next',
        '--service',
        args.service_id,
        ...(args.from === undefined ? [] : ['--from', args.from]),
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
        ...(args.timezone === undefined ? [] : ['--tz', args.timezone]),
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
    name: 'bookrail_availability_check',
    title: 'Is this exact instant bookable',
    description: [
      'Answers whether one precise instant is bookable, and when it is not, returns the structured reasons.',
      'Use it right before booking an instant you got from somewhere else (a UI, a cache, a user), and to close the loop after a configuration change.',
      'Returns: `{ available, available_capacity, price, resource_options, reasons? }`.',
      'Next: `bookrail_hold_create` if available; `bookrail_explain_unavailable` or `bookrail_availability` with explain: true if not.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: serviceArgument,
      start: instant('The instant to check'),
      duration_minutes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Required when the service offers several durations.'),
      quantity: z.number().int().min(1).optional().describe('How many units. Default 1.'),
      resource_ids: resourceArgument,
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'availability',
        'check',
        '--service',
        args.service_id,
        '--start',
        args.start,
        ...(args.duration_minutes === undefined
          ? []
          : ['--duration', String(args.duration_minutes)]),
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
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

  registerTool(server, workspace, {
    name: 'bookrail_explain_unavailable',
    title: 'Why is this instant not bookable',
    description: [
      'The "why not" of the availability engine for one instant: closed schedule, block, existing occupancy, buffer, booking window, grid alignment, capacity, policy. Each one comes back as a code, a message and, where it applies, the resource it came from.',
      'Use it whenever an instant you expected to be bookable is not. It is the same computation `bookrail_availability_check` reports and the same one `explain: true` reports over a window, narrowed to one instant so the answer is short.',
      'Returns: `{ available, reasons: [{ code, message, resource_id? }] }`.',
      'Next: fix the model (`bookrail_config_push`) or pick another instant (`bookrail_availability_next`).',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      service_id: serviceArgument,
      start: instant('The instant that is not bookable'),
      duration_minutes: z.number().int().min(1).optional().describe('The duration you intended.'),
      quantity: z.number().int().min(1).optional().describe('How many units. Default 1.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'availability',
        'check',
        '--service',
        args.service_id,
        '--start',
        args.start,
        ...(args.duration_minutes === undefined
          ? []
          : ['--duration', String(args.duration_minutes)]),
        ...(args.quantity === undefined ? [] : ['--quantity', String(args.quantity)]),
      ]);
      const data = envelope.data as { available?: boolean; reasons?: unknown[] };
      return {
        ok: true,
        environment: ctx.environment,
        data,
        next_steps:
          data.available === true
            ? ['This instant IS bookable. Call bookrail_hold_create or bookrail_booking_create.']
            : [
                'Read `reasons[].code`. `bookrail_edge_cases` with topic "schedules" explains the order rules, exceptions and blocks are applied in.',
                `Find another instant: bookrail_availability_next with service_id "${args.service_id}".`,
              ],
      };
    },
  });
}
