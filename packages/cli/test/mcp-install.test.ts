import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h.close();
});

interface InstallData {
  client: string;
  path: string | null;
  written: boolean;
  dry_run: boolean;
  action?: string;
  entry: Record<string, unknown>;
  snippet?: Record<string, unknown>;
  preserved?: string[];
}

/** Where each client keeps its file, and which key inside it holds the servers. */
const CLIENTS: { name: string; segments: string[]; scope: 'project' | 'home'; key: string }[] = [
  { name: 'claude-code', segments: ['.mcp.json'], scope: 'project', key: 'mcpServers' },
  { name: 'cursor', segments: ['.cursor', 'mcp.json'], scope: 'project', key: 'mcpServers' },
  { name: 'vscode', segments: ['.vscode', 'mcp.json'], scope: 'project', key: 'servers' },
  {
    name: 'windsurf',
    segments: ['.codeium', 'windsurf', 'mcp_config.json'],
    scope: 'home',
    key: 'mcpServers',
  },
];

describe('bookrail mcp install', () => {
  it('lists the clients it can configure when none is named', async () => {
    const result = await h.cli(['mcp', 'install', '--json']);
    expect(result.code).toBe(0);
    const data = result.json<{ clients: { client: string }[] }>().data;
    expect(data?.clients.map((entry) => entry.client)).toEqual([
      'claude-code',
      'cursor',
      'vscode',
      'windsurf',
      'generic',
    ]);
  });

  it('refuses an unknown client with the list in the fix', async () => {
    const result = await h.cli(['mcp', 'install', '--client', 'emacs', '--json']);
    expect(result.code).toBe(1);
    const error = result.json().error;
    expect(error?.code).toBe('unknown_client');
    expect(error?.fix).toContain('claude-code');
  });

  it('prints a snippet for `generic` and writes nothing', async () => {
    const cwd = await h.workdir();
    const result = await h.cli(['mcp', 'install', '--client', 'generic', '--json'], { cwd });
    expect(result.code).toBe(0);
    const data = result.json<InstallData>().data as InstallData;
    expect(data.path).toBeNull();
    expect(data.written).toBe(false);
    expect(data.snippet).toEqual({
      mcpServers: { bookrail: { command: 'npx', args: ['-y', '@bookrail/mcp'] } },
    });
  });

  for (const client of CLIENTS) {
    it(`writes ${client.name} at the right path, with the right shape`, async () => {
      const cwd = await h.workdir();
      const home = await h.workdir();
      const expected = join(client.scope === 'project' ? cwd : home, ...client.segments);

      const dry = await h.cli(['mcp', 'install', '--client', client.name, '--dry-run', '--json'], {
        cwd,
        home,
      });
      expect(dry.code).toBe(0);
      const dryData = dry.json<InstallData>().data as InstallData;
      expect(dryData.path).toBe(expected);
      expect(dryData.written).toBe(false);
      expect(dryData.action).toBe('create');
      await expect(readFile(expected, 'utf8')).rejects.toThrow();

      const result = await h.cli(['mcp', 'install', '--client', client.name, '--json'], {
        cwd,
        home,
      });
      expect(result.code).toBe(0);
      const data = result.json<InstallData>().data as InstallData;
      expect(data.path).toBe(expected);
      expect(data.written).toBe(true);

      const written = JSON.parse(await readFile(expected, 'utf8')) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      const entry = written[client.key]?.bookrail;
      expect(entry).toBeDefined();
      expect(entry?.command).toBe('npx');
      expect(entry?.args).toEqual(['-y', '@bookrail/mcp']);
      // VS Code is the one client that wants the transport spelled out.
      expect(entry?.type).toBe(client.name === 'vscode' ? 'stdio' : undefined);
      // No key is ever written into an editor configuration.
      expect(JSON.stringify(written)).not.toContain('sk_test_');
      expect(JSON.stringify(written)).not.toContain('sk_live_');
    });
  }

  it('preserves the other servers and the unrelated keys of an existing file', async () => {
    const cwd = await h.workdir();
    const path = join(cwd, '.mcp.json');
    await writeFile(
      path,
      JSON.stringify(
        {
          $schema: 'https://example.com/mcp.json',
          mcpServers: {
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          },
          somethingElse: { keep: true },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await h.cli(['mcp', 'install', '--client', 'claude-code', '--json'], { cwd });
    expect(result.code).toBe(0);
    expect((result.json<InstallData>().data as InstallData).action).toBe('add');
    expect((result.json<InstallData>().data as InstallData).preserved).toEqual(['github']);

    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(written.$schema).toBe('https://example.com/mcp.json');
    expect(written.somethingElse).toEqual({ keep: true });
    const servers = written.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers).sort()).toEqual(['bookrail', 'github']);
    expect(servers.github?.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
  });

  it('is idempotent: a second install replaces its own entry and nothing else', async () => {
    const cwd = await h.workdir();
    const path = join(cwd, '.cursor', 'mcp.json');
    await h.cli(['mcp', 'install', '--client', 'cursor', '--json'], { cwd });
    const first = await readFile(path, 'utf8');
    const again = await h.cli(['mcp', 'install', '--client', 'cursor', '--json'], { cwd });
    expect((again.json<InstallData>().data as InstallData).action).toBe('replace');
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('refuses a file that is not valid JSON instead of overwriting it', async () => {
    const cwd = await h.workdir();
    await mkdir(join(cwd, '.vscode'), { recursive: true });
    const path = join(cwd, '.vscode', 'mcp.json');
    await writeFile(path, '{ this is not json', 'utf8');

    const result = await h.cli(['mcp', 'install', '--client', 'vscode', '--json'], { cwd });
    expect(result.code).toBe(1);
    const error = result.json().error;
    expect(error?.code).toBe('client_config_corrupt');
    expect(error?.fix).toContain('generic');
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });

  it('never contacts the API', async () => {
    const cwd = await h.workdir();
    const before = h.seenRequests.length;
    await h.cli(['mcp', 'install', '--client', 'claude-code', '--json'], { cwd });
    expect(h.seenRequests.slice(before)).toEqual([]);
  });
});
