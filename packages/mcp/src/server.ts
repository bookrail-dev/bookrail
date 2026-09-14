import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CLI_VERSION } from 'bookrail';
import { createLogger, parseLevel, type Logger } from './log.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerAvailabilityTools } from './tools/availability.js';
import { registerBookingTools } from './tools/bookings.js';
import { registerConfigTools } from './tools/config.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerObjectTools } from './tools/objects.js';
import { registerObservabilityTools } from './tools/observability.js';
import { registerProjectTools } from './tools/project.js';
import type { Workspace } from './environment.js';

export const MCP_VERSION = '0.3.1';

export interface CreateServerOptions {
  /** The project directory: where `bookrail.config.ts` is looked for. Default: `process.cwd()`. */
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Where diagnostics go. Never stdout. Default: a logger on `process.stderr`. */
  logger?: Logger;
}

/**
 * The Bookrail MCP server.
 *
 * It is a value, not a process: the transport is chosen by the caller. `index.ts` gives it
 * stdio, the test suite gives it an in-memory pair, and a hosted remote server, when there is
 * one, will give it a streamable HTTP one without touching anything here. Nothing in this file,
 * or in anything it registers, writes to a stream.
 */
export function createServer(options: CreateServerOptions = {}): {
  server: McpServer;
  workspace: Workspace;
} {
  const env = options.env ?? process.env;
  const logger =
    options.logger ??
    createLogger(parseLevel(env.BOOKRAIL_MCP_LOG), (chunk) => void process.stderr.write(chunk));

  const workspace: Workspace = {
    cwd: options.cwd ?? process.cwd(),
    home: options.home ?? homedir(),
    env,
    logger,
  };

  const server = new McpServer(
    { name: 'bookrail', version: MCP_VERSION },
    {
      instructions: [
        'Bookrail is booking infrastructure: availability, holds, bookings, policies, webhooks.',
        '',
        'The recommended order is: bookrail_project_info, then bookrail_examples for the closest',
        'vertical, then bookrail_config_validate, then bookrail_config_push with dry_run: true,',
        'then bookrail_config_push with dry_run: false and confirm: true, then bookrail_objects_list',
        'to read back the svc_ ids, then bookrail_availability, then bookrail_booking_create.',
        '',
        'Two rules that are enforced, not advisory:',
        '- every tool defaults to environment "test"; "live" is refused unless this server was',
        '  started with BOOKRAIL_MCP_ALLOW_LIVE=1 and a live key is configured;',
        '- irreversible tools (deletes, cancel, an applied push) do nothing without confirm: true.',
        '  Without it they return a preview and requires_confirmation: true.',
        '',
        'Every result is { ok, environment, data, next_steps? }. An error carries { code, message,',
        'fix, doc_url }: act on `fix`. Instants in must carry an explicit offset; instants out are UTC.',
        `This server drives the bookrail CLI ${CLI_VERSION} in-process, so the two never disagree.`,
      ].join('\n'),
      capabilities: { logging: {} },
    },
  );

  registerDiscoveryTools(server, workspace);
  registerProjectTools(server, workspace);
  registerConfigTools(server, workspace);
  registerAvailabilityTools(server, workspace);
  registerBookingTools(server, workspace);
  registerObjectTools(server, workspace);
  registerObservabilityTools(server, workspace);
  registerResources(server, workspace);
  registerPrompts(server, workspace);

  return { server, workspace };
}

/** Connects a created server to a transport. Kept separate so a test can pick its own. */
export async function connect(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
}

export type { Workspace } from './environment.js';
export type { Logger } from './log.js';
export { createLogger, parseLevel, silentLogger } from './log.js';
export { guardStdout } from './stdout-guard.js';
export { OBJECT_KINDS } from './tools/objects.js';
