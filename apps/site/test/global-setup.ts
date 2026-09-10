import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The suite asserts on `dist`, so the suite builds `dist`.
 *
 * Always, not "when it looks stale": every check in this directory is a claim about the files a
 * deploy would upload, and a test that passes against yesterday's output is not a test. The
 * build also proves the MCP server still starts and still answers `tools/list`, because
 * `scripts/generate.mjs` cannot finish without it.
 */
export default async function setup(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['run', 'build'], {
      cwd: siteRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, SITE_URL: process.env.SITE_URL ?? 'https://bookrail.dev' },
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`site build failed with code ${String(code)}`)),
    );
  });
}
