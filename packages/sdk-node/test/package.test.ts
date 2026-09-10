/**
 * The published artefact: one runtime dependency, ESM only, and a main path that imports no
 * Node built-in.
 *
 * The module graph is walked over the **emitted** JavaScript rather than over the source,
 * because what a consumer installs is `dist`. It is walked statically (every import in this
 * package is a static `import`, there is not one dynamic `import()`), which makes the answer
 * exact and needs no loader hook, no `--conditions` and no child process. A dynamic import
 * would defeat it, so a test below fails if one ever appears.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(packageRoot, 'dist');

/** Every `from '...'` of an `import`/`export` statement, plus any `import(` expression. */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC = /[^.\w]import\s*\(/;

interface Graph {
  /** Emitted file (relative to `dist`) → the bare specifiers it imports. */
  bare: Map<string, string[]>;
  /** Every emitted file reached from the entry. */
  files: string[];
}

async function walk(entry: string): Promise<Graph> {
  const bare = new Map<string, string[]>();
  const files: string[] = [];
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(relative(dist, file));
    const source = await readFile(file, 'utf8');
    expect(DYNAMIC.test(source), `${file} uses a dynamic import`).toBe(false);
    const specifiers: string[] = [];
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
      } else {
        specifiers.push(specifier);
      }
    }
    bare.set(relative(dist, file), specifiers);
  }
  return { bare, files };
}

describe('the published package', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    await run(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
      cwd: packageRoot,
    });
  }, 180_000);

  it('declares one runtime dependency, ESM only, and ships dist', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string;
      type: string;
      sideEffects: boolean;
      files: string[];
      exports: Record<string, Record<string, string>>;
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('@bookrail/node');
    expect(manifest.type).toBe('module');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(manifest.engines.node).toBe('>=20.10');
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
    expect(Object.keys(manifest.dependencies)).toEqual(['@bookrail/webhook-signature']);
  });

  it('imports @bookrail/webhook-signature from exactly one module, and nothing else', async () => {
    const graph = await walk(join(dist, 'index.js'));
    const importers = [...graph.bare.entries()]
      .filter(([, specifiers]) => specifiers.includes('@bookrail/webhook-signature'))
      .map(([file]) => file);
    expect(importers).toEqual(['resources/webhooks.js']);

    const everySpecifier = new Set([...graph.bare.values()].flat());
    expect([...everySpecifier]).toEqual(['@bookrail/webhook-signature']);
  });

  it('reaches no Node built-in from the client, which is what runs on the edge', async () => {
    const graph = await walk(join(dist, 'core.js'));
    const specifiers = [...graph.bare.values()].flat();
    expect(specifiers).toEqual([]);
    expect(graph.files.some((file) => file.startsWith('resources/'))).toBe(false);
  });

  it('has no `node:` import anywhere in dist', async () => {
    const files: string[] = [];
    async function collect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await collect(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    }
    await collect(dist);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(SPECIFIER)) {
        expect(match[1]?.startsWith('node:'), `${file} imports ${String(match[1])}`).toBe(false);
      }
    }
  });
});
