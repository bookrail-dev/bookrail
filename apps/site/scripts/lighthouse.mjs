/**
 * Lighthouse over the built site, against the project thresholds.
 *
 * It is a command (`pnpm --filter site lighthouse`) rather than a case in the vitest suite for
 * one reason: a Lighthouse run is a measurement of a machine, not an assertion about the code.
 * It takes half a minute, it moves by a point or two between runs, and a red build caused by a
 * busy laptop teaches a team to ignore red builds. The thresholds are still enforced here, and
 * the numbers go in the report.
 *
 *   node scripts/lighthouse.mjs              # /, and /docs/errors/
 *   node scripts/lighthouse.mjs /docs/cli/   # any path
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(siteRoot, 'dist');

const THRESHOLDS = {
  performance: 90,
  accessibility: 95,
  'best-practices': 95,
  seo: 90,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml',
};

const server = createServer((request, response) => {
  void (async () => {
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    let file = join(distRoot, pathname);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      if (extname(pathname) === '') file = join(distRoot, pathname, 'index.html');
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // What nginx will send for a hashed asset, so the audit measures the real thing.
        'cache-control': pathname.startsWith('/_astro/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=600',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  })();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const chrome = await chromeLauncher.launch({
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
});

const paths = process.argv.slice(2);
const targets = paths.length > 0 ? paths : ['/', '/docs/errors/'];
let failed = false;

try {
  for (const path of targets) {
    const result = await lighthouse(
      `http://127.0.0.1:${port}${path}`,
      { port: chrome.port, output: 'json', logLevel: 'error' },
      undefined,
    );
    const categories = result.lhr.categories;
    const line = Object.entries(THRESHOLDS).map(([key, floor]) => {
      const score = Math.round((categories[key]?.score ?? 0) * 100);
      if (score < floor) failed = true;
      return `${categories[key]?.title ?? key} ${String(score)}${score < floor ? ` (under ${String(floor)})` : ''}`;
    });
    const metric = (id) => result.lhr.audits[id]?.displayValue ?? '';
    process.stdout.write(
      `${path.padEnd(16)} ${line.join('  ')}\n` +
        `${''.padEnd(16)} LCP ${metric('largest-contentful-paint')}  ` +
        `CLS ${metric('cumulative-layout-shift')}  TBT ${metric('total-blocking-time')}\n`,
    );
  }
} finally {
  chrome.kill();
  server.close();
}

if (failed) {
  process.stderr.write('[site] a Lighthouse category is under its threshold\n');
  process.exitCode = 1;
}
