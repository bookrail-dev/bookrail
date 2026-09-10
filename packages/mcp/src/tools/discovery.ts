import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CliError, ENTITY_KINDS, TEMPLATE_NAMES } from 'bookrail';
import { z } from 'zod';
import {
  EDGE_CASE_TOPICS,
  readAllPages,
  readPage,
  searchPages,
  sectionOf,
  listPages,
} from '../docs.js';
import type { Workspace } from '../environment.js';
import { registerTool } from '../tool.js';

/**
 * What `bookrail schema` accepts, derived from the CLI's own list of entity kinds rather than
 * written out again here.
 */
const SCHEMA_TARGETS: [string, ...string[]] = ['config', ...ENTITY_KINDS];

const EDGE_CASE_TOPIC_NAMES = EDGE_CASE_TOPICS.map((entry) => entry.topic) as [string, ...string[]];

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Nothing here leaves the machine: the pages, the schemas and the examples are packaged
  // inside the `bookrail` package this server depends on.
  openWorldHint: false,
} as const;

/**
 * The five tools that need no key at all.
 *
 * They are the ones an agent reaches for first (before it has been given a key, and often
 * before it has decided whether to use Bookrail), so none of them can fail for want of
 * credentials, and none of them touch the network.
 */
export function registerDiscoveryTools(server: McpServer, workspace: Workspace): void {
  registerTool(server, workspace, {
    name: 'bookrail_docs_search',
    title: 'Search the Bookrail documentation',
    description: [
      'Searches the Bookrail documentation packaged with this server and returns the matching pages, ranked, each with the lines that matched.',
      'Use it whenever you are about to guess: how availability is computed, what a config field means, what an error code means, how holds and bookings relate.',
      'Returns: `{ query, hits: [{ topic, title, url, score, excerpts }] }`.',
      'Next: `bookrail_docs_get` with the `topic` of the best hit, for the whole page.',
    ].join('\n'),
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe('Words to look for, e.g. "daylight saving" or "idempotency".'),
      limit: z.number().int().min(1).max(10).default(5).describe('How many pages to return.'),
    },
    annotations: READ_ONLY,
    async run(args) {
      const pages = await readAllPages(workspace);
      const hits = searchPages(pages, args.query, args.limit);
      return {
        ok: true,
        environment: 'test',
        data: { query: args.query, hits, pages_searched: pages.length },
        next_steps:
          hits.length === 0
            ? [
                `Nothing matched. The pages are: ${pages.map((page) => page.topic).join(', ')}. Call bookrail_docs_get with one of them.`,
              ]
            : [
                `Read the whole page: bookrail_docs_get with path "${hits[0]?.topic ?? ''}".`,
                'Call bookrail_edge_cases if you are deciding whether Bookrail already handles a case you were about to build.',
              ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_docs_get',
    title: 'Read one documentation page',
    description: [
      'Returns one page of the Bookrail documentation as markdown, offline. With no `path`, lists the pages available.',
      'Use it after `bookrail_docs_search`, or directly when you know the page: `getting-started`, `config`, `entities`, `api`, `errors`, `timezones`, `agents`.',
      'Returns: `{ topic, title, markdown, url }`, or `{ topics: [...] }` when `path` is omitted.',
      'Next: `bookrail_schema` for the exact shape of the configuration, then `bookrail_config_validate`.',
    ].join('\n'),
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('The page name, e.g. "config". Omit to list every page. A prefix is enough.'),
    },
    annotations: READ_ONLY,
    async run(args) {
      if (args.path === undefined || args.path.trim() === '') {
        const topics = await listPages(workspace);
        return {
          ok: true,
          environment: 'test',
          data: { topics },
          next_steps: ['Call bookrail_docs_get again with one of `topics[].topic` as `path`.'],
        };
      }
      const page = await readPage(workspace, args.path.trim());
      return {
        ok: true,
        environment: 'test',
        data: page,
        next_steps: [
          'Call bookrail_schema with entity "config" for the JSON Schema of bookrail.config.ts.',
          'Call bookrail_examples with a vertical for a complete working model.',
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_schema',
    title: 'JSON Schema of the configuration or of one entity',
    description: [
      'Returns the JSON Schema of `bookrail.config.ts`, or of one of its collections, generated from the same Zod schemas that validate a push, so a config written against it cannot be refused for a field that does not exist.',
      'Use it before writing or editing a configuration, and whenever `bookrail_config_validate` reported a field you do not recognise.',
      `Entities: config, ${SCHEMA_TARGETS.filter((name) => name !== 'config').join(', ')}.`,
      'Returns: the JSON Schema object, or `{ schemas: [...] }` when `entity` is omitted.',
      'Next: `bookrail_config_validate`, then `bookrail_config_push` with dry_run: true.',
    ].join('\n'),
    inputSchema: {
      entity: z.enum(SCHEMA_TARGETS).optional().describe('Which schema. Omit to list them.'),
    },
    annotations: READ_ONLY,
    async run(args, ctx) {
      const envelope = await ctx.cliOffline([
        'schema',
        ...(args.entity === undefined ? [] : [args.entity]),
      ]);
      return {
        ok: true,
        environment: 'test',
        data: envelope.data,
        next_steps: envelope.next_steps ?? [
          'Write the configuration, then call bookrail_config_validate with it.',
        ],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_examples',
    title: 'A complete working model of a vertical',
    description: [
      'Returns a complete, valid `bookrail.config.ts` for one vertical, plus the calls that follow it in order.',
      'Use it as the starting point for modelling a business: pick the closest vertical, then edit it. It is faster and safer than writing a configuration from the schema alone.',
      `Verticals: ${TEMPLATE_NAMES.join(', ')}.`,
      'Returns: `{ vertical, summary, config, config_file, calls }`. `config` is the object to pass to `bookrail_config_push`.',
      'Next: `bookrail_config_validate` with your edited config, then `bookrail_config_push` with dry_run: true.',
    ].join('\n'),
    inputSchema: {
      vertical: z
        .enum(TEMPLATE_NAMES as [string, ...string[]])
        .optional()
        .describe('Which vertical. Omit to list them with one line each.'),
      framework: z
        .string()
        .optional()
        .describe(
          'nextjs, nuxt, sveltekit, expo, ts or node to get the calls in TypeScript instead of curl.',
        ),
    },
    annotations: READ_ONLY,
    async run(args, ctx) {
      const envelope = await ctx.cliOffline([
        'examples',
        ...(args.vertical === undefined ? [] : [args.vertical]),
        ...(args.framework === undefined ? [] : ['--framework', args.framework]),
      ]);
      return {
        ok: true,
        environment: 'test',
        data: envelope.data,
        next_steps: envelope.next_steps ?? [],
      };
    },
  });

  registerTool(server, workspace, {
    name: 'bookrail_edge_cases',
    title: 'The edge cases Bookrail already handles',
    description: [
      'Returns the list of booking edge cases Bookrail handles, with how it handles each: simultaneous requests for the last seat, holds expiring mid-flow, schedule changes that orphan a booking, capacity reductions, overlapping buffers, bookings across midnight and across a clock change, splits across a group, blocks, pricing rules on a band that wraps midnight or on an hour that does not exist, and the pitfalls of driving the API.',
      'Use it before building anything yourself: most of what looks like "a special case in my business" is already a tested case here.',
      `Topics: ${EDGE_CASE_TOPICS.map((entry) => entry.topic).join(', ')}. Omit to get them all.`,
      'Returns: `{ topics: [{ topic, title, source_page, markdown }] }`.',
      'Next: `bookrail_docs_get` for the whole page a topic came from.',
    ].join('\n'),
    inputSchema: {
      topic: z
        .enum(EDGE_CASE_TOPIC_NAMES)
        .optional()
        .describe('Narrow to one topic. Omit for all of them.'),
    },
    annotations: READ_ONLY,
    async run(args) {
      const wanted = EDGE_CASE_TOPICS.filter(
        (entry) => args.topic === undefined || entry.topic === args.topic,
      );
      const topics = [];
      for (const entry of wanted) {
        const page = await readPage(workspace, entry.page);
        const markdown = sectionOf(page.markdown, entry.heading);
        if (markdown === '') {
          throw new CliError(
            'docs_section_missing',
            `The packaged page "${entry.page}" no longer has a section "${entry.heading ?? ''}".`,
            {
              fix:
                'Reinstall @bookrail/mcp and the bookrail CLI at the same version, or call bookrail_docs_get with path "' +
                entry.page +
                '".',
            },
          );
        }
        topics.push({
          topic: entry.topic,
          title: entry.title,
          source_page: entry.page,
          source_url: page.url,
          markdown,
        });
      }
      return {
        ok: true,
        environment: 'test',
        data: { topics },
        next_steps: [
          'Call bookrail_docs_get with the `source_page` of a topic to read it in context.',
          'Call bookrail_examples with the closest vertical to start modelling instead of building this yourself.',
        ],
      };
    },
  });
}
