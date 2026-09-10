import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { CliError, ENTITY_KINDS, findConfigFile, loadConfig } from 'bookrail';
import { runCli, runCliWithKey } from './cli.js';
import { listPages, readPage } from './docs.js';
import { ioOf, type Workspace } from './environment.js';

const SCHEMA_TARGETS = ['config', ...ENTITY_KINDS];

function json(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) },
    ],
  };
}

function markdown(uri: URL, text: string): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
}

/**
 * The four resources this server publishes.
 *
 * A resource is what a client can attach to a conversation without spending a tool call, so
 * these are the four things an agent wants *in front of it* rather than fetched: the
 * documentation, the schema it must write against, the configuration in the working directory,
 * and who it is talking to.
 *
 * **`bookrail://config` and `bookrail://project` are re-read on every read.** This server is a
 * process that lives for hours: the agent edits `bookrail.config.ts` between two reads, and a
 * cached answer would be a lie. `loadConfig` appends a cache-busting query to the dynamic
 * import for exactly this reason.
 */
export function registerResources(server: McpServer, workspace: Workspace): void {
  server.registerResource(
    'bookrail-docs',
    new ResourceTemplate('bookrail://docs/{path}', {
      list: async () => {
        const topics = await listPages(workspace);
        return {
          resources: topics.map((topic) => ({
            uri: `bookrail://docs/${topic.topic}`,
            name: topic.topic,
            title: topic.title,
            mimeType: 'text/markdown',
          })),
        };
      },
      complete: {
        path: async (value) => {
          const topics = await listPages(workspace);
          return topics
            .map((topic) => topic.topic)
            .filter((topic) => topic.startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      title: 'Bookrail documentation',
      description:
        'The documentation packaged with the CLI, offline: getting-started, config, entities, api, errors, timezones, agents.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const path = String(Array.isArray(variables.path) ? variables.path[0] : variables.path);
      const page = await readPage(workspace, path);
      return markdown(uri, page.markdown);
    },
  );

  server.registerResource(
    'bookrail-schema',
    new ResourceTemplate('bookrail://schema/{entity}', {
      list: () => ({
        resources: SCHEMA_TARGETS.map((entity) => ({
          uri: `bookrail://schema/${entity}`,
          name: entity,
          title:
            entity === 'config'
              ? 'JSON Schema of the whole bookrail.config.ts'
              : `JSON Schema of one \`${entity}\` entry`,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        entity: (value) => SCHEMA_TARGETS.filter((entity) => entity.startsWith(value)),
      },
    }),
    {
      title: 'Bookrail configuration schemas',
      description:
        'JSON Schema of the configuration and of each of its collections, generated from the same Zod schemas a push validates with.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const entity = String(
        Array.isArray(variables.entity) ? variables.entity[0] : variables.entity,
      );
      if (!SCHEMA_TARGETS.includes(entity)) {
        throw new CliError('unknown_entity', `No schema named "${entity}".`, {
          fix: `Use one of: ${SCHEMA_TARGETS.join(', ')}.`,
        });
      }
      const envelope = await runCliWithKey(workspace, 'test', ['schema', entity], undefined);
      return json(uri, envelope.data);
    },
  );

  server.registerResource(
    'bookrail-config',
    'bookrail://config',
    {
      title: 'bookrail.config.ts in the working directory',
      description:
        'The configuration file of the project this server was started in, re-read on every access, with its validation issues if it has any.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const io = ioOf(workspace);
      const path = await findConfigFile(io, undefined);
      if (path === null) {
        return json(uri, {
          present: false,
          directory: workspace.cwd,
          fix: 'Write bookrail.config.ts here, or call the tool bookrail_examples for a working one.',
        });
      }
      try {
        const loaded = await loadConfig(io);
        return json(uri, {
          present: true,
          path: loaded.path,
          loader: loaded.loader,
          valid: true,
          config: loaded.config,
        });
      } catch (error) {
        const cliError = error instanceof CliError ? error : null;
        return json(uri, {
          present: true,
          path,
          valid: false,
          error: cliError?.toBody() ?? { message: String(error) },
        });
      }
    },
  );

  server.registerResource(
    'bookrail-project',
    'bookrail://project',
    {
      title: 'The project this server is authenticated against',
      description:
        'Project, key (masked), API URL and version for the test environment, and whether live is reachable at all from this server.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const envelope = await runCli(workspace, 'test', ['whoami']);
        return json(uri, { authenticated: true, ...(envelope.data as object) });
      } catch (error) {
        const cliError = error instanceof CliError ? error : null;
        // A resource that threw would show the client an empty panel. The reason and its fix
        // are more useful than an error frame, and this is the resource an agent reads exactly
        // when nothing is configured yet.
        return json(uri, {
          authenticated: false,
          error: cliError?.toBody() ?? { message: String(error) },
        });
      }
    },
  );
}
