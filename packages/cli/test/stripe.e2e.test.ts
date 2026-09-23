/**
 * `bookrail stripe connect|status|disconnect`, and `openInBrowser` underneath them.
 *
 * Nothing is mocked but the browser. The API is the real one on real Postgres, Stripe is a
 * `node:http` server on 127.0.0.1, and the half of the flow that belongs to a person (opening
 * the link and authorising) is done with a plain `fetch` against the public callback, exactly
 * as a browser would do it, while the command is polling.
 *
 * `openInBrowser` is exercised with an injected `spawn`, so the suite asserts the command and
 * the arguments for each platform and never launches anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { browserCommand, openInBrowser, type SpawnLike } from '../src/browser.js';
import {
  createHarness,
  startFakeStripe,
  type FakeStripe,
  type Harness,
  type Project,
} from './harness.js';

interface ConnectionData {
  status: string;
  account_id: string | null;
  publishable_key: string | null;
  charges_enabled: boolean | null;
  disconnect_reason: string | null;
}

interface LinkData {
  url: string;
  expires_at: string;
  opened: boolean;
}

describe('openInBrowser', () => {
  it('knows the one command each platform has for this', () => {
    expect(browserCommand('https://example.test/a', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.test/a'],
    });
    expect(browserCommand('https://example.test/a', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.test/a'],
    });
    expect(browserCommand('https://example.test/a', 'win32')).toEqual({
      command: 'cmd',
      // The empty string is `start`'s window title argument, not a stray value: without it the
      // URL would be read as the title and nothing would open.
      args: ['/c', 'start', '', 'https://example.test/a'],
    });
  });

  it('spawns detached, with its streams ignored, and never inherits ours', () => {
    const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
    const fake: SpawnLike = (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => undefined, on: () => undefined };
    };
    expect(openInBrowser('https://example.test/a', { platform: 'linux', spawnImpl: fake })).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.detached).toBe(true);
    expect(calls[0]!.options.stdio).toBe('ignore');
  });

  it('refuses anything that is not http or https, and spawns nothing', () => {
    const calls: string[] = [];
    const fake: SpawnLike = (command) => {
      calls.push(command);
      return { unref: () => undefined, on: () => undefined };
    };
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
      expect(openInBrowser(url, { platform: 'darwin', spawnImpl: fake }), url).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('answers false rather than throwing when there is nothing to open with', () => {
    const throwing: SpawnLike = () => {
      throw new Error('ENOENT');
    };
    expect(
      openInBrowser('https://example.test/a', { platform: 'linux', spawnImpl: throwing }),
    ).toBe(false);
  });
});

describe('bookrail stripe, against a deployment that is not a platform', () => {
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('CLI stripe off');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('reports the sentence the API wrote for the operator', async () => {
    const result = await h.cli(['stripe', 'status', '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    expect(result.code).toBe(3);
    const envelope = result.json();
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('stripe_not_configured');
    expect(envelope.error?.fix).toContain('STRIPE_CLIENT_ID');
  });

  it('turns the same answer into a doctor warning rather than a failure', async () => {
    const result = await h.cli(['doctor', '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    const checks = result.json<{ checks: { name: string; status: string; fix?: string }[] }>().data!
      .checks;
    const check = checks.find((c) => c.name === 'stripe_connection');
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.fix).toContain('STRIPE_CLIENT_ID');
    // The old sentence about payment provider keys having no endpoint to ask is gone: there is
    // an endpoint now, and `doctor` asks it.
    const notChecked = checks.find((c) => c.name === 'not_checked');
    expect(notChecked?.fix ?? '').not.toContain('payment');
  });
});

describe('bookrail stripe, end to end', () => {
  let stripe: FakeStripe;
  let h: Harness;
  let project: Project;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    h = await createHarness({ stripeBase: stripe.url });
    project = await h.bootstrap('CLI stripe');
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  const env = (): Record<string, string> => ({ BOOKRAIL_SECRET_KEY: project.testKey });

  /** The person's half: open the link and authorise. */
  async function authorise(url: string): Promise<number> {
    const state = new URL(url).searchParams.get('state');
    expect(state).not.toBeNull();
    const response = await fetch(
      `${h.url}/v1/stripe/callback?state=${encodeURIComponent(state!)}&code=ac_cli`,
    );
    return response.status;
  }

  it('says not_connected before anything has been authorised', async () => {
    const result = await h.cli(['stripe', 'status', '--json'], { env: env() });
    expect(result.code).toBe(0);
    const data = result.json<ConnectionData>().data!;
    expect(data.status).toBe('not_connected');
    expect(data.publishable_key).toBe('pk_test_cliHarness');
    expect(data.charges_enabled).toBeNull();
  });

  it('prints the link and opens nothing without a terminal, with --no-wait', async () => {
    const result = await h.cli(['stripe', 'connect', '--no-wait', '--json'], { env: env() });
    expect(result.code).toBe(0);
    const data = result.json<LinkData>().data!;
    expect(data.url).toContain('client_id=ca_CliTestApplication');
    expect(data.url).toContain('scope=read_write');
    // `--json` and no TTY: there is nothing to open and nothing was opened.
    expect(data.opened).toBe(false);
    expect(Date.parse(data.expires_at)).toBeGreaterThan(Date.now());

    // The link is real: authorising against it connects the account.
    expect(await authorise(data.url)).toBe(200);
    const status = await h.cli(['stripe', 'status', '--json'], { env: env() });
    expect(status.json<ConnectionData>().data!.status).toBe('connected');
    expect(status.json<ConnectionData>().data!.account_id).toBe('acct_CliTest');
    expect(status.json<ConnectionData>().data!.charges_enabled).toBe(true);
  });

  it('refuses a second connect while one account is connected', async () => {
    const result = await h.cli(['stripe', 'connect', '--no-wait', '--json'], { env: env() });
    expect(result.code).toBe(4);
    expect(result.json().error?.code).toBe('stripe_already_connected');
  });

  it('needs --yes to disconnect, and then does', async () => {
    const refused = await h.cli(['stripe', 'disconnect', '--json'], { env: env() });
    expect(refused.code).toBe(1);
    expect(refused.json().error?.code).toBe('confirmation_required');
    // Still connected: the refusal changed nothing.
    const still = await h.cli(['stripe', 'status', '--json'], { env: env() });
    expect(still.json<ConnectionData>().data!.status).toBe('connected');

    const done = await h.cli(['stripe', 'disconnect', '--yes', '--json'], { env: env() });
    expect(done.code).toBe(0);
    const data = done.json<ConnectionData>().data!;
    expect(data.status).toBe('disconnected');
    expect(data.disconnect_reason).toBe('user');
  });

  it('waits, and stops waiting as soon as the browser has come back', async () => {
    // The command is started first and the authorisation happens while it is polling, which is
    // the sequence a person actually produces. The link is read from the command's own output
    // as it prints it, not from a response the test could have built itself.
    let printed = '';
    const running = h.cli(['stripe', 'connect', '--no-open'], {
      env: env(),
      onStdout: (chunk) => {
        printed += chunk;
      },
    });

    // Polled on the condition, not on a timer: the command has to make a real HTTP round trip
    // and a real write to Postgres before it can print anything, and a sleep aimed at the
    // middle of that window is right until the machine is loaded.
    const url = await waitFor(() => /https?:\/\/\S+oauth\/authorize\S*/.exec(printed)?.[0] ?? null);
    expect(await authorise(url)).toBe(200);

    const result = await running;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('acct_CliTest');
    expect(result.stdout).toContain('connected');
  }, 60_000);

  async function waitFor<T>(probe: () => T | null): Promise<T> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('the condition never held');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});
