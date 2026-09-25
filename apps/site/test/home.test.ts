/**
 * The homepage says only what the code says.
 *
 * Every product number, field and line of output on the homepage is generated at
 * build time. Each test here goes back to the source of one of them, recomputes it or reads it
 * where it lives, and compares it with what the built page shows: a value that drifted from its
 * source fails here, not in front of a reader.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  API_DISPATCH,
  CLI_LIB,
  CLI_PACKAGE,
  ENGINE_ENTRY,
  AGENTS_PAGE,
  OPENAPI_PATH,
  QUICKSTART_PAGE,
  WEBHOOK_DEMO_SECRET,
  agentTerminal,
  codeSamples,
  configDiff,
  explainInput,
  explainRows,
  mcpTools,
  openSourceFacts,
  refusalAnswers,
  shortDuration,
  subcommandSummary,
  API_SERIALIZE,
} from '../scripts/generate.mjs';
import { GRID_DAY, GRID_RESOURCES } from '../src/data/grid-day.mjs';
import { distRoot, siteRoot } from './helpers.js';
import {
  EMITTED_EVENT_TYPES,
  PLANS,
  PLAN_PRICES,
  decodeId,
  verifySignature,
} from '@bookrail/shared';

/* eslint-disable @typescript-eslint/no-explicit-any -- the compiled packages are imported by path, untyped */
const load = (path: string): Promise<any> => import(pathToFileURL(path).href);

/** What Astro writes for a piece of text. */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The text of the page, tags removed and entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&middot;', '·')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ');
}

/** The part of the page from the element carrying `attribute` to the end of that element's tag. */
function section(html: string, attribute: string, length = 20_000): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(0);
  return html.slice(at, at + length);
}

let html = '';
let page = '';
let generated: any;
let engine: any;

beforeAll(async () => {
  html = await readFile(join(distRoot, 'index.html'), 'utf8');
  page = text(html);
  generated = JSON.parse(await readFile(join(siteRoot, 'src', 'generated', 'home.json'), 'utf8'));
  engine = await load(ENGINE_ENTRY);
});

describe('the explain rows', () => {
  it('are what the engine answers about the day the grid draws, recomputed now', () => {
    const fresh = explainRows(engine);
    expect(generated.explain).toEqual(fresh);
    expect(fresh.rows.length).toBeGreaterThan(0);
    const table = section(html, 'data-explain-table');
    for (const row of fresh.rows) {
      expect(table, row.ref).toContain(row.ref);
      expect(table, row.message).toContain(escape(row.message));
    }
    // One row per court, per refused instant: the table has exactly as many rows as the answer.
    const body = table.split('<tbody')[1]?.split('</tbody>')[0] ?? '';
    expect([...body.matchAll(/<tr[\s>]/g)]).toHaveLength(fresh.rows.length);
    expect(page).toContain(
      `${String(fresh.slots)} slots · ${String(fresh.instants)} instants refused`,
    );
  });

  it('name, for every refusal, a booking, hold or block that really covers that instant', () => {
    const input = explainInput(engine);
    const slots = new Map(
      GRID_RESOURCES.flatMap((resource) =>
        resource.slots.map((slot) => [slot.id.replaceAll('-', ''), { resource, slot }] as const),
      ),
    );
    for (const row of generated.explain.rows) {
      const hex = row.ref.slice(row.ref.indexOf('_') + 1);
      const found = slots.get(hex);
      expect(found, row.ref).toBeDefined();
      expect(found!.resource.name).toBe(row.resource);
      expect(found!.slot.kind).toBe(row.kind);
      const start = input.from + found!.slot.from * 3_600_000;
      const end = start + found!.slot.hours * 3_600_000;
      const at = Date.parse(row.at);
      // The match is 60 minutes: it collides when the two periods overlap.
      expect(at < end && at + 3_600_000 > start, `${row.at} ${row.ref}`).toBe(true);
    }
  });

  it('put the featured instant, where a booking, a hold and a block meet, on the Availability card', () => {
    const featured = generated.explain.rows.filter(
      (row: { at: string }) => row.at === generated.explain.featured,
    );
    expect(new Set(featured.map((row: { kind: string }) => row.kind))).toEqual(
      new Set(['booking', 'hold', 'block']),
    );
    const card = section(html, 'data-explain-featured', 4000);
    for (const row of featured) expect(card).toContain(row.resource);
    expect(GRID_DAY.timezone).toBe(generated.explain.timezone);
  });
});

describe('the refusal the grid draws', () => {
  it('is a request the engine refuses, because a booking of that resource already holds it', () => {
    const answers = refusalAnswers(engine);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      // No slot: the 409 on the picture is the answer the engine would give.
      expect(answer.slots, `${answer.resource} at ${answer.at}`).toBe(0);
      expect(answer.reasons.map((reason: { code: string }) => reason.code)).toContain('occupied');
      const resource = GRID_RESOURCES.find((candidate) => candidate.name === answer.resource);
      const held = answer.reasons.map((reason: { refId: string | null }) => reason.refId);
      expect(resource?.slots.some((slot) => held.includes(slot.id))).toBe(true);
    }
    // And the picture draws it where the data says, over that capacity.
    const refused = GRID_RESOURCES.find((resource) => resource.rejected !== undefined);
    const left = (refused?.rejected?.from ?? -1) * (100 / GRID_DAY.hours);
    expect(html).toMatch(new RegExp(`class="rejected"[^>]*style="left:${String(left)}%`));
  });

  it('would catch a refusal drawn on free capacity', () => {
    // The position the first homepage drew, 16:00 to 20:00 on Court 1, where the court is free.
    const moved = GRID_RESOURCES.map((resource) =>
      resource.rejected === undefined
        ? resource
        : { ...resource, rejected: { ...resource.rejected, from: 8 } },
    );
    const [answer] = refusalAnswers(engine, { resources: moved });
    expect(answer?.slots).toBe(1);
  });
});

describe('the terminal of the section for agents', () => {
  it('is what the compiled CLI prints, run again now', async () => {
    const fresh = await agentTerminal(engine, await load(API_SERIALIZE));
    expect(generated.terminal).toEqual(fresh);
    const terminal = section(html, 'data-terminal');
    for (const step of fresh) {
      expect(terminal).toContain(escape(step.command));
      for (const line of step.output) if (line !== '') expect(terminal).toContain(escape(line));
    }
    expect(fresh[0]?.output[0]).toMatch(/^\[test\] wrote \.\/\.mcp\.json/);
    expect(fresh[1]?.output.join('\n')).toContain('instant(s) rejected');
  }, 60_000);
});

describe('the CLI card', () => {
  it('shows the diff the CLI prints after two edits of the padel template', async () => {
    const fresh = await configDiff();
    expect(generated.diff).toEqual(fresh);
    expect(fresh.rows).toHaveLength(2);
    const card = section(html, 'data-diff', 2000);
    expect(card).toContain(escape(fresh.summary));
    for (const row of fresh.rows) expect(card).toContain(row.replace(/\s+/g, ' '));
  }, 60_000);
});

describe('the Policies card', () => {
  it('draws the engine transition matrix, for the actions the API exposes', () => {
    const actions = [...engine.HTTP_TRANSITION_ACTIONS];
    expect(generated.matrix.actions).toEqual(actions);
    let allowed = 0;
    for (const [status, moves] of Object.entries(engine.TRANSITIONS)) {
      const row = generated.matrix.rows.find((r: { status: string }) => r.status === status);
      const legal = actions.filter(
        (action) => (moves as Record<string, unknown>)[action] !== undefined,
      );
      expect(row?.allowed, status).toEqual(legal);
      allowed += legal.length;
    }
    const matrix = section(html, 'data-matrix', 6000).split('</table>')[0] ?? '';
    expect([...matrix.matchAll(/<td class="on"/g)]).toHaveLength(allowed);
    for (const action of actions) expect(matrix).toContain(`>${action}</th>`);
  });
});

describe('the Webhooks card', () => {
  it('prints the retry ladder of the delivery worker', async () => {
    const dispatch = await load(API_DISPATCH);
    const ladder = [...dispatch.WEBHOOK_RETRY_DELAYS_SECONDS].map(shortDuration);
    expect(ladder).toEqual(['3s', '30s', '5m', '30m', '2h', '12h', '24h']);
    const card = section(html, 'data-ladder', 1000).split('</ol>')[0] ?? '';
    expect([...card.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual(ladder);
    expect(page).toContain(`${String(dispatch.MAX_DELIVERY_ATTEMPTS)} attempts in all`);
  });
});

describe('the Payments card', () => {
  it('quotes the CLI help of stripe connect', async () => {
    const summary = await subcommandSummary('stripe', 'connect');
    expect(generated.stripe.summary).toBe(summary);
    expect(section(html, 'data-stripe', 1000)).toContain(escape(summary));
  });
});

describe('the Bookings card', () => {
  it('uses the two statuses POST /v1/bookings documents, 409 being slot_unavailable', async () => {
    const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
    const responses = spec.paths['/v1/bookings'].post.responses;
    expect(Object.keys(responses)).toContain('201');
    expect(responses['409'].description).toContain('`slot_unavailable`');
    const card = section(html, 'data-booking-codes', 1000);
    expect(card).toContain('<b>201</b>');
    expect(card).toContain('409</b> slot_unavailable');
  });
});

describe('the MCP tool count', () => {
  it('is the number of tools the server answers to tools/list, right now', async () => {
    const live = (await mcpTools()) as { name: string }[];
    const counts = [...html.matchAll(/data-mcp-count>(\d+) tools/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const count of counts) expect(count).toBe(live.length);
  }, 60_000);
});

describe('the templates', () => {
  it('are the templates the CLI ships, every one of them named on the page', async () => {
    const cli = await load(CLI_LIB);
    const names = Object.keys(cli.TEMPLATES);
    expect(generated.templates.map((t: { name: string }) => t.name)).toEqual(names);
    for (const name of names) expect(page, name).toContain(name);
    const cards = [...html.matchAll(/data-template="([^"]+)"/g)].map((m) => m[1]);
    expect(cards.slice(0, 2)).toEqual(['padel', 'salon']);
    expect(cards).toHaveLength(Math.min(6, names.length));
    for (const name of cards) {
      expect(html).toContain(`npx bookrail init --template ${name}`);
      expect(page).toContain(escape(cli.TEMPLATES[name].summary).replaceAll('&#39;', "'"));
    }
  });
});

describe('the pricing strip', () => {
  it('prints the quotas the API enforces and the prices the checkout charges', () => {
    const strip = text(section(html, 'data-price-strip', 3000).split('</dl>')[0] ?? '');
    const thousands = (value: number): string =>
      String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    expect(strip).toContain(thousands(PLANS.free.bookingsIncluded ?? -1));
    expect(strip).toContain(`€${String(PLAN_PRICES.pro.monthly / 100)}`);
    expect(strip).toContain(
      `with ${thousands(PLANS.pro.bookingsIncluded ?? -1)} bookings included`,
    );
    expect(strip).toContain(`${String(PLAN_PRICES.pro.extraBooking)} cents`);
    expect(strip).toContain('€0');
  });
});

describe('the webhook tab', () => {
  it('is a booking.created event of the Event schema, signed over the exact body shown', async () => {
    const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
    const schema = spec.components.schemas.Event;
    const { event, body, timestamp, headers } = generated.webhook;
    expect(Object.keys(event).sort()).toEqual([...schema.required].sort());
    expect(event.id).toMatch(new RegExp(schema.properties.id.pattern));
    expect(EMITTED_EVENT_TYPES).toContain(event.type);
    expect(body).toBe(JSON.stringify(event));
    const signature = (headers as [string, string][]).find(
      ([name]) => name === 'Bookrail-Signature',
    );
    expect(signature).toBeDefined();
    expect(verifySignature(body, signature![1], WEBHOOK_DEMO_SECRET, 300, timestamp)).toBe(true);
    expect(verifySignature(`${body} `, signature![1], WEBHOOK_DEMO_SECRET, 300, timestamp)).toBe(
      false,
    );
    expect(section(html, 'data-webhook', 20_000)).toContain(signature![1]);
    // The booking inside it is the booking of the Booking tab.
    expect(event.data.object.id).toBe('bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c');
    expect(decodeId('event', event.id)).not.toBeNull();
  });
});

describe('the code tabs', () => {
  it('are the blocks of the quickstart and of the agent page, and nothing typed again', async () => {
    const tools = JSON.parse(
      await readFile(join(siteRoot, 'src', 'generated', 'mcp-tools.json'), 'utf8'),
    );
    const fresh = codeSamples(
      await readFile(QUICKSTART_PAGE, 'utf8'),
      await readFile(AGENTS_PAGE, 'utf8'),
      tools,
    );
    expect(generated.samples).toEqual(fresh);
    expect(fresh.map((s: { label: string }) => s.label)).toEqual([
      'Node SDK',
      'HTTP',
      'CLI',
      'MCP',
    ]);
    const quickstart = await readFile(QUICKSTART_PAGE, 'utf8');
    for (const sample of fresh) {
      expect(html, sample.id).toContain(`data-sample="${sample.id}">${escape(sample.code)}</pre>`);
      if (sample.id !== 'mcp') {
        for (const part of sample.code.split('\n\n')) expect(quickstart, sample.id).toContain(part);
      }
    }
  });
});

describe('the Open source card', () => {
  it('prints the licence and the repository the CLI package declares', async () => {
    const facts = openSourceFacts(JSON.parse(await readFile(CLI_PACKAGE, 'utf8')));
    expect(facts.license).toBe('Apache-2.0');
    const card = section(html, 'data-open-source', 1000);
    expect(card).toContain(facts.license);
    expect(card).toContain(facts.repository);
  });
});

describe('the markdown twin', () => {
  it('carries the same explain rows and the same numbers as the page', async () => {
    const twin = await readFile(join(distRoot, 'index.md'), 'utf8');
    for (const row of generated.explain.rows) expect(twin).toContain(row.message);
    expect(twin).toContain(`${String(generated.tools.length)} tools`);
    for (const template of generated.templates) expect(twin).toContain(`\`${template.name}\``);
  });
});
