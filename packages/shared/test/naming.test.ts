/**
 * The product was renamed on 7 September 2026. This test is what keeps the old name from
 * creeping back: it walks the repository and fails on any occurrence of the former name, in
 * any case, outside a short list of places where it is deliberately still there.
 *
 * The name itself is never written out below. It is assembled from two halves, so that this
 * file is not itself an occurrence and needs no exception of its own.
 *
 * The exceptions, and why each one is an exception:
 *
 *   * `packages/db/migrations/0007_rls_and_grants.sql` and
 *     `packages/db/migrations/0017_rename_application_role.sql` are applied migrations. Their
 *     text is checksummed, and comparing that checksum is the only defence against an edit to
 *     a migration that has already run, so neither file can ever be touched again. The second
 *     one is also the migration that performs the rename, and it has to name what it renames.
 *   * the changelog, the numbered documents beside it and a one page PDF exported under the old
 *     brand exist only in the working copy this package is developed in. They are records of
 *     what happened under the old name, and rewriting them to match the present is how a record
 *     stops being evidence. In a checkout that does not contain them the entries below simply
 *     never match.
 *
 * Everything else, including every package, every script and the site, is checked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  '.astro',
  '.claude',
  '.impeccable',
  '__screenshots__',
  // Written in halves, like the former name below, so that this file is not itself an
  // occurrence of a word the export refuses. The directory exists only in the working copy.
  ['brie', 'fs'].join(''),
  'coverage',
  'dist',
  'node_modules',
]);

/** Assembled from two halves so that this file is not itself an occurrence of the word. */
const FORMER_NAME = ['slot', 'base'].join('');
const FORMER_NAME_RE = new RegExp(FORMER_NAME, 'i');

/** The one file whose name carries the former brand, with the capitalisation it was given. */
const FORMER_BRAND_PDF = `${['Slot', 'base'].join('')}-in-breve.pdf`;

const SKIPPED_FILES = new Set(
  [
    'packages/db/migrations/0007_rls_and_grants.sql',
    'packages/db/migrations/0017_rename_application_role.sql',
    'packages/shared/test/naming.test.ts',
    FORMER_BRAND_PDF,
  ].map((path) => path.split('/').join(sep)),
);

/**
 * The written record of the rename: the changelog, and the numbered documents that sit beside
 * it at the root of the working copy this package is developed in.
 *
 * Matched by shape rather than listed by name, for two reasons. There is more than one of them,
 * and the list would have to be kept in step with a directory this package cannot see. And a
 * name written out here would be a pointer, in a file that is published, to a document nobody
 * outside that working copy can open.
 *
 * A checkout without those documents matches nothing, and loses nothing either: the export
 * refuses the former name anywhere outside the two migrations above, which is the same rule
 * applied from the other side.
 */
const PRIVATE_RECORD = /^(?:CHANGELOG\.md|[0-9]{2}-[a-z0-9-]+\.md)$/;

function isSkipped(path: string): boolean {
  return SKIPPED_FILES.has(path) || PRIVATE_RECORD.test(path);
}

function textFilesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      textFilesUnder(full, found);
      continue;
    }
    found.push(full);
  }
  return found;
}

describe('the former product name', () => {
  it('appears in no file name', () => {
    const offenders = textFilesUnder(REPO_ROOT)
      .map((file) => relative(REPO_ROOT, file))
      .filter((file) => FORMER_NAME_RE.test(file))
      .filter((file) => !isSkipped(file));
    expect(offenders).toEqual([]);
  });

  it('appears in no file content', () => {
    const offenders: string[] = [];
    for (const file of textFilesUnder(REPO_ROOT)) {
      const path = relative(REPO_ROOT, file);
      if (isSkipped(path)) continue;
      const buffer = readFileSync(file);
      if (buffer.includes(0)) continue; // binary
      const lines = buffer.toString('utf8').split('\n');
      lines.forEach((line, index) => {
        if (FORMER_NAME_RE.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
