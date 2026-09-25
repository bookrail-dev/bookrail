/**
 * The legal texts the test suite builds the site with.
 *
 * The real texts, when they are in the working copy, copied into a directory of their own with
 * the status of each set to `approved` (they are drafts until a lawyer approves them, and the
 * build refuses a draft, which is the point); the fixtures of `test/fixtures/legal` otherwise.
 * Either way the texts in the repository are never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, siteRoot } from './helpers.js';

export const LEGAL_FILES = ['terms-of-service.md', 'data-processing-agreement.md'] as const;

/** Where the real texts are, in a working copy that has them. */
export const REAL_LEGAL_DIR = join(repoRoot, 'legale');

export const FIXTURE_LEGAL_DIR = join(siteRoot, 'test', 'fixtures', 'legal');

/** A copy of the texts with every `status:` set to `status`, in a fresh directory. */
export function legalCopy(status: 'approved' | 'draft'): string {
  const source = LEGAL_FILES.every((file) => existsSync(join(REAL_LEGAL_DIR, file)))
    ? REAL_LEGAL_DIR
    : FIXTURE_LEGAL_DIR;
  const target = mkdtempSync(join(tmpdir(), `bookrail-legal-${status}-`));
  mkdirSync(target, { recursive: true });
  for (const file of LEGAL_FILES) {
    const text = readFileSync(join(source, file), 'utf8');
    writeFileSync(join(target, file), text.replace(/^status: .*$/m, `status: ${status}`), 'utf8');
  }
  return target;
}
