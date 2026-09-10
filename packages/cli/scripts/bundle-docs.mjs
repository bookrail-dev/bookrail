#!/usr/bin/env node
/**
 * Copies `docs/*.md` into `dist/docs/` after `tsc` has run, and writes an index.
 *
 * The packaged documentation is generated at build time from the sources in
 * `packages/cli/docs`. Keeping it a copy rather than a code generator
 * means the pages stay readable markdown in git and stay markdown at runtime, which is the
 * form an agent can read with no browser and no network.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs');
const target = join(root, 'dist', 'docs');

await mkdir(target, { recursive: true });
const files = (await readdir(source)).filter((name) => name.endsWith('.md')).sort();
const index = [];
for (const name of files) {
  const contents = await readFile(join(source, name), 'utf8');
  await writeFile(join(target, name), contents, 'utf8');
  index.push({
    topic: name.replace(/\.md$/, ''),
    title: (contents.split('\n', 1)[0] ?? '').replace(/^#\s*/, '').trim(),
    bytes: Buffer.byteLength(contents),
  });
}
await writeFile(join(target, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.error(`bundled ${index.length} documentation pages into dist/docs`);
