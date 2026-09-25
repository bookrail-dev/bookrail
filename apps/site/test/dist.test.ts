/**
 * What a deploy would upload, checked as a whole.
 *
 * These are the things a reader notices before anything else: a link that goes nowhere, a page
 * with two titles or none, an image without a description, a character the founder banned, a
 * request leaving for a third party, and a homepage that takes too long to arrive.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { distFingerprint, distRoot, serveDist, siteRoot, walk } from './helpers.js';
import { FIXTURE_LEGAL_DIR, legalCopy } from './legal-copy.js';
import { readLegalTexts, renderLegalText } from '../scripts/generate.mjs';

const files = await walk();
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const textFiles = files.filter(
  (file) =>
    !file.startsWith('pagefind/') &&
    (file.endsWith('.html') || file.endsWith('.md') || file.endsWith('.txt')),
);

const read = (file: string): Promise<string> => readFile(join(distRoot, file), 'utf8');

/** The bundles a page loads, and every module those import one level down. */
async function scriptsOf(file: string): Promise<string[]> {
  const html = await read(file);
  const sources = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1] ?? '');
  const bundles: string[] = [];
  for (const source of sources) bundles.push(await read(source.replace(/^\//, '')));
  // And every module those import, one level down, which is where the shared code ends up.
  for (const bundle of [...bundles]) {
    for (const match of bundle.matchAll(/from\s*"(\.\/[^"]+\.js)"/g)) {
      bundles.push(await read(`_astro/${(match[1] ?? '').replace(/^\.\//, '')}`));
    }
  }
  return bundles;
}

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

  /**
   * A placeholder that survives a build becomes a sentence on a public page.
   *
   * `DEPLOY_DATE_021` did, and was replaced by hand because somebody remembered. The allow list is
   * the way to keep that from being a matter of memory: a placeholder is legal only while it is
   * written down, and a line that names a placeholder no longer in the build fails too, so the
   * list cannot outlive the thing it excuses.
   */
  it('ships no unreplaced deploy date placeholder', async () => {
    const allowed = (await readFile(join(siteRoot, 'test', 'pending-placeholders.txt'), 'utf8'))
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line !== '');
    const found = new Map<string, string[]>();
    for (const file of textFiles) {
      for (const match of (await read(file)).matchAll(/DEPLOY_DATE_[A-Za-z0-9_]*/g)) {
        found.set(match[0], [...(found.get(match[0]) ?? []), file]);
      }
    }
    // Nothing in the build that the list does not excuse, with the files named when it fails.
    expect(
      [...found]
        .filter(([name]) => !allowed.includes(name))
        .map(([name, where]) => `${name} in ${where.join(', ')}`),
    ).toEqual([]);
    // And nothing on the list that the build no longer has.
    expect(allowed.filter((name) => !found.has(name))).toEqual([]);
  });

  it('has no emoji in the pages it writes itself', async () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u;
    for (const file of ['index.html', 'index.md', 'pricing/index.html', 'docs/index.html']) {
      expect(emoji.test(await read(file)), file).toBe(false);
    }
  });

  it('uses no gradient, no glass and no coloured shadow in its own stylesheets', async () => {
    for (const file of [
      'src/styles/site.css',
      'src/styles/figures.css',
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
      // No shadow at all on the site's own surfaces, coloured or not.
      expect(css, file).not.toMatch(/box-shadow:\s*(?!\s|none)[^;]+;/);
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
      // Printed by the API reference and by the Stripe guide: the shape of the authorisation
      // URL that `POST /v1/stripe/connect` returns. It is an example in the specification and a
      // sentence in a guide, never a link the page follows, and the test below proves that no
      // script, stylesheet or font is loaded from it.
      'https://connect.stripe.com',
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

  /**
   * The homepage of 25 September 2026 may weigh up to twice the 50.5 KB of the first one, fonts
   * excluded, and it still ships one JavaScript file.
   */
  it('stays within twice the weight of the first homepage, fonts excluded', async () => {
    const html = await read('index.html');
    const assets = [...html.matchAll(/(?:href|src)="(\/_astro\/[^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    let total = Buffer.byteLength(html);
    for (const asset of assets) total += (await stat(join(distRoot, asset))).size;
    expect(total, `${String(total)} bytes`).toBeLessThanOrEqual(2 * 50.5 * 1024);
  });

  it('ships one JavaScript file on the homepage: Lenis, the motion, the tabs and the header', async () => {
    const html = await read('index.html');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(scripts).toHaveLength(1);
    const bundle = await read((scripts[0] ?? '').replace(/^\//, ''));
    // One file, not one file and the modules it imports.
    expect(bundle).not.toMatch(/from\s*"\.\//);
    expect(bundle).not.toMatch(/import\s*\(/);
    expect(bundle, 'Lenis').toContain('lerp');
    expect(bundle, 'the tabs').toContain('aria-selected');
    expect(bundle, 'the header').toContain('data-session-link');
    expect(bundle, 'the menu').toContain('aria-expanded');
    // It reads the tab's storage and calls nobody.
    expect(bundle).not.toMatch(/fetch\(/);
    expect([...html.matchAll(/<script(?![^>]*src=)[^>]*>/g)]).toHaveLength(0);
  });

  it('gives every other page the header in a file of its own, small, calling nobody', async () => {
    const html = await read('pricing/index.html');
    const bundles = await scriptsOf('pricing/index.html');
    const nav = bundles.find((bundle) => bundle.includes('data-session-link')) ?? '';
    expect(nav, 'the header script').not.toBe('');
    expect(nav).not.toMatch(/fetch\(/);
    expect(nav).not.toContain('lerp');
    expect(Buffer.byteLength(nav)).toBeLessThan(2048);
    expect(html).toContain('data-session-key="bookrail.dashboard.session"');
  });
});

describe('the homepage', () => {
  it('has its eleven sections, in order', async () => {
    const html = await read('index.html');
    const order = [
      'class="hero"',
      'id="product"',
      'id="demo"',
      'id="code"',
      'id="templates"',
      'id="agents"',
      'class="price-band"',
      'class="block community"',
      'class="oss"',
      'class="block closing"',
      'class="site-footer"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('marks up its two tablists: every tab controls a panel that names it back', async () => {
    const html = await read('index.html');
    const lists = [...html.matchAll(/role="tablist"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(lists).toEqual(['Product demo', 'Ways to call Bookrail']);
    const tabs = [...html.matchAll(/<a[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
    expect(tabs).toHaveLength(7);
    for (const tab of tabs) {
      const id = /\bid="([^"]+)"/.exec(tab)?.[1] ?? '';
      const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1] ?? '';
      const href = /href="([^"]+)"/.exec(tab)?.[1] ?? '';
      expect(tab).toMatch(/aria-selected="(true|false)"/);
      // Without JavaScript a tab is a link to its own panel.
      expect(href).toBe(`#${controls}`);
      const panel = new RegExp(`<div[^>]*role="tabpanel"[^>]*id="${controls}"[^>]*>`).exec(
        html,
      )?.[0];
      expect(panel, controls).toBeDefined();
      expect(panel).toContain(`aria-labelledby="${id}"`);
    }
    // One selected tab per list, and no panel hidden before the script runs.
    expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(2);
    expect(html).not.toMatch(/role="tabpanel"[^>]*hidden/);
  });

  it('has a menu button for small screens that says what it controls', async () => {
    const html = await read('index.html');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="nav-panel"/);
    expect(html).toContain('id="nav-panel"');
  });

  it('shows no star count, no customer logo and no embed from GitHub', async () => {
    const html = await read('index.html');
    expect(html).not.toMatch(/stargazers|api\.github\.com|<iframe/);
    expect(html).toContain('href="https://github.com/bookrail-dev/bookrail/discussions"');
  });

  it('carries the GitHub mark inline, in the colour of the link, on the site and in the docs', async () => {
    for (const file of ['index.html', 'pricing/index.html', 'docs/errors/index.html']) {
      const html = await read(file);
      const link =
        /<a[^>]*href="https:\/\/github\.com\/bookrail-dev\/bookrail"[^>]*>\s*<svg[^>]*>/.exec(
          html,
        )?.[0];
      expect(link, file).toBeDefined();
      expect(link, file).toContain('gh-mark');
      expect(link, file).toContain('fill="currentColor"');
      expect(link, file).toContain('aria-hidden="true"');
    }
  });

  it('keeps its markdown twin next to it', async () => {
    const twin = await read('index.md');
    expect(twin.startsWith('# Bookrail\n')).toBe(true);
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

  it('says on /privacy what the sign up stores, and for how long', async () => {
    const privacy = await read('privacy/index.html');
    expect(privacy).toContain('When you sign up');
    expect(privacy).toContain('6(1)(b)');
    expect(privacy).toContain('Hostinger');
    expect(privacy).toContain('7 days');
    // The address of the caller is hashed, never written down as such, and the page says so.
    expect(privacy).toContain('hash');
  });

  it('says on /privacy exactly what this site does, which is a log line and nothing else', async () => {
    const privacy = await read('privacy/index.html');
    expect(privacy).toContain('MP Informatica Srl');
    expect(privacy).toContain('14 days');
    expect(privacy).toContain('6(1)(f)');
    expect(privacy).toContain('Garante');
    expect(privacy).toContain('no cookie');
  });

  it('links privacy, legal, the terms and the DPA from every page, documentation and API reference included', async () => {
    const missing: string[] = [];
    for (const file of htmlFiles) {
      const html = await read(file);
      for (const href of ['/privacy', '/legal', '/terms', '/dpa']) {
        if (!html.includes(`href="${href}"`)) missing.push(`${file} ${href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('says on /legal where the terms are, and no longer that there are none', async () => {
    const legal = await read('legal/index.html');
    expect(legal).toContain('href="/terms"');
    expect(legal).toContain('href="/dpa"');
    expect(legal).not.toContain('There are none yet');
  });

  it('says on /privacy what a paid plan stores, and for how long', async () => {
    const privacy = await read('privacy/index.html');
    expect(privacy).toContain('When you buy a paid plan');
    expect(privacy).toContain('6(1)(c)');
    expect(privacy).toContain('ten years');
    expect(privacy).toContain('Stripe');
  });
});

/**
 * `/terms` and `/dpa`: the two texts a key and a paid plan are issued under, read at build time
 * from their source, and never published as a draft.
 */
describe('the terms and the DPA', () => {
  it.each(['terms/index.html', 'dpa/index.html'])('%s exists and answers 200', async (file) => {
    expect(files, file).toContain(file);
    const server = await serveDist();
    try {
      const response = await fetch(`${server.origin}/${file.replace('/index.html', '')}`);
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('prints the title, the version and the date, and the text without the notes for its authors', async () => {
    const legal = process.env.BOOKRAIL_LEGAL_DIR ?? legalCopy('approved');
    for (const [file, source] of [
      ['terms/index.html', 'terms-of-service.md'],
      ['dpa/index.html', 'data-processing-agreement.md'],
    ] as const) {
      const html = await read(file);
      const text = readFileSync(join(legal, source), 'utf8');
      const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
      const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
      expect(html, file).toContain(`data-legal-version="${version}"`);
      expect(html, file).toContain(`<h1>${title}</h1>`);
      expect([...html.matchAll(/<h1[\s>]/g)], file).toHaveLength(1);
      expect(html, file).not.toContain('<!--');
    }
    // The clauses approved one by one have the anchor the sign up links to.
    expect(await read('terms/index.html')).toContain('id="17-specific-approval"');
  });

  /** `node scripts/generate.mjs`, the first step of the build, with the legal texts of `dir`. */
  function generate(dir: string): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/generate.mjs'], {
        cwd: siteRoot,
        env: { ...process.env, BOOKRAIL_LEGAL_DIR: dir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  // The refusals below remove the generated pages, as they must: they are put back for the
  // files that build again after this one.
  afterAll(async () => {
    const restored = await generate(process.env.BOOKRAIL_LEGAL_DIR ?? legalCopy('approved'));
    expect(restored.code).toBe(0);
  }, 120_000);

  it('refuses to build with a draft, before it has written anything, and leaves no page behind', async () => {
    expect(existsSync(join(siteRoot, 'src', 'generated', 'legal', 'terms.md'))).toBe(true);
    const result = await generate(legalCopy('draft'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[site] refusing to build');
    expect(result.stderr).toContain('status: draft');
    // What an earlier run generated from an approved copy is gone.
    expect(existsSync(join(siteRoot, 'src', 'generated', 'legal'))).toBe(false);
  });

  it('never renders a page left behind from a source other than the one of the build', async () => {
    // A page generated from some other approved copy, as a test leaves behind: the build of
    // this directory, with the texts of the suite, refuses it.
    const elsewhere = legalCopy('approved');
    const generated = join(siteRoot, 'src', 'generated', 'legal');
    await mkdir(generated, { recursive: true });
    for (const text of await readLegalTexts(elsewhere)) {
      await writeFile(join(generated, `${text.slug}.md`), renderLegalText(text), 'utf8');
    }
    const out = mkdtempSync(join(tmpdir(), 'bookrail-legal-left-'));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn('pnpm', ['exec', 'astro', 'build', '--outDir', out], {
        cwd: siteRoot,
        env: { ...process.env, SITE_CACHE_DIR: join(out, '.cache') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the generated page does not come from');
  }, 180_000);

  it('refuses to build without the texts at all', async () => {
    const result = await generate(mkdtempSync(join(tmpdir(), 'bookrail-legal-none-')));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is missing');
  });

  it('never writes dist, the directory that is published: the suite builds elsewhere', async () => {
    const before = process.env.BOOKRAIL_SITE_DIST_BEFORE;
    expect(before).toBeDefined();
    expect(distRoot.endsWith('dist-test')).toBe(true);
    expect(await distFingerprint()).toBe(before);
    // And the build of the suite, with its copy of the texts, is where the suite says it is.
    expect(await readFile(join(distRoot, 'terms', 'index.html'), 'utf8')).toContain(
      'data-legal-version',
    );
  });

  it('takes a draft, or the fixtures, only for what publishes nothing (--preview-legal)', async () => {
    const drafts = await readLegalTexts(legalCopy('draft'), { preview: true });
    expect(drafts.map((text) => (text.front as Record<string, string>).status)).toEqual([
      'draft',
      'draft',
    ]);
    const none = join(tmpdir(), 'bookrail-legal-absent-directory');
    const fixtures = await readLegalTexts(none, { preview: true });
    expect(fixtures.map((text) => (text.front as Record<string, string>).version)).toEqual([
      '2026-01-01-fixture',
      '2026-01-01-fixture',
    ]);
    expect(FIXTURE_LEGAL_DIR).toContain(join('test', 'fixtures', 'legal'));
    // Without the flag the same drafts are refused, which is what `build` does.
    await expect(readLegalTexts(legalCopy('draft'))).rejects.toThrow('status: draft');
    const scripts = JSON.parse(readFileSync(join(siteRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts.scripts.build).not.toContain('--preview-legal');
    expect(scripts.scripts.typecheck).toContain('--preview-legal');
  });
});

/**
 * The two pages of the sign up: the form and the page the link in the message lands on.
 *
 * They are the only pages of this site that talk to anything at run time, so what they are
 * checked for is exactly that: they exist, they are served the way nginx will serve them, they
 * talk to the API and to nothing else, and they set no cookie and store nothing in the browser.
 */
describe('the sign up pages', () => {
  it.each(['signup/index.html', 'signup/confirm/index.html'])('%s exists', (file) => {
    expect(files, file).toContain(file);
  });

  it('answers 200 on /signup and /signup/confirm, the way nginx will serve them', async () => {
    const server = await serveDist();
    try {
      for (const path of ['/signup', '/signup/', '/signup/confirm', '/signup/confirm/']) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.status, path).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it('has a form that posts to the API, and a button that says what it does', async () => {
    const page = await read('signup/index.html');
    const code = (await scriptsOf('signup/index.html')).join('\n');
    expect(page).toContain('id="signup-form"');
    expect(page).toContain('name="email"');
    expect(page).toContain('Send me a link');
    expect(code).toContain('/v1/signups');
    expect(page).toContain('data-api-url="https://api.bookrail.dev"');
    // Both keys, and where more of them are made: nobody is sent to a mailbox for a key.
    expect(page).toContain('sk_live_');
    expect(page).toContain('href="/dashboard/"');
  });

  it('asks for the two boxes of the terms, both required, with their links, and sends both', async () => {
    const page = await read('signup/index.html');
    const code = (await scriptsOf('signup/index.html')).join('\n');
    expect(page).toMatch(/<input[^>]*id="signup-accept-terms"[^>]*required/);
    expect(page).toMatch(/<input[^>]*id="signup-approve-clauses"[^>]*required/);
    expect(page).toContain('on behalf of my business');
    expect(page).toContain('Articles 1341 and 1342 of the Italian Civil Code');
    expect(page).toContain('href="/terms"');
    expect(page).toContain('href="/dpa"');
    expect(page).toContain('href="/terms#17-specific-approval"');
    expect(code).toContain('accept_terms');
    expect(code).toContain('approve_clauses');
  });

  it('reads the token from the fragment and offers to copy the key once', async () => {
    const html = await read('signup/confirm/index.html');
    const code = (await scriptsOf('signup/confirm/index.html')).join('\n');
    const page = `${html}\n${code}`;
    expect(code).toContain('location.hash');
    expect(code).toContain('/v1/signups/confirm');
    expect(html).toContain('>Copy<');
    expect(page).toContain('Your terminal has the keys');
    // The title follows the state: «Confirming» while it checks, then what happened.
    expect(html).toMatch(/<h1 id="confirm-title"[^>]*>Confirming<\/h1>/);
    for (const title of [
      'Your keys',
      'This address already has an account',
      'This link has expired',
      'This link has been used',
      'This link did not work',
    ]) {
      expect(code, title).toContain(title);
    }
    // Two keys, each with its own copy button, the Free plan in words, and the two ways on.
    expect(page).toContain('live_secret_key');
    expect(page).toContain('id="confirm-live-copy"');
    expect(page).toContain('Free plan');
    expect(page).toContain('Open dashboard');
    expect(page).toContain('Read the quickstart');
    // The three things that can go wrong, each with a sentence of its own.
    expect(page).toContain('email_taken');
    expect(page).toContain('signup_expired');
    expect(page).toContain('signup_already_confirmed');
  });

  it('keeps the key panel hidden until there is a key to show', async () => {
    // The panel is a grid, and a `display` on the class beats the `hidden` attribute unless
    // the stylesheet says otherwise. Without this rule the page showed two empty black boxes
    // when the terminal, not the browser, had received the key (seen on 11 September 2026).
    const page = await read('signup/confirm/index.html');
    expect(page).toMatch(/id="confirm-key"[^>]*\bhidden\b/);
    // Astro scopes the class as `.key-panel:where(.astro-xxx)[hidden]`.
    expect(page).toMatch(/\.key-panel[^{,]*\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('tells a reader without JavaScript what to run instead', async () => {
    for (const file of ['signup/index.html', 'signup/confirm/index.html']) {
      const page = await read(file);
      expect(page, file).toMatch(/<noscript>/);
      expect(page.slice(page.indexOf('<noscript>')), file).toContain('npx bookrail signup');
    }
  });

  it('runs no inline script: the server refuses them on these pages too', async () => {
    for (const file of ['signup/index.html', 'signup/confirm/index.html']) {
      const html = await read(file);
      expect([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)], file).toHaveLength(0);
      expect(html, file).not.toMatch(/\son[a-z]+="/);
    }
  });

  it('stores nothing in the browser and calls nobody else', async () => {
    for (const file of ['signup/index.html', 'signup/confirm/index.html']) {
      const bundles = await scriptsOf(file);
      // The header's script reads the tab's session to relabel «Sign in»; the sign up's own
      // scripts store nothing.
      const own = bundles.filter((bundle) => !bundle.includes('data-session-link'));
      const page = [await read(file), ...own].join('\n');
      expect(page, file).not.toMatch(/document\.cookie/);
      expect(page, file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      const origins = [...page.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((match) =>
        (match[0] ?? '').toLowerCase(),
      );
      const foreign = origins.filter(
        (origin) =>
          !origin.startsWith('https://bookrail.dev') &&
          !origin.startsWith('https://api.bookrail.dev') &&
          !origin.startsWith('http://www.w3.org') &&
          !origin.startsWith('https://www.w3.org') &&
          // The repository, linked from the header of every page: a link, never a
          // request, and `no third party` above proves nothing is loaded from it.
          origin !== 'https://github.com',
      );
      expect(foreign, file).toEqual([]);
    }
  });

  /**
   * The mailto that used to be the only way to a test key.
   *
   * The subject line is assembled from its parts rather than written out, the way every other
   * guardian in this repository spells the thing it is looking for: a test that contains the
   * string it forbids is itself the last occurrence of it, and makes a plain `grep` over the
   * tree answer "found" for ever.
   */
  it('no longer sends anybody to a mailbox for a test key', async () => {
    const gone = `subject=Bookrail%20early%20${['acce', 'ss'].join('')}`;
    const guilty: string[] = [];
    for (const file of textFiles) {
      if ((await read(file)).includes(gone)) guilty.push(file);
    }
    expect(guilty).toEqual([]);
  });
});

/**
 * The dashboard: a sign in page, the page the link lands on, and the account view.
 *
 * The server refuses inline scripts on these pages, so the first thing checked is that there are
 * none: a page with an inline script would work in this test and be blank in production. Then
 * what the bundled scripts may and may not touch: `sessionStorage` for the session, and never a
 * cookie, `localStorage` or another host.
 */
describe('the dashboard pages', () => {
  const PAGES = ['dashboard/index.html', 'dashboard/confirm/index.html'];

  it.each(PAGES)('%s exists', (file) => {
    expect(files, file).toContain(file);
  });

  it('answers 200 on /dashboard and /dashboard/confirm, the way nginx will serve them', async () => {
    const server = await serveDist();
    try {
      for (const path of ['/dashboard/', '/dashboard/confirm', '/dashboard/confirm/']) {
        const response = await fetch(`${server.origin}${path}`);
        expect(response.status, path).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it('has no inline script: only files of this site', async () => {
    for (const file of PAGES) {
      const html = await read(file);
      expect([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)], file).toHaveLength(0);
      expect(html, file).not.toMatch(/\son[a-z]+="/);
      const sources = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(sources.length, file).toBeGreaterThan(0);
      for (const source of sources) expect(source, file).toMatch(/^\/_astro\//);
    }
  });

  it('keeps the session in sessionStorage, and sets no cookie and nothing in localStorage', async () => {
    for (const file of PAGES) {
      const code = [await read(file), ...(await scriptsOf(file))].join('\n');
      expect(code, file).toContain('sessionStorage');
      expect(code, file).not.toMatch(/document\.cookie/);
      expect(code, file).not.toMatch(/localStorage|indexedDB/);
      const origins = [...code.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((match) =>
        (match[0] ?? '').toLowerCase(),
      );
      const foreign = origins.filter(
        (origin) =>
          !origin.startsWith('https://bookrail.dev') &&
          !origin.startsWith('https://api.bookrail.dev') &&
          !origin.startsWith('http://www.w3.org') &&
          !origin.startsWith('https://www.w3.org') &&
          // The repository, linked from the header of every page: a link, never a
          // request, and `no third party` above proves nothing is loaded from it.
          origin !== 'https://github.com',
      );
      expect(foreign, file).toEqual([]);
    }
  });

  it('reads the link from the fragment, takes it off the address bar, and talks to the API', async () => {
    const confirm = (await scriptsOf('dashboard/confirm/index.html')).join('\n');
    expect(confirm).toContain('location.hash');
    expect(confirm).toContain('replaceState');
    expect(confirm).toContain('/v1/dashboard/login/confirm');
    const dashboard = (await scriptsOf('dashboard/index.html')).join('\n');
    for (const path of ['/v1/dashboard/login', '/v1/dashboard/account', '/v1/dashboard/logout']) {
      expect(dashboard, path).toContain(path);
    }
    expect(await read('dashboard/index.html')).toContain('data-api-url="https://api.bookrail.dev"');
  });

  it('offers the two paid plans, the billing portal, and the two boxes of the terms before a checkout', async () => {
    const html = await read('dashboard/index.html');
    expect(html).toMatch(/<button[^>]*data-upgrade-plan="pro"[^>]*>\s*Upgrade to Pro/);
    expect(html).toMatch(/<button[^>]*data-upgrade-plan="scale"[^>]*>\s*Upgrade to Scale/);
    expect(html).toMatch(/<button[^>]*data-manage-billing[^>]*>\s*Manage billing/);
    expect(html).toContain('id="dash-past-due"');
    expect(html).toContain('id="upgrade-accept-terms"');
    expect(html).toContain('id="upgrade-approve-clauses"');
    expect(html).toContain('href="/terms#17-specific-approval"');
    expect(html).not.toMatch(/mailto:[^"]*upgrade/i);
    const dashboard = (await scriptsOf('dashboard/index.html')).join('\n');
    for (const path of ['/v1/dashboard/billing/checkout', '/v1/dashboard/billing/portal']) {
      expect(dashboard, path).toContain(path);
    }
  });
});

describe('the pages that are gone', () => {
  it('no longer builds an early access page: nginx sends it to /signup', () => {
    expect(files).not.toContain('early-access/index.html');
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
