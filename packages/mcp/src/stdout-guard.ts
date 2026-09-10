import { Writable } from 'node:stream';

/**
 * Makes it impossible for anything but the transport to write to stdout.
 *
 * A stdio MCP server owns stdout: the client parses it as a stream of JSON-RPC frames. Any
 * other write (a stray `console.log`, a dependency that prints a deprecation, a crash
 * handler) corrupts the session, and the symptom (the client sees a parse error and drops
 * the connection) points nowhere near the cause.
 *
 * So instead of asking every code path to behave, the real `write` is taken away: the guard
 * keeps the original function for the transport and replaces `process.stdout.write` with one
 * that forwards to stderr, prefixed so the redirection is visible rather than silent. The
 * transport is handed {@link StdoutGuard.protocol}, the only stream that still reaches
 * stdout.
 *
 * `restore()` puts the original back, which is what the tests use and what a caller embedding
 * the server in another process needs.
 */
export interface StdoutGuard {
  /** The only writable that still reaches the real stdout. Give it to the transport. */
  protocol: Writable;
  restore(): void;
}

export interface GuardStreams {
  stdout: NodeJS.WriteStream | (NodeJS.WritableStream & { write: NodeJS.WriteStream['write'] });
  stderr: { write(chunk: string): unknown };
}

export function guardStdout(streams: GuardStreams): StdoutGuard {
  const target = streams.stdout;
  const original = target.write.bind(target) as (
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown,
  ) => boolean;

  const protocol = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      original(chunk as string | Uint8Array);
      callback();
      return;
    },
  });

  const redirect = (
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    streams.stderr.write(`[bookrail-mcp] stdout-redirected ${text.replace(/\n$/, '')}\n`);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };

  // The cast is the point of the whole file: the replacement deliberately does not honour the
  // `WriteStream.write` overloads, because nothing is supposed to be calling it any more.
  (target as { write: unknown }).write = redirect;

  return {
    protocol,
    restore(): void {
      (target as { write: unknown }).write = original;
    },
  };
}
