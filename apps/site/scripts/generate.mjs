/**
 * Everything the site shows that is owned by somebody else.
 *
 * The rule of this file is that nothing it produces was typed twice. The seven documentation
 * pages come from `packages/cli/docs`, the API reference from `packages/api/openapi`, the tool
 * list from the MCP server itself, the CLI page from the CLI's own `--help`, and the booking
 * response on the homepage from the `Booking` schema of the OpenAPI document. Each output is a
 * pure function of its source, so `test/sources.test.ts` can recompute it and refuse a
 * divergence.
 *
 * Outputs live in `src/content/docs/docs/` and `src/generated/`, both git-ignored: a copy that
 * can be edited is a second source waiting to disagree with the first.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CURRENT_API_VERSION, encodeId, signPayload } from '@bookrail/shared';
import { EXPLAIN_QUESTION, GRID_DAY, GRID_RESOURCES } from '../src/data/grid-day.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const siteRoot = join(here, '..');
export const repoRoot = join(siteRoot, '..', '..');

export const CLI_DOCS = join(repoRoot, 'packages', 'cli', 'docs');
export const BRAND = join(repoRoot, 'brand');
export const OPENAPI_PATH = join(repoRoot, 'packages', 'api', 'openapi', 'openapi.json');
export const CLI_BIN = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
export const MCP_BIN = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
export const SDK_README = join(repoRoot, 'packages', 'sdk-node', 'README.md');
/** The compiled engine, API and CLI, imported by path the way `MCP_BIN` is spawned by path. */
export const ENGINE_ENTRY = join(repoRoot, 'packages', 'engine', 'dist', 'index.js');
export const API_SERIALIZE = join(repoRoot, 'packages', 'api', 'dist', 'serialize.js');
export const API_DISPATCH = join(repoRoot, 'packages', 'api', 'dist', 'webhooks', 'dispatch.js');
export const API_DELIVER = join(repoRoot, 'packages', 'api', 'dist', 'webhooks', 'deliver.js');
export const CLI_LIB = join(repoRoot, 'packages', 'cli', 'dist', 'lib.js');
export const CLI_PACKAGE = join(repoRoot, 'packages', 'cli', 'package.json');

export const GENERATED_DOCS = join(siteRoot, 'src', 'content', 'docs', 'docs');
export const GENERATED_DATA = join(siteRoot, 'src', 'generated');
export const GENERATED_BRAND = join(siteRoot, 'src', 'assets', 'brand');
/** The hand written pages the homepage reads its code samples from. */
export const QUICKSTART_PAGE = join(siteRoot, 'src', 'content', 'docs', 'docs', 'quickstart.md');
export const AGENTS_PAGE = join(siteRoot, 'src', 'content', 'docs', 'docs', 'for-ai-agents.md');
/** Hand written fragments a generated page carries after its source. */
export const FRAGMENTS = join(siteRoot, 'src', 'fragments');

/**
 * The mark, copied from `brand/` where the founder put it, never redrawn here.
 *
 * `src/assets/brand/` feeds the components and Starlight's own header; `public/` gets the three
 * files a browser asks for by URL. Both are git-ignored and both are byte compared by
 * `test/sources.test.ts`, so the site can never drift from the brand folder.
 */
export const BRAND_FILES = [
  { from: 'bookrail-mark.svg', to: ['src/assets/brand/bookrail-mark.svg'] },
  { from: 'bookrail-mark-on-dark.svg', to: ['src/assets/brand/bookrail-mark-on-dark.svg'] },
  { from: 'bookrail-mark-mono.svg', to: ['src/assets/brand/bookrail-mark-mono.svg'] },
  { from: 'favicon.svg', to: ['public/favicon.svg'] },
  { from: 'png/bookrail-icon-180.png', to: ['public/apple-touch-icon.png'] },
  { from: 'png/bookrail-social-1200x630.png', to: ['public/og.png'] },
];

/**
 * The pages owned by another package, in the order the sidebar shows them, with the path and
 * the title the site gives them.
 *
 * Two slugs were taken back for pages written here: `quickstart` is now the timed
 * walkthrough and `concepts` is the data model with figures, so `getting-started.md` moved to
 * `cli-basics` and `entities.md` to `entities`, which is what each one actually is. Nothing was
 * dropped: every page of `packages/cli/docs` is still published, still from its one source.
 *
 * `append` names a fragment in `src/fragments/`, added under the source. It exists for
 * `guides/time-zones`, which is extended with the HTTP API while keeping the CLI
 * text where it lives. The fragment is part of the transform, so `test/sources.test.ts`
 * recomputes it too and a divergence still fails.
 */
export const CLI_PAGES = [
  {
    source: 'entities.md',
    slug: 'entities',
    title: 'Entity reference',
    order: 13,
    description: 'Every entity and the fields it carries, in the words of the CLI reference.',
  },
  {
    source: 'config.md',
    slug: 'configuration',
    title: 'Configuration',
    order: 14,
    description: 'bookrail.config.ts, the booking model as code, and what push does with it.',
  },
  {
    source: 'api.md',
    slug: 'api',
    title: 'API',
    order: 30,
    description: 'The short form of the HTTP API: headers, endpoints, pagination, idempotency.',
  },
  {
    source: 'errors.md',
    slug: 'errors',
    title: 'Errors',
    order: 32,
    description: 'Every error code, its type, when it happens, and the exit codes of the CLI.',
  },
  {
    source: 'timezones.md',
    slug: 'guides/time-zones',
    title: 'Time zones',
    order: 41,
    description: 'Local schedules, UTC instants, and what happens on the night a clock changes.',
    append: 'time-zones-api.md',
  },
  {
    source: 'getting-started.md',
    slug: 'cli-basics',
    title: 'CLI basics',
    order: 60,
    description: 'The loop, where the key comes from, the output envelope and the exit codes.',
  },
  {
    source: 'agents.md',
    slug: 'agents',
    title: 'Rules an agent can rely on',
    order: 63,
    description: 'The seven rules the CLI is built to, and the things that will bite.',
  },
];

/**
 * `packages/sdk-node/README.md` is the SDK reference, the same way `packages/cli/docs` is the
 * CLI reference: what npm shows and what the site shows are one file.
 */
export const SDK_PAGE = {
  slug: 'sdk',
  title: 'SDK for TypeScript',
  order: 31,
  description:
    'The @bookrail/node client: install, configure, retries, idempotency, pagination, errors, webhooks.',
};

/** The pages written by hand, in this repository. Everything else under `docs/` is generated. */
export const AUTHORED_PAGES = [
  'index',
  'quickstart',
  'concepts',
  'edge-cases',
  'for-ai-agents',
  'open-source',
  'guides/webhooks',
  'guides/idempotency',
  'guides/policies',
  'guides/stripe',
  'guides/agents',
];

/** Exactly the files `main()` writes into `src/content/docs/docs/`, and nothing else. */
export const GENERATED_PAGE_FILES = [
  ...CLI_PAGES.map((page) => `${page.slug}.md`),
  `${SDK_PAGE.slug}.md`,
  'cli.md',
  'mcp.md',
];

const escapeYaml = (value) => `'${value.replaceAll("'", "''")}'`;

/**
 * The one transform applied to a source page: a Starlight front matter, and the source's own
 * first heading removed because Starlight renders `title` as the page's `h1` and two would
 * fail `test/html.test.ts`. Everything after it is copied byte for byte.
 */
export function renderDocPage({ title, order, body, description }) {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first >= 0 && lines[first].startsWith('# ')) {
    lines.splice(first, 1);
    while (lines.length > first && lines[first].trim() === '') lines.splice(first, 1);
  }
  const front = [
    '---',
    `title: ${escapeYaml(title)}`,
    ...(description === undefined ? [] : [`description: ${escapeYaml(description)}`]),
    `sidebar:`,
    `  order: ${order}`,
    '---',
    '',
  ];
  return front.join('\n') + lines.join('\n').replace(/\n*$/, '\n');
}

/** Reads the front matter title of a built page, for `llms.txt` and the markdown twins. */
export function splitFrontMatter(text) {
  if (!text.startsWith('---\n')) return { front: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { front: {}, body: text };
  const front = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    front[match[1]] = value;
  }
  return { front, body: text.slice(end + 5) };
}

// --------------------------------------------------------------- OpenAPI derived sample

/**
 * A value that satisfies one property schema of the OpenAPI document.
 *
 * The homepage shows a booking, and the point of the section is that the shape is the API's
 * own. So no value here is invented free-hand: it is the schema's `example`, or the first
 * member of its `enum`, or a literal listed in `SAMPLE_OVERRIDES` and then checked against the
 * schema by `test/booking-sample.test.ts`.
 */
const SAMPLE_OVERRIDES = {
  status: 'confirmed',
  start: '2026-09-08T07:00:00Z',
  end: '2026-09-08T08:00:00Z',
  duration_minutes: 60,
  timezone: 'Europe/Rome',
  quantity: 1,
  price: { amount: 2500, currency: 'EUR' },
  policy_snapshot: { cancellation: [{ before_minutes: 1440, refund_percent: 100 }] },
  allocations: [
    {
      object: 'booking_allocation',
      resource_id: 'res_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c',
      role: 'court',
      capacity_used: 1,
    },
  ],
  created_at: '2026-09-07T10:12:04Z',
};

/** The fields the homepage prints, in the order the API returns them. */
export const BOOKING_SAMPLE_FIELDS = [
  'id',
  'object',
  'status',
  'service_id',
  'customer_id',
  'start',
  'end',
  'duration_minutes',
  'timezone',
  'quantity',
  'price',
  'policy_snapshot',
  'allocations',
  'created_at',
];

export function bookingSample(openapi) {
  const schema = openapi.components.schemas.Booking;
  const shown = {};
  for (const key of BOOKING_SAMPLE_FIELDS) {
    const property = schema.properties[key];
    if (property === undefined) throw new Error(`Booking has no property "${key}"`);
    if (Object.hasOwn(SAMPLE_OVERRIDES, key)) shown[key] = SAMPLE_OVERRIDES[key];
    else if (property.example !== undefined) shown[key] = property.example;
    else if (Array.isArray(property.enum)) shown[key] = property.enum[0];
    else throw new Error(`no sample value for Booking.${key}`);
  }
  return {
    fields: BOOKING_SAMPLE_FIELDS,
    value: shown,
    total: schema.required.length,
    omitted: schema.required.length - BOOKING_SAMPLE_FIELDS.length,
  };
}

// --------------------------------------------------------------- MCP tools

/**
 * `tools/list`, asked of the real server over stdio, exactly as `packages/mcp/test` does.
 *
 * Spawning the published entry point rather than importing `createServer` is the point: what
 * ends up on the site is what a client gets, transport included, and a server that fails to
 * start fails the build instead of shipping a stale list. The protocol is three newline
 * delimited frames, so no MCP client library is pulled into the site.
 */
export function mcpTools({ bin = MCP_BIN, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BOOKRAIL_MCP_LOG: 'silent', BOOKRAIL_SECRET_KEY: '' },
    });
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the MCP server did not answer tools/list in ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    const done = (error, value) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    child.on('error', (error) => done(error));
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          done(new Error(`the MCP server wrote a non JSON line on stdout: ${line}`));
          return;
        }
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (message.id === 2) {
          if (message.error) done(new Error(`tools/list failed: ${JSON.stringify(message.error)}`));
          else done(null, message.result.tools);
          return;
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bookrail-site', version: '0.1.0' },
        },
      })}\n`,
    );
  });
}

// --------------------------------------------------------------- CLI help

export function cliHelp(args, { bin = CLI_BIN } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', COLUMNS: '90' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('close', () => resolve(out.trimEnd()));
  });
}

/** The commands the page documents: the ones this build actually implements. */
export const CLI_COMMANDS = [
  'login',
  'logout',
  'whoami',
  'env',
  'version',
  'init',
  'push',
  'pull',
  'diff',
  'locations',
  'resources',
  'resource_groups',
  'schedules',
  'services',
  'policies',
  'customers',
  'availability',
  'holds',
  'bookings',
  'webhooks',
  'events',
  'doctor',
  'schema',
  'examples',
  'docs',
  'mcp',
];

export async function renderCliPage() {
  const root = await cliHelp([]);
  const sections = [];
  for (const command of CLI_COMMANDS) {
    sections.push(`## bookrail ${command}\n\n\`\`\`\n${await cliHelp([command])}\n\`\`\`\n`);
  }
  const body = [
    '# CLI',
    '',
    'Every block on this page is the output of `--help` of the compiled CLI, captured at build',
    'time. If a flag is here, this build has it.',
    '',
    'Install nothing: `npx bookrail <command>`. Every command takes `--json` and prints',
    '`{ ok, environment, data, error?, next_steps? }`. The default environment is test.',
    '',
    '```',
    root,
    '```',
    '',
    ...sections,
  ].join('\n');
  return renderDocPage({
    title: 'CLI',
    order: 62,
    description: 'Every command of the Bookrail CLI, from its own --help.',
    body,
  });
}

export function renderMcpPage(tools) {
  const rows = tools.map((tool) => {
    const annotations = tool.annotations ?? {};
    const marks = [
      annotations.readOnlyHint === true ? 'read only' : null,
      annotations.destructiveHint === true ? 'destructive' : null,
      annotations.idempotentHint === true ? 'idempotent' : null,
    ].filter((mark) => mark !== null);
    const summary = (tool.description ?? '').split('\n')[0].split('Returns:')[0].trim();
    return `| \`${tool.name}\` | ${summary} | ${marks.join(', ')} |`;
  });
  const details = tools.map((tool) => {
    const required = tool.inputSchema?.required ?? [];
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    const args =
      properties.length === 0
        ? 'No arguments.'
        : properties
            .map((name) => `\`${name}\`${required.includes(name) ? ' (required)' : ''}`)
            .join(', ');
    return [`### ${tool.name}`, '', tool.description ?? '', '', `Arguments: ${args}`, ''].join(
      '\n',
    );
  });
  const body = [
    '# MCP',
    '',
    `The Bookrail MCP server exposes ${tools.length} tools. This page is generated from the`,
    'server itself: the build starts it over stdio, asks `tools/list`, and writes both this page',
    'and [`/mcp/tools.json`](/mcp/tools.json), the same list with every input schema.',
    '',
    '```bash',
    'npx bookrail mcp install --client claude-code   # writes ./.mcp.json',
    'npx @bookrail/mcp                               # or run the server by hand, over stdio',
    '```',
    '',
    'The default environment is test. A tool refuses live unless the server was started with',
    '`BOOKRAIL_MCP_ALLOW_LIVE=1` and a live key. Irreversible tools return a preview until they',
    'are called again with `confirm: true`.',
    '',
    '| Tool | What it does | Annotations |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Every tool',
    '',
    ...details,
  ].join('\n');
  return renderDocPage({
    title: 'MCP',
    order: 64,
    description: 'Every tool of the Bookrail MCP server, read from the server itself.',
    body,
  });
}

// --------------------------------------------------------------- the homepage

/**
 * Everything the homepage says about the product that the product itself can say.
 *
 * The rule of the page is that a number, a field, a line of output or a name on it is produced
 * by the code that owns it, at build time, and never typed: the `explain` rows are what the
 * availability engine answers about the synthetic day of the hero grid; the terminal lines are
 * printed by the compiled CLI; the transition matrix, the retry ladder and the template list are
 * the engine's, the delivery worker's and the CLI's own constants; the webhook is signed by the
 * function a receiver verifies it with. `test/home.test.ts` recomputes each of them from its
 * source and compares it with what the page shows.
 *
 * Where the CLI needs an API to answer (the `explain` table, the `diff`), it is run against a
 * local stub that answers with the engine and the API's own serializer, or that stores what the
 * CLI sent and gives it back. The CLI, and what it prints, are the real ones; the stub is named
 * in the page's comment and in `DESIGN.md`.
 */

const HOUR_MS = 3_600_000;

const load = (path) => import(/* @vite-ignore */ pathToFileURL(path).href);

/** `2026-09-08T07:30:00.000Z` in a zone, as `09:30`. */
function localClock(instant, offsetMs) {
  return new Date(instant + offsetMs).toISOString().slice(11, 16);
}

/** `+02:00` for an offset in milliseconds. */
function offsetSuffix(offsetMs) {
  const minutes = Math.round(offsetMs / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The availability data of the three courts of the synthetic day, in the engine's own shape. */
export function explainInput(engine, { day = GRID_DAY, resources = GRID_RESOURCES } = {}) {
  const midnight = engine.localDayRange(day.timezone, day.date).start;
  const openHour = Number(day.open.slice(0, 2));
  const opening = midnight + openHour * HOUR_MS;
  const courts = resources.filter((resource) => resource.court);
  const question = EXPLAIN_QUESTION;
  const data = {
    service: {
      id: question.serviceId,
      durationMinutes: question.durationMinutes,
      durationOptions: null,
      durationMinMinutes: null,
      durationMaxMinutes: null,
      capacityPerBooking: 1,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      slotIntervalMinutes: question.slotIntervalMinutes,
      alignTo: 'half_hour',
      priceAmount: 3000,
      priceCurrency: 'EUR',
      pricingRules: [],
      bookingWindow: null,
      bufferSharing: false,
      allowSplit: false,
    },
    requirements: [
      {
        id: question.requirementId,
        quantity: 1,
        consumes: 'per_unit',
        role: null,
        resourceGroupId: question.groupId,
        allocationStrategy: 'first_available',
        resourceIds: courts.map((court) => court.id),
      },
    ],
    resources: courts.map((court) => ({
      id: court.id,
      name: court.name,
      capacity: 1,
      timezone: day.timezone,
      rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: day.open, endTime: day.close }],
      exceptions: [],
      occupancies: court.slots.map((slot) => ({
        id: slot.id,
        resourceId: court.id,
        start: opening + slot.from * HOUR_MS,
        end: opening + (slot.from + slot.hours) * HOUR_MS,
        capacityUsed: 1,
        kind: slot.kind,
        refId: slot.id,
        bufferBeforeMs: 0,
        bufferAfterMs: 0,
      })),
    })),
    policy: null,
    customerActiveBookings: null,
    ignoredPricingRules: [],
    timezone: day.timezone,
  };
  return {
    data,
    from: opening,
    to: opening + day.hours * HOUR_MS,
    now: Date.parse(question.now),
    offsetMs: engine.zoneOffsetMs(day.timezone, opening),
  };
}

/** The prefix of the object an occupancy of the synthetic day belongs to. */
const REF_KIND = { booking: 'booking', hold: 'hold', block: 'resource_block' };

/**
 * `explain` over the whole band: every refused instant, one row per court, as the engine says it.
 * The one instant where the three kinds of occupancy meet (a booking, a hold and a block) is the
 * one the feature card prints.
 */
export function explainRows(engine, input = explainInput(engine)) {
  const result = engine.computeAvailability({
    data: input.data,
    from: input.from,
    to: input.to,
    now: input.now,
    explain: true,
  });
  const resourceName = new Map(input.data.resources.map((r) => [r.id, r.name]));
  const occupancyKind = new Map(
    input.data.resources.flatMap((r) => r.occupancies.map((o) => [o.refId, o.kind])),
  );
  const rows = [];
  for (const entry of result.explain ?? []) {
    for (const reason of entry.reasons) {
      const kind = reason.refId === undefined ? undefined : occupancyKind.get(reason.refId);
      rows.push({
        at: new Date(entry.at).toISOString(),
        local: localClock(entry.at, input.offsetMs),
        code: reason.code,
        resource:
          reason.resourceId === undefined ? '' : (resourceName.get(reason.resourceId) ?? ''),
        resource_id: reason.resourceId === undefined ? '' : encodeId('resource', reason.resourceId),
        kind: kind ?? null,
        ref:
          reason.refId === undefined || kind === undefined
            ? ''
            : encodeId(REF_KIND[kind], reason.refId),
        message: reason.detail,
      });
    }
  }
  const kindsAt = new Map();
  for (const row of rows) kindsAt.set(row.at, new Set([...(kindsAt.get(row.at) ?? []), row.kind]));
  const featured =
    [...kindsAt.entries()].sort(
      (a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? null;
  return {
    service_id: encodeId('service', input.data.service.id),
    timezone: input.data.timezone,
    slots: result.slots.length,
    instants: (result.explain ?? []).length,
    rows,
    featured,
  };
}

/**
 * What the engine answers to the one request the grid draws as refused: that resource alone, for
 * the length of the request, at its start. The picture may only show a 409 the engine would give,
 * and `test/home.test.ts` fails if this answer offers a slot.
 */
export function refusalAnswers(engine, { day = GRID_DAY, resources = GRID_RESOURCES } = {}) {
  const base = explainInput(engine, { day, resources });
  const answers = [];
  for (const resource of resources) {
    if (resource.rejected === undefined) continue;
    const start = base.from + resource.rejected.from * HOUR_MS;
    const data = {
      ...base.data,
      service: {
        ...base.data.service,
        durationMinutes: resource.rejected.hours * 60,
        slotIntervalMinutes: null,
        alignTo: null,
      },
      requirements: [
        { ...base.data.requirements[0], resourceGroupId: null, resourceIds: [resource.id] },
      ],
      resources: [
        {
          id: resource.id,
          name: resource.name,
          capacity: 1,
          timezone: day.timezone,
          rules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: day.open, endTime: day.close }],
          exceptions: [],
          occupancies: resource.slots.map((slot) => ({
            id: slot.id,
            resourceId: resource.id,
            start: base.from + slot.from * HOUR_MS,
            end: base.from + (slot.from + slot.hours) * HOUR_MS,
            capacityUsed: 1,
            kind: slot.kind,
            refId: slot.id,
            bufferBeforeMs: 0,
            bufferAfterMs: 0,
          })),
        },
      ],
    };
    const result = engine.computeAvailability({
      data,
      from: start,
      to: start + 1,
      now: base.now,
      explain: true,
      candidates: [start],
    });
    answers.push({
      resource: resource.name,
      at: new Date(start).toISOString(),
      hours: resource.rejected.hours,
      slots: result.slots.length,
      reasons: (result.explain ?? []).flatMap((entry) =>
        entry.reasons.map((reason) => ({ code: reason.code, refId: reason.refId ?? null })),
      ),
    });
  }
  return answers;
}

/** A local HTTP server for the length of `fn`, answering with `handler(method, path, body)`. */
async function withStubApi(handler, fn) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      let answer;
      try {
        answer = handler(request.method, request.url ?? '/', body === '' ? null : JSON.parse(body));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'stub', message: String(error) } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * The compiled CLI, in a directory of its own, with a home of its own (so it never reads the
 * credentials of whoever runs the build) and a key that only has the shape of one.
 */
function runCli(args, { cwd, apiUrl } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, ...(apiUrl === undefined ? [] : ['--api-url', apiUrl])],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: cwd,
          XDG_CONFIG_HOME: join(cwd, '.config'),
          NO_COLOR: '1',
          COLUMNS: '200',
          BOOKRAIL_SECRET_KEY: `sk_test_${'0'.repeat(40)}`,
        },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`bookrail ${args.join(' ')} exited ${String(code)}\n${out}\n${err}`));
    });
  });
}

/** What the CLI printed, up to the «Next steps» it closes every human answer with. */
function beforeNextSteps(output, cwd, real) {
  const lines = output.replaceAll(real, '.').replaceAll(cwd, '.').replace(/\n+$/, '').split('\n');
  const end = lines.findIndex((line) => line === 'Next steps');
  const kept = end === -1 ? lines : lines.slice(0, end);
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept;
}

/**
 * The terminal of the section for agents: `mcp install`, which never calls the API, and
 * `availability --explain`, answered by the engine through the API's serializer.
 */
export async function agentTerminal(engine, serialize) {
  const cwd = await mkdtemp(join(tmpdir(), 'bookrail-home-agent-'));
  const real = await realpath(cwd);
  try {
    const input = explainInput(engine);
    const service = encodeId('service', input.data.service.id);
    const suffix = offsetSuffix(input.offsetMs);
    // Two hours of the morning: one slot left, and three instants refused on every court.
    const from = `${GRID_DAY.date}T${GRID_DAY.open}:00${suffix}`;
    const to = `${GRID_DAY.date}T${localClock(input.from + 2 * HOUR_MS, input.offsetMs)}:00${suffix}`;
    const install = ['mcp', 'install', '--client', 'claude-code'];
    const ask = ['availability', '--service', service, '--from', from, '--to', to, '--explain'];
    const installed = await runCli(install, { cwd });
    const asked = await withStubApi(
      (method, path, body) => {
        if (method !== 'POST' || !path.startsWith('/v1/availability')) {
          throw new Error(`unexpected ${method} ${path}`);
        }
        const window = { from: Date.parse(body.from), to: Date.parse(body.to) };
        const result = engine.computeAvailability({
          data: input.data,
          ...window,
          now: input.now,
          explain: body.explain === true,
        });
        return serialize.serializeAvailability(result, {
          serviceId: input.data.service.id,
          timezone: body.timezone ?? input.data.timezone,
          granularity: 'slots',
          truncateEndAt: window.to,
        });
      },
      (apiUrl) => runCli(ask, { cwd, apiUrl }),
    );
    return [
      {
        command: `npx bookrail ${install.join(' ')}`,
        output: beforeNextSteps(installed, cwd, real),
      },
      { command: `npx bookrail ${ask.join(' ')}`, output: beforeNextSteps(asked, cwd, real) },
    ];
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** The edit the CLI card makes to the padel template before it asks for a `diff`. */
export const DIFF_EDITS = [
  { from: "to: '23:00'", to: "to: '22:00'" },
  { from: 'durationOptions: [60, 90]', to: 'durationOptions: [60, 90, 120]' },
];

const COLLECTIONS = {
  locations: 'location',
  schedules: 'schedule',
  resources: 'resource',
  resource_groups: 'resource_group',
  policies: 'policy',
  services: 'service',
};

/**
 * `bookrail diff` on the padel template, after a push and two edits.
 *
 * The API is a stub that stores what the CLI sends and lists it back, which is all `push` and
 * `diff` ask of it: the plan is computed by the CLI, from the file and from the objects.
 */
export async function configDiff() {
  const cwd = await mkdtemp(join(tmpdir(), 'bookrail-home-diff-'));
  const real = await realpath(cwd);
  try {
    await runCli(['init', '--template', 'padel'], { cwd });
    const store = new Map();
    let counter = 0;
    const output = await withStubApi(
      (method, path, body) => {
        const collection = new URL(path, 'http://stub').pathname.split('/')[2] ?? '';
        const kind = COLLECTIONS[collection];
        if (kind === undefined) throw new Error(`unexpected ${method} ${path}`);
        if (method === 'POST') {
          counter += 1;
          const object = {
            id: encodeId(kind, `0198f0c2-a1b4-7e2e-9a1c-${String(counter).padStart(12, '0')}`),
            object: kind,
            ...body,
          };
          store.set(collection, [...(store.get(collection) ?? []), object]);
          return object;
        }
        return { object: 'list', data: store.get(collection) ?? [], has_more: false };
      },
      async (apiUrl) => {
        await runCli(['push'], { cwd, apiUrl });
        const file = join(cwd, 'bookrail.config.ts');
        let text = await readFile(file, 'utf8');
        for (const edit of DIFF_EDITS) {
          if (!text.includes(edit.from)) {
            throw new Error(`the padel template no longer contains ${edit.from}`);
          }
          text = text.replace(edit.from, edit.to);
        }
        await writeFile(file, text, 'utf8');
        return runCli(['diff'], { cwd, apiUrl });
      },
    );
    const lines = beforeNextSteps(output, cwd, real);
    return {
      command: 'bookrail diff',
      summary: lines[0] ?? '',
      rows: lines.filter((line) => /^(create|update|delete) /.test(line)),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** `2h` for 7200: the ladder the way the webhook guide writes it. */
export function shortDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The one line of `--help` that says what a subcommand does. */
export async function subcommandSummary(command, subcommand) {
  const lines = (await cliHelp([command])).split('\n');
  const at = lines.findIndex((candidate) => candidate.trim().startsWith(`${subcommand} `));
  if (at === -1) throw new Error(`bookrail ${command} --help has no ${subcommand}`);
  // Commander wraps a long description onto lines indented past the command column.
  const parts = [lines[at].trim().replace(/^\S+\s+(\[options\]\s+)?/, '')];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s{6,}\S/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ').trim();
}

/** `90` as `90 min`, `480` as `8 h`, `1440` as `1 day`: a length the way a person says it. */
export function readableMinutes(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`;
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** Every template the CLI ships, in its own order, with what the cards draw. */
export function templateCards(templates) {
  return Object.values(templates).map((template) => ({
    name: template.name,
    summary: template.summary,
    vertical: template.vertical.replace(/^\d+\.\s*/, ''),
    resources: (template.config.resources ?? []).map((resource) => resource.name),
    services: (template.config.services ?? []).map((service) => ({
      name: service.name,
      length:
        service.durationOptions !== undefined
          ? service.durationOptions.map(readableMinutes).join(' or ')
          : service.duration !== undefined
            ? readableMinutes(service.duration)
            : service.durationRange !== undefined
              ? `${readableMinutes(service.durationRange.min)} to ${readableMinutes(service.durationRange.max)}`
              : '',
    })),
  }));
}

/** The status by action matrix, from the engine's own table, for the actions the API exposes. */
export function transitionMatrix(engine) {
  return {
    actions: [...engine.HTTP_TRANSITION_ACTIONS],
    rows: Object.entries(engine.TRANSITIONS).map(([status, allowed]) => ({
      status,
      allowed: engine.HTTP_TRANSITION_ACTIONS.filter((action) => allowed[action] !== undefined),
    })),
  };
}

/** A synthetic secret, of the shape `POST /v1/webhooks` returns. It signs nothing real. */
export const WEBHOOK_DEMO_SECRET = `whsec_${'homepage'.repeat(4)}`;

/**
 * One `booking.created` delivery, as the worker sends it: the event object of `GET /v1/events`,
 * with the booking of the homepage as its `data.object`, and the headers of a delivery. The
 * signature is computed over the exact body shown, with the synthetic secret above, by the same
 * function `@bookrail/webhook-signature` verifies with.
 */
export function webhookDelivery(sample, userAgent) {
  const createdAt = sample.value.created_at;
  const event = {
    id: 'evt_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c',
    object: 'event',
    type: 'booking.created',
    occurred_at: createdAt,
    api_version: CURRENT_API_VERSION,
    seq: 1,
    actor: { type: 'api', id: 'key_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c' },
    data: { object: sample.value, previous: null },
    environment: 'test',
    created_at: createdAt,
  };
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.parse(createdAt) / 1000);
  return {
    event,
    body,
    timestamp,
    headers: [
      ['Content-Type', 'application/json; charset=utf-8'],
      ['User-Agent', userAgent],
      ['Bookrail-Signature', signPayload(body, WEBHOOK_DEMO_SECRET, timestamp)],
      ['Bookrail-Event-Id', event.id],
      ['Bookrail-Webhook-Id', 'wh_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c'],
      ['Bookrail-Delivery-Id', 'whd_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c'],
    ],
  };
}

/** Every fenced block of a markdown page, with its language. */
export function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].map((match) => ({
    lang: match[1] ?? '',
    code: match[2] ?? '',
  }));
}

function pick(blocks, lang, start, page) {
  const found = blocks.find((block) => block.lang === lang && block.code.startsWith(start));
  if (found === undefined) throw new Error(`${page} has no \`\`\`${lang} block starting ${start}`);
  return found.code;
}

/**
 * The code of the four tabs, read from the quickstart and from the page for agents, never typed
 * again. MCP has no block of its own in the quickstart: its tab is the install line of the agent
 * page and the two calls an agent makes, whose argument names are the required ones of the two
 * tools in the server's own `tools/list`, with the values of the quickstart.
 */
export function codeSamples(quickstart, agents, tools) {
  const q = fencedBlocks(quickstart);
  const a = fencedBlocks(agents);
  const node = pick(q, 'ts', "import Bookrail from '@bookrail/node'", 'quickstart');
  const cliAsk = pick(q, 'bash', 'npx bookrail availability', 'quickstart');
  const cliBook = pick(q, 'bash', 'npx bookrail bookings create', 'quickstart');
  const httpAsk = pick(q, 'bash', 'curl -s https://api.bookrail.dev/v1/availability', 'quickstart');
  const httpBook = pick(q, 'bash', 'curl -s https://api.bookrail.dev/v1/bookings', 'quickstart');
  const install = pick(a, 'bash', '# The CLI', 'for-ai-agents')
    .split('\n')
    .find((line) => line.startsWith('npx bookrail mcp install'));
  if (install === undefined) throw new Error('for-ai-agents has no mcp install line');

  // The values of the quickstart's own HTTP example: the service, the day, the slot, the customer.
  const value = (block, key) => new RegExp(`"${key}":"([^"]+)"`).exec(block)?.[1];
  const service = value(httpAsk, 'service_id');
  const from = value(httpAsk, 'from');
  const to = value(httpAsk, 'to');
  const start = value(httpBook, 'start');
  const email = value(httpBook, 'email');
  if ([service, from, to, start, email].some((found) => found === undefined)) {
    throw new Error(
      'the HTTP example of the quickstart no longer has its service, window or email',
    );
  }
  const call = (name, values) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`the MCP server has no tool ${name}`);
    const properties = tool.inputSchema?.properties ?? {};
    for (const key of Object.keys(values)) {
      if (!(key in properties)) throw new Error(`${name} takes no argument ${key}`);
    }
    for (const key of tool.inputSchema?.required ?? []) {
      if (!(key in values)) throw new Error(`${name} requires ${key}`);
    }
    return JSON.stringify({ name, arguments: values }, null, 2);
  };
  const mcp = [
    install,
    '',
    '# then the agent calls two tools of the server: ask, and book',
    call('bookrail_availability', { service_id: service, from, to }),
    call('bookrail_booking_create', { service_id: service, start, customer_email: email }),
  ].join('\n');

  return [
    {
      id: 'node',
      label: 'Node SDK',
      name: 'the Node SDK',
      lang: 'ts',
      code: node,
      docs: '/docs/sdk/',
    },
    {
      id: 'http',
      label: 'HTTP',
      name: 'plain HTTP',
      lang: 'bash',
      code: `${httpAsk}\n\n${httpBook}`,
      docs: '/docs/api/',
    },
    {
      id: 'cli',
      label: 'CLI',
      name: 'the CLI',
      lang: 'bash',
      code: `${cliAsk}\n\n${cliBook}`,
      docs: '/docs/cli-basics/',
    },
    { id: 'mcp', label: 'MCP', name: 'MCP', lang: 'json', code: mcp, docs: '/docs/mcp/' },
  ];
}

/** The licence and the repository, as the published CLI package declares them. */
export function openSourceFacts(cliPackage) {
  const repository =
    typeof cliPackage.repository === 'string' ? cliPackage.repository : cliPackage.repository?.url;
  const path = /github\.com[/:]([^/]+\/[^/.]+)/.exec(repository ?? '')?.[1];
  if (path === undefined) throw new Error('the CLI package declares no GitHub repository');
  return { license: cliPackage.license, repository: `github.com/${path}` };
}

/** Everything above, in the one file the homepage reads. */
export async function homeData({ tools, openapi } = {}) {
  const engine = await load(ENGINE_ENTRY);
  const serialize = await load(API_SERIALIZE);
  const dispatch = await load(API_DISPATCH);
  const deliver = await load(API_DELIVER);
  const cli = await load(CLI_LIB);
  const spec = openapi ?? JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
  const list = tools ?? (await mcpTools());
  const create = spec.paths['/v1/bookings'].post.responses;
  return {
    explain: explainRows(engine),
    terminal: await agentTerminal(engine, serialize),
    diff: await configDiff(),
    matrix: transitionMatrix(engine),
    ladder: dispatch.WEBHOOK_RETRY_DELAYS_SECONDS.map(shortDuration),
    attempts: dispatch.MAX_DELIVERY_ATTEMPTS,
    stripe: {
      command: 'bookrail stripe connect',
      summary: await subcommandSummary('stripe', 'connect'),
    },
    booking: {
      created: Object.hasOwn(create, '201') ? 201 : null,
      conflict:
        Object.hasOwn(create, '409') && create['409'].description.includes('`slot_unavailable`')
          ? 409
          : null,
    },
    templates: templateCards(cli.TEMPLATES),
    webhook: webhookDelivery(bookingSample(spec), deliver.USER_AGENT),
    samples: codeSamples(
      await readFile(QUICKSTART_PAGE, 'utf8'),
      await readFile(AGENTS_PAGE, 'utf8'),
      list,
    ),
    tools: list.map((tool) => tool.name),
    openSource: openSourceFacts(JSON.parse(await readFile(CLI_PACKAGE, 'utf8'))),
  };
}

// --------------------------------------------------------------- the legal texts

/**
 * The Terms of Service and the Data Processing Agreement, published at `/terms` and `/dpa`.
 *
 * They are written and approved outside this site, and read from their directory at build time,
 * like the documentation is read from `packages/cli/docs`: one source, never copied by hand.
 * `BOOKRAIL_LEGAL_DIR` points the build at a copy, which is how the test suite builds.
 *
 * **A draft is never published.** Each text says in its front matter whether it is `draft` or
 * `approved`, and the build stops, before it has written anything, when either is not approved
 * or is missing. The pages check it again when they render, so a build that skipped this script
 * cannot publish one either.
 *
 * `--preview-legal` is for what publishes nothing (`dev`, `check`, `typecheck`): it takes a draft
 * as it is, so that its page can be read in the development server, and without the directory
 * (the public repository has none) it reads the fixtures of the test suite. `build` never passes
 * it.
 */
export const LEGAL_DIR = process.env.BOOKRAIL_LEGAL_DIR ?? join(repoRoot, 'legale');

export const FIXTURE_LEGAL_DIR = join(siteRoot, 'test', 'fixtures', 'legal');

export const LEGAL_TEXTS = [
  { source: 'terms-of-service.md', slug: 'terms' },
  { source: 'data-processing-agreement.md', slug: 'dpa' },
];

export const GENERATED_LEGAL = join(GENERATED_DATA, 'legal');

export class LegalNotPublishable extends Error {}

/** The two texts, with their front matter, or a refusal that says which and why. */
export async function readLegalTexts(dir = LEGAL_DIR, { preview = false } = {}) {
  if (preview && !existsSync(dir)) dir = FIXTURE_LEGAL_DIR;
  const texts = [];
  for (const text of LEGAL_TEXTS) {
    let raw;
    try {
      raw = await readFile(join(dir, text.source), 'utf8');
    } catch {
      throw new LegalNotPublishable(
        `${join(dir, text.source)} is missing: the site is not built without its ${text.slug} page.`,
      );
    }
    const { front, body } = splitFrontMatter(raw);
    const sourcePath = join(dir, text.source);
    const sourceHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    if (front.status !== 'approved' && !preview) {
      throw new LegalNotPublishable(
        `${text.source} has status: ${front.status ?? 'none'}. A legal text is published only once it is approved (status: approved in its front matter). To build with a copy, set BOOKRAIL_LEGAL_DIR.`,
      );
    }
    if (!front.title || !front.version || !front.effective) {
      throw new LegalNotPublishable(
        `${text.source} needs a title, a version and an effective date.`,
      );
    }
    texts.push({ ...text, front, body, sourcePath, sourceHash });
  }
  return texts;
}

/**
 * The page source of one text: its front matter, and its body without the notes for its authors
 * (HTML comments, which a browser would not show and a source view would) and without its own
 * first heading, since the page has one.
 */
/**
 * The generated page carries where it came from: the absolute path of its source and the SHA-256
 * of the source as it was read. `LegalText.astro` reads the source again when the page renders
 * and refuses a page whose source is not in the directory of this build, has changed, or is not
 * approved: a page left behind by an earlier run (a copy approved for a test) is never trusted.
 */
export function renderLegalText({ front, body, sourcePath, sourceHash }) {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*# [^\n]*\n/, '')
    .replace(/^\n+/, '');
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return [
    '---',
    `title: ${quote(front.title)}`,
    `version: ${quote(front.version)}`,
    `status: ${quote(front.status)}`,
    `effective: ${quote(front.effective)}`,
    ...(sourcePath === undefined ? [] : [`source: ${quote(sourcePath)}`]),
    ...(sourceHash === undefined ? [] : [`sha256: ${quote(sourceHash)}`]),
    '---',
    '',
    cleaned.replace(/\n*$/, '\n'),
  ].join('\n');
}

// --------------------------------------------------------------- run

async function main() {
  // What an earlier run generated from the legal texts goes first, whatever happens next: a
  // draft refused here must not leave behind the pages of a copy approved for a test.
  await rm(GENERATED_LEGAL, { recursive: true, force: true });
  // Then, before anything is written: a draft stops the build here.
  let legal;
  try {
    legal = await readLegalTexts(LEGAL_DIR, { preview: process.argv.includes('--preview-legal') });
  } catch (error) {
    if (!(error instanceof LegalNotPublishable)) throw error;
    process.stderr.write(`[site] refusing to build: ${error.message}\n`);
    process.exit(1);
  }

  await mkdir(GENERATED_DOCS, { recursive: true });
  await mkdir(GENERATED_DATA, { recursive: true });
  await mkdir(GENERATED_BRAND, { recursive: true });
  await mkdir(join(siteRoot, 'public'), { recursive: true });

  for (const asset of BRAND_FILES) {
    for (const target of asset.to) {
      await copyFile(join(BRAND, asset.from), join(siteRoot, target));
    }
  }

  // A stale generated page is a page nobody wrote and nobody can delete: start from nothing.
  for (const name of GENERATED_PAGE_FILES) {
    await rm(join(GENERATED_DOCS, name), { force: true });
  }

  for (const page of CLI_PAGES) {
    let body = await readFile(join(CLI_DOCS, page.source), 'utf8');
    if (page.append !== undefined) {
      body = `${body.replace(/\n*$/, '\n')}\n${await readFile(join(FRAGMENTS, page.append), 'utf8')}`;
    }
    const target = join(GENERATED_DOCS, `${page.slug}.md`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      renderDocPage({
        title: page.title,
        order: page.order,
        description: page.description,
        body,
      }),
      'utf8',
    );
  }

  await writeFile(
    join(GENERATED_DOCS, `${SDK_PAGE.slug}.md`),
    renderDocPage({
      title: SDK_PAGE.title,
      order: SDK_PAGE.order,
      description: SDK_PAGE.description,
      body: await readFile(SDK_README, 'utf8'),
    }),
    'utf8',
  );

  const openapi = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
  await writeFile(
    join(GENERATED_DATA, 'booking-response.json'),
    `${JSON.stringify(bookingSample(openapi), null, 2)}\n`,
    'utf8',
  );

  const tools = await mcpTools();
  await writeFile(
    join(GENERATED_DATA, 'mcp-tools.json'),
    `${JSON.stringify(tools, null, 2)}\n`,
    'utf8',
  );
  const home = await homeData({ tools, openapi });
  await writeFile(join(GENERATED_DATA, 'home.json'), `${JSON.stringify(home, null, 2)}\n`, 'utf8');

  await mkdir(GENERATED_LEGAL, { recursive: true });
  for (const text of legal) {
    await writeFile(join(GENERATED_LEGAL, `${text.slug}.md`), renderLegalText(text), 'utf8');
  }

  await writeFile(join(GENERATED_DOCS, 'mcp.md'), renderMcpPage(tools), 'utf8');
  await writeFile(join(GENERATED_DOCS, 'cli.md'), await renderCliPage(), 'utf8');

  process.stderr.write(
    `[site] generated ${CLI_PAGES.length} source pages, ${tools.length} MCP tools, ` +
      `${Object.keys(openapi.paths).length} OpenAPI paths, ${BRAND_FILES.length} brand assets\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
