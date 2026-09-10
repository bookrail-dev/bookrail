/**
 * Logging for a server whose stdout belongs to the protocol.
 *
 * This server is run over stdio: one stray byte on stdout that is not a JSON-RPC frame
 * desynchronises the client, and the failure looks like the server crashed. So every diagnostic
 * goes to stderr, and the level is chosen with `BOOKRAIL_MCP_LOG` (`silent`, `error`, `warn`,
 * `info`, `debug`; default `warn`).
 *
 * There is no `console` here on purpose: `console.log` writes to stdout, and a logger that
 * merely *promises* not to use it is a logger someone will change.
 */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  level: LogLevel;
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export function parseLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'warn';
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : 'warn';
}

/** A logger that writes one line per record to `write`, which must never be stdout. */
export function createLogger(level: LogLevel, write: (chunk: string) => void): Logger {
  const emit = (at: LogLevel, message: string, detail?: unknown): void => {
    if (RANK[at] > RANK[level]) return;
    const suffix = detail === undefined ? '' : ` ${safeJson(detail)}`;
    write(`[bookrail-mcp] ${at} ${message}${suffix}\n`);
  };
  return {
    level,
    error: (message, detail) => emit('error', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    info: (message, detail) => emit('info', message, detail),
    debug: (message, detail) => emit('debug', message, detail),
  };
}

export const silentLogger: Logger = createLogger('silent', () => {});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
