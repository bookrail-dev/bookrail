/**
 * `bookrail://config` is re-read on every access, proved in a **real Node process**.
 *
 * `resources.test.ts` already asserts this, in-process, over a `bookrail.config.json`. That
 * test is worth keeping and it is not enough for two reasons, and both are about the thing an
 * agent actually does:
 *
 *  1. the file an agent writes is `bookrail.config.ts`, and Node 20 does not import
 *     TypeScript. The CLI's loader deals with that by extracting the argument of
 *     `defineConfig(...)` and evaluating it as a JavaScript literal, or by registering `tsx`
 *     when the host project has it. None of that
 *     is exercised by a `.json`;
 *  2. "re-read on every access" is a claim about a **long-lived process**. In-process, vitest's
 *     module graph and the loader's cache-busting query are the same objects the assertion is
 *     about. Over stdio, with a server that was started once and outlives the edit, they are
 *     not.
 *
 * So this spawns `dist/index.js`, speaks JSON-RPC to it over pipes, reads the resource, edits
 * the file on disk, and reads it again from the same process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(packageRoot, 'dist', 'index.js');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The configuration file an agent writes, as a real `.ts` module. */
function configSource(courts: string[]): string {
  return [
    "import { defineConfig } from 'bookrail';",
    '',
    'export default defineConfig({',
    "  locations: [{ id: 'club', name: 'Club', timezone: 'Europe/Rome' }],",
    '  resources: [',
    ...courts.map(
      (name) =>
        `    { id: '${name.toLowerCase().replace(/ /g, '_')}', name: '${name}', type: 'court', location: 'club' },`,
    ),
    '  ],',
    '});',
    '',
  ].join('\n');
}

/** A JSON-RPC client over a child process's pipes. Small on purpose: one file needs it. */
class StdioClient {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  stderr = '';

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line !== '') {
          const message = JSON.parse(line) as Record<string, unknown>;
          const resolve = this.pending.get(message.id as number);
          if (resolve) {
            this.pending.delete(message.id as number);
            resolve(message);
          }
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout on ${method}; stderr=${this.stderr}`)),
        30_000,
      );
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return answer;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function resourceBody(answer: Record<string, unknown>): {
  present: boolean;
  path?: string;
  loader?: string;
  valid?: boolean;
  config?: { resources?: { name: string }[] };
} {
  const result = answer.result as { contents?: { text: string }[] } | undefined;
  const text = result?.contents?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text ?? '{}') as ReturnType<typeof resourceBody>;
}

describe('bookrail://config in a live server process', () => {
  let workdir = '';
  let client: StdioClient | null = null;

  beforeAll(async () => {
    if (!(await exists(binary))) {
      const require = createRequire(import.meta.url);
      await runFile(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
        cwd: packageRoot,
      });
    }
    workdir = await mkdtemp(join(tmpdir(), 'bookrail-reload-'));
  }, 180_000);

  afterAll(async () => {
    client?.close();
    if (workdir !== '') await rm(workdir, { recursive: true, force: true });
  });

  it('reflects an edit to bookrail.config.ts without restarting the server', async () => {
    await writeFile(join(workdir, 'bookrail.config.ts'), configSource(['Court 1']), 'utf8');

    const child = spawn(process.execPath, [binary], {
      cwd: workdir,
      env: {
        ...process.env,
        BOOKRAIL_MCP_LOG: 'error',
        BOOKRAIL_SECRET_KEY: '',
        XDG_CONFIG_HOME: join(workdir, 'no-such-config-home'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    client = new StdioClient(child);

    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'reload-probe', version: '0' },
    });
    client.notify('notifications/initialized');

    const first = resourceBody(
      await client.request('resources/read', { uri: 'bookrail://config' }),
    );
    expect(first.present).toBe(true);
    expect(first.valid).toBe(true);
    expect(first.path?.endsWith('bookrail.config.ts')).toBe(true);
    expect(first.config?.resources?.map((resource) => resource.name)).toEqual(['Court 1']);

    // The edit an agent makes between two calls, on disk, while the server is running.
    await writeFile(
      join(workdir, 'bookrail.config.ts'),
      configSource(['Court 1', 'Court 2', 'Court 3']),
      'utf8',
    );

    const second = resourceBody(
      await client.request('resources/read', { uri: 'bookrail://config' }),
    );
    expect(second.present).toBe(true);
    expect(second.valid).toBe(true);
    expect(second.config?.resources?.map((resource) => resource.name)).toEqual([
      'Court 1',
      'Court 2',
      'Court 3',
    ]);

    // And a file that stops being valid is reported as such, still without a restart.
    await writeFile(join(workdir, 'bookrail.config.ts'), 'export default 42;\n', 'utf8');
    const broken = resourceBody(
      await client.request('resources/read', { uri: 'bookrail://config' }),
    );
    expect(broken.present).toBe(true);
    expect(broken.valid).toBe(false);

    // Nothing but JSON-RPC ever reached stdout: every frame above parsed.
    expect(client.stderr).not.toContain('bookrail://config');
  }, 120_000);
});
