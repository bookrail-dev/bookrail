export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Overridable so tests can capture output without touching stdout. */
  sink?: (line: string) => void;
  base?: LogFields;
}

/**
 * Structured single-line JSON logger. Request bodies are never passed to it:
 * callers log method, path, status, latency, request_id and project_id only.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = {
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...(fields ?? {}),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(fields: LogFields): Logger {
      return createLogger({ level, sink, base: { ...base, ...fields } });
    },
  };
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });
