/**
 * No em dash (U+2014) in anything a user of this package can read.
 *
 * The house rule: prose that reaches a customer uses a comma, a colon, a full stop or
 * parentheses. It applies to the README, to the messages of every exception this package
 * throws, and to the JSDoc that ends up in the shipped `.d.ts` and therefore in the customer's
 * editor. Comments that stay inside the source are held to the same rule by
 * `packages/shared/test/public-sources.test.ts`, which walks the whole tree; this suite is about
 * what a customer reads.
 *
 * So there are two checks, and they are deliberately different:
 *
 * 1. `src/**\/*.ts` **with the comments removed**, which leaves the string literals: that is
 *    where the error messages live.
 * 2. The emitted `dist/**\/*.d.ts`, which is exactly the set of comments that stop being
 *    internal. Checking the declaration output rather than the source is what tells a JSDoc on
 *    an exported class from a note on a local helper: only the first one is emitted.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Assembled from its code point, so that this file is not itself an occurrence of it. */
const EM_DASH = String.fromCharCode(0x2014);

/** Every file under `directory` whose name ends in `suffix`, recursively. */
async function filesUnder(directory: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full, suffix)));
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found.sort();
}

/**
 * The source with every comment blanked out, offsets preserved.
 *
 * Blanked rather than deleted so that the line number of what survives is still the line
 * number in the file: a failure has to say where to go.
 *
 * The scanner has to know about strings, or a `//` inside a URL would swallow the rest of the
 * line, and about template literals, or a `/*` inside one would swallow the rest of the file.
 */
export function withoutComments(source: string): string {
  const out = [...source];
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) if (out[at] !== '\n') out[at] = ' ';
  };
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === char) break;
        index += 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/** `path:line: the offending line`, for every line of `text` that carries an em dash. */
function offences(label: string, text: string): string[] {
  return text
    .split('\n')
    .map((line, at) => ({ line, at }))
    .filter(({ line }) => line.includes(EM_DASH))
    .map(({ line, at }) => `${label}:${String(at + 1)}: ${line.trim()}`);
}

describe('no em dash in what a user reads', () => {
  it('has none in the README', async () => {
    const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
    expect(offences('README.md', readme)).toEqual([]);
  });

  it('has none in any string of the source, which is where the messages are', async () => {
    const found: string[] = [];
    for (const file of await filesUnder(join(packageRoot, 'src'), '.ts')) {
      const source = await readFile(file, 'utf8');
      found.push(...offences(relative(packageRoot, file), withoutComments(source)));
    }
    expect(found).toEqual([]);
  });

  it('blanks comments and keeps strings, which is what the check above relies on', () => {
    const stripped = withoutComments(
      [
        `// a comment with an ${EM_DASH} in it`,
        `const message = 'a string with a colon: kept';`,
        `/* a block ${EM_DASH} comment */`,
        'const url = "https://example.test//path";',
        'const tpl = `a template /* not a comment */`;',
      ].join('\n'),
    );
    expect(stripped).not.toContain(EM_DASH);
    expect(stripped).toContain("'a string with a colon: kept'");
    expect(stripped).toContain('"https://example.test//path"');
    expect(stripped).toContain('`a template /* not a comment */`');
    // Offsets survive, so a reported line number is the real one.
    expect(stripped.split('\n')).toHaveLength(5);
  });
});

describe('no em dash in the JSDoc that ships', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    await run(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
      cwd: packageRoot,
    });
  }, 180_000);

  it('has none in any declaration file, which is what the customer’s editor shows', async () => {
    const declarations = await filesUnder(join(packageRoot, 'dist'), '.d.ts');
    expect(declarations.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of declarations) {
      const source = await readFile(file, 'utf8');
      found.push(...offences(relative(packageRoot, file), source));
    }
    expect(found).toEqual([]);
  });
});
