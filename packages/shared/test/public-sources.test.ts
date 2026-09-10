/**
 * The sources of this repository are read by people who have nothing else: no internal
 * tracker, no delivery notes, no review threads, and none of the design documents the product
 * was written from. A comment that says "see the third finding of the independent review", or
 * one that cites a section of a file in a language the reader does not speak, is for them a
 * dead link with no target.
 *
 * So the rule is that every explanation in `packages/` and `apps/site` stands on its own. This
 * test enforces it by walking both trees and failing on two families of pointer:
 *
 *   * the words that can only refer to the private process behind the code: the English word
 *     for a work item, and the two Italian words for a review finding and for the review
 *     itself;
 *   * the shapes that cite a private document: the section sign, the name of a numbered design
 *     document, the file that records the current state of the application, the directory of
 *     visual prototypes, and the directory that deploys the hosted service;
 *   * the numbered lists inside those documents, cited by their number alone. The design
 *     documents number their invariants, their principles, their points and their edge cases,
 *     and a comment that says "the fourth invariant" without saying which one is a pointer with
 *     no target here, even though it names no file.
 *
 * A third rule rides with them because it has the same subject, which is what a stranger sees
 * when they open a file: no em dash anywhere in the published sources. It began as a rule for
 * the visible surface (the site, the documentation, the output of the CLI and the MCP server,
 * the error messages) and it is the whole tree now, comments included, because a comment is
 * read by whoever reads the code.
 *
 * The exceptions, each one an exception for a reason that cannot be worked around:
 *
 *   * `packages/db/migrations/`: every file there is applied and checksummed, and comparing
 *     that checksum is the only defence against an edit to a migration that has already run.
 *     The text of a migration is therefore frozen for ever, comments included. New migrations
 *     are written to these rules from the start, and the em dash check below holds every
 *     migration after 0019 to it so that the exception cannot grow.
 *   * `naming.test.ts`: the test that keeps the former product name out has to be able to
 *     write the word it is looking for.
 *   * `apps/site/DESIGN.md`: notes on how the site was designed, kept in this working copy and
 *     not published, so it is not held to the rule about what a stranger can read.
 *
 * A line is not the unit of search. Reading one line at a time is how a rule like this gets
 * walked past by pressing Return, and it is not a hypothetical: three of these phrases lived
 * here for weeks with a line break in the middle, because that is where a formatter put it. So
 * each file is searched three times: as it is written, with the comment markers stripped and
 * the lines joined by a space (which closes a phrase split over two lines), and with the lines
 * joined by nothing (which closes a word split over two lines, and a citation split inside the
 * name of the document it cites).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const ROOTS = ['packages', join('apps', 'site')];

const SKIPPED_DIRECTORIES = new Set([
  '.astro',
  '.claude',
  '.git',
  '.impeccable',
  '.turbo',
  '__screenshots__',
  'coverage',
  'dist',
  'node_modules',
]);

const SKIPPED_PATHS = [
  join('packages', 'db', 'migrations'),
  join('packages', 'shared', 'test', 'naming.test.ts'),
  // Notes on how the site was designed and why, for whoever works on it in this working copy.
  // It is not part of what is published, so it is not held to the rule about dead links.
  join('apps', 'site', 'DESIGN.md'),
];

/**
 * The section sign, assembled from its code point rather than written out, for the same reason
 * every pattern below hides one of its own letters in a character class: this file has to be
 * able to look for something without being an occurrence of it.
 */
const SECTION_SIGN = String.fromCharCode(0xa7);

/**
 * One pattern per kind of dead link, each with the reason it is forbidden.
 *
 * The first group is the private process: the English name of one unit of work, and the two
 * Italian words for a review finding and for the review that produced it. The second group is
 * the private documents: the sign that introduces one of their sections, the shape of their
 * file names, the file that records the state of the application, the directory of visual
 * prototypes, and the directory that deploys the hosted service. The third group is the
 * numbering used inside those documents, which survives the loss of the file name: their
 * invariants, their principles, their points and their cases are cited by an ordinal, and an
 * ordinal without the list it indexes is the emptiest pointer of the three. None of them names
 * anything a reader of this repository can look up.
 *
 * Each pattern is written with one letter in a character class, or built from a code point, so
 * that this file matches none of them and needs no exception from the scanner that runs over
 * the exported tree.
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bbrie[f]s?\b/gi, why: 'names a private work item' },
  { pattern: /\brilie[v]i?o?\b/gi, why: 'names a finding of a private review' },
  { pattern: /\brevisione\s+indipendent[e]\b/gi, why: 'names a private review' },
  { pattern: /\bP[M]\b/g, why: 'names a role that exists only in the private process' },
  { pattern: /\bdecisione\s+del\b/gi, why: 'attributes a decision to somebody unnamed here' },
  { pattern: /\bverifica\s+P[M]\b/gi, why: 'names a step of the private process' },
  { pattern: /\b0[0-9]{2}[a-c]?\s+(?:report|review|suite)\b/gi, why: 'names a private document' },
  { pattern: /\b(?:the|del|of)\s+0[0-9]{2}[a-c]\b/gi, why: 'names a private work item by number' },
  { pattern: new RegExp(SECTION_SIGN, 'g'), why: 'cites a section of an unpublished document' },
  { pattern: /\b[0-9]{2}-[a-z0-9-]+\.md\b/g, why: 'names an unpublished design document' },
  { pattern: /\bSTATO[-]APP\b/g, why: 'names the private record of the state of the app' },
  { pattern: /\bsite[-]prototypes\//g, why: 'names a directory of private visual prototypes' },
  { pattern: /\binfra\/deplo[y]\//g, why: 'names the private deployment of the hosted service' },
  {
    pattern: /\binvarian[t]\s+[0-9]/gi,
    why: 'cites an invariant by the number a private document gives it',
  },
  {
    pattern: /\bprincipl[e]\s+[0-9]/gi,
    why: 'cites a principle by the number a private document gives it',
  },
  { pattern: /\bpoin[t]\s+[0-9]/gi, why: 'cites a numbered point of a private document' },
  { pattern: /\bcas[e]\s+[0-9]+\s+of\b/gi, why: 'cites a numbered case of a private document' },
];

const TEXT_FILE = /\.(ts|mts|cts|js|mjs|cjs|astro|css|md|json|yml|yaml|sh|sql|txt)$/;

function sourcesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      sourcesUnder(full, found);
      continue;
    }
    if (TEXT_FILE.test(entry)) found.push(full);
  }
  return found;
}

function isSkipped(path: string): boolean {
  return SKIPPED_PATHS.some((skipped) => path === skipped || path.startsWith(skipped + sep));
}

const COMMENT_MARKER = /^\s*(?:\/\/+|\/\*+|\*\/|\*+|--+|#+|<!--)\s?/;

/** One searchable text, plus the map from an offset in it back to a line of the file. */
function joinWithMap(lines: readonly string[], glue: string): { text: string; lineOf: number[] } {
  let text = '';
  const lineOf: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      for (let c = 0; c < glue.length; c += 1) lineOf.push(index + 1);
      text += glue;
    }
    const line = lines[index] ?? '';
    for (let c = 0; c < line.length; c += 1) lineOf.push(index + 1);
    text += line;
  }
  return { text, lineOf };
}

const LITERAL_CONCATENATION = /(['"`])\s*\+\s*(['"`])/g;

/**
 * Closes `'first half' + 'second half'` into `first halfsecond half`, so a pointer written as
 * two literals reads as the one string it becomes at run time. A line break is not the only
 * way to break a word in half; a plus sign is the other, and it is the one a formatter reaches
 * for on a long line. The map from offset to line is rebuilt as the text is, so a finding still
 * names the line it starts on.
 */
function deconcatenate({ text, lineOf }: { text: string; lineOf: number[] }): {
  text: string;
  lineOf: number[];
} {
  const out: string[] = [];
  const map: number[] = [];
  const copy = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      out.push(text[at] as string);
      map.push(lineOf[at] as number);
    }
  };
  let last = 0;
  for (const match of text.matchAll(LITERAL_CONCATENATION)) {
    copy(last, match.index);
    last = match.index + match[0].length;
  }
  copy(last, text.length);
  return { text: out.join(''), lineOf: map };
}

/**
 * The file as written, the file with its comment markers stripped and its lines joined by a
 * space, and the same joined by nothing. The second closes a phrase split over two lines, the
 * third closes a word split over two lines, and both of the last two also close a literal
 * written as two shorter literals joined by a plus.
 */
function viewsOf(source: string): { text: string; lineOf: number[] }[] {
  const raw = source.split('\n');
  const bare = raw.map((line) => line.replace(COMMENT_MARKER, '').replace(/\s+/g, ' ').trim());
  return [
    joinWithMap(raw, ' '),
    deconcatenate(joinWithMap(bare, ' ')),
    deconcatenate(joinWithMap(bare, '')),
  ];
}

/** Every offender a single file would produce, used both by the walk and by the self test. */
function offendersIn(path: string, source: string): string[] {
  const lines = source.split('\n');
  const found = new Set<string>();
  for (const { text, lineOf } of viewsOf(source)) {
    for (const { pattern, why } of FORBIDDEN) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const at = lineOf[match.index] ?? 1;
        found.add(`${path}:${at} (${why}): ${(lines[at - 1] ?? '').trim()}`);
      }
    }
  }
  return [...found];
}

describe('the published sources', () => {
  it('explain themselves without referring to the private process', () => {
    const offenders = new Set<string>();
    for (const root of ROOTS) {
      for (const file of sourcesUnder(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        if (isSkipped(path)) continue;
        for (const offender of offendersIn(path, readFileSync(file, 'utf8'))) {
          offenders.add(offender);
        }
      }
    }
    expect([...offenders]).toEqual([]);
  });

  /**
   * The three ways a pointer used to survive a check that read one line at a time, each fed to
   * the same function the walk above uses. A rule nobody has watched refuse anything is a rule
   * that may be matching nothing.
   *
   * The name of the document is assembled from its parts rather than written out, for the same
   * reason the patterns hide a letter each: this file is walked by the check above, so a fixture
   * spelled in full would make the test the one thing it forbids, and would buy the file an
   * exception it does not need.
   */
  it('close a phrase, a word and a literal broken in half', () => {
    const document = ['04', 'modello', 'dati'].join('-') + '.' + ['m', 'd'].join('');
    const cut = document.indexOf('dati');

    const brokenPhrase = [
      '/**',
      ' * The invariant is stated in 04',
      ` * ${SECTION_SIGN} Booking, and the citation is broken by a line break.`,
      ' */',
    ].join('\n');
    expect(offendersIn('planted.ts', brokenPhrase)).not.toEqual([]);

    const brokenWord = [
      `// The rule this paraphrases is written out in ${document.slice(0, cut)}`,
      `// ${document.slice(cut)}, one token only once the lines are glued together.`,
    ].join('\n');
    expect(offendersIn('planted.ts', brokenWord)).not.toEqual([]);

    const concatenated = `const where = '${document.slice(0, cut)}' + '${document.slice(cut)}';`;
    expect(offendersIn('planted.ts', concatenated)).not.toEqual([]);

    // And the same explanation once the pointer is gone, which has to pass.
    expect(
      offendersIn('planted.ts', '// The invariant is stated next to the code that holds it.'),
    ).toEqual([]);
  });

  /**
   * The pointer that carries no file name at all: the ordinal of a numbered list inside one of
   * those documents. It is what a citation decays into when the file name is taken out of it,
   * and it is the shape that survived the first sweep of these sources.
   */
  it('close a citation that has lost its file name and kept its number', () => {
    const word = ['invarian', 't'].join('');
    expect(
      offendersIn('planted.ts', `// ${word} 4 asks for one event per transition.`),
    ).not.toEqual([]);
    expect(
      offendersIn(
        'planted.ts',
        `/**\n * The event this owes is the one ${word}\n * 4 asks for.\n */`,
      ),
    ).not.toEqual([]);

    // The same reason, carried instead of pointed at, which has to pass.
    expect(
      offendersIn('planted.ts', '// Every state change owes exactly one event, and there are two.'),
    ).toEqual([]);
  });
});

/**
 * The other half of the rule, and the half that matters most: a **string** that names an
 * internal document is not a dead link in a comment, it is a dead link the product hands to
 * somebody.
 *
 * Three of them were shipping: two lines that `bookrail listen` prints, one `nextSteps` entry
 * an agent reads out of `--json`, and the `fix` field of a `bookrail doctor` check, each one
 * citing an Italian file that exists in no checkout anybody can obtain. Two more were the
 * comment header that `bookrail examples` writes into a user's own configuration file.
 *
 * So: no section sign, and no `NN-name.md`, inside any string literal or template literal of
 * the sources. The rule above now covers comments too, so this one is no longer the only net;
 * it is kept because it is the sharper one. It walks the TypeScript parser rather than the
 * text, which is what tells a string from a comment, so a failure here names a line that the
 * product actually prints and can be read as such.
 */
const PRINTED_ROOTS = [
  join('packages', 'api', 'src'),
  join('packages', 'cli', 'src'),
  join('packages', 'engine', 'src'),
  join('packages', 'mcp', 'src'),
  join('packages', 'sdk-node', 'src'),
  join('packages', 'shared', 'src'),
  join('packages', 'db', 'src'),
  join('apps', 'site', 'src'),
];

const INTERNAL_DOCUMENT = new RegExp(`${SECTION_SIGN}|\\b[0-9]{2}-[a-z0-9-]+\\.md\\b`);

function stringsNamingAnInternalDocument(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  if (!INTERNAL_DOCUMENT.test(source)) return [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.getText(parsed);
      if (INTERNAL_DOCUMENT.test(text)) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line;
        found.push(`${relative(REPO_ROOT, file)}:${String(line + 1)}: ${text.trim()}`);
      }
    }
    for (const child of node.getChildren(parsed)) visit(child);
  };
  visit(parsed);
  return found;
}

describe('what the product prints', () => {
  it('never names a document that only exists in the private working copy', () => {
    const offenders: string[] = [];
    for (const root of PRINTED_ROOTS) {
      for (const file of sourcesUnder(join(REPO_ROOT, root))) {
        if (!/\.(ts|mts|cts)$/.test(file)) continue;
        offenders.push(...stringsNamingAnInternalDocument(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * No em dash, anywhere in the published sources.
 *
 * The house style is a comma, a colon, a full stop or brackets. It was a rule for the visible
 * surface first, and three packages still check their own strings and their own shipped
 * declaration files one by one, which is the sharper question: a message is read by somebody
 * who never asked to read prose at all. This is the blunt one, and it covers what those cannot,
 * which is the comments. A comment is visible: it is the page a stranger lands on when they
 * open a file of this repository, and half of what this project is offering them is the
 * explanations next to the code.
 *
 * The em dash is assembled from its code point, so that this file can look for a character it
 * does not contain.
 *
 * `packages/db/migrations/` is the only exception, and it is not one anybody chose: a migration
 * is checksummed when it is applied and can never be edited again, comments and the text of a
 * `COMMENT ON` included. Files 0001 to 0019 were written before this rule and keep their em
 * dashes for ever. Every migration from 0020 on is held to the rule like everything else, which
 * is what stops the exception from growing one file at a time.
 */
const EM_DASH = String.fromCharCode(0x2014);

const MIGRATIONS = join('packages', 'db', 'migrations');

/** Migrations written before the rule existed, and frozen by their checksums. */
const FROZEN_MIGRATION = /^00(?:0[1-9]|1[0-9])_/;

function emDashOffences(paths: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of paths) {
    const path = relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(EM_DASH)) offenders.push(`${path}:${String(index + 1)}: ${line.trim()}`);
    });
  }
  return offenders;
}

describe('the published sources, again', () => {
  it('carry no em dash, comments included', () => {
    const files: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourcesUnder(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        // Not published, so not held to a rule about what a stranger reads.
        if (path === join('apps', 'site', 'DESIGN.md')) continue;
        if (path.startsWith(MIGRATIONS + sep)) continue;
        files.push(file);
      }
    }
    expect(files.length).toBeGreaterThan(100);
    expect(emDashOffences(files)).toEqual([]);
  });

  it('hold every migration after the frozen ones to the same rule', () => {
    const recent = sourcesUnder(join(REPO_ROOT, MIGRATIONS)).filter(
      (file) => !FROZEN_MIGRATION.test(relative(join(REPO_ROOT, MIGRATIONS), file)),
    );
    expect(recent.length).toBeGreaterThan(0);
    expect(emDashOffences(recent)).toEqual([]);
  });
});
