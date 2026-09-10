/**
 * "The edge cases of booking" claims that a test proves each case. This checks that it does.
 *
 * The page is the only argument the site makes that is not about what Bookrail can do but about
 * what has been *verified*, and it makes it by naming files and test titles in the repository.
 * A citation nobody checks is a citation that survives a rename by six months, and making the
 * paths links to the public repository does not change that: a link to a file that moved is a
 * 404, and one to a file that stayed while its tests were rewritten still opens.
 *
 * So the page is the source, and this file is the check. Nothing here is a second list to keep
 * in step: every path and every quoted title is extracted from the markdown of
 * `docs/edge-cases.md` itself, in the paragraphs that begin "**Proved by.**". Two tiers:
 *
 * 1. every code span that looks like a test file must exist at that path;
 * 2. every other code span in the same paragraph must appear verbatim in one of the files that
 *    paragraph cites, and, when it is a sentence (four words or more), it must appear inside an
 *    actual `it` / `test` / `describe` title rather than merely somewhere in the file.
 *
 * The second tier is what a scenario name such as `composite`, which lives in an `it.each`
 * table rather than in a title, is deliberately not held to.
 *
 * The known limit: a title moved from one cited file to another cited file in the same
 * paragraph still passes, and a title rewritten in both the page and the test source at once
 * passes because it should. What cannot happen any more is the page quoting a test that no
 * longer exists.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, siteRoot } from './helpers.js';

const PAGE = join(siteRoot, 'src', 'content', 'docs', 'docs', 'edge-cases.md');

/** A path that names a test file of this repository. */
const TEST_FILE = /^packages\/[\w/-]+\/test\/[\w./-]+\.test\.ts$/;

interface Citation {
  /** The heading the paragraph belongs to, so a failure says which case is wrong. */
  readonly heading: string;
  readonly files: readonly string[];
  readonly claims: readonly string[];
}

/**
 * Every "Proved by." paragraph of the page, with its file paths and its quoted claims.
 *
 * Line wraps inside a code span are collapsed first: markdown lets a span run over a newline
 * and the source is wrapped at 100 columns, so half the titles are cut in two on disk.
 */
async function citations(): Promise<Citation[]> {
  const markdown = await readFile(PAGE, 'utf8');
  const out: Citation[] = [];
  let heading = '(before the first heading)';
  for (const block of markdown.split(/\n\s*\n/)) {
    const title = /^#{2,3} (.+)$/m.exec(block);
    if (title !== null) heading = title[1] ?? heading;
    if (!block.startsWith('**Proved by.**')) continue;
    const flat = block.replace(/\s+/g, ' ');
    const spans = [...flat.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    out.push({
      heading,
      files: spans.filter((span) => TEST_FILE.test(span)),
      claims: spans.filter((span) => !TEST_FILE.test(span)),
    });
  }
  return out;
}

/** Every `it` / `test` / `describe` title of one source file, including template literals. */
function titlesOf(source: string): string[] {
  const titles: string[] = [];
  const call = /\b(?:it|test|describe)(?:\.each\([\s\S]*?\))?\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const match of source.matchAll(call)) titles.push(match[2] ?? '');
  return titles;
}

const CITATIONS = await citations();

describe('the edge cases page', () => {
  it('cites the paragraphs it says it does', () => {
    // Twenty-one cases, each with its own "Proved by.". An equality, not a floor: the page's
    // own description counts them in words ("Twenty-one things that go wrong"), and a floor is
    // how that number came to be two behind the page. Add a case, change this number, change
    // the description. If a case loses its proof, this is the first thing that fails.
    expect(CITATIONS.length).toBe(21);
    for (const citation of CITATIONS) {
      expect(citation.files.length, citation.heading).toBeGreaterThan(0);
    }
  });

  it('names test files that exist', async () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const citation of CITATIONS) {
      for (const file of citation.files) {
        seen.add(file);
        try {
          await readFile(join(repoRoot, file), 'utf8');
        } catch {
          missing.push(`${citation.heading}: ${file}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // A sanity floor, so deleting half the citations cannot pass quietly.
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });

  it('quotes only text that is still in the file it points at', async () => {
    const wrong: string[] = [];
    for (const citation of CITATIONS) {
      const sources = await Promise.all(
        citation.files.map((file) => readFile(join(repoRoot, file), 'utf8')),
      );
      for (const claim of citation.claims) {
        if (!sources.some((source) => source.includes(claim))) {
          wrong.push(`${citation.heading}: "${claim}" is in none of ${citation.files.join(', ')}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('quotes every sentence from an actual test title', async () => {
    const wrong: string[] = [];
    for (const citation of CITATIONS) {
      const titles = (
        await Promise.all(citation.files.map((file) => readFile(join(repoRoot, file), 'utf8')))
      ).flatMap((source) => titlesOf(source));
      for (const claim of citation.claims) {
        if (claim.split(' ').length < 4) continue;
        if (!titles.some((title) => title.includes(claim))) {
          wrong.push(
            `${citation.heading}: "${claim}" is not the title of any test in the files cited`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
