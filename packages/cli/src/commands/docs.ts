import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { renderTable, type CommandResult } from '../output.js';

/**
 * Where the packaged documentation is.
 *
 * `dist/commands/docs.js` finds `dist/docs`, which the build copies from `docs/`; running the
 * sources directly (`tsx src/index.ts`) finds `packages/cli/docs`. Both are checked, in that
 * order, so the same code path serves a published package and a checkout.
 */
async function docsDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'docs'), join(here, '..', '..', 'docs')]) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  throw new CliError('docs_missing', 'The packaged documentation is not in this build.', {
    fix: 'Reinstall the CLI (`npm i -g bookrail@latest`), or read https://bookrail.dev/docs.',
  });
}

export interface Topic {
  topic: string;
  title: string;
  path: string;
}

export async function listTopics(): Promise<Topic[]> {
  const directory = await docsDir();
  const files = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
  const topics: Topic[] = [];
  for (const file of files) {
    const path = join(directory, file);
    const first = (await readFile(path, 'utf8')).split('\n', 1)[0] ?? '';
    topics.push({
      topic: file.replace(/\.md$/, ''),
      title: first.replace(/^#\s*/, '').trim(),
      path,
    });
  }
  return topics;
}

/**
 * Prints one packaged page.
 *
 * Offline on purpose: an agent that has just failed a call should not need the network to find
 * out why, and plain markdown at a predictable path is the form a machine can read. When the
 * public documentation exists these pages become a cache of it; until then they are it.
 */
export async function docs(
  ctx: Context,
  topic: string | undefined,
  options: { markdown?: boolean },
): Promise<CommandResult> {
  const topics = await listTopics();

  if (topic === undefined) {
    return {
      data: { topics: topics.map(({ topic: name, title }) => ({ topic: name, title })) },
      human: [
        `${ctx.presenter.badge()} documentation bundled with this CLI`,
        '',
        renderTable(
          ['topic', 'title'],
          topics.map((entry) => [entry.topic, entry.title]),
        ),
        '',
        'Run `bookrail docs <topic>` to print one.',
      ].join('\n'),
      nextSteps: ['Run `bookrail docs getting-started` first.'],
    };
  }

  const match =
    topics.find((entry) => entry.topic === topic) ??
    topics.find((entry) => entry.topic.startsWith(topic));
  if (!match) {
    throw new CliError('unknown_topic', `No documentation page named "${topic}".`, {
      fix: `Choose one of: ${topics.map((entry) => entry.topic).join(', ')}.`,
    });
  }

  const markdown = await readFile(match.path, 'utf8');
  // `--markdown` is accepted and is the only rendering there is: the pages are markdown, and
  // reformatting them for a terminal would take away exactly what makes them useful to an
  // agent. The flag exists so that a caller that asks for it is not told it does not exist.
  void options.markdown;
  return {
    data: { topic: match.topic, title: match.title, markdown },
    human: markdown.trimEnd(),
  };
}
