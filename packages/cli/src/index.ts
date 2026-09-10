#!/usr/bin/env node
import { processIo } from './io.js';
import { run } from './run.js';

/**
 * The `bookrail` binary.
 *
 * Everything it does is call {@link run} and set the exit code: the process boundary is one
 * file, so the whole CLI is testable in-process and reusable from the MCP server.
 */
const code = await run(process.argv.slice(2), processIo());
process.exitCode = code;
