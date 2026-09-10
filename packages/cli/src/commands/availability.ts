/**
 * `bookrail availability`, `availability next` and `availability check`: the three ways of
 * asking what can be booked.
 *
 * They are the commands an agent runs first and reads most, so two things get more care here
 * than anywhere else in the CLI:
 *
 *  1. **`--explain` is printed, not dumped.** The API answers a list of instants each with a
 *     list of structured reasons, and an output that does not say what to do next is not
 *     finished. So the human form is a table with one row per (instant, reason) plus a count per
 *     code, which is the shape in which "the court is blocked all Tuesday" is visible at a
 *     glance. `--json` carries the API's own object, untouched.
 *  2. **Every instant is shown twice**, UTC and local: the UTC form is what the next command
 *     takes, the local form is what the person recognises. Availability is always computed in
 *     the resource's own zone and only presented in the requested one, so the local form is
 *     never more than presentation.
 *
 * Two of the three are POSTs (`next` is a GET), so they carry an `Idempotency-Key` like every
 * other POST of the CLI. It is harmless on a read, and an endpoint that answered differently to
 * a repeated key would be a trap.
 */
import type { Context } from '../context.js';
import { localTime, money, priceRule, resourcesOf, text } from '../format.js';
import { renderTable, truncate, type CommandResult } from '../output.js';
import { clientFor, instant, integer, optionalInstant, required } from './helpers.js';

interface Slot {
  start: string;
  end: string;
  duration_minutes: number | null;
  available_capacity: number;
  price: unknown;
  price_rule: unknown;
  resource_options: unknown[];
  min_duration_minutes?: number;
  max_duration_minutes?: number;
}

interface AvailabilityBody {
  object: string;
  service_id: string;
  timezone: string;
  granularity: string;
  slots: Slot[];
  next_available: string | null;
  reason?: { code: string; message: string };
  explain?: { at: string; reasons: { code: string; message: string; resource_id?: string }[] }[];
  explain_notes?: { code: string; message: string; index: number }[];
  explain_truncated?: boolean;
}

export interface AvailabilityOptions {
  service?: string;
  from?: string;
  to?: string;
  tz?: string;
  quantity?: string;
  resource?: string[];
  customer?: string;
  granularity?: string;
  explain?: boolean;
}

function slotTable(body: AvailabilityBody): string {
  const ranges = body.granularity === 'ranges';
  const headers = ranges
    ? ['start (UTC)', 'local', 'end (UTC)', 'min', 'max', 'cap', 'price', 'rule', 'resources']
    : ['start (UTC)', 'local', 'end (UTC)', 'min', 'cap', 'price', 'rule', 'resources'];
  const rows = body.slots.map((slot) => {
    const shared = [
      slot.start,
      localTime(slot.start, body.timezone),
      slot.end,
      ...(ranges
        ? [text(slot.min_duration_minutes), text(slot.max_duration_minutes)]
        : [text(slot.duration_minutes)]),
      String(slot.available_capacity),
      money(slot.price),
      // Which `pricing_rules` entry priced the slot: `base` for the flat service price, `#2`
      // (with its label, when it has one) for a rule. The output has to say what is going on,
      // and a surcharge nobody can trace back to a rule is a support ticket.
      truncate(priceRule(slot.price_rule), 24),
      truncate(slot.resource_options.map(resourcesOf).join(' | '), 40),
    ];
    return shared;
  });
  return renderTable(headers, rows);
}

/**
 * What `explain` says about the answer as a whole rather than about one rejected instant.
 *
 * Today that is `pricing_rule_ignored`: a rule stored on the service that the strict schema
 * refuses, skipped at evaluation, so the price came from the next rule that matched. It is
 * printed before the table because it changes how every price in that table is to be read.
 */
function explainNotes(body: AvailabilityBody): string[] {
  const notes = body.explain_notes ?? [];
  if (notes.length === 0) return [];
  return ['', ...notes.map((note) => `${note.code}: ${note.message}`)];
}

function explainTable(body: AvailabilityBody): string[] {
  const explain = body.explain ?? [];
  if (explain.length === 0) {
    return [
      ...explainNotes(body),
      '',
      'Every candidate instant of this window is available: nothing to explain.',
    ];
  }
  const counts = new Map<string, number>();
  const rows: string[][] = [];
  for (const entry of explain) {
    for (const reason of entry.reasons) {
      counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
      rows.push([
        localTime(entry.at, body.timezone),
        reason.code,
        reason.resource_id ?? '',
        truncate(reason.message, 60),
      ]);
    }
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} ${count}`)
    .join(', ');
  return [
    ...explainNotes(body),
    '',
    `${explain.length} instant(s) rejected: ${summary}`,
    '',
    renderTable(['local instant', 'code', 'resource', 'why'], rows),
    ...(body.explain_truncated === true
      ? ['', 'explain_truncated: the 500 instant ceiling was reached; narrow the window.']
      : []),
  ];
}

export async function availability(
  ctx: Context,
  options: AvailabilityOptions,
): Promise<CommandResult> {
  const body: Record<string, unknown> = {
    service_id: required(options.service, 'service', 'the service to ask about'),
    from: instant(options.from, 'from'),
    to: instant(options.to, 'to'),
  };
  const quantity = integer(options.quantity, 'quantity', { min: 1, max: 100000 });
  if (quantity !== undefined) body.quantity = quantity;
  if (options.resource !== undefined && options.resource.length > 0) {
    body.resource_ids = options.resource;
  }
  if (options.customer !== undefined) body.customer_id = options.customer;
  if (options.tz !== undefined) body.timezone = options.tz;
  if (options.granularity !== undefined) body.granularity = options.granularity;
  if (options.explain === true) body.explain = true;

  const client = await clientFor(ctx);
  const response = await client.post<AvailabilityBody>('/v1/availability', body);
  const data = response.data;

  const lines = [
    `${ctx.presenter.badge()} ${data.slots.length} ${data.granularity === 'ranges' ? 'range(s)' : 'slot(s)'} for ${data.service_id}, times shown in ${data.timezone}`,
  ];
  if (data.reason !== undefined) {
    lines.push(
      '',
      `No slot can exist in this window (${data.reason.code}): ${data.reason.message}`,
    );
  }
  if (data.slots.length > 0) lines.push('', slotTable(data));
  if (options.explain === true) lines.push(...explainTable(data));

  const first = data.slots[0];
  return {
    data,
    human: lines.join('\n'),
    nextSteps:
      first === undefined
        ? [
            'Nothing is bookable in this window. Run the same command with `--explain` to see why each instant was rejected.',
            `Run \`bookrail availability next --service ${data.service_id} --json\` to find the first bookable instant.`,
          ]
        : [
            `Hold it: \`bookrail holds create --service ${data.service_id} --start ${first.start} --json\`.`,
            `Book it directly: \`bookrail bookings create --service ${data.service_id} --start ${first.start} --customer-email you@example.com --json\`.`,
          ],
  };
}

export interface NextOptions {
  service?: string;
  from?: string;
  quantity?: string;
  tz?: string;
}

interface NextBody {
  object: string;
  service_id: string;
  timezone: string;
  next_available: string | null;
  slot: Slot | null;
  searched_through: string;
}

export async function availabilityNext(ctx: Context, options: NextOptions): Promise<CommandResult> {
  const query: Record<string, string | number> = {
    service_id: required(options.service, 'service', 'the service to search'),
  };
  const from = optionalInstant(options.from, 'from');
  if (from !== undefined) query.from = from;
  const quantity = integer(options.quantity, 'quantity', { min: 1, max: 100000 });
  if (quantity !== undefined) query.quantity = quantity;
  if (options.tz !== undefined) query.timezone = options.tz;

  const client = await clientFor(ctx);
  const data = (await client.get<NextBody>('/v1/availability/next', { query })).data;

  const human =
    data.next_available === null
      ? `${ctx.presenter.badge()} nothing available for ${data.service_id} before ${data.searched_through}.`
      : [
          `${ctx.presenter.badge()} next available: ${data.next_available} (${localTime(data.next_available, data.timezone)} ${data.timezone})`,
          '',
          renderTable(
            ['start (UTC)', 'end (UTC)', 'min', 'cap', 'price', 'rule', 'resources'],
            data.slot === null
              ? []
              : [
                  [
                    data.slot.start,
                    data.slot.end,
                    text(data.slot.duration_minutes),
                    String(data.slot.available_capacity),
                    money(data.slot.price),
                    truncate(priceRule(data.slot.price_rule), 24),
                    truncate(data.slot.resource_options.map(resourcesOf).join(' | '), 40),
                  ],
                ],
          ),
        ].join('\n');

  return {
    data,
    human,
    nextSteps:
      data.next_available === null
        ? [
            `Nothing in the next 90 days. \`bookrail availability --service ${data.service_id} --from ... --to ... --explain\` says why.`,
          ]
        : [
            `Check it: \`bookrail availability check --service ${data.service_id} --start ${data.next_available} --json\`.`,
            `Hold it: \`bookrail holds create --service ${data.service_id} --start ${data.next_available} --json\`.`,
          ],
  };
}

export interface CheckOptions {
  service?: string;
  start?: string;
  duration?: string;
  quantity?: string;
  resource?: string[];
}

interface CheckBody {
  object: string;
  service_id: string;
  start: string;
  duration_minutes: number | null;
  available: boolean;
  available_capacity: number;
  price: unknown;
  price_rule: unknown;
  resource_options: unknown[];
  reasons?: { code: string; message: string; resource_id?: string }[];
  reason?: { code: string; message: string };
}

export async function availabilityCheck(
  ctx: Context,
  options: CheckOptions,
): Promise<CommandResult> {
  const body: Record<string, unknown> = {
    service_id: required(options.service, 'service', 'the service to check'),
    start: instant(options.start, 'start'),
  };
  const duration = integer(options.duration, 'duration', { min: 1, max: 525600 });
  if (duration !== undefined) body.duration_minutes = duration;
  const quantity = integer(options.quantity, 'quantity', { min: 1, max: 100000 });
  if (quantity !== undefined) body.quantity = quantity;
  if (options.resource !== undefined && options.resource.length > 0) {
    body.resource_ids = options.resource;
  }

  const client = await clientFor(ctx);
  const data = (await client.post<CheckBody>('/v1/availability/check', body)).data;

  const lines = [
    `${ctx.presenter.badge()} ${data.available ? 'available' : 'not available'} at ${data.start} (${String(data.duration_minutes ?? '?')} min, capacity ${String(data.available_capacity)}${money(data.price) === '' ? '' : `, ${money(data.price)} [${priceRule(data.price_rule)}]`})`,
  ];
  if (data.available && data.resource_options.length > 0) {
    lines.push(
      '',
      renderTable(
        ['option', 'resources'],
        data.resource_options.map((option, index) => [String(index + 1), resourcesOf(option)]),
      ),
    );
  }
  if (!data.available) {
    const reasons = data.reasons ?? [];
    lines.push(
      '',
      reasons.length === 0
        ? 'No structured reason was returned for this instant.'
        : renderTable(
            ['code', 'resource', 'why'],
            reasons.map((reason) => [
              reason.code,
              reason.resource_id ?? '',
              truncate(reason.message, 70),
            ]),
          ),
    );
  }
  if (data.reason !== undefined) lines.push('', `${data.reason.code}: ${data.reason.message}`);

  return {
    data,
    human: lines.join('\n'),
    nextSteps: data.available
      ? [
          `Hold it: \`bookrail holds create --service ${data.service_id} --start ${data.start} --json\`.`,
        ]
      : [
          `Find the next one: \`bookrail availability next --service ${data.service_id} --from ${data.start} --json\`.`,
        ],
  };
}
