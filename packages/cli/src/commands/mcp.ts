import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import type { Io } from '../io.js';
import { renderTable, type CommandResult } from '../output.js';

/** The npm package `npx` runs, and the name the entry gets in every client. */
const PACKAGE = '@bookrail/mcp';
const SERVER_NAME = 'bookrail';

export interface ClientDescriptor {
  /** `--client <name>`. */
  name: string;
  label: string;
  /**
   * Where the file lives. `project` is relative to the working directory (and the
   * configuration is then committed with the repository); `home` is the user's own file.
   */
  scope: 'project' | 'home' | 'none';
  /** Path segments, joined onto the working directory or the home directory. */
  segments: string[];
  /** The object inside the file that holds the servers, by name. */
  key: 'mcpServers' | 'servers';
  /** Extra fields on the entry. VS Code wants the transport spelled out. */
  extra?: Record<string, unknown>;
}

/**
 * The five clients this command can install into, each with the file and the shape it reads.
 *
 * The differences are small and entirely arbitrary (`mcpServers` versus `servers`, a `type`
 * field or not, project directory versus home directory), which is exactly why this command
 * exists: they are four chances to write a working configuration into a file nobody reads.
 */
export const MCP_CLIENTS: ClientDescriptor[] = [
  {
    name: 'claude-code',
    label: 'Claude Code (project scope, committed with the repository)',
    scope: 'project',
    segments: ['.mcp.json'],
    key: 'mcpServers',
  },
  {
    name: 'cursor',
    label: 'Cursor (project scope)',
    scope: 'project',
    segments: ['.cursor', 'mcp.json'],
    key: 'mcpServers',
  },
  {
    name: 'vscode',
    label: 'VS Code (workspace scope)',
    scope: 'project',
    segments: ['.vscode', 'mcp.json'],
    key: 'servers',
    extra: { type: 'stdio' },
  },
  {
    name: 'windsurf',
    label: 'Windsurf (user scope)',
    scope: 'home',
    segments: ['.codeium', 'windsurf', 'mcp_config.json'],
    key: 'mcpServers',
  },
  {
    name: 'generic',
    label: 'Any other client: prints the snippet, writes nothing',
    scope: 'none',
    segments: [],
    key: 'mcpServers',
  },
];

export const MCP_CLIENT_NAMES = MCP_CLIENTS.map((client) => client.name);

function clientByName(name: string | undefined): ClientDescriptor {
  const found = MCP_CLIENTS.find((client) => client.name === name);
  if (!found) {
    throw new CliError('unknown_client', `No MCP client named "${name ?? ''}".`, {
      param: 'client',
      fix: `Pass \`--client <name>\` with one of: ${MCP_CLIENT_NAMES.join(', ')}.`,
    });
  }
  return found;
}

function pathFor(io: Io, client: ClientDescriptor): string | null {
  if (client.scope === 'none') return null;
  const base = client.scope === 'project' ? io.cwd : io.home;
  const relative = join(...client.segments);
  return isAbsolute(relative) ? relative : resolvePath(base, relative);
}

function entryFor(client: ClientDescriptor): Record<string, unknown> {
  return { ...(client.extra ?? {}), command: 'npx', args: ['-y', PACKAGE] };
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError('client_config_unreadable', `Could not read ${path}: ${String(error)}`, {
      fix: `Check the permissions of ${path}.`,
    });
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Refused rather than overwritten: the file belongs to the user's editor and may hold
    // half a dozen other servers. Losing them to make room for this one is not an upgrade.
    throw new CliError('client_config_corrupt', `${path} is not valid JSON.`, {
      fix: `Fix the JSON in ${path}, or move it aside, then run the command again. \`bookrail mcp install --client generic\` prints the snippet to paste by hand.`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError('client_config_corrupt', `${path} does not contain a JSON object.`, {
      fix: `Replace the contents of ${path} with \`{}\` and run the command again.`,
    });
  }
  return parsed as Record<string, unknown>;
}

export interface McpInstallOptions {
  client?: string;
  dryRun?: boolean;
}

/**
 * `bookrail mcp install --client ...`.
 *
 * One command instead of a page of instructions per editor. Two things it does not do:
 *
 * - **It never rewrites the file.** The existing object is read, the `bookrail` entry is set,
 *   and everything else (other servers, unrelated keys, the user's own settings) is written
 *   back untouched. A file that does not parse is refused, not replaced.
 * - **It never writes a secret.** The entry is `npx -y @bookrail/mcp` and nothing else: the
 *   server finds the key the same way the CLI does, from `BOOKRAIL_SECRET_KEY` or from
 *   `~/.config/bookrail/credentials.json`. A key pasted into an editor configuration is a key
 *   in a repository, and no part of Bookrail ever writes a key where something can read it.
 */
export async function mcpInstall(ctx: Context, options: McpInstallOptions): Promise<CommandResult> {
  if (options.client === undefined) {
    return {
      data: {
        clients: MCP_CLIENTS.map((client) => ({
          client: client.name,
          scope: client.scope,
          path: pathFor(ctx.io, client),
          key: client.key,
        })),
      },
      human: [
        `${ctx.presenter.badge()} MCP clients this command can configure`,
        '',
        renderTable(
          ['client', 'file'],
          MCP_CLIENTS.map((client) => [
            client.name,
            pathFor(ctx.io, client) ?? '(prints a snippet)',
          ]),
        ),
        '',
        'Run `bookrail mcp install --client <name>`, or add `--dry-run` to see what it would write.',
      ].join('\n'),
      nextSteps: [`Run \`bookrail mcp install --client ${MCP_CLIENT_NAMES[0] ?? 'claude-code'}\`.`],
    };
  }

  const client = clientByName(options.client);
  const entry = entryFor(client);
  const path = pathFor(ctx.io, client);

  if (path === null) {
    const snippet = { [client.key]: { [SERVER_NAME]: entry } };
    return {
      data: {
        client: client.name,
        path: null,
        written: false,
        dry_run: options.dryRun === true,
        entry,
        snippet,
      },
      human: [
        `${ctx.presenter.badge()} paste this into your MCP client configuration:`,
        '',
        JSON.stringify(snippet, null, 2),
      ].join('\n'),
      nextSteps: [
        'Restart the client so it picks the server up.',
        'Run `bookrail login` first if you have not: the server reads the same credentials file.',
        'To let the server touch the live environment, add `"env": { "BOOKRAIL_MCP_ALLOW_LIVE": "1" }` to the entry and store a live key. Without it every tool call runs against test.',
      ],
    };
  }

  const existing = await readJsonObject(path);
  const current = existing ?? {};
  const servers = (
    typeof current[client.key] === 'object' &&
    current[client.key] !== null &&
    !Array.isArray(current[client.key])
      ? { ...(current[client.key] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const replaced = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  servers[SERVER_NAME] = entry;
  const next = { ...current, [client.key]: servers };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  const action = existing === null ? 'create' : replaced ? 'replace' : 'add';

  if (options.dryRun === true) {
    return {
      data: {
        client: client.name,
        path,
        written: false,
        dry_run: true,
        action,
        entry,
        contents: next,
        preserved: Object.keys(servers).filter((name) => name !== SERVER_NAME),
      },
      human: [
        `${ctx.presenter.badge()} would ${action} the "${SERVER_NAME}" server in ${path}`,
        '',
        contents.trimEnd(),
      ].join('\n'),
      nextSteps: [`Run the same command without \`--dry-run\` to write ${path}.`],
    };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');

  return {
    data: {
      client: client.name,
      path,
      written: true,
      dry_run: false,
      action,
      entry,
      preserved: Object.keys(servers).filter((name) => name !== SERVER_NAME),
    },
    human: `${ctx.presenter.badge()} ${action === 'create' ? 'wrote' : 'updated'} ${path} (${client.label})`,
    nextSteps: [
      'Restart the client so it picks the server up.',
      'Run `bookrail login` if you have not: the MCP server reads the same credentials file, and no key was written into the client configuration.',
      'To let the server touch the live environment, add `"env": { "BOOKRAIL_MCP_ALLOW_LIVE": "1" }` to the entry and store a live key. Without it every tool call runs against test.',
    ],
  };
}

/** Only used by the tests, to check the file a client would get without writing it. */
export async function mcpConfigPath(io: Io, name: string): Promise<string | null> {
  const client = clientByName(name);
  const path = pathFor(io, client);
  if (path === null) return null;
  try {
    await stat(path);
  } catch {
    /* the caller only wants the path */
  }
  return path;
}
