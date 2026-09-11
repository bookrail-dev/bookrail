/**
 * The site has no content of its own that somebody else already owns.
 *
 * Each check here recomputes an output from its source and refuses a difference, which is the
 * only version of "one source" that survives a busy week: a copy nobody compares is a copy that
 * drifts.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_SAMPLE_FIELDS,
  BRAND,
  BRAND_FILES,
  CLI_DOCS,
  CLI_PAGES,
  FRAGMENTS,
  GENERATED_DOCS,
  OPENAPI_PATH,
  SDK_PAGE,
  SDK_README,
  bookingSample,
  mcpTools,
  renderDocPage,
} from '../scripts/generate.mjs';
import { distRoot, siteRoot } from './helpers.js';

/** Every markdown page under `docs/`, including the guides in their own directory. */
async function pageFiles(directory = GENERATED_DOCS, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await pageFiles(join(directory, entry.name), relative)));
    else if (entry.name.endsWith('.md')) out.push(relative);
  }
  return out.sort();
}

describe('the pages another package owns', () => {
  it.each(CLI_PAGES)('$slug is $source, transformed and nothing else', async (page) => {
    let body = await readFile(join(CLI_DOCS, page.source), 'utf8');
    if (page.append !== undefined) {
      body = `${body.replace(/\n*$/, '\n')}\n${await readFile(join(FRAGMENTS, page.append), 'utf8')}`;
    }
    const built = await readFile(join(GENERATED_DOCS, `${page.slug}.md`), 'utf8');
    expect(built).toBe(
      renderDocPage({
        title: page.title,
        order: page.order,
        description: page.description,
        body,
      }),
    );
  });

  it('builds the SDK page from the package README, and nothing else', async () => {
    const built = await readFile(join(GENERATED_DOCS, `${SDK_PAGE.slug}.md`), 'utf8');
    expect(built).toBe(
      renderDocPage({
        title: SDK_PAGE.title,
        order: SDK_PAGE.order,
        description: SDK_PAGE.description,
        body: await readFile(SDK_README, 'utf8'),
      }),
    );
    expect(built).toContain('@bookrail/webhook-signature');
    expect(built).toContain('constructEvent');
  });

  it('keeps every command, package and header name that has to be copy pasted', async () => {
    const built = await readFile(join(GENERATED_DOCS, 'cli-basics.md'), 'utf8');
    // Brand and code say the same word, and a snippet has to run as copied.
    expect(built).toContain('Bookrail is booking infrastructure');
    expect(built).toContain('bookrail login');
    const api = await readFile(join(GENERATED_DOCS, 'api.md'), 'utf8');
    expect(api).toContain('Bookrail-Version');
    expect(api).toContain('Bookrail-Request-Id');
  });

  it('leaves exactly one h1 per page for Starlight to render', async () => {
    for (const name of await pageFiles()) {
      const body = (await readFile(join(GENERATED_DOCS, name), 'utf8')).split('\n---\n')[1] ?? '';
      // Fenced blocks are full of shell comments, which are not headings.
      const prose = body.replace(/^```[\s\S]*?^```$/gm, '');
      const headings = prose.split('\n').filter((line) => /^# /.test(line));
      expect(headings, name).toHaveLength(0);
    }
  });
});

describe('the mark', () => {
  it.each(BRAND_FILES)('$from is the file in brand/, byte for byte', async (asset) => {
    const source = await readFile(join(BRAND, asset.from));
    for (const target of asset.to) {
      const copy = await readFile(join(siteRoot, target));
      expect(copy.equals(source), `${asset.from} -> ${target}`).toBe(true);
    }
  });

  it('is drawn from the brand file and not redrawn in the component', async () => {
    const source = await readFile(join(BRAND, 'bookrail-mark.svg'), 'utf8');
    const cells = [...source.matchAll(/<rect [^>]*\/>/g)].map((match) => match[0]);
    expect(cells).toHaveLength(6);
    expect(cells.filter((cell) => cell.includes('#2857f0'))).toHaveLength(1);

    const home = await readFile(join(distRoot, 'index.html'), 'utf8');
    for (const cell of cells) expect(home, cell).toContain(cell);

    const component = await readFile(join(siteRoot, 'src', 'components', 'Logo.astro'), 'utf8');
    expect(component, 'the component must not carry a copy of the geometry').not.toMatch(/<rect\b/);
  });

  it('ships the icon and the social card the founder exported', async () => {
    const icon = await readFile(join(distRoot, 'apple-touch-icon.png'));
    const social = await readFile(join(distRoot, 'og.png'));
    expect(icon.equals(await readFile(join(BRAND, 'png', 'bookrail-icon-180.png')))).toBe(true);
    expect(social.equals(await readFile(join(BRAND, 'png', 'bookrail-social-1200x630.png')))).toBe(
      true,
    );

    const home = await readFile(join(distRoot, 'index.html'), 'utf8');
    expect(home).toContain('<meta property="og:image" content="https://bookrail.dev/og.png">');
    expect(home).toContain('rel="apple-touch-icon"');
  });
});

describe('the OpenAPI document', () => {
  it('is served byte for byte as the API serves it', async () => {
    const source = await readFile(OPENAPI_PATH);
    const served = await readFile(join(distRoot, 'openapi.json'));
    expect(served.equals(source)).toBe(true);
  });

  it('has a reference page for each of its operations', async () => {
    const document = JSON.parse(await readFile(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const ids = Object.values(document.paths).flatMap((path) =>
      Object.values(path)
        .map((operation) => operation.operationId)
        .filter((id): id is string => id !== undefined),
    );
    expect(ids).toHaveLength(70);

    const pages = new Set(await readdir(join(distRoot, 'docs', 'api', 'reference', 'operations')));
    const missing = ids.filter((id) => !pages.has(id.toLowerCase().replace(/[^a-z0-9_]/g, '')));
    expect(missing).toEqual([]);
  });
});

describe('the MCP tool list', () => {
  it('is what the server answers to tools/list, right now', async () => {
    const published = JSON.parse(await readFile(join(distRoot, 'mcp', 'tools.json'), 'utf8')) as {
      name: string;
    }[];
    const live = (await mcpTools()) as { name: string }[];

    expect(published.length).toBe(live.length);
    expect(published.map((tool) => tool.name).sort()).toEqual(live.map((tool) => tool.name).sort());
    for (const tool of published) expect(tool.name.startsWith('bookrail_')).toBe(true);
  }, 60_000);

  it('carries an input schema and annotations for every tool', async () => {
    const tools = JSON.parse(await readFile(join(distRoot, 'mcp', 'tools.json'), 'utf8')) as {
      name: string;
      description?: string;
      inputSchema?: { type?: string };
      annotations?: Record<string, unknown>;
    }[];
    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect(tool.inputSchema?.type, tool.name).toBe('object');
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
    }
  });
});

describe('the booking on the homepage', () => {
  it('shows only fields the Booking schema always returns, with values it allows', async () => {
    const document = JSON.parse(await readFile(OPENAPI_PATH, 'utf8')) as {
      components: {
        schemas: {
          Booking: {
            required: string[];
            properties: Record<string, Record<string, unknown>>;
          };
        };
      };
    };
    const schema = document.components.schemas.Booking;
    const sample = bookingSample(document);

    for (const field of BOOKING_SAMPLE_FIELDS) {
      expect(schema.required, field).toContain(field);
      const property = schema.properties[field];
      const value = (sample.value as Record<string, unknown>)[field];
      const pattern = property?.pattern;
      if (typeof pattern === 'string') {
        expect(new RegExp(pattern).test(String(value)), `${field} against ${pattern}`).toBe(true);
      }
      if (Array.isArray(property?.enum)) expect(property.enum).toContain(value);
      if (property?.format === 'date-time') {
        expect(String(value), field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      }
      if (property?.type === 'integer') expect(Number.isInteger(value), field).toBe(true);
    }

    expect(sample.total).toBe(schema.required.length);
    expect(sample.omitted).toBe(schema.required.length - BOOKING_SAMPLE_FIELDS.length);

    // And the page prints the numbers it computed, not numbers somebody typed.
    const home = await readFile(join(distRoot, 'index.html'), 'utf8');
    expect(home).toContain(`${BOOKING_SAMPLE_FIELDS.length} of the ${sample.total} fields`);
    expect(home).toContain('bk_0198f0c2a1b47e2e9a1c0f4d5e6a7b8c');
  });
});

describe('llms.txt', () => {
  it('points at a file that exists for every line it prints', async () => {
    const llms = await readFile(join(distRoot, 'llms.txt'), 'utf8');
    const urls = [...llms.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1] ?? '');
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      const path = new URL(url).pathname;
      await expect(readFile(join(distRoot, path)), url).resolves.toBeTruthy();
    }
  });

  it('lists every documentation page, and llms-full.txt carries their bodies', async () => {
    const pages = await pageFiles();
    const llms = await readFile(join(distRoot, 'llms.txt'), 'utf8');
    const full = await readFile(join(distRoot, 'llms-full.txt'), 'utf8');
    for (const name of pages) {
      const slug = name.replace(/\.md$/, '');
      expect(llms, slug).toContain(`/docs/${slug}.md`);
    }
    expect(full.length).toBeGreaterThan(llms.length * 5);
    expect(full).toContain('## The loop');
    expect(full).toContain('## Exit codes');
  });

  it('serves a markdown twin at the same URL with .md on the end', async () => {
    for (const slug of [
      'errors',
      'quickstart',
      'concepts',
      'edge-cases',
      'sdk',
      'for-ai-agents',
      'cli',
      'mcp',
      'guides/webhooks',
      'guides/time-zones',
    ]) {
      const html = await readFile(join(distRoot, 'docs', slug, 'index.html'), 'utf8');
      const markdown = await readFile(join(distRoot, 'docs', `${slug}.md`), 'utf8');
      expect(html.length, slug).toBeGreaterThan(0);
      expect(markdown.startsWith('# '), slug).toBe(true);
    }
  });
});
