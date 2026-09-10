import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from '../errors.js';
import type { Io } from '../io.js';
import { assertValidConfig, type NormalizedConfig } from './normalize.js';

/** In the order `push`, `pull` and `diff` look for one. */
export const CONFIG_FILE_NAMES = [
  'bookrail.config.ts',
  'bookrail.config.mts',
  'bookrail.config.mjs',
  'bookrail.config.js',
  'bookrail.config.json',
] as const;

export interface LoadedConfig {
  path: string;
  config: NormalizedConfig;
  /** How the file was read, reported by `doctor`. */
  loader: 'json' | 'import' | 'literal';
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findConfigFile(io: Io, explicit?: string): Promise<string | null> {
  if (explicit !== undefined && explicit !== '') {
    const path = isAbsolute(explicit) ? explicit : resolvePath(io.cwd, explicit);
    if (await exists(path)) return path;
    throw new CliError('config_not_found', `No configuration file at ${path}.`, {
      fix: 'Check the path passed to `--config`, or run `bookrail init` to create one.',
    });
  }
  for (const name of CONFIG_FILE_NAMES) {
    const path = resolvePath(io.cwd, name);
    if (await exists(path)) return path;
  }
  return null;
}

export async function requireConfigFile(io: Io, explicit?: string): Promise<string> {
  const path = await findConfigFile(io, explicit);
  if (path !== null) return path;
  throw new CliError('config_not_found', `No bookrail.config.* found in ${io.cwd}.`, {
    fix: 'Run `bookrail init --template <vertical>` to create one, or pass `--config <path>`.',
  });
}

let tsLoaderTried = false;

/**
 * Registers a TypeScript ESM loader if the host has one, so that `import()` can read a
 * `bookrail.config.ts`.
 *
 * Node 20, the version this repository targets, cannot import a `.ts` file at all, and Node
 * only started stripping types by itself in 22.18. Rather than take a transpiler as a runtime
 * dependency, the CLI uses `tsx` when the host project already has it (which a TypeScript
 * project usually does) and otherwise falls back to {@link evaluateDefineConfigLiteral}. Both
 * paths are exercised by the test suite.
 */
async function registerTsLoader(near: string): Promise<boolean> {
  if (tsLoaderTried) return true;
  tsLoaderTried = true;
  const require = createRequire(near);
  for (const candidate of ['tsx/esm/api']) {
    try {
      require.resolve(candidate);
    } catch {
      continue;
    }
    try {
      const loader = (await import(candidate)) as { register?: () => unknown };
      loader.register?.();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Reads the argument of the single `defineConfig(...)` call of a config file.
 *
 * This is the fallback used when the runtime cannot import TypeScript. It works because a
 * config file is data: `bookrail init` writes an object literal, and an object literal is
 * valid JavaScript. Anything with real TypeScript syntax inside the literal (`satisfies`,
 * `as const`, an annotated arrow function) throws, and the message says exactly what to do
 * about it, which is better than a `SyntaxError` from the module loader.
 */
export function evaluateDefineConfigLiteral(source: string, path: string): unknown {
  const call = /defineConfig\s*\(/.exec(source);
  const start = call ? call.index + call[0].length : indexOfDefaultObject(source);
  if (start < 0) {
    throw unreadable(
      path,
      'no `defineConfig({ ... })` call and no default-exported object literal',
    );
  }
  const literal = balanced(source, start);
  if (literal === null) throw unreadable(path, 'the object literal is not balanced');
  try {
    const factory = new Function(`"use strict"; return (${literal});`) as () => unknown;
    return factory();
  } catch (error) {
    throw unreadable(path, error instanceof Error ? error.message : String(error));
  }
}

function indexOfDefaultObject(source: string): number {
  const match = /export\s+default\s*(?=\{)/.exec(source);
  return match ? match.index + match[0].length : -1;
}

/** Returns the balanced `{...}` (or `[...]`) that begins at or after `from`, string-aware. */
function balanced(source: string, from: number): string | null {
  let index = from;
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  const open = source[index];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quote: string | null = null;
  for (let i = index; i < source.length; i += 1) {
    const char = source[i];
    const previous = source[i - 1];
    if (quote !== null) {
      if (char === quote && previous !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(index, i + 1);
    }
  }
  return null;
}

function unreadable(path: string, reason: string): CliError {
  return new CliError('config_unreadable', `Could not read ${path}: ${reason}.`, {
    fix: `On Node ${process.versions.node} a TypeScript config is read either through \`tsx\` (\`npm i -D tsx\`) or as a plain object literal. Install tsx, or rename the file to bookrail.config.mjs or bookrail.config.json.`,
  });
}

export async function loadConfig(io: Io, explicit?: string): Promise<LoadedConfig> {
  const path = await requireConfigFile(io, explicit);

  if (path.endsWith('.json')) {
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw unreadable(path, error instanceof Error ? error.message : String(error));
    }
    return { path, config: assertValidConfig(parsed, path), loader: 'json' };
  }

  const isTypeScript = path.endsWith('.ts') || path.endsWith('.mts');
  if (isTypeScript) await registerTsLoader(path);

  try {
    const module = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as {
      default?: unknown;
    };
    if (module.default === undefined) {
      throw new CliError('config_unreadable', `${path} has no default export.`, {
        fix: 'End the file with `export default defineConfig({ ... });`.',
      });
    }
    return { path, config: assertValidConfig(module.default, path), loader: 'import' };
  } catch (error) {
    if (error instanceof CliError && error.code === 'invalid_config') throw error;
    if (!isTypeScript) {
      throw unreadable(path, error instanceof Error ? error.message : String(error));
    }
  }

  const source = await readFile(path, 'utf8');
  const literal = evaluateDefineConfigLiteral(source, path);
  return { path, config: assertValidConfig(literal, path), loader: 'literal' };
}
