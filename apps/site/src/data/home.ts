/**
 * What the homepage shows about the product, read from what the build generated.
 *
 * `scripts/generate.mjs` writes `src/generated/home.json` from the engine, the API's serializer,
 * the compiled CLI, the delivery worker's constants and the pages of the documentation, and
 * `mcp-tools.json` from the MCP server's own `tools/list`. This file only gives the page typed
 * names for them, and the few sentences that are made of their numbers. Nothing in it is a
 * number, a field or a line of output typed by hand; `test/home.test.ts` checks the page against
 * the sources.
 */
import { PLANS, PLAN_PRICES } from '@bookrail/shared';
import sample from '../generated/booking-response.json';
import home from '../generated/home.json';
import tools from '../generated/mcp-tools.json';
import { PRICED_PLANS, TEST_ENVIRONMENT, euro, thousands } from './pricing';

export interface ExplainRow {
  at: string;
  local: string;
  code: string;
  resource: string;
  resource_id: string;
  kind: 'booking' | 'hold' | 'block' | null;
  ref: string;
  message: string;
}

export interface CodeSample {
  id: string;
  label: string;
  name: string;
  lang: string;
  code: string;
  docs: string;
}

export interface TemplateCard {
  name: string;
  summary: string;
  vertical: string;
  resources: string[];
  services: { name: string; length: string }[];
}

export const EXPLAIN = home.explain as unknown as {
  service_id: string;
  timezone: string;
  slots: number;
  instants: number;
  rows: ExplainRow[];
  featured: string | null;
};

/** The instant the Availability card prints: the one where a booking, a hold and a block meet. */
export const FEATURED_EXPLAIN = EXPLAIN.rows.filter((row) => row.at === EXPLAIN.featured);

/** `occupied 12, blocked 3`, counted from the rows the way the CLI counts them. */
export function explainSummary(rows: ExplainRow[] = EXPLAIN.rows): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} ${String(count)}`)
    .join(', ');
}

export const TERMINAL = home.terminal as { command: string; output: string[] }[];
export const DIFF = home.diff as { command: string; summary: string; rows: string[] };
export const MATRIX = home.matrix as {
  actions: string[];
  rows: { status: string; allowed: string[] }[];
};
export const LADDER = home.ladder as string[];
export const ATTEMPTS = home.attempts as number;
export const STRIPE = home.stripe as { command: string; summary: string };
export const BOOKING_CODES = home.booking as { created: number | null; conflict: number | null };
export const TEMPLATES = home.templates as TemplateCard[];
export const SAMPLES = home.samples as CodeSample[];
export const OPEN_SOURCE = home.openSource as { license: string; repository: string };
export const WEBHOOK = home.webhook as unknown as {
  event: Record<string, unknown>;
  body: string;
  timestamp: number;
  headers: [string, string][];
};

/** The booking of the Booking tab, and how many of its always present fields it shows. */
export const BOOKING = sample as {
  fields: string[];
  value: Record<string, unknown>;
  total: number;
  omitted: number;
};

/** Every tool of the MCP server, as it answered `tools/list` during the build. */
export const MCP_TOOLS = (tools as { name: string }[]).map((tool) => tool.name);
export const MCP_TOOL_COUNT = MCP_TOOLS.length;

/** The two templates the big cards draw, then the four small ones, then the rest. */
export const FEATURED_TEMPLATES = ['padel', 'salon'];
export function templateGroups(all: TemplateCard[] = TEMPLATES) {
  const big = FEATURED_TEMPLATES.map((name) => all.find((t) => t.name === name)).filter(
    (t): t is TemplateCard => t !== undefined,
  );
  const others = all.filter((t) => !FEATURED_TEMPLATES.includes(t.name));
  return { big, small: others.slice(0, 4), rest: others.slice(4) };
}

/** The four numbers of the pricing strip, from the table the API enforces and the price list. */
export function priceStrip() {
  const free = PRICED_PLANS.find((plan) => plan.id === 'free');
  const included = PLANS.free.bookingsIncluded;
  const pro = PLANS.pro.bookingsIncluded;
  if (free === undefined || free.price.kind !== 'monthly' || included === null || pro === null) {
    throw new Error('A number the pricing strip prints is missing.');
  }
  const cents = PLAN_PRICES.pro.extraBooking;
  return [
    { figure: euro(free.price.eur), label: 'to start: the Free plan has the whole API' },
    { figure: thousands(included), label: 'live bookings a month included on Free' },
    {
      figure: euro(PLAN_PRICES.pro.monthly / 100),
      label: `a month for Pro, with ${thousands(pro)} bookings included`,
    },
    {
      figure: `${String(cents)} ${cents === 1 ? 'cent' : 'cents'}`,
      label: 'for each booking after that, on Pro',
    },
  ];
}

/** «Free, never counted», the way the pricing page says it. */
export const TEST_ENVIRONMENT_NOTE = TEST_ENVIRONMENT;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One key per line at the top level, nested values inline. */
function inline(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([key, nested]) => `"${key}": ${inline(nested)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** An object as the lines the panes print: `{`, one line per key, `}`. */
export function jsonLines(object: Record<string, unknown>, indent = '  '): string[] {
  const entries = Object.entries(object as Record<string, Json>);
  return [
    '{',
    ...entries.map(
      ([key, value], index) =>
        `${indent}"${key}": ${inline(value)}${index === entries.length - 1 ? '' : ','}`,
    ),
    '}',
  ];
}

/** Colours the three things worth telling apart in a line of JSON: a key, a string, a number. */
export function jsonTokens(line: string): { text: string; kind: string }[] {
  const out: { text: string; kind: string }[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) out.push({ text: line.slice(last, match.index), kind: 'punct' });
    out.push({
      text: match[0],
      kind: match[1] !== undefined ? 'key' : match[2] !== undefined ? 'str' : 'num',
    });
    last = match.index + match[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: 'punct' });
  return out;
}
