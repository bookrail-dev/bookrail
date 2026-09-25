import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distFingerprint } from './helpers.js';
import { legalCopy } from './legal-copy.js';

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the suite builds: never `dist`, which is what gets published. See `helpers.ts`. */
export const TEST_OUT_DIR = 'dist-test';

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: siteRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      env,
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} failed with code ${String(code)}`)),
    );
  });
}

/**
 * The suite asserts on a build of its own, so the suite builds it.
 *
 * Always, not "when it looks stale": every check in this directory is a claim about the files a
 * deploy would upload, and a test that passes against yesterday's output is not a test. The
 * build also proves the MCP server still starts and still answers `tools/list`, because
 * `scripts/generate.mjs` cannot finish without it.
 *
 * It goes to `dist-test`, not to `dist`: the legal texts are drafts until they are approved, and
 * the suite builds with a copy marked approved (`legal-copy.ts`, never touching the originals).
 * A site built that way must never sit in the directory that is published. What `dist` held
 * before the build is recorded, and `dist.test.ts` proves the suite left it as it was.
 */
export default async function setup(): Promise<() => Promise<void>> {
  process.env.BOOKRAIL_SITE_DIST_BEFORE = await distFingerprint();
  const legal = legalCopy('approved');
  process.env.BOOKRAIL_LEGAL_DIR = legal;
  const env = {
    ...process.env,
    SITE_URL: process.env.SITE_URL ?? 'https://bookrail.dev',
    BOOKRAIL_LEGAL_DIR: legal,
  };
  await run(process.execPath, ['scripts/generate.mjs'], env);
  await run('pnpm', ['exec', 'astro', 'build', '--outDir', TEST_OUT_DIR], env);
  // Returned, not exported: with a default export Vitest ignores a named `teardown`.
  return teardown;
}

/**
 * After the suite, the pages it generated from its copy of the legal texts go: nothing built
 * afterwards finds them. (`LegalText.astro` would refuse them anyway, since their source is not
 * in the directory of that build.)
 */
async function teardown(): Promise<void> {
  await rm(join(siteRoot, 'src', 'generated', 'legal'), { recursive: true, force: true });
}
