import { EXIT, type CliError, type CliErrorBody, type ExitCode } from './errors.js';
import type { Io } from './io.js';
import type { Environment } from './version.js';

/**
 * The object every `--json` invocation prints, the same for every command and for every outcome:
 * `ok` and `environment` always, then `data` on success or `error` on failure, and `next_steps`
 * when there is something to run next.
 */
export interface JsonEnvelope {
  ok: boolean;
  environment: Environment;
  data?: unknown;
  error?: CliErrorBody;
  next_steps?: string[];
}

export interface CommandResult {
  /** The machine-readable payload; becomes `data` in the JSON envelope. */
  data: unknown;
  /** What an agent should do next; printed as `next_steps` in the JSON envelope. */
  nextSteps?: string[];
  /** Human rendering. Omitted means "print the data as indented JSON". */
  human?: string;
  /** Non-zero exit for a command that ran to completion but reported a problem. */
  exitCode?: ExitCode;
}

const ESC = '\u001b';

const COLOR_CODES = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const;

export type ColorName = Exclude<keyof typeof COLOR_CODES, 'reset'>;

/**
 * Colour is on only for a real terminal that has not asked for it to be off, and never for
 * `--json`. There is no `--color=always`: an agent reading the output is the default reader,
 * and the structured form has to stay parseable, so it is the one that is never decorated.
 */
export function colorEnabled(io: Io, json: boolean): boolean {
  if (json || !io.isTTY) return false;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== '') return false;
  if (io.env.TERM === 'dumb') return false;
  return true;
}

export function makePaint(enabled: boolean): (name: ColorName, text: string) => string {
  return (name, text) => (enabled ? `${COLOR_CODES[name]}${text}${COLOR_CODES.reset}` : text);
}

export interface Presenter {
  json: boolean;
  environment: Environment;
  paint(name: ColorName, text: string): string;
  /** `[test]` / `[LIVE]`: every output declares which environment it ran against. */
  badge(): string;
  print(line: string): void;
  warn(line: string): void;
  emit(result: CommandResult): ExitCode;
  fail(error: CliError): ExitCode;
}

export function createPresenter(
  io: Io,
  options: { json: boolean; environment: Environment },
): Presenter {
  const paint = makePaint(colorEnabled(io, options.json));
  const badge = (): string =>
    options.environment === 'live' ? paint('yellow', '[LIVE]') : paint('dim', '[test]');

  return {
    json: options.json,
    environment: options.environment,
    paint,
    badge,
    print: (line) => io.stdout(`${line}\n`),
    warn: (line) => io.stderr(`${line}\n`),
    emit(result) {
      if (options.json) {
        const envelope: JsonEnvelope = {
          ok: true,
          environment: options.environment,
          data: result.data,
        };
        if (result.nextSteps && result.nextSteps.length > 0) envelope.next_steps = result.nextSteps;
        io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const body = result.human ?? JSON.stringify(result.data, null, 2);
        if (body !== '') io.stdout(`${body}\n`);
        if (result.nextSteps && result.nextSteps.length > 0) {
          io.stdout(`\n${paint('bold', 'Next steps')}\n`);
          for (const step of result.nextSteps) io.stdout(`  - ${step}\n`);
        }
      }
      return result.exitCode ?? EXIT.ok;
    },
    fail(error) {
      if (options.json) {
        const envelope: JsonEnvelope = {
          ok: false,
          environment: options.environment,
          error: error.toBody(),
        };
        io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        io.stderr(`${paint('red', 'Error')} [${error.code}] ${error.message}\n`);
        if (error.param !== undefined) io.stderr(`  param: ${error.param}\n`);
        if (error.requestId !== undefined) io.stderr(`  request id: ${error.requestId}\n`);
        if (error.fix !== undefined) io.stderr(`  ${paint('bold', 'Fix:')} ${error.fix}\n`);
        io.stderr(`  ${error.docUrl}\n`);
      }
      return error.exitCode;
    },
  };
}

/**
 * A plain, alignment-only table. No dependency: a booking CLI that pulled a rendering library
 * in for six columns would pay for it on every cold `npx` start.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  const out = [
    line(headers),
    widths
      .map((width) => '-'.repeat(width))
      .join('  ')
      .trimEnd(),
  ];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
