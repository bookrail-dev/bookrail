import { createServer, type Server } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const siteRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, '');
export const distRoot = join(siteRoot, 'dist');
export const repoRoot = join(siteRoot, '..', '..');

/** Every file under `dist`, as paths relative to it. */
export async function walk(directory = distRoot, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(directory, entry.name), relative)));
    else out.push(relative);
  }
  return out;
}

const TYPES: Record<string, string> = {
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

/**
 * The `dist` directory over HTTP, the way nginx will serve it.
 *
 * A local server rather than `file://` because a page opened from the file system resolves
 * root relative links against the file system root, which is precisely the class of bug these
 * tests exist to catch.
 */
export async function serveDist(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
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
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Chrome, the one installed on the machine.
 *
 * Playwright's own Chromium is a 130 MB download and this repository does not install heavy
 * things on the developer's machine; the device emulation is a property of the driver, not of
 * the binary, so the system channel is enough. If a machine has no Chrome,
 * `PLAYWRIGHT_CHANNEL=chromium` uses the bundled one.
 */
export const browserChannel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';
