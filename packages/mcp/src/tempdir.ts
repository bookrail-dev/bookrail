/**
 * The temporary directory `bookrail_config_push` writes an inline configuration into, and the
 * one guarantee it makes: nothing is left behind.
 *
 * ## Why there is a file at all
 *
 * An agent usually holds the model in memory before it holds it on disk, and `bookrail push`
 * reads a file. So an inline `config` is written to a temporary `bookrail.config.json` and
 * passed with `--config`: same loader, same validation, same plan. The alternative, making the
 * agent write the file first, turns one tool call into two with a failure mode in between.
 *
 * ## Why it needed its own module
 *
 * The `finally` that removed the directory covered the only way the *call* could end. It did
 * not cover the ways the **process** can end: an MCP client that shuts its server down sends
 * `SIGTERM`, a developer pressing Ctrl-C sends `SIGINT`, and either one arriving while a push
 * was in flight left a directory in `os.tmpdir()` for ever. Not a leak of anything secret (a
 * booking model, not a key) but a server started by `npx` on every session that leaves litter
 * every time it is interrupted is a server that fills a laptop's temp directory over a year.
 *
 * So: one dedicated root (`<tmpdir>/bookrail-mcp`) instead of loose directories among
 * everyone else's, a registry of what is currently open, and one signal handler installed the
 * first time a directory is created, lazily, because a server that never writes a temporary
 * file must not change how the process reacts to Ctrl-C.
 *
 * The handler re-raises the signal after cleaning up rather than calling `process.exit`, so the
 * exit status stays the one the signal implies and any other listener still runs.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every temporary directory this process makes lives under here, and nowhere else. */
export const TEMP_ROOT = join(tmpdir(), 'bookrail-mcp');

/** Directories currently in use, so a signal knows exactly what to remove. */
const open = new Set<string>();

let handlersInstalled = false;

/** Synchronous on purpose: an exit handler has no chance to await anything. */
function cleanupSync(): void {
  for (const directory of open) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Nothing useful to do while the process is going down, and stdout belongs to the
      // protocol: a failure here must not become output.
    }
  }
  open.clear();
}

function installHandlersOnce(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', cleanupSync);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanupSync();
      // Re-raise with no handler of ours in the way, so the process dies exactly as it would
      // have without this module: same exit status, same semantics.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Runs `body` with a fresh directory under {@link TEMP_ROOT}, removed on the way out, whether
 * `body` returned, threw, or the process was signalled while it ran.
 */
export async function withTempDirectory<T>(
  prefix: string,
  body: (directory: string) => Promise<T>,
): Promise<T> {
  installHandlersOnce();
  mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEMP_ROOT, `${prefix}-`));
  open.add(directory);
  try {
    return await body(directory);
  } finally {
    open.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }
}
