import { homedir } from 'node:os';

/**
 * Everything the CLI is allowed to touch outside its own process state.
 *
 * The commands never reach for `process` or `console` directly: a test drives them in-process
 * with a recording `Io`, and the MCP server drives the same command layer
 * with an `Io` that writes nowhere. The rule that no command may block on hidden interactivity
 * is enforceable only because `readStdin` and `isTTY` are values here rather than globals.
 */
export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  /** True only when stdout is a real terminal: colours and emoji are gated on it. */
  isTTY: boolean;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  readStdin(): Promise<string>;
  /**
   * Asks the person at the terminal one question. Present only when `isTTY`; every command
   * that uses it has a flag that replaces it, and refuses to run without either.
   */
  prompt?(question: string): Promise<string>;
  /**
   * Registers one handler for an interrupt (Ctrl-C), and returns the function that removes it.
   *
   * Only the long-running commands use it (`events list --follow` and `webhooks listen`), and
   * they use it to stop the loop **and clean up** (a `listen` that was killed without deleting
   * its temporary endpoint leaves the project delivering to a socket that no longer exists). It
   * is a capability of `Io` rather than a `process.on` inside the command for the usual reason:
   * a test drives those loops in-process and bounds them with `--max` / `--duration` instead,
   * and the MCP server must not have its own signal handling hijacked.
   *
   * Absent means "there is no interrupt here": the loop then relies on its bounds.
   */
  onInterrupt?(handler: () => void): () => void;
}

export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    isTTY: process.stdout.isTTY === true,
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (chunk) => void process.stderr.write(chunk),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    },
    prompt: async (question) => {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    // `once`, so a second Ctrl-C kills the process the ordinary way: a clean-up that is itself
    // hanging must not be able to make the terminal feel stuck.
    onInterrupt: (handler) => {
      process.once('SIGINT', handler);
      return () => process.removeListener('SIGINT', handler);
    },
  };
}
