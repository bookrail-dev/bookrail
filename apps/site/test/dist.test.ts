/**
 * What a deploy would upload, checked as a whole.
 *
 * These are the things a reader notices before anything else: a link that goes nowhere, a page
 * with two titles or none, an image without a description, a character the founder banned, a
 * request leaving for a third party, and a homepage that takes too long to arrive.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distRoot, serveDist, walk } from './helpers.js';

const files = await walk();
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const textFiles = files.filter(
  (file) =>
    !file.startsWith('pagefind/') &&
    (file.endsWith('.html') || file.endsWith('.md') || file.endsWith('.txt')),
);

const read = (file: string): Promise<string> => readFile(join(distRoot, file), 'utf8');

/** `/docs/errors/` and `/docs/errors` and `/docs/errors.md` all have to resolve on nginx. */
function resolves(pathname: string): boolean {
  const clean = pathname.replace(/^\//, '').replace(/\/$/, '');
  if (clean === '') return files.includes('index.html');
  return (
    files.includes(clean) ||
    files.includes(`${clean}/index.html`) ||
    files.includes(`${clean}.html`)
  );
}

describe('links', () => {
  it('every internal href points at a file in dist', async () => {
    const broken: string[] = [];
    for (const file of htmlFiles) {
      const html = await read(file);
      for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const target = match[1] ?? '';
        if (!target.startsWith('/')) continue;
        const pathname = (target.split('#')[0] ?? '').split('?')[0] ?? '';
        if (pathname === '') continue;
        if (!resolves(pathname)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every internal link in a markdown twin points at a file in dist', async () => {
    const broken: string[] = [];
    for (const file of files.filter((name) => name.endsWith('.md'))) {
      const markdown = await read(file);
      for (const match of markdown.matchAll(/\]\((\/[^)]*)\)/g)) {
        const pathname = (match[1] ?? '').split('#')[0] ?? '';
        if (!resolves(pathname)) broken.push(`${file} -> ${match[1] ?? ''}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

/** Assembled from its code point, so that this file is not itself an occurrence of it. */
const EM_DASH = String.fromCharCode(0x2014);

describe('the house rules', () => {
  it('has no em dash anywhere a reader can see it', async () => {
    const guilty: string[] = [];
    for (const file of textFiles) {
      const text = await read(file);
      if (text.includes(EM_DASH)) {
        const line = text.split('\n').find((candidate) => candidate.includes(EM_DASH)) ?? '';
        guilty.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(guilty).toEqual([]);
  });

  it('has no emoji in the pages it writes itself', async () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u;
    for (const file of ['index.html', 'early-access/index.html', 'docs/index.html']) {
      expect(emoji.test(await read(file)), file).toBe(false);
    }
  });

  it('uses no gradient, no glass and no coloured shadow in its own stylesheets', async () => {
    for (const file of [
      'src/styles/site.css',
      'src/styles/tokens.css',
      'src/styles/starlight.css',
    ]) {
      const css = await readFile(join(distRoot, '..', file), 'utf8');
      expect(css, file).not.toMatch(/backdrop-filter/);
      // The one gradient is the hatch of a blocked resource and the hairline of a lane, both
      // flat two colour repeats rather than a fade.
      const gradients = [...css.matchAll(/(linear|radial|conic)-gradient/g)].length;
      expect(gradients, file).toBeLessThanOrEqual(2);
      expect(css, file).not.toMatch(/box-shadow:\s*[^;]*rgb/);
    }
  });
});

describe('accessibility basics', () => {
  it('gives every page exactly one h1', async () => {
    const wrong: string[] = [];
    for (const file of htmlFiles) {
      if (file === '404.html') continue;
      const count = [...(await read(file)).matchAll(/<h1[\s>]/g)].length;
      if (count !== 1) wrong.push(`${file}: ${String(count)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('gives every img an alt attribute', async () => {
    const wrong: string[] = [];
    for (const file of htmlFiles) {
      for (const match of (await read(file)).matchAll(/<img\b[^>]*>/g)) {
        // A bare `alt` is `alt=""`, which is the right answer for the logo mark: the site name
        // is the text next to it, and a screen reader that says it twice is worse.
        if (!/\balt(?:=|[\s>])/.test(match[0])) wrong.push(`${file}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('labels the decorative svg of the logo and the picture the grid makes', async () => {
    const home = await read('index.html');
    expect(home).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(home).toMatch(/role="img"[^>]*aria-label="[^"]{40,}"/);
  });

  it('declares the language and a description on every page', async () => {
    for (const file of htmlFiles) {
      const html = await read(file);
      expect(html, file).toMatch(/<html[^>]*lang="en"/);
      expect(html, file).toMatch(/<meta name="description"/);
    }
  });
});

describe('no third party', () => {
  it('asks nothing of any host but the editorial links the report lists', async () => {
    const allowed = [
      'https://bookrail.dev',
      'https://api.bookrail.dev',
      'https://www.w3.org', // SVG namespaces
      'http://www.w3.org',
      'https://json-schema.org',
      'https://spec.openapis.org',
      'https://opensource.org',
      'https://github.com',
      'https://www.npmjs.com',
      'https://example.com',
      'https://scripts.sil.org',
      // Printed by the API reference: the `servers` block of the specification. They are text
      // on a page, not a request.
      'https://api.bookrail.dev',
      'http://localhost',
      'http://127.0.0.1',
    ];
    const found = new Set<string>();
    for (const file of htmlFiles) {
      for (const match of (await read(file)).matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
        found.add((match[0] ?? '').toLowerCase());
      }
    }
    const unexpected = [...found].filter(
      (origin) => !allowed.some((prefix) => origin.startsWith(prefix)),
    );
    expect(unexpected).toEqual([]);
  });

  it('loads no font, script or stylesheet from outside the site', async () => {
    for (const file of htmlFiles) {
      const html = await read(file);
      // A canonical or an `og:url` is metadata, not a fetch; a script, a stylesheet, a
      // preload or a preconnect is a request, and none of them may leave.
      expect(html, file).not.toMatch(/<script[^>]+src="https?:\/\//);
      expect(html, file).not.toMatch(
        /<link[^>]+rel="(?:stylesheet|preload|preconnect|dns-prefetch)"[^>]*href="https?:\/\//,
      );
      expect(html, file).not.toMatch(
        /<link[^>]+href="https?:\/\/[^"]*"[^>]*rel="(?:stylesheet|preload|preconnect|dns-prefetch)"/,
      );
      expect(html, file).not.toMatch(/@import\s+url\(["']?https?:/);
    }
  });
});

describe('the homepage budget', () => {
  it('arrives in under 150 KB before the fonts', async () => {
    const html = await read('index.html');
    const assets = [...html.matchAll(/(?:href|src)="(\/_astro\/[^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    let total = Buffer.byteLength(html);
    for (const asset of assets) total += (await stat(join(distRoot, asset))).size;
    expect(assets.length).toBeGreaterThan(0);
    expect(
      total,
      `${String(total)} bytes over ${String(assets.length)} assets plus the document`,
    ).toBeLessThan(150 * 1024);
  });

  it('keeps the fonts under 200 KB in total', async () => {
    let total = 0;
    for (const file of files.filter((name) => name.endsWith('.woff2'))) {
      total += (await stat(join(distRoot, file))).size;
    }
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(200 * 1024);
  });

  it('ships no JavaScript on the homepage beyond Lenis and the two animated components', async () => {
    const html = await read('index.html');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(scripts).toHaveLength(1);
    const bundle = await read(scripts[0]?.replace(/^\//, '') ?? '');
    expect(bundle).toContain('lerp');
    expect([...html.matchAll(/<script(?![^>]*src=)[^>]*>/g)]).toHaveLength(0);
  });
});

describe('the pages the company owes a visitor', () => {
  it.each(['privacy/index.html', 'legal/index.html'])('%s exists', (file) => {
    expect(files, file).toContain(file);
  });

  it('answers 200 on /privacy and /legal, the way nginx will serve them', async () => {
    const server = await serveDist();
    try {
      for (const path of ['/privacy', '/legal', '/privacy/', '/legal/']) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.status, path).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it('carries the company details article 2250 asks for, and nothing it must not', async () => {
    const legal = await read('legal/index.html');
    for (const fact of [
      'MP Informatica Srl',
      'Strada di Santa Bona Nuova 33/B',
      '31100 Treviso',
      '05355370262',
      'TV-437915',
      '10,000 EUR, fully paid up',
      'hello@bookrail.dev',
    ]) {
      expect(legal, fact).toContain(fact);
    }
    // The company is not a single member company, and the PEC is deliberately not published.
    expect(legal.toLowerCase()).not.toContain('socio unico');
    expect(legal.toLowerCase()).not.toContain('single member');
    expect(legal.toLowerCase()).not.toMatch(/\bpec\b|@pec\./);
    // No telephone number either. Article 2250 does not require one, it is a direct line to a
    // person rather than to a company, and the email address above is the contact this project
    // answers on. It was published here once and has been taken down; this is what keeps it
    // down, and the secret scanner refuses the same number everywhere in the repository.
    expect(legal).not.toMatch(/\b0422\b/);
  });

  it('says on /privacy exactly what this site does, which is a log line and nothing else', async () => {
    const privacy = await read('privacy/index.html');
    expect(privacy).toContain('MP Informatica Srl');
    expect(privacy).toContain('14 days');
    expect(privacy).toContain('6(1)(f)');
    expect(privacy).toContain('Garante');
    expect(privacy).toContain('no cookie');
  });

  it('links privacy and legal from every page, documentation and API reference included', async () => {
    const missing: string[] = [];
    for (const file of htmlFiles) {
      const html = await read(file);
      if (!html.includes('href="/privacy"') || !html.includes('href="/legal"')) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});

describe('the figures', () => {
  it('gives every inline figure a title, a description and a caption', async () => {
    const withFigures = ['docs/concepts/index.html'];
    for (const file of withFigures) {
      const html = await read(file);
      const svgs = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].filter((match) =>
        (match[0] ?? '').includes('role="img"'),
      );
      expect(svgs.length, file).toBeGreaterThanOrEqual(4);
      for (const svg of svgs) {
        expect(svg[0], file).toMatch(/aria-labelledby="[^"]+"/);
        expect(svg[0], file).toMatch(/<title id="/);
        expect(svg[0], file).toMatch(/<desc id="/);
      }
      expect([...html.matchAll(/<figcaption/g)].length, file).toBeGreaterThanOrEqual(4);
    }
  });

  it('paints them from the tokens, never from a literal colour', async () => {
    const css = await readFile(join(distRoot, '..', 'src/styles/figures.css'), 'utf8');
    // Every fill and stroke is a token. The only literal allowed is `none`.
    const literals = [...css.matchAll(/(?:fill|stroke):\s*(#[0-9a-f]{3,8}|rgb)/gi)];
    expect(literals.map((match) => match[0])).toEqual([]);
    const home = await read('docs/concepts/index.html');
    expect(home).not.toMatch(/<svg[^>]*>[\s\S]{0,4000}?(fill|stroke)="#/);
  });
});

describe('the files the agents are promised', () => {
  it.each([
    'llms.txt',
    'llms-full.txt',
    'openapi.json',
    'mcp/tools.json',
    'favicon.svg',
    'og.png',
    'apple-touch-icon.png',
    'fonts/bricolage-grotesque-OFL.txt',
    'fonts/jetbrains-mono-OFL.txt',
  ])('%s exists', (file) => {
    expect(files, file).toContain(file);
  });

  it('ships the font licences next to the fonts', async () => {
    const licence = await read('fonts/bricolage-grotesque-OFL.txt');
    expect(licence).toContain('SIL Open Font License');
  });
});
