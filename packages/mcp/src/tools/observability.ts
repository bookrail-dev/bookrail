import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Workspace } from '../environment.js';
import { confirmArgument, environmentArgument, needsConfirmation, registerTool } from '../tool.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The event log and the webhook endpoints: what an agent uses to find out what actually
 * happened, and to wire the application to it.
 *
 * There is deliberately no `bookrail_request_get(request_id)`: the API keeps no request log to
 * read, only a `Bookrail-Request-Id` header on each response. `bookrail_events_list` is the log
 * that does exist.
 */
export function registerObservabilityTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_events_list',
    title: 'Read the event log',
    description: [
      'Lists the events of the project (booking.created, booking.cancelled, booking.orphaned, hold.expired and the rest), newest page first, in a total order that is safe to page through.',
      'Use it to find out what a call actually did, to check that a change produced the event you expected, and as the payload reference for a webhook handler: an event here is byte for byte what a delivery would have carried.',
      'Returns: `{ data: [{ id, type, occurred_at, actor, data: { object, previous } }], has_more, next_cursor }`.',
      'Next: `bookrail_event_get` for one of them; `bookrail_webhook_create` to receive them instead of polling.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      type: z
        .array(z.string())
        .optional()
        .describe('Only these event types, e.g. ["booking.created"].'),
      object_id: z.string().optional().describe('Only events about this object.'),
      from: z.string().optional().describe('ISO 8601 instant with an offset.'),
      to: z.string().optional().describe('ISO 8601 instant with an offset.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100.'),
      starting_after: z.string().optional().describe('Cursor: the id of the last event you saw.'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'events',
        'list',
        ...(args.type ?? []).flatMap((value) => ['--type', value]),
        ...(args.object_id === undefined ? [] : ['--object-id', args.object_id]),
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
    name: 'bookrail_event_get',
    title: 'Read one event',
    description: [
      'Returns one event with its full payload: the object as it is after the change, and the previous version where there is one.',
      'Use it when an event id came from a webhook delivery or from `bookrail_events_list` and you need the whole body.',
      'Returns: the event object.',
      'Next: `bookrail_booking_get` on `data.object.id` if it is a booking event.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      event_id: z.string().describe('The event id (`evt_...`).'),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli(['events', 'get', args.event_id]);
      return { ok: true, environment: ctx.environment, data: envelope.data };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_webhook_list',
    title: 'List webhook endpoints',
    description: [
      'Lists the webhook endpoints of the project with their URL, subscribed events and status.',
      'Use it before creating one, so you do not add a second endpoint for the same URL.',
      'Returns: `{ data: [{ id, url, events, status }], has_more, next_cursor }`. The signing secret is never returned here: it is shown only once, by `bookrail_webhook_create`.',
      'Next: `bookrail_webhook_test` to make one deliver now.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      limit: z.number().int().min(1).max(100).optional(),
      starting_after: z.string().optional(),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'webhooks',
        'list',
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
    name: 'bookrail_webhook_create',
    title: 'Register a webhook endpoint',
    description: [
      'Registers an endpoint to deliver events to, and returns its signing secret. That is the only time it is shown: no other call ever returns it again, not even an idempotent replay.',
      "Use it when wiring an application to Bookrail. Store the secret in the application's environment immediately (BOOKRAIL_WEBHOOK_SECRET) and verify every `Bookrail-Signature` with it.",
      'On live only https is accepted; on test http is allowed on ports 80, 443 and 8080-8099.',
      'Returns: `{ id, url, events, status, secret }`.',
      'Next: `bookrail_webhook_test` to deliver a synthetic event and see what the endpoint answers.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      url: z.string().describe('Where deliveries go, e.g. https://example.com/api/bookrail.'),
      events: z
        .array(z.string())
        .optional()
        .describe('Event types to subscribe to. Omit for all of them.'),
      description: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'webhooks',
        'create',
        '--url',
        args.url,
        ...(args.events === undefined ? [] : ['--events', args.events.join(',')]),
        ...(args.description === undefined ? [] : ['--description', args.description]),
        ...(args.metadata === undefined ? [] : ['--metadata', JSON.stringify(args.metadata)]),
      ]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: [
          'The `secret` in this answer is shown once. Put it in the application environment now.',
          'Call bookrail_webhook_test with the returned id to check the endpoint answers.',
          ...(envelope.next_steps ?? []),
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_webhook_test',
    title: 'Deliver a synthetic event now',
    description: [
      'Delivers a synthetic event to one endpoint, synchronously, and returns what the endpoint answered.',
      'Use it to check a handler end to end without creating a real booking.',
      'Returns: `{ status: "succeeded" | "failed", response_status, duration_ms, error? }`. `ok` stays true even when the endpoint answers 500: the delivery happened, and that IS the answer. Branch on `data.status`.',
      "Next: `bookrail_webhook_deliveries` to read the endpoint's log.",
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      webhook_id: z.string().describe('The endpoint id (`wh_...`).'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, ctx) {
      const envelope = await ctx.cli(['webhooks', 'test', args.webhook_id]);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_webhook_deliveries',
    title: 'Read the delivery log of an endpoint',
    description: [
      'Lists the deliveries attempted to one endpoint, with attempt number, response status, duration, error and when the next retry is due.',
      'Use it when an endpoint is not receiving what you expect: it distinguishes "never sent" from "sent and refused".',
      'Returns: `{ data: [{ id, event_id, status, attempt, response_status, error, next_attempt_at }], has_more }`.',
      "Next: `bookrail_event_get` on a delivery's `event_id` to see what was sent.",
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      webhook_id: z.string().describe('The endpoint id (`wh_...`).'),
      status: z.string().optional().describe('pending, succeeded, failed.'),
      event: z.string().optional().describe('Only deliveries of this event type.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
    async run(args, ctx) {
      const envelope = await ctx.cli([
        'webhooks',
        'deliveries',
        args.webhook_id,
        ...(args.status === undefined ? [] : ['--status', args.status]),
        ...(args.event === undefined ? [] : ['--event', args.event]),
        ...(args.limit === undefined ? [] : ['--limit', String(args.limit)]),
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
    name: 'bookrail_webhook_delete',
    title: 'Remove a webhook endpoint',
    description: [
      'Removes an endpoint. Events stop being delivered to it immediately, and its signing secret is gone: re-creating the endpoint gives a new one, and every handler verifying the old secret breaks.',
      'IRREVERSIBLE: without `confirm: true` the tool returns the endpoint as it stands and `requires_confirmation: true`, and removes nothing.',
      'Returns: `{ id, deleted: true }`.',
      'Next: `bookrail_webhook_list` to check what is left.',
    ].join('\n'),
    inputSchema: {
      environment: environmentArgument,
      webhook_id: z.string().describe('The endpoint id (`wh_...`).'),
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
        const current = await ctx.cli(['webhooks', 'get', args.webhook_id]);
        return needsConfirmation(ctx.environment, current.data, [
          'Nothing was removed. Check `preview.url` is the endpoint you meant, then call again with confirm: true.',
          'The signing secret cannot be recovered: a new endpoint for the same URL gets a new one.',
        ]);
      }
      const envelope = await ctx.cli(['webhooks', 'delete', args.webhook_id, '--yes']);
      return {
        ok: true,
        environment: ctx.environment,
        data: envelope.data,
        next_steps: ['Call bookrail_webhook_list to check what is left.'],
      };
    },
  });
}
