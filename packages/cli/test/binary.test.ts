import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(packageRoot, 'dist', 'index.js');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The published artefact, exercised as a real process.
 *
 * Everything else in this suite drives the command layer in-process; this file is what proves
 * that `npx bookrail` works: the `bin` resolves, the shebang is there, the bundled
 * documentation ships inside `dist`, and the cold start is under the 300 ms budget, which is
 * the number that decides whether an agent is willing to call the CLI in a loop.
 */
describe('the published binary', () => {
  beforeAll(async () => {
    if (await exists(binary)) return;
    const require = createRequire(import.meta.url);
    await run(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
      cwd: packageRoot,
    });
    await run(process.execPath, [join(packageRoot, 'scripts', 'bundle-docs.mjs')], {
      cwd: packageRoot,
    });
  }, 180_000);

  it('declares a bin and ships dist plus the documentation', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.bin.bookrail).toBe('./dist/index.js');
    expect(manifest.files).toContain('dist');
    // Three runtime dependencies, and every one of them has none of its own. The third,
    // `@bookrail/webhook-signature`, is the webhook verifier
    // `webhooks listen` used to carry as a forty-line copy of `@bookrail/shared`, extracted
    // into a package with no dependencies precisely so that this list could grow by one
    // without the install growing at all.
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@bookrail/webhook-signature',
      'commander',
      'zod',
    ]);
    expect(await exists(join(packageRoot, 'dist', 'docs', 'getting-started.md'))).toBe(true);
    expect((await readFile(binary, 'utf8')).startsWith('#!/usr/bin/env node')).toBe(true);
  });

  /**
   * The package still installs on its own, with one qualification.
   *
   * Before the webhook verifier was extracted, no dependency was a workspace package at all.
   * `@bookrail/webhook-signature` is one, declared `workspace:*`, which the package manager
   * rewrites to a real version range at publish time; what the qualification costs is a
   * **release rule**, not an install cost:
   * `@bookrail/webhook-signature` has to be published before, or with, `bookrail`. So the
   * assertion is no longer "no workspace protocol" but the two things that actually matter:
   * every workspace dependency is one of ours, and every one of them is itself dependency-free,
   * which is what keeps `npx bookrail` a two-package download.
   */
  it('depends only on packages that carry nothing with them', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!version.startsWith('workspace:')) continue;
      expect(name.startsWith('@bookrail/')).toBe(true);
      const own = JSON.parse(
        await readFile(
          join(packageRoot, '..', name.replace('@bookrail/', ''), 'package.json'),
          'utf8',
        ),
      ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      expect(own.dependencies).toBeUndefined();
      expect(own.peerDependencies).toBeUndefined();
    }
  });

  it('prints its help and exits 0', async () => {
    const { stdout } = await run(process.execPath, [binary, '--help']);
    expect(stdout).toContain('booking infrastructure as code');
    expect(stdout).toContain('Exit codes: 0 success');
  });

  it('answers doctor as JSON, and exits 1 when a check fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bookrail-bin-'));
    await expect(
      run(process.execPath, [binary, 'doctor', '--json'], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: home,
          BOOKRAIL_API_URL: 'http://127.0.0.1:1',
          BOOKRAIL_SECRET_KEY: '',
        },
        cwd: home,
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('reads the documentation from inside dist', async () => {
    const { stdout } = await run(process.execPath, [binary, 'docs', 'agents', '--json'], {
      cwd: tmpdir(),
    });
    const envelope = JSON.parse(stdout) as { data: { markdown: string } };
    expect(envelope.data.markdown).toContain('For coding agents');
  });

  it('starts in well under 300 ms', async () => {
    // Two warm-ups first: the page cache, not the CLI, is what the first run measures.
    await run(process.execPath, [binary, '--help']);
    await run(process.execPath, [binary, '--help']);
    const samples: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const started = process.hrtime.bigint();
      await run(process.execPath, [binary, '--help']);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    // Reported so that a regression is visible in the test output, not only in a failure.
    process.stderr.write(
      `bookrail --help: median ${median.toFixed(1)} ms over ${samples.length} runs ` +
        `(min ${samples[0]!.toFixed(1)}, max ${samples[samples.length - 1]!.toFixed(1)})\n`,
    );
    expect(median).toBeLessThan(300);
  }, 60_000);
});
