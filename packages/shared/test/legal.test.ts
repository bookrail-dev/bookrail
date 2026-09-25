/**
 * The versions an acceptance records, against the texts that are published.
 *
 * The legal texts live next to the code in this working copy and are read by the website when
 * it builds `/terms` and `/dpa`. Their front matter carries a `version`, and an acceptance has to
 * record exactly that version, or the record would name a text that was never shown. A checkout
 * that does not contain the texts (the public repository) has nothing to compare against, and
 * only the shape of the constants is checked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSIONS, TERMS_CHANNELS } from '../src/legal.js';

const LEGAL_DIR = fileURLToPath(new URL('../../../legale', import.meta.url));

function versionOf(file: string): string | null {
  const path = join(LEGAL_DIR, file);
  if (!existsSync(path)) return null;
  const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
  return /^version:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
}

describe('the legal versions', () => {
  it('are non empty, and there are exactly three channels', () => {
    expect(LEGAL_VERSIONS.terms).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    expect(LEGAL_VERSIONS.dpa).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    expect([...TERMS_CHANNELS]).toEqual(['web', 'cli', 'dashboard']);
  });

  it('are the versions of the texts in the working copy', () => {
    const terms = versionOf('terms-of-service.md');
    const dpa = versionOf('data-processing-agreement.md');
    if (terms !== null) expect(LEGAL_VERSIONS.terms).toBe(terms);
    if (dpa !== null) expect(LEGAL_VERSIONS.dpa).toBe(dpa);
  });
});
