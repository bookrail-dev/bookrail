import { CommanderError, type Command } from 'commander';
import { CliError, EXIT, type ExitCode } from './errors.js';
import type { Io } from './io.js';
import { createPresenter } from './output.js';
import { buildProgram, toCliError, type Outcome } from './program.js';

/**
 * Runs one CLI invocation and returns its exit code. It never touches `process`.
 *
 * `commander` is put in `exitOverride` mode so that `--help`, `--version` and a usage error
 * come back as exceptions instead of killing the process: a test runs a hundred invocations
 * inside one process, and the MCP server runs them inside a long-lived one.
 */
export async function run(argv: string[], io: Io): Promise<ExitCode> {
  const outcome: Outcome = { code: EXIT.ok };
  // Read before parsing, because a usage error has to be reported in the shape the caller
  // asked for and `commander` fails before any option is available.
  const json = argv.includes('--json');
  const live = argv.includes('--live');

  const program = buildProgram(io, outcome);
  program.exitOverride();
  program.configureOutput({
    writeOut: (text: string) => {
      if (!json) io.stdout(text);
    },
    writeErr: (text: string) => {
      if (!json) io.stderr(text);
    },
  });
  for (const command of allCommands(program)) {
    command.exitOverride();
    command.configureOutput({
      writeOut: (text: string) => {
        if (!json) io.stdout(text);
      },
      writeErr: (text: string) => {
        if (!json) io.stderr(text);
      },
    });
  }

  try {
    await program.parseAsync(['node', 'bookrail', ...argv]);
    return outcome.code;
  } catch (error) {
    if (error instanceof CommanderError) {
      const presenter = createPresenter(io, { json, environment: live ? 'live' : 'test' });
      if (error.exitCode === 0) {
        // `--help` and `--version`. With `--json` the text was swallowed above, so the
        // structured form is emitted instead of nothing at all.
        if (json) presenter.emit({ data: { output: error.message ?? '' } });
        return EXIT.ok;
      }
      return presenter.fail(
        new CliError('invalid_usage', usageMessage(error), {
          fix: 'Run `bookrail --help`, or `bookrail <command> --help`.',
          exitCode: EXIT.user,
        }),
      );
    }
    const presenter = createPresenter(io, { json, environment: live ? 'live' : 'test' });
    return presenter.fail(toCliError(error));
  }
}

function usageMessage(error: CommanderError): string {
  const message = error.message.trim();
  return message === '' ? `Invalid usage (${error.code}).` : message.replace(/^error:\s*/i, '');
}

function allCommands(command: Command): Command[] {
  const out: Command[] = [];
  for (const child of command.commands) {
    out.push(child, ...allCommands(child));
  }
  return out;
}
