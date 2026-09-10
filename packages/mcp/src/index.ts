#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { guardStdout } from './stdout-guard.js';

/**
 * `npx @bookrail/mcp`: the server over stdio.
 *
 * Two lines matter here.
 *
 * The **guard comes first**, before anything else can print: from that point on the only way
 * to reach the real stdout is the writable the transport is given, and every other write,
 * including one from a dependency loaded later, lands on stderr with a marker instead of
 * corrupting the JSON-RPC stream.
 *
 * The **failure path also goes to stderr**, and exits non-zero, because a stdio server that
 * dies quietly looks to the client exactly like a server that answered nothing.
 */
const guard = guardStdout({ stdout: process.stdout, stderr: process.stderr });

try {
  const { server, workspace } = createServer();
  workspace.logger.info('starting', {
    cwd: workspace.cwd,
    live_allowed: workspace.env.BOOKRAIL_MCP_ALLOW_LIVE === '1',
  });
  await server.connect(new StdioServerTransport(process.stdin, guard.protocol));
  workspace.logger.info('connected over stdio');
} catch (error) {
  process.stderr.write(
    `[bookrail-mcp] error failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  guard.restore();
  process.exitCode = 1;
}
