import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardStdout } from '../src/stdout-guard.js';
import { createHarness, type Harness, type Project } from './harness.js';

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

describe('the stdout guard', () => {
  it('sends everything but the transport stream to stderr, and restores', () => {
    const out: string[] = [];
    const err: string[] = [];
    const fake = {
      write(chunk: string): boolean {
        out.push(chunk);
        return true;
      },
    };
    const guard = guardStdout({
      stdout: fake as never,
      stderr: { write: (chunk: string) => err.push(chunk) },
    });

    (fake as { write: (chunk: string) => boolean }).write('a stray console.log\n');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('stdout-redirected');
    expect(err.join('')).toContain('a stray console.log');

    guard.protocol.write('{"jsonrpc":"2.0"}\n');
    expect(out.join('')).toBe('{"jsonrpc":"2.0"}\n');

    guard.restore();
    (fake as { write: (chunk: string) => boolean }).write('after restore\n');
    expect(out.join('')).toContain('after restore');
  });
});

describe('nothing reaches stdout during a tool call', () => {
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('MCP Stdout');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('captures no write, not even while an internal error is being handled', async () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };

    try {
      // A base URL that is not a URL at all: the failure is a TypeError deep inside the HTTP
      // client, not a CliError, so this exercises the path that has no error contract of its
      // own, the one a stray `console.error` or an unhandled rejection would come from.
      const broken = await h.session({
        env: { BOOKRAIL_SECRET_KEY: project.testKey, BOOKRAIL_API_URL: 'not-a-url' },
      });
      const failed = await broken.call('bookrail_project_info', {});
      expect(failed.isError).toBe(true);
      expect(failed.envelope.ok).toBe(false);
      expect(failed.envelope.error?.code).toBeTruthy();
      expect(failed.envelope.error?.fix).toBeTruthy();
      await broken.close();

      const working = await h.session({ env: { BOOKRAIL_SECRET_KEY: project.testKey } });
      await working.call('bookrail_docs_get', { path: 'agents' });
      await working.call('bookrail_project_info', {});
      // A tool that fails inside the command layer, with a proper error contract.
      const unknown = await working.call('bookrail_docs_get', { path: 'no-such-page' });
      expect(unknown.isError).toBe(true);
      expect(unknown.envelope.error?.code).toBe('unknown_topic');
      // A tool that fails inside the MCP layer, before any command runs.
      const refused = await working.call('bookrail_project_info', { environment: 'live' });
      expect(refused.envelope.error?.code).toBe('live_not_allowed');
      await working.close();
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }

    expect(captured.join('')).toBe('');
  });
});

describe('the published binary', () => {
  beforeAll(async () => {
    if (await exists(binary)) return;
    const require = createRequire(import.meta.url);
    await runFile(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
      cwd: packageRoot,
    });
  }, 180_000);

  it('declares a bin and a shebang', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.bin['bookrail-mcp']).toBe('./dist/index.js');
    expect(manifest.files).toContain('dist');
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@modelcontextprotocol/sdk',
      'bookrail',
      'zod',
    ]);
    expect((await readFile(binary, 'utf8')).startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('speaks JSON-RPC on stdout and nothing else, over a real pipe', async () => {
    const child = spawn(process.execPath, [binary], {
      cwd: packageRoot,
      env: {
        ...process.env,
        BOOKRAIL_MCP_LOG: 'debug',
        BOOKRAIL_SECRET_KEY: '',
        XDG_CONFIG_HOME: join(packageRoot, 'test', 'no-such-config-home'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    // A call that fails for want of a key: the failure must not print anything.
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'bookrail_project_info', arguments: {} },
    });

    const answers = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; stdout=${stdout}`)), 30_000);
      const check = (): void => {
        const lines = stdout.split('\n').filter((line) => line.trim() !== '');
        if (lines.length < 3) return;
        clearTimeout(timer);
        resolve(lines.map((line) => JSON.parse(line) as Record<string, unknown>));
      };
      child.stdout.on('data', check);
      child.on('error', reject);
    });

    child.stdin.end();
    child.kill();

    // Every single line of stdout is a JSON-RPC frame: the parse above would have thrown.
    for (const answer of answers) expect(answer.jsonrpc).toBe('2.0');
    const tools = answers.find((answer) => answer.id === 2) as
      { result?: { tools?: unknown[] } } | undefined;
    expect((tools?.result?.tools ?? []).length).toBeGreaterThan(30);

    const call = answers.find((answer) => answer.id === 3) as
      { result?: { isError?: boolean; content?: { text: string }[] } } | undefined;
    expect(call?.result?.isError).toBe(true);
    const envelope = JSON.parse(call?.result?.content?.[0]?.text ?? '{}') as {
      ok: boolean;
      error?: { code: string; fix?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.fix).toBeTruthy();

    // The diagnostics went to stderr, where they belong, and stdout stayed clean.
    expect(stderr).toContain('[bookrail-mcp]');
  }, 60_000);
});
