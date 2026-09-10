import { CliError, EXIT, run, type Io } from 'bookrail';
import type { Environment, Workspace } from './environment.js';
import { resolveKey } from './environment.js';

/**
 * The envelope every `bookrail ... --json` invocation prints, and the envelope every tool of
 * this server returns.
 */
export interface Envelope {
  ok: boolean;
  environment: Environment;
  data?: unknown;
  next_steps?: string[];
  error?: {
    code: string;
    message: string;
    param?: string;
    doc_url: string;
    fix?: string;
    request_id?: string;
  };
}

/**
 * The whole of this package's access to Bookrail: the CLI's own command layer, driven
 * in-process.
 *
 * The rule this package is built on is that it reuses the CLI's API client and configuration
 * validation instead of duplicating them, and it is the design `packages/cli` was already
 * built for: `run()` never touches `process`, and `Io` exists precisely so that a host can
 * drive the same command layer with an `Io` that writes nowhere (`packages/cli/src/io.ts`).
 *
 * Driving the commands rather than the `ApiClient` buys three things a hand-written client
 * would have had to reimplement and then keep in step:
 *
 *  - the **input validation** that refuses a bare date or a `--customer` together with
 *    `--customer-email` before any request leaves the process;
 *  - the `next_steps` of every command, which a tool result has to carry so that an agent is
 *    never left guessing what to call next, and which the CLI already writes per command;
 *  - the **error contract**: `{ code, message, param?, doc_url, fix?, request_id? }`, the same
 *    body an agent would have read from the CLI, so the two interfaces cannot disagree about
 *    what went wrong.
 *
 * The one thing this function adds is the barrier: {@link resolveKey} runs first, and a
 * refusal there means no `Io` is built, no argv is parsed and no socket is opened.
 */
export async function runCli(
  workspace: Workspace,
  environment: Environment,
  argv: string[],
): Promise<Envelope> {
  const key = await resolveKey(workspace, environment);
  return runCliWithKey(workspace, environment, argv, key.secretKey);
}

/** The half of {@link runCli} after the barrier. Only `runCli` and the offline tools call it. */
export async function runCliWithKey(
  workspace: Workspace,
  environment: Environment,
  argv: string[],
  secretKey: string | undefined,
): Promise<Envelope> {
  let stdout = '';
  const io: Io = {
    env: {
      ...workspace.env,
      // Whatever the ambient variable held, the key for *this* call is the one the barrier
      // chose. The CLI checks the prefix against the environment again on its own side.
      ...(secretKey === undefined ? {} : { BOOKRAIL_SECRET_KEY: secretKey }),
      // This process is the MCP server, so every request it makes says so: the API writes it
      // into `events.actor.via`, which is what makes a write done through an agent tellable
      // apart from a write done by the customer's own code, at equal API key. It is set
      // **last**, so an ambient `BOOKRAIL_ACTOR` cannot make this server claim to be something
      // it is not.
      BOOKRAIL_ACTOR: 'mcp',
      NO_COLOR: '1',
    },
    cwd: workspace.cwd,
    home: workspace.home,
    // Never a terminal: nothing here may prompt, and a prompt inside a tool call would hang
    // the client forever.
    isTTY: false,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => workspace.logger.debug(`cli: ${chunk.trimEnd()}`),
    readStdin: async () => '',
  };

  const full = [...argv, '--json', ...(environment === 'live' ? ['--live'] : [])];
  workspace.logger.debug('bookrail', { argv: full });
  const code = await run(full, io);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      'invalid_cli_output',
      `The command \`bookrail ${argv.join(' ')}\` produced no JSON envelope (exit ${String(code)}).`,
      {
        fix: 'This is a bug in @bookrail/mcp. Re-run the same command in a shell with --json and report the output.',
        exitCode: EXIT.service,
      },
    );
  }

  const envelope = parsed as Envelope;
  if (envelope.ok === false && envelope.error !== undefined) {
    throw new CliError(envelope.error.code, envelope.error.message, {
      param: envelope.error.param,
      fix: envelope.error.fix,
      requestId: envelope.error.request_id,
      docUrl: envelope.error.doc_url,
      exitCode: exitCodeOf(code),
    });
  }
  return envelope;
}

function exitCodeOf(code: number): (typeof EXIT)[keyof typeof EXIT] {
  const known = Object.values(EXIT).find((value) => value === code);
  return known ?? EXIT.service;
}
