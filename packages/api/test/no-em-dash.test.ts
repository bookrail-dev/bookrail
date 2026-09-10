/**
 * No em-dash in anything a user or an agent reads.
 *
 * The house rule: prose that reaches a customer uses a comma, a colon, a full stop or
 * parentheses, because the em-dash is a recognisable tic of model-written
 * prose and is not the voice of the product. Here that means the error messages of the API and
 * every `description` and `summary` that ends up in the specification, so the generated
 * `openapi/openapi.json` is checked as well: it is what an SDK generator and a code agent
 * read. Comments are not UI and are exempt, which is why the source is read through the
 * TypeScript parser rather than a regular expression: the parser is what tells a comment from
 * a string, and `/'/g` from the start of one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Assembled from its code point, so that this file is not itself an occurrence of it. */
const EM_DASH = String.fromCharCode(0x2014);
const ESCAPED = '\\u2014';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => join(ROOT, dir, entry))
    .sort();
}

/**
 * Every token of the file except the comments.
 *
 * `getText()` on a leaf token starts after the leading trivia, so line comments and block
 * comments are already out; JSDoc blocks are the exception, because the parser turns them into
 * real nodes, so they are pruned by hand.
 */
function offendingTokens(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  if (!source.includes(EM_DASH)) return [];
  const lines = source.split('\n');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(parsed);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const start = node.getStart(parsed);
    const text = node.getText(parsed);
    for (let at = text.indexOf(EM_DASH); at !== -1; at = text.indexOf(EM_DASH, at + 1)) {
      const line = parsed.getLineAndCharacterOfPosition(start + at).line;
      found.add(`${relative(ROOT, file)}:${String(line + 1)}: ${(lines[line] ?? '').trim()}`);
    }
  };
  visit(parsed);
  return [...found];
}

function offendingLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      line.includes(EM_DASH) || line.includes(ESCAPED)
        ? [`${relative(ROOT, file)}:${String(index + 1)}: ${line.trim()}`]
        : [],
    );
}

describe('no em-dash in visible text', () => {
  it('no em-dash in any string of src/**/*.ts', () => {
    expect(filesUnder('src', '.ts').flatMap(offendingTokens)).toEqual([]);
  });

  it('no em-dash in the generated openapi.json', () => {
    expect(offendingLines(join(ROOT, 'openapi', 'openapi.json'))).toEqual([]);
  });
});
