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
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const siteRoot = join(here, '..');
export const repoRoot = join(siteRoot, '..', '..');

export const CLI_DOCS = join(repoRoot, 'packages', 'cli', 'docs');
export const BRAND = join(repoRoot, 'brand');
export const OPENAPI_PATH = join(repoRoot, 'packages', 'api', 'openapi', 'openapi.json');
export const CLI_BIN = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
export const MCP_BIN = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
export const SDK_README = join(repoRoot, 'packages', 'sdk-node', 'README.md');

export const GENERATED_DOCS = join(siteRoot, 'src', 'content', 'docs', 'docs');
export const GENERATED_DATA = join(siteRoot, 'src', 'generated');
export const GENERATED_BRAND = join(siteRoot, 'src', 'assets', 'brand');
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

// --------------------------------------------------------------- run

async function main() {
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
  await writeFile(join(GENERATED_DOCS, 'mcp.md'), renderMcpPage(tools), 'utf8');
  await writeFile(join(GENERATED_DOCS, 'cli.md'), await renderCliPage(), 'utf8');

  process.stderr.write(
    `[site] generated ${CLI_PAGES.length} source pages, ${tools.length} MCP tools, ` +
      `${Object.keys(openapi.paths).length} OpenAPI paths, ${BRAND_FILES.length} brand assets\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
