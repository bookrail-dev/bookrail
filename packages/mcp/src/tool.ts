import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { CliError, EXIT } from 'bookrail';
import { z, type ZodRawShape } from 'zod';
import { runCli, runCliWithKey, type Envelope } from './cli.js';
import { ENVIRONMENTS, type Environment, type Workspace } from './environment.js';

/**
 * What every tool of this server returns, in `structuredContent` and, serialised, in
 * `content[0].text`.
 *
 * It is the CLI's envelope plus the two fields a tool needs and a command line does not:
 * `requires_confirmation`, because an agent cannot be asked a question at a terminal, and
 * `preview`, which is what it is being asked about.
 */
export interface ToolEnvelope extends Envelope {
  /** True when the call did nothing and is waiting for `confirm: true`. */
  requires_confirmation?: boolean;
  /** What the confirmed call would do. Only ever set together with `requires_confirmation`. */
  preview?: unknown;
}

export const outputShape = {
  ok: z.boolean().describe('False only when `error` is set.'),
  environment: z.enum(ENVIRONMENTS).describe('The environment this call ran against.'),
  data: z.unknown().optional().describe('The payload, identical to `bookrail ... --json`.'),
  next_steps: z.array(z.string()).optional().describe('What to do next, as tool calls.'),
  requires_confirmation: z
    .boolean()
    .optional()
    .describe('True when nothing was done and the call must be repeated with confirm: true.'),
  preview: z.unknown().optional().describe('What a confirmed call would do.'),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      param: z.string().optional(),
      doc_url: z.string(),
      fix: z.string().optional(),
      request_id: z.string().optional(),
    })
    .optional()
    .describe('Set when ok is false. `fix` is the sentence to act on.'),
};

/** The `environment` argument of every tool that talks to the API. Default `test`, always. */
export const environmentArgument = z
  .enum(ENVIRONMENTS)
  .default('test')
  .describe(
    'Which environment to operate on. Defaults to "test". "live" is refused unless the server was started with BOOKRAIL_MCP_ALLOW_LIVE=1 and a live key is configured.',
  );

/** The confirmation a destructive tool needs, in place of the question a terminal would ask. */
export const confirmArgument = z
  .boolean()
  .default(false)
  .describe(
    'Must be true to actually perform this irreversible operation. With false (the default) the tool returns a preview and requires_confirmation: true, and changes nothing.',
  );

export interface ToolContext {
  environment: Environment;
  workspace: Workspace;
  /** Runs one `bookrail` command in-process, in this call's environment. */
  cli(argv: string[]): Promise<Envelope>;
  /**
   * Runs one `bookrail` command that needs no key and no network: `docs`, `schema`,
   * `examples`. It goes past the barrier of {@link resolveKey} because there is nothing to
   * guard: no request can leave a command that never builds a client.
   */
  cliOffline(argv: string[]): Promise<Envelope>;
}

export interface ToolSpec<S extends ZodRawShape> {
  name: string;
  title: string;
  /**
   * What it does, when to use it, what it returns, and the tool to call next. Written as
   * prose because that is what the model reads before choosing.
   */
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolEnvelope>;
}

function environmentOf(args: unknown): Environment {
  const value = (args as { environment?: unknown } | undefined)?.environment;
  return value === 'live' ? 'live' : 'test';
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError('unexpected_error', `The tool failed: ${message}`, {
    fix: 'This is a bug in @bookrail/mcp. Call bookrail_doctor to check the environment, and report this message.',
    exitCode: EXIT.service,
  });
}

export function toResult(envelope: ToolEnvelope): CallToolResult {
  return {
    // Both forms on purpose: `structuredContent` for a client that reads the schema, and the
    // same object as text for one that does not. A client that got only one of the two would
    // see either nothing or unparsed prose.
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.ok ? {} : { isError: true }),
  };
}

/**
 * Registers one tool, with the two guarantees every tool of this server has to make.
 *
 * **No unhandled exception ever leaves a handler.** Anything thrown (a `CliError` from the
 * command layer, a `TypeError` from a bug here) comes back as `isError: true` with
 * `{ code, message, fix, doc_url }`. An MCP error frame with a stack trace in it tells an
 * agent nothing it can act on; a `fix` does.
 *
 * **Nothing is written to stdout.** The handler's only output is its return value: the command
 * layer writes into a string, and the logger writes to stderr.
 */
export function registerTool<S extends ZodRawShape>(
  server: McpServer,
  workspace: Workspace,
  spec: ToolSpec<S>,
): void {
  const callback = (async (args: unknown): Promise<CallToolResult> => {
    const environment = environmentOf(args);
    try {
      const envelope = await spec.run(args as z.infer<z.ZodObject<S>>, {
        environment,
        workspace,
        cli: (argv) => runCli(workspace, environment, argv),
        cliOffline: (argv) => runCliWithKey(workspace, 'test', argv, undefined),
      });
      return toResult(envelope);
    } catch (error) {
      const cliError = toCliError(error);
      workspace.logger.warn(`${spec.name} failed`, { code: cliError.code });
      return toResult({ ok: false, environment, error: cliError.toBody() });
    }
  }) as ToolCallback<S>;

  server.registerTool<typeof outputShape, S>(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: outputShape,
      annotations: { title: spec.title, ...spec.annotations },
    },
    callback,
  );
}

/** The answer a destructive tool gives when `confirm` was not passed. */
export function needsConfirmation(
  environment: Environment,
  preview: unknown,
  nextSteps: string[],
): ToolEnvelope {
  return { ok: true, environment, requires_confirmation: true, preview, next_steps: nextSteps };
}
