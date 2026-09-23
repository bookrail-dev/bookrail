/**
 * Opening a URL in whatever browser the person uses, without a dependency.
 *
 * Every platform ships one command for this and it has been the same command for years:
 * `open` on macOS, `xdg-open` on the freedesktop world, `start` through `cmd` on Windows. A
 * package that wrapped the three would be a supply chain entry, in a CLI that is installed
 * globally, in exchange for the eight lines below.
 *
 * Three properties matter, and all three are about not getting in the way:
 *
 *  * **Detached, and its streams ignored.** A browser outlives the terminal that started it,
 *    and a browser that inherited this process's stdout would print its own warnings into the
 *    structured output of a command an agent is parsing.
 *  * **A failure is not an error.** A machine with no desktop, a container, an SSH session:
 *    there may simply be nothing to open. The caller prints the URL either way, so the person
 *    can copy it, and {@link openInBrowser} answers whether it managed rather than throwing.
 *  * **The URL is checked before it is passed to anything.** Only `https:` and `http:` are
 *    opened. It is an argument to a command, not a shell string, so nothing in it can be
 *    interpreted; refusing anything else is the second line, against a `file:` or a custom
 *    scheme arriving from an API answer that a future version got wrong.
 */
import { spawn, type SpawnOptions } from 'node:child_process';

/** The `spawn` to use. Only a test passes one, so that no test ever opens a real browser. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void; on(event: 'error', listener: (error: Error) => void): unknown };

export interface OpenInBrowserOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: SpawnLike;
}

/** The command and arguments for one platform. Exported so a test can assert them. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    // `start` is a builtin of `cmd`, not an executable, and its first quoted argument is the
    // window title: the empty string is that title, and the URL is what it opens.
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/**
 * Opens `url`, and says whether it managed to try.
 *
 * `false` means "this machine has nothing to open it with", which is a fact about the machine
 * and not a failure of the command: every caller prints the URL as well.
 */
export function openInBrowser(url: string, options: OpenInBrowserOptions = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const { command, args } = browserCommand(url, platform);
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
    // A missing `xdg-open` is reported asynchronously, after this function has returned, so it
    // needs a listener or it becomes an unhandled `error` event and takes the process with it.
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
