import { CliError } from 'bookrail';
import { runCliWithKey } from './cli.js';
import type { Workspace } from './environment.js';

export interface DocPage {
  topic: string;
  title: string;
  markdown: string;
  url: string;
}

const DOC_BASE = 'https://bookrail.dev/docs';

/**
 * The documentation packaged inside the `bookrail` CLI, read through the CLI itself.
 *
 * Not a copy: `bookrail docs --json` lists the pages and `bookrail docs <topic> --json`
 * returns one, so the pages an agent gets from `bookrail_docs_get` are byte for byte the pages
 * it would get from the command line, offline, with no second bundling step to drift.
 */
export async function listPages(workspace: Workspace): Promise<{ topic: string; title: string }[]> {
  const envelope = await runCliWithKey(workspace, 'test', ['docs'], undefined);
  const data = envelope.data as { topics?: { topic: string; title: string }[] } | undefined;
  return data?.topics ?? [];
}

export async function readPage(workspace: Workspace, topic: string): Promise<DocPage> {
  const envelope = await runCliWithKey(workspace, 'test', ['docs', topic], undefined);
  const data = envelope.data as { topic: string; title: string; markdown: string };
  return { ...data, url: `${DOC_BASE}/${data.topic}` };
}

export async function readAllPages(workspace: Workspace): Promise<DocPage[]> {
  const index = await listPages(workspace);
  const pages: DocPage[] = [];
  for (const entry of index) pages.push(await readPage(workspace, entry.topic));
  return pages;
}

export interface SearchHit {
  topic: string;
  title: string;
  url: string;
  score: number;
  /** The lines that matched, in order, so the answer is usable without a second call. */
  excerpts: string[];
}

/**
 * Ranks the packaged pages against a query.
 *
 * Deliberately simple (term frequency over lowercased words, title matches weighted) because
 * seven pages do not need an index, and because a search that returns the *lines* that matched
 * lets an agent answer a narrow question without a second round trip to `bookrail_docs_get`.
 */
export function searchPages(pages: DocPage[], query: string, limit = 5): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) {
    throw new CliError('parameter_invalid', 'The query has no searchable word in it.', {
      param: 'query',
      fix: 'Pass something like `query: "daylight saving"` or `query: "idempotency"`. Call bookrail_docs_get with no query to list the pages instead.',
    });
  }

  const hits: SearchHit[] = [];
  for (const page of pages) {
    const lines = page.markdown.split('\n');
    const title = page.title.toLowerCase();
    let score = 0;
    const excerpts: string[] = [];
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      if (page.topic.includes(term)) score += 3;
    }
    for (const line of lines) {
      const lowered = line.toLowerCase();
      const matched = terms.filter((term) => lowered.includes(term)).length;
      if (matched === 0) continue;
      score += matched;
      if (excerpts.length < 6 && line.trim() !== '') excerpts.push(line.trim());
    }
    if (score > 0)
      hits.push({ topic: page.topic, title: page.title, url: page.url, score, excerpts });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface EdgeCaseTopic {
  topic: string;
  title: string;
  page: string;
  /** The heading inside the page, or null when the whole page is the answer. */
  heading: string | null;
}

/**
 * Where the edge-case answers live inside the packaged documentation.
 *
 * `bookrail_edge_cases` is meant to be the list of edge cases together with how Bookrail
 * handles each one, so that an agent can decide not to build an engine of its own. Writing that
 * list a second time here would be the one duplication that matters most, because it would go
 * stale exactly when the engine changes, so the tool is an index into the pages and the text
 * comes out of them at call time.
 */
export const EDGE_CASE_TOPICS: EdgeCaseTopic[] = [
  {
    topic: 'concurrency',
    title: 'Cases handled and tested: races, expiry, orphans, buffers, splits',
    page: 'timezones',
    heading: 'Other edge cases handled and tested',
  },
  {
    topic: 'daylight-saving',
    title: 'Clock changes: non-existent and repeated local times',
    page: 'timezones',
    heading: 'Daylight saving',
  },
  {
    topic: 'schedules',
    title: 'Rules, exceptions and blocks: the order they are applied in',
    page: 'timezones',
    heading: 'Rules, exceptions and blocks: the order',
  },
  {
    topic: 'pricing',
    title: 'Prices that depend on the slot, and on the two nights the clocks change',
    page: 'timezones',
    heading: 'Prices that depend on the clock',
  },
  {
    topic: 'pitfalls',
    title: 'Things that will bite an agent driving Bookrail',
    page: 'agents',
    heading: 'Things that will bite',
  },
  {
    topic: 'errors',
    title: 'Every error code, what it means, and how to fix it',
    page: 'errors',
    heading: null,
  },
];

export function sectionOf(markdown: string, heading: string | null): string {
  if (heading === null) return markdown.trim();
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{2,3}\s/.test(line) && line.includes(heading));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3}\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}
