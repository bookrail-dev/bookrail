/**
 * The files the site owes to machines, written straight into `dist` when the build is done.
 *
 * They are emitted here rather than kept in `public/` for one reason: a file in `public/` is a
 * file somebody can edit, and every one of these is derived. `openapi.json` is a byte copy of
 * the specification the API serves, `mcp/tools.json` is what the MCP server answered at build
 * time, the markdown twins are the sources the pages were built from, and the two `llms` files
 * are an index of those.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_DATA,
  GENERATED_DOCS,
  OPENAPI_PATH,
  siteRoot,
  splitFrontMatter,
} from './generate.mjs';

/** The articles, written by hand, one markdown file per article. */
const BLOG_SOURCE = join(siteRoot, 'src', 'content', 'blog');

/** The public origin. Absolute in `llms.txt`, because an agent may read it out of context. */
const ORIGIN = process.env.SITE_URL ?? 'https://bookrail.dev';

const SUMMARY =
  'Booking infrastructure for developers: availability, resources, holds, bookings, policies and webhooks behind one API. Capacity is enforced by Postgres, not by application code.';

const NOTES = [
  'Every page written in markdown is served as markdown at the same URL with `.md` on the end.',
  'The repository is not public yet and the packages are not on npm yet: /docs/open-source/ says when.',
  'The API reference pages are generated from the OpenAPI document: read /openapi.json instead.',
  'Instants in carry an explicit offset, instants out are UTC. Identifiers are prefixed.',
  'Amounts are integers in the minor unit. Lists are cursored, never offset, and carry no total.',
];

/** Every markdown page under `docs/`, including the ones in a subdirectory such as `guides/`. */
async function listMarkdown(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      out.push(...(await listMarkdown(join(directory, entry.name), relative)));
    else if (entry.name.endsWith('.md')) out.push(relative);
  }
  return out.sort();
}

/** The pages, in sidebar order, with the front matter each one declares. */
async function readPages() {
  const names = await listMarkdown(GENERATED_DOCS);
  const pages = [];
  for (const name of names) {
    const raw = await readFile(join(GENERATED_DOCS, name), 'utf8');
    const { front, body } = splitFrontMatter(raw);
    const slug = name.replace(/\.md$/, '');
    pages.push({
      slug,
      name,
      title: front.title ?? basename(slug),
      description: front.description,
      order: Number(front.order ?? /order:\s*(\d+)/.exec(raw)?.[1] ?? 99),
      body,
      path: `/docs/${slug}.md`,
      url: `${ORIGIN}/docs/${slug}.md`,
      page: slug === 'index' ? '/docs/' : `/docs/${slug}/`,
    });
  }
  return pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** A front matter value written with double quotes, which `splitFrontMatter` leaves alone. */
function unquote(value) {
  return /^"[\s\S]*"$/.test(value) ? value.slice(1, -1).replaceAll('\\"', '"') : value;
}

/**
 * The published articles, newest first, read from the files the pages were built from.
 *
 * The pages read the same directory through the content collection; this reads it directly,
 * because a build hook runs after the collection is gone. The two agree on the one thing that
 * matters, which is that `draft: true` is not published: an article in that state has no page,
 * no markdown twin, no line in the index for machines, and no entry in the feed.
 */
async function readPosts() {
  let names;
  try {
    names = (await readdir(BLOG_SOURCE)).filter((name) => name.endsWith('.md'));
  } catch {
    // No directory at all is the same thing as no article in it.
    return [];
  }
  const posts = [];
  for (const name of names) {
    const raw = await readFile(join(BLOG_SOURCE, name), 'utf8');
    const { front, body } = splitFrontMatter(raw);
    if (unquote(front.draft ?? 'false') === 'true') continue;
    const slug = name.replace(/\.md$/, '');
    posts.push({
      slug,
      title: unquote(front.title ?? slug),
      description: front.description === undefined ? undefined : unquote(front.description),
      date: unquote(front.date ?? ''),
      body,
      path: `/blog/${slug}.md`,
      url: `${ORIGIN}/blog/${slug}.md`,
      page: `/blog/${slug}/`,
    });
  }
  // Newest first, the order of the index, with the slug breaking a tie so a build is repeatable.
  return posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function siteAssets() {
  return {
    name: 'site-assets',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);

        // 1. The specification, byte for byte. `test/openapi.test.ts` compares the two files.
        await copyFile(OPENAPI_PATH, join(out, 'openapi.json'));

        // 2. The MCP tool list, as the server answered it during `scripts/generate.mjs`.
        await mkdir(join(out, 'mcp'), { recursive: true });
        const tools = await readFile(join(GENERATED_DATA, 'mcp-tools.json'), 'utf8');
        await writeFile(join(out, 'mcp', 'tools.json'), tools, 'utf8');

        // 3. A markdown twin next to every page that has a markdown source.
        const pages = await readPages();
        await mkdir(join(out, 'docs'), { recursive: true });
        for (const page of pages) {
          await mkdir(dirname(join(out, 'docs', `${page.slug}.md`)), { recursive: true });
          await writeFile(
            join(out, 'docs', `${page.slug}.md`),
            `# ${page.title}\n\n${page.body.replace(/^\n+/, '')}`,
            'utf8',
          );
        }

        // 4. The same twin next to every published article, when there is one.
        const posts = await readPosts();
        if (posts.length > 0) {
          await mkdir(join(out, 'blog'), { recursive: true });
          for (const post of posts) {
            await writeFile(
              join(out, 'blog', `${post.slug}.md`),
              `# ${post.title}\n\n${post.body.replace(/^\n+/, '')}`,
              'utf8',
            );
          }
        }

        // 5. The index, and the whole thing in one file.
        const blogIndex =
          posts.length === 0
            ? []
            : [
                '## Blog',
                '',
                ...posts.map(
                  (post) =>
                    `- [${post.title}](${post.url})${post.description ? `: ${post.description}` : ''}`,
                ),
                '',
              ];
        // The pricing page has a twin of its own, written by the page itself
        // (`src/pages/pricing.md.ts`) from the data the page is built from.
        const pricing = await readFile(join(out, 'pricing.md'), 'utf8');
        const llms = [
          '# Bookrail',
          '',
          `> ${SUMMARY}`,
          '',
          ...NOTES.map((note) => `- ${note}`),
          '',
          '## Pages',
          '',
          `- [Home](${ORIGIN}/index.md): what Bookrail does today, the explain table of the homepage, the code of the four ways to call it, the templates and the prices in short.`,
          `- [Pricing](${ORIGIN}/pricing.md): the four plans, what each includes and enforces, and what counts as a booking.`,
          `- [Dashboard](${ORIGIN}/dashboard/): plan, usage of the month, projects and API keys. Signed in with a link sent to the owner address; a person, not an agent.`,
          '',
          '## Documentation',
          '',
          ...pages.map(
            (page) =>
              `- [${page.title}](${page.url})${page.description ? `: ${page.description}` : ''}`,
          ),
          '',
          ...blogIndex,
          '## Machine readable',
          '',
          `- [OpenAPI 3.1 document](${ORIGIN}/openapi.json): every operation of the API, generated from the schemas that validate each request.`,
          `- [MCP tools](${ORIGIN}/mcp/tools.json): every tool of the Bookrail MCP server, with its input schema and annotations.`,
          `- [Everything above in one file](${ORIGIN}/llms-full.txt)`,
          '',
        ].join('\n');
        await writeFile(join(out, 'llms.txt'), llms, 'utf8');

        const full = [
          '# Bookrail documentation',
          '',
          `> ${SUMMARY}`,
          '',
          '---',
          '',
          `Source: ${ORIGIN}/pricing`,
          '',
          pricing.trimEnd(),
          '',
          ...[...pages, ...posts].flatMap((page) => [
            '---',
            '',
            `# ${page.title}`,
            '',
            `Source: ${ORIGIN}${page.page}`,
            '',
            page.body.replace(/^\n+/, '').trimEnd(),
            '',
          ]),
        ].join('\n');
        await writeFile(join(out, 'llms-full.txt'), full, 'utf8');

        logger.info(
          `wrote openapi.json, mcp/tools.json, llms.txt, llms-full.txt and ${
            pages.length + posts.length
          } markdown twins (${posts.length} of them articles)`,
        );
      },
    },
  };
}
