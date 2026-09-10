import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TEMPLATE_NAMES } from 'bookrail';
import { z } from 'zod';
import type { Workspace } from './environment.js';

function userMessage(text: string): {
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * The three guided workflows the tools of this build can carry out.
 *
 * A prompt here is not a description of the product: it is the order of operations, written so
 * that an agent that follows it literally ends up with a working integration. Each step names
 * the tool to call and what to check in its answer, because the failure mode these exist to
 * prevent is an agent that calls the right tools in the wrong order and then explains why the
 * result is empty.
 *
 * A fourth workflow, moving off a hand-built booking system, is deliberately absent: it needs
 * `bookrail migrate`, which does not exist yet.
 */
export function registerPrompts(server: McpServer, workspace: Workspace): void {
  void workspace;

  server.registerPrompt(
    'add-bookings-to-app',
    {
      title: 'Add bookings to this application',
      description:
        'End to end: detect the framework, model the vertical, push to test, wire the SDK call, register a webhook, and verify with a real booking.',
      argsSchema: {
        business: z
          .string()
          .describe(
            'What the application books, in one sentence, e.g. "padel courts, 60 or 90 minutes".',
          ),
        framework: z
          .string()
          .optional()
          .describe('nextjs, nuxt, sveltekit, laravel, rails, django, expo, or none.'),
      },
    },
    ({ business, framework }) =>
      userMessage(
        [
          `I want to add bookings to this application. It books: ${business}.`,
          framework === undefined || framework === ''
            ? 'Work out the framework from the files in this repository before you start.'
            : `The framework is ${framework}.`,
          '',
          'Follow these steps in this order, and do not skip the verifications.',
          '',
          '1. Call `bookrail_project_info`. It tells you which project and environment you are about to change, and proves the key works. If it fails, call `bookrail_doctor` and act on every `fix` before going on.',
          '2. Call `bookrail_examples` with the vertical closest to the business above (one of: ' +
            TEMPLATE_NAMES.join(', ') +
            '). Read the returned `config`: it is a complete, valid model.',
          '3. Adapt that `config` to the business. Call `bookrail_schema` with entity "config" whenever you are unsure of a field. Ids in a configuration are LOGICAL: `svc_...` identifiers only exist after a push.',
          '4. Call `bookrail_config_validate` with your config. Fix every issue by its `path` until `valid` is true.',
          '5. Call `bookrail_config_push` with your config and `dry_run: true`. Read the plan. Then call it again with `dry_run: false` and `confirm: true`.',
          '6. Call `bookrail_objects_list` with kind "services" and note the `svc_` id of each service, matching them by `metadata.config_id`.',
          '7. Call `bookrail_availability` for the next seven days on the main service. If it returns no slots, call it again with `explain: true` and fix the model. Do not proceed with an empty calendar.',
          '8. Write the application code: a server-side call to `POST /v1/availability` and one to `POST /v1/bookings`. Call `bookrail_docs_get` with path "api" for the exact bodies, and keep the secret key server-side only. Store the service id in an environment variable; never hard-code a `svc_`.',
          '9. Call `bookrail_webhook_create` with the application\'s public endpoint. The `secret` in the answer is shown ONCE: write it into the application environment immediately, and verify every `Bookrail-Signature` with it. Then call `bookrail_webhook_test` and check `data.status` is "succeeded".',
          '10. Verify end to end: `bookrail_availability_next`, then `bookrail_booking_create` on that instant with a test customer, then `bookrail_booking_get` on the id you got back, then `bookrail_events_list` to see `booking.created`.',
          '',
          'Everything above runs in the test environment. Do not pass `environment: "live"` at any point.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'model-my-vertical',
    {
      title: 'Model this business as a Bookrail configuration',
      description:
        'A structured interview (what is sold, what must be free, how many at once, what the money and time rules are) that ends in a validated configuration.',
      argsSchema: {
        business: z.string().describe("What the business is, in the owner's own words."),
      },
    },
    ({ business }) =>
      userMessage(
        [
          `Model this business as a Bookrail configuration: ${business}`,
          '',
          'Ask me these four questions, one at a time, and do not guess an answer you can ask for. Then write the configuration.',
          '',
          '1. **What is sold?** That is a Service. A service declares exactly ONE duration form: a fixed `duration`, a set of `durationOptions`, or a `durationRange`. Which is it, and what are the values?',
          '2. **What has to be free for it to happen?** Those are Resources, and the service\'s `requirements`. If several things must be free at the same time, that is several requirements: a room AND a therapist, not a "room-with-therapist".',
          '3. **How many at once?** That is `capacity` on the resource and `quantity` on the booking. If the count lives on one thing (the seats of a class), put the capacity there and make the other requirements `consumes: "whole"`.',
          '4. **What are the rules about money and time?** That is a Policy: the cancellation ladder, the reschedule ladder, the deposit, the no-show charge, how long a hold lasts, how many reschedules are allowed.',
          '',
          'Also settle: the opening hours and the time zone (a Schedule, written on a local clock), whether bookings must start on a grid (`slotInterval` and `alignTo`) or at any instant, how far ahead and how late bookings are accepted (`bookingWindow`), and whether there is cleaning or turnaround time (`bufferAfter`).',
          '',
          'Do NOT model a "slot": slots are computed from the schedule, the service and what is already booked, never stored.',
          '',
          'While you work: call `bookrail_examples` for the closest vertical to start from, `bookrail_schema` with entity "config" for the exact field names, and `bookrail_edge_cases` before you invent anything: most special cases are already handled and tested.',
          '',
          'Finish by calling `bookrail_config_validate` with the configuration, and show me the result. Do not push anything without asking me first.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'debug-availability',
    {
      title: 'Find out why a slot is not bookable',
      description:
        "Collects service, instant and expectation, calls the engine's explain, and reads the answer back as a cause.",
      argsSchema: {
        service_id: z.string().optional().describe('The service id (`svc_...`), if you know it.'),
        expectation: z
          .string()
          .optional()
          .describe('What you expected, e.g. "court 1 should be free on Tuesday at 18:00".'),
      },
    },
    ({ service_id, expectation }) =>
      userMessage(
        [
          'Availability is not what I expect. Work out why.',
          service_id === undefined || service_id === ''
            ? 'I do not have the service id: start by calling `bookrail_objects_list` with kind "services" and show me the list so I can pick one.'
            : `The service is ${service_id}.`,
          expectation === undefined || expectation === ''
            ? 'Ask me what exactly I expected (which instant, which resource, how long) before you call anything else.'
            : `What I expected: ${expectation}`,
          '',
          'Then, in this order:',
          '',
          '1. Call `bookrail_availability_check` on the exact instant I expected. If it says `available: true`, the model is fine and the problem is in the caller: tell me that and stop.',
          '2. Call `bookrail_explain_unavailable` on the same instant and read every `reasons[].code`. Do not paraphrase them: name the code and say what it means.',
          '3. Call `bookrail_availability` over the surrounding day with `explain: true`, so you can see whether the whole day is rejected or only that instant, and for the same reason.',
          '4. Map the reason back to the model:',
          '   - a closed schedule or an exception: read `bookrail_edge_cases` with topic "schedules", where closures beat openings and a `closed` exception without hours suppresses the whole day;',
          '   - a grid mismatch: `slotInterval` and `alignTo` on the service decide which instants exist at all;',
          '   - a booking window: `minNoticeMinutes` and `maxAdvanceDays`;',
          '   - a buffer: an existing occupancy carries ITS OWN buffers, not those of the service asking;',
          '   - capacity or an existing occupancy: call `bookrail_booking_list` for that window and that resource to see what is holding it;',
          '   - a clock change: read `bookrail_edge_cases` with topic "daylight-saving".',
          '5. Tell me the cause in one sentence, and propose the smallest change to the configuration that fixes it. Show me the change with `bookrail_config_push` and `dry_run: true` before applying anything.',
        ].join('\n'),
      ),
  );
}
