/**
 * The blog, in the three states it can be in.
 *
 * Nothing published at all, one article that is still a draft, and one article on the site.
 * The first two are absences, and they are the whole point of the section being built from the
 * articles rather than from a directory that exists: no index, no feed, and no link in any
 * header to a page that would have nothing on it.
 *
 * None of the three can be read off the working copy, because the working copy publishes
 * whatever it publishes on the day. So each of the three builds below owns the input it is
 * asserting on: the articles of `src/content/blog/` are moved aside, exactly the articles the
 * state calls for are written in their place, the site is built into an output directory and a
 * cache of its own, and the working copy is put back. A build of its own rather than a copy of
 * the site tree, because the thing under test is the real build, integration and all; and a
 * fixture that is written and taken away rather than one committed to `src/content/blog/`,
 * because an article committed to make a test pass is an article that gets published by
 * accident. The last check in this file is that the directory came back exactly as it was.
 *
 * The articles the working copy really does publish are checked too, against the `dist` the
 * suite builds: that is the deploy, and it is the only place the launch article is asserted on.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { browserChannel, distRoot, siteRoot, walk } from './helpers.js';

const BLOG_SOURCE = join(siteRoot, 'src', 'content', 'blog');
const SLUG = 'how-an-article-is-published';
const FIXTURE_NAME = `${SLUG}.md`;
/**
 * Everything this file writes lives under one directory, and it is in `.gitignore`. The output
 * of the extra builds ends in `dist` on purpose: the checks that walk this repository looking
 * for what a stranger cannot read skip a directory by that name, so a run that is killed
 * before it can tidy up cannot fail an unrelated suite.
 */
const FIXTURE_ROOT = join(siteRoot, '.blog-fixture');
const FIXTURE_OUT = join(FIXTURE_ROOT, 'dist');
/**
 * And a cache of its own, so that an article this file writes and then removes cannot survive
 * in the cache of the working copy and be built into a page by the next build that runs there.
 */
const FIXTURE_CACHE = join(FIXTURE_ROOT, 'cache');
/** Where the articles of the working copy wait while a build of this file runs. */
const PARKED = join(FIXTURE_ROOT, 'parked');

const TITLE = 'How an article is published';
const DESCRIPTION =
  'One markdown file, five fields of front matter, and a build. What the site does with an article once the file exists.';
const AUTHOR = 'Bookrail';
const DATE = '2026-09-14';

const FIXTURE = `---
title: '${TITLE}'
description: '${DESCRIPTION}'
date: ${DATE}
author: '${AUTHOR}'
draft: false
---

An article on this site is one markdown file. The name of the file is the address of the page,
the front matter is all of the metadata there is, and the build does the rest.

## What the build makes of it

- A page, in the same column the pages outside [the documentation](/docs/) use.
- A markdown twin at the same address with \`.md\` on the end, for a reader that is a program.
- A line in the index those programs read, and an entry in the feed.

\`\`\`bash
pnpm --filter site build
\`\`\`

Setting \`draft: true\` in the front matter takes all of that away again, which is what an
article that is not finished should do.
`;

/** The article files of a directory, sorted, so two listings can be compared. */
async function articlesIn(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
}

/** The articles the working copy publishes, read before this file has touched anything. */
const WORKING_COPY = await articlesIn(BLOG_SOURCE);

/** One article to write into `src/content/blog/` for the duration of a build. */
interface Article {
  readonly file: string;
  readonly body: string;
}

/**
 * The site, built with exactly `articles` in `src/content/blog/`, into an output directory and
 * a cache of its own. Returns everything it wrote, relative to that output directory.
 *
 * The working copy is moved aside first and put back by `clean()`, which every caller runs,
 * including the one whose build has just thrown.
 */
async function buildWith(articles: readonly Article[]): Promise<string[]> {
  await mkdir(PARKED, { recursive: true });
  for (const name of await articlesIn(BLOG_SOURCE)) {
    await rename(join(BLOG_SOURCE, name), join(PARKED, name));
  }
  try {
    for (const article of articles) {
      await writeFile(join(BLOG_SOURCE, article.file), article.body, 'utf8');
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pnpm', ['exec', 'astro', 'build', '--outDir', FIXTURE_OUT], {
        cwd: siteRoot,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          SITE_URL: process.env.SITE_URL ?? 'https://bookrail.dev',
          SITE_CACHE_DIR: FIXTURE_CACHE,
        },
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`the second build failed with code ${String(code)}`)),
      );
    });
    return await walk(FIXTURE_OUT);
  } catch (error) {
    await clean();
    throw error;
  }
}

/** The articles this file wrote, what the build made of them, and the cache: all of it goes. */
async function clean(): Promise<void> {
  for (const name of await articlesIn(BLOG_SOURCE)) {
    await rm(join(BLOG_SOURCE, name), { force: true });
  }
  for (const name of await articlesIn(PARKED).catch(() => [])) {
    await rename(join(PARKED, name), join(BLOG_SOURCE, name));
  }
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
}

const EM_DASH = String.fromCharCode(0x2014);

const files = await walk();

describe('with nothing published', () => {
  let out: string[] = [];

  const read = (file: string): Promise<string> => readFile(join(FIXTURE_OUT, file), 'utf8');

  beforeAll(async () => {
    out = await buildWith([]);
  }, 300_000);

  afterAll(clean);

  it('builds no blog directory, no index, no feed', () => {
    expect(out.filter((file) => file.startsWith('blog/'))).toEqual([]);
  });

  it('links the blog from no page at all', async () => {
    const linking: string[] = [];
    for (const file of out.filter((name) => name.endsWith('.html'))) {
      if ((await read(file)).includes('/blog/')) linking.push(file);
    }
    expect(linking).toEqual([]);
  });

  it('gives the files for machines no blog section', async () => {
    for (const name of ['llms.txt', 'llms-full.txt']) {
      const text = await read(name);
      expect(text, name).not.toContain('## Blog');
      expect(text, name).not.toContain('/blog/');
    }
  });
});

describe('with one article published', () => {
  let out: string[] = [];
  let browser: Browser;

  const read = (file: string): Promise<string> => readFile(join(FIXTURE_OUT, file), 'utf8');

  beforeAll(async () => {
    out = await buildWith([{ file: FIXTURE_NAME, body: FIXTURE }]);
    browser = await chromium.launch({ channel: browserChannel });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await clean();
  });

  it('builds the index, the article, the twin and the feed', () => {
    for (const file of [
      'blog/index.html',
      `blog/${SLUG}/index.html`,
      `blog/${SLUG}.md`,
      'blog/feed.xml',
    ]) {
      expect(out, file).toContain(file);
    }
  });

  it('lists the article on the index, with its date and its description', async () => {
    const index = await read('blog/index.html');
    expect(index).toContain(`href="/blog/${SLUG}/"`);
    expect(index).toContain(TITLE);
    expect(index).toContain('14 September 2026');
    expect(index).toContain(DESCRIPTION);
    expect([...index.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
  });

  it('gives the article one title, the canonical URL of the site, and the author at the foot', async () => {
    const page = await read(`blog/${SLUG}/index.html`);
    expect(page).toContain(`<title>${TITLE}, Bookrail</title>`);
    expect([...page.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    expect(page).toContain(`<link rel="canonical" href="https://bookrail.dev/blog/${SLUG}/">`);
    expect(page).toContain(`<meta property="og:url" content="https://bookrail.dev/blog/${SLUG}/">`);
    expect(page).toContain(`<meta name="description" content="${DESCRIPTION}">`);
    expect(page).toContain(`<time datetime="2026-09-14T00:00:00Z">14 September 2026</time>`);
    expect(page).toContain(`Written by ${AUTHOR}.`);
    // The body of the article, rendered: a list, a link and a code block.
    expect(page).toContain('href="/docs/"');
    expect(page).toContain('pnpm --filter site build');
  });

  it('advertises the feed from the pages of the blog, and from nowhere else', async () => {
    const feedLink =
      '<link rel="alternate" type="application/atom+xml" title="Bookrail blog" href="/blog/feed.xml">';
    expect(await read('blog/index.html')).toContain(feedLink);
    expect(await read(`blog/${SLUG}/index.html`)).toContain(feedLink);
    for (const file of ['index.html', 'early-access/index.html', 'docs/index.html']) {
      expect(await read(file), file).not.toContain('atom+xml');
    }
  });

  it('puts the blog in the header, the footer and the header of the documentation', async () => {
    // A page outside the documentation carries the header and the footer, so two links.
    for (const file of ['index.html', 'early-access/index.html']) {
      const html = await read(file);
      expect([...html.matchAll(/href="\/blog\/"/g)].length, file).toBe(2);
    }
    // Starlight has its own shell, and it prints the header links twice: once in the header
    // and once in the panel the menu opens on a phone.
    for (const file of ['docs/index.html', 'docs/errors/index.html']) {
      const html = await read(file);
      expect([...html.matchAll(/href="\/blog\/"/g)].length, file).toBe(2);
    }
  });

  it('serves the article as markdown at the same address with .md on the end', async () => {
    const twin = await read(`blog/${SLUG}.md`);
    expect(twin.startsWith(`# ${TITLE}\n`)).toBe(true);
    expect(twin).toContain('[the documentation](/docs/)');
    expect(twin).not.toContain('---\ntitle:');
  });

  it('adds a blog section to the files the agents read', async () => {
    const llms = await read('llms.txt');
    expect(llms).toContain('## Blog');
    expect(llms).toContain(`- [${TITLE}](https://bookrail.dev/blog/${SLUG}.md): ${DESCRIPTION}`);
    const full = await read('llms-full.txt');
    expect(full).toContain(`Source: https://bookrail.dev/blog/${SLUG}/`);
    expect(full).toContain('An article on this site is one markdown file.');
  });

  it('writes a feed a parser accepts, with one entry for the article', async () => {
    const xml = await read('blog/feed.xml');
    const context = await browser.newContext();
    const tab = await context.newPage();
    const parsed = await tab.evaluate((source: string) => {
      const document_ = new DOMParser().parseFromString(source, 'application/xml');
      const error = document_.querySelector('parsererror');
      return {
        error: error === null ? '' : (error.textContent ?? 'invalid'),
        root: document_.documentElement.nodeName,
        namespace: document_.documentElement.namespaceURI ?? '',
        title: document_.querySelector('feed > title')?.textContent ?? '',
        self: document_.querySelector('feed > link[rel="self"]')?.getAttribute('href') ?? '',
        updated: document_.querySelector('feed > updated')?.textContent ?? '',
        entries: [...document_.querySelectorAll('entry')].map((entry) => ({
          title: entry.querySelector('title')?.textContent ?? '',
          id: entry.querySelector('id')?.textContent ?? '',
          link: entry.querySelector('link')?.getAttribute('href') ?? '',
          author: entry.querySelector('author > name')?.textContent ?? '',
          summary: entry.querySelector('summary')?.textContent ?? '',
          updated: entry.querySelector('updated')?.textContent ?? '',
        })),
      };
    }, xml);
    await context.close();

    expect(parsed.error).toBe('');
    expect(parsed.root).toBe('feed');
    expect(parsed.namespace).toBe('http://www.w3.org/2005/Atom');
    expect(parsed.title).toBe('Bookrail blog');
    expect(parsed.self).toBe('https://bookrail.dev/blog/feed.xml');
    expect(parsed.updated).toBe('2026-09-14T00:00:00Z');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({
      title: TITLE,
      id: `https://bookrail.dev/blog/${SLUG}/`,
      link: `https://bookrail.dev/blog/${SLUG}/`,
      author: AUTHOR,
      summary: DESCRIPTION,
      updated: '2026-09-14T00:00:00Z',
    });
  });

  it('holds the pages of the blog to the house rules', async () => {
    for (const file of out.filter(
      (name) => name.startsWith('blog/') && (name.endsWith('.html') || name.endsWith('.md')),
    )) {
      const text = await read(file);
      expect(text, file).not.toContain(EM_DASH);
      expect(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.test(text), file).toBe(
        false,
      );
    }
    const page = await read(`blog/${SLUG}/index.html`);
    expect(page).toMatch(/<html[^>]*lang="en"/);
    expect(page).toContain('href="/privacy"');
    expect(page).toContain('href="/legal"');
  });
});

describe('the code block of an article', () => {
  /**
   * Nobody renders a fenced code block twice on this site: the component that renders one in
   * the documentation renders the one in an article too. It paints itself from variables the
   * documentation's shell declares and this shell has to declare as well, so the two
   * declarations are compared here rather than left to be noticed by a reader.
   */
  const declarations = async (file: string): Promise<Map<string, string>> => {
    const css = await readFile(join(siteRoot, 'src', 'styles', file), 'utf8');
    return new Map(
      [...css.matchAll(/(--sl-[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
        match[1] ?? '',
        (match[2] ?? '').trim(),
      ]),
    );
  };

  it('is given the same values the documentation gives it', async () => {
    const here = await declarations('site.css');
    const documentation = await declarations('starlight.css');
    expect(here.size).toBeGreaterThan(0);
    const different = [...here].filter(
      ([name, value]) => documentation.has(name) && documentation.get(name) !== value,
    );
    expect(different).toEqual([]);
  });

  it('is given every value it asks for', async () => {
    const stylesheet = files.find((file) => /^_astro\/ec\..*\.css$/.test(file));
    expect(stylesheet, 'the stylesheet of the code block component').toBeDefined();
    const css = await readFile(join(distRoot, stylesheet ?? ''), 'utf8');
    const asked = new Set(
      [...css.matchAll(/var\((--sl-[a-z0-9-]+)/g)].map((match) => match[1] ?? ''),
    );
    const here = await declarations('site.css');
    expect(asked.size).toBeGreaterThan(0);
    expect([...asked].filter((name) => !here.has(name))).toEqual([]);
  });
});

describe('with only a draft', () => {
  it('is the empty state again: no page, no listing, no feed, no line for the agents', async () => {
    try {
      const out = await buildWith([
        { file: FIXTURE_NAME, body: FIXTURE.replace('draft: false', 'draft: true') },
      ]);
      expect(out.filter((file) => file.startsWith('blog/'))).toEqual([]);
      const home = await readFile(join(FIXTURE_OUT, 'index.html'), 'utf8');
      expect(home).not.toContain('/blog/');
      expect(await readFile(join(FIXTURE_OUT, 'llms.txt'), 'utf8')).not.toContain('## Blog');
    } finally {
      await clean();
    }
  }, 300_000);
});

/**
 * What the working copy publishes today, in the `dist` a deploy would upload.
 *
 * Read from the directory rather than listed here, so that publishing an article is one file
 * and nothing else, and so that this check cannot quietly stop covering the article it was
 * written for.
 */
describe('the articles this working copy publishes', () => {
  const read = (file: string): Promise<string> => readFile(join(distRoot, file), 'utf8');
  const slugs = WORKING_COPY.map((name) => name.replace(/\.md$/, ''));

  it('has at least one, and the section is built', () => {
    expect(slugs.length).toBeGreaterThan(0);
    for (const file of ['blog/index.html', 'blog/feed.xml']) expect(files, file).toContain(file);
  });

  it.each(slugs)(
    '/blog/%s/ has a page, a twin, a line on the index and an entry in the feed',
    async (slug) => {
      for (const file of [`blog/${slug}/index.html`, `blog/${slug}.md`]) {
        expect(files, file).toContain(file);
      }
      const page = await read(`blog/${slug}/index.html`);
      expect(page).toContain(`<link rel="canonical" href="https://bookrail.dev/blog/${slug}/">`);
      expect([...page.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
      expect(page, 'the house rule on the em dash').not.toContain(EM_DASH);
      expect(await read('blog/index.html')).toContain(`href="/blog/${slug}/"`);
      expect(await read('blog/feed.xml')).toContain(`https://bookrail.dev/blog/${slug}/`);
      expect(await read('llms.txt')).toContain(`https://bookrail.dev/blog/${slug}.md`);
    },
  );

  it('links the blog from the header and the footer, documentation included', async () => {
    for (const file of ['index.html', 'early-access/index.html', 'docs/index.html']) {
      expect([...(await read(file)).matchAll(/href="\/blog\/"/g)].length, file).toBe(2);
    }
  });
});

describe('the working copy', () => {
  it('is left with exactly the articles this file found in it, and none of its own', async () => {
    const now = await articlesIn(BLOG_SOURCE);
    expect(now).toEqual(WORKING_COPY);
    expect(now).not.toContain(FIXTURE_NAME);
  });
});
