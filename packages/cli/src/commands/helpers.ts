import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { ApiClient } from '../api/client.js';
import type { Context } from '../context.js';
import { CliError, EXIT } from '../errors.js';

/**
 * The values `Bookrail-Actor` accepts. Closed, and the same list the API validates against: a
 * value outside it is a 400 there, so sending one from here would only turn every command into
 * an error.
 */
const ACTORS = new Set(['mcp', 'cli', 'sdk', 'dashboard']);

/**
 * Which of Bookrail's own tools this process is, for the event log.
 *
 * `cli` by default, because that is what this process is. The rule is that **no process
 * declares itself something it is not**, and the one process that is not the CLI while running
 * the CLI is the MCP server, which drives `run(argv, io)` in-process: it hands down an `Io`
 * whose `env` carries `BOOKRAIL_ACTOR=mcp`, and that is the only reason this is read from the
 * environment at all.
 *
 * A value outside the closed list is ignored rather than fatal. It is a claim about provenance,
 * not a credential; a stray environment variable should not make every command fail, and the
 * fallback, `cli`, is still true of the process that is running.
 */
export function actorOf(ctx: Context): string {
  const declared = ctx.io.env.BOOKRAIL_ACTOR?.trim();
  return declared !== undefined && ACTORS.has(declared) ? declared : 'cli';
}

export async function clientFor(ctx: Context): Promise<ApiClient> {
  const [auth, baseUrl] = await Promise.all([ctx.auth(), ctx.apiUrl()]);
  return new ApiClient({
    baseUrl,
    secretKey: auth.secretKey,
    environment: auth.environment,
    actor: actorOf(ctx),
    ...(ctx.options.timeout === undefined ? {} : { timeoutMs: ctx.options.timeout }),
  });
}

/**
 * The body of a `create` or `update`, from `--file`, `--data` or repeated `--set`.
 *
 * Three ways in, because the three callers are different: a human types `--set`, a script
 * pipes JSON on `--file -`, and an agent that already has the object passes `--data`.
 */
export interface BodyOptions {
  file?: string;
  data?: string;
  set?: string[];
}

export async function readBody(
  ctx: Context,
  options: BodyOptions,
  what: string,
): Promise<Record<string, unknown>> {
  const body = await readOptionalBody(ctx, options);
  if (Object.keys(body).length === 0) {
    throw new CliError('missing_input', `No fields given for ${what}.`, {
      param: 'data',
      fix: 'Pass `--data \'{"name":"..."}\'`, `--file body.json` (or `--file -` for stdin), or one or more `--set key=value`.',
      exitCode: EXIT.user,
    });
  }
  return body;
}

/**
 * The same three ways in, without requiring that any of them was used.
 *
 * The operational commands build most of the body from named flags
 * (`--service`, `--start`, ...) and let `--data` / `--file` / `--set` add or override the rest,
 * so for them an empty body is normal rather than a mistake.
 */
export async function readOptionalBody(
  ctx: Context,
  options: BodyOptions,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};

  if (options.file !== undefined) {
    const text =
      options.file === '-'
        ? await ctx.io.readStdin()
        : await readFile(
            isAbsolute(options.file) ? options.file : resolvePath(ctx.io.cwd, options.file),
            'utf8',
          );
    body = { ...body, ...parseObject(text, `--file ${options.file}`) };
  }

  if (options.data !== undefined) {
    body = { ...body, ...parseObject(options.data, '--data') };
  }

  for (const assignment of options.set ?? []) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      throw new CliError('parameter_invalid', `--set expects key=value, got "${assignment}".`, {
        param: 'set',
        fix: 'Write it as `--set name=Court 1` or `--set capacity=4`. JSON values are parsed as JSON.',
      });
    }
    const path = assignment.slice(0, separator);
    const raw = assignment.slice(separator + 1);
    assign(body, path.split('.'), parseScalar(raw));
  }

  return body;
}

function parseObject(text: string, origin: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError('invalid_body', `${origin} is not valid JSON: ${String(error)}`, {
      fix: 'Check the JSON. `bookrail schema <entity> --json` prints the schema of the object.',
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError('invalid_body', `${origin} must be a JSON object.`, {
      fix: 'Wrap the fields in `{ ... }`.',
    });
  }
  return parsed as Record<string, unknown>;
}

/** A `--set` value is JSON when it parses as JSON, and a plain string otherwise. */
function parseScalar(raw: string): unknown {
  if (raw === '') return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function assign(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}

/** A command of a later release, refused with the reason and what to use today. */
export function notYetAvailable(name: string, when: string): CliError {
  return new CliError('not_yet_available', `\`bookrail ${name}\` is not available in this build.`, {
    fix: `It arrives in ${when}. Until then use the HTTP API directly; \`bookrail docs api\` prints the reference.`,
    exitCode: EXIT.user,
  });
}

// --- inputs of the operational commands ------------------------------------------

/** A flag the command cannot run without, refused before any request leaves the process. */
export function required(value: unknown, flag: string, what: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new CliError('missing_input', `--${flag} is required: ${what}.`, {
    param: flag,
    fix: `Pass \`--${flag} <value>\`. Run \`bookrail <command> --help\` to see every flag.`,
    exitCode: EXIT.user,
  });
}

/**
 * An instant carries an explicit offset going in and coming back: the API accepts any offset
 * and answers in UTC.
 *
 * Checked here rather than left to the API on purpose. `--from 2026-09-08` is what a person
 * types first, and it is exactly the input that must **not** be guessed at: expanding it to
 * midnight UTC would silently shift a Rome schedule by two hours. So it is refused, locally,
 * with the form spelled out: no round trip, and no invented time zone.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function instant(value: unknown, flag: string): string {
  const raw = required(value, flag, 'an ISO 8601 instant with an explicit offset');
  if (!ISO_INSTANT.test(raw) || Number.isNaN(new Date(raw).getTime())) {
    throw new CliError(
      'parameter_invalid',
      `--${flag} must be an ISO 8601 instant with an explicit offset, got "${raw}".`,
      {
        param: flag,
        fix: 'Write it as `2026-09-08T07:00:00Z` or `2026-09-08T09:00:00+02:00`. A bare date is refused because midnight is not the same instant in every time zone.',
        exitCode: EXIT.user,
      },
    );
  }
  return raw;
}

export function optionalInstant(value: unknown, flag: string): string | undefined {
  return value === undefined ? undefined : instant(value, flag);
}

/** A whole number from a flag, with the bounds the API documents checked before the call. */
export function integer(
  value: unknown,
  flag: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(
      'parameter_invalid',
      `--${flag} must be a whole number between ${min} and ${max}, got "${String(value)}".`,
      { param: flag, fix: `Pass \`--${flag} ${String(min)}\` or another whole number in range.` },
    );
  }
  return parsed;
}

export function jsonObject(value: unknown, flag: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return parseObject(String(value), `--${flag}`);
}

/** `a,b , c` -> `["a","b","c"]`; repeated flags are concatenated. Empty entries are dropped. */
export function commaList(values: string[] | string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const list = (Array.isArray(values) ? values : [values])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return list.length === 0 ? undefined : list;
}

export interface CustomerOptions {
  customer?: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerExternalId?: string;
}

/**
 * The `customer_id` / `customer` half of a hold or booking body.
 *
 * The two are mutually exclusive and the API answers 400 for both at once; the CLI refuses
 * before the request, because the caller can fix it without the round trip and the `fix` can
 * name the two flags rather than the two JSON fields.
 */
export function customerFields(options: CustomerOptions): Record<string, unknown> {
  const inline: Record<string, unknown> = {};
  if (options.customerEmail !== undefined) inline.email = options.customerEmail;
  if (options.customerName !== undefined) inline.name = options.customerName;
  if (options.customerPhone !== undefined) inline.phone = options.customerPhone;
  if (options.customerExternalId !== undefined) inline.external_id = options.customerExternalId;
  const hasInline = Object.keys(inline).length > 0;

  if (options.customer !== undefined && hasInline) {
    throw new CliError(
      'parameter_invalid',
      'Give either --customer, or the inline --customer-* flags, not both.',
      {
        param: 'customer',
        fix: 'Use `--customer cus_...` for a customer that exists, or `--customer-email ...` to create or find one.',
      },
    );
  }
  if (options.customer !== undefined) return { customer_id: options.customer };
  if (!hasInline) return {};
  if (
    options.customerEmail === undefined &&
    options.customerPhone === undefined &&
    options.customerExternalId === undefined
  ) {
    throw new CliError(
      'parameter_invalid',
      'An inline customer needs at least one of --customer-email, --customer-phone or --customer-external-id.',
      {
        param: 'customer',
        fix: 'Add `--customer-email someone@example.com`, or pass an existing `--customer cus_...`.',
      },
    );
  }
  return { customer: inline };
}

/**
 * The confirmation an irreversible action needs.
 *
 * `--yes` always passes. On a terminal without it the question is asked; anywhere else (a
 * pipe, a CI job, an agent) there is nobody to ask, so the answer is an error naming the flag
 * rather than a prompt nobody will ever see.
 */
export async function confirm(
  ctx: Context,
  question: string,
  options: { yes?: boolean },
  fix: string,
): Promise<void> {
  if (options.yes === true) return;
  if (ctx.options.nonInteractive || ctx.io.prompt === undefined) {
    throw new CliError('confirmation_required', `${question} needs --yes.`, {
      fix,
      exitCode: EXIT.user,
    });
  }
  const answer = (await ctx.io.prompt(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw new CliError('cancelled', 'Nothing was done: the confirmation was declined.', {
      fix,
      exitCode: EXIT.user,
    });
  }
}

/** A promise that settles after `ms`, or as soon as `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
