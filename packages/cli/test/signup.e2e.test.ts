/**
 * `bookrail signup`, against the real API, the real endpoints and a real Postgres.
 *
 * The only thing replaced is the mail server: the harness gives the API a mailer that keeps
 * what it would have sent, so a test can read the confirmation link out of the message the
 * product actually wrote. Everything after that is the real flow, including the browser half,
 * which is one `fetch` to `POST /v1/signups/confirm`, exactly what the page on the website does.
 *
 * Nothing here waits for a number of milliseconds and then asserts. The command polls every two
 * seconds by design; a test waits for the message to exist, opens the link, and then waits for
 * the command to return. The condition is the message and the return, never a clock.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_RATE_LIMIT_PAUSE_MS,
  MIN_RATE_LIMIT_PAUSE_MS,
  RATE_LIMIT_PAUSE_MS,
  rateLimitPauseMs,
} from '../src/commands/signup.js';
import { createHarness, type Harness } from './harness.js';

interface SignupData {
  id: string;
  email: string;
  status: string;
  account: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  api_key: { id: string; prefix: string } | null;
  api_keys: { id: string; environment: string; prefix: string }[];
  stored_in?: string;
  secret_key?: string;
  live_secret_key?: string;
}

let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `cli-signup-${String(counter)}-${String(process.pid)}@example.com`;
}

/**
 * Waits for the API to have sent a message to that address, and returns the token in its link.
 *
 * The condition is the message, not an interval: the command sends it before it starts
 * polling, so this returns as soon as the request has been served.
 *
 * `since` is how many messages had been sent before the command was started. Without it, a
 * second sign up for the same address would find the **first** message, which is still in the
 * list and whose link has already been used: the test would then be asserting on a token from
 * a previous invocation, and would fail for a reason that has nothing to do with the product.
 */
async function tokenFor(h: Harness, email: string, since = 0): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const message = h.mailer.sent.slice(since).find((sent) => sent.to === email);
    if (message !== undefined) {
      const match = /#token=([A-Za-z0-9_%-]+)/.exec(message.text);
      if (match?.[1] === undefined) throw new Error(`no token in the message:\n${message.text}`);
      return decodeURIComponent(match[1]);
    }
    if (Date.now() > deadline) throw new Error(`no message was ever sent to ${email}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What the browser does when the link is opened. */
async function openTheLink(h: Harness, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${h.url}/v1/signups/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(body)}`);
  return body;
}

describe('bookrail signup', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('waits for the link, stores both keys, and never prints them', async () => {
    const email = freshEmail();
    const running = h.cli([
      'signup',
      '--accept-terms',
      '--approve-clauses',
      '--email',
      email,
      '--json',
    ]);
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;

    expect(result.code).toBe(0);
    const envelope = result.json<SignupData>();
    expect(envelope.ok).toBe(true);
    const data = envelope.data;
    expect(data?.status).toBe('confirmed');
    expect(data?.account?.id).toMatch(/^acct_/);
    expect(data?.project?.id).toMatch(/^proj_/);
    expect(data?.api_key?.id).toMatch(/^key_/);
    expect(data?.api_keys.map((key) => key.environment)).toEqual(['test', 'live']);
    // Stored, therefore not printed: the keys are on disk and nowhere else.
    expect(data?.secret_key).toBeUndefined();
    expect(data?.live_secret_key).toBeUndefined();
    expect(typeof data?.stored_in).toBe('string');
    expect(result.stdout).not.toMatch(/sk_(test|live)_[A-Za-z0-9_-]{20,}/);

    const path = join(h.configHome, 'bookrail', 'credentials.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      keys: { test?: string; live?: string };
    };
    expect(stored.keys.test).toMatch(/^sk_test_/);
    expect(stored.keys.live).toMatch(/^sk_live_/);
    expect(stored.keys.live).toContain(data?.api_keys[1]?.prefix ?? 'nothing');
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // And they are keys: each opens the project it was made for, test by default and live only
    // when asked.
    const whoami = await h.cli(['whoami', '--json']);
    expect(whoami.code).toBe(0);
    expect(whoami.json<{ project: { id: string } }>().data?.project.id).toBe(data?.project?.id);
    expect(whoami.json().environment).toBe('test');
    const live = await h.cli(['whoami', '--live', '--json']);
    expect(live.code).toBe(0);
    expect(live.json<{ project: { id: string } }>().data?.project.id).toBe(data?.project?.id);
    expect(live.json().environment).toBe('live');
  });

  it('prints both keys once and stores nothing with --no-store', async () => {
    const email = freshEmail();
    const running = h.cli(
      ['signup', '--accept-terms', '--approve-clauses', '--email', email, '--no-store', '--json'],
      {
        home: await h.workdir(),
        env: { XDG_CONFIG_HOME: await h.workdir() },
      },
    );
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;

    expect(result.code).toBe(0);
    const data = result.json<SignupData>().data;
    expect(data?.secret_key).toMatch(/^sk_test_/);
    expect(data?.live_secret_key).toMatch(/^sk_live_/);
    expect(data?.stored_in).toBeUndefined();
  });

  it('asks for the address on a terminal, and refuses to ask in a pipe', async () => {
    const piped = await h.cli(['signup', '--json']);
    expect(piped.code).toBe(1);
    expect(piped.json().error?.code).toBe('missing_input');
    expect(piped.json().error?.fix).toContain('bookrail signup --email');

    const email = freshEmail();
    const running = h.cli(['signup', '--json'], { tty: true, answers: [email, 'yes', 'yes'] });
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.questions[0]).toContain('Email address');
    // And, on a terminal, the two ticks of the terms, each with its own question.
    expect(result.questions[1]).toContain(
      'I accept the Terms of Service and the Data Processing Agreement on behalf of my business',
    );
    expect(result.questions[2]).toContain('Articles 1341 and 1342 of the Italian Civil Code');
  });

  it('refuses to sign up without the terms: no flag in a pipe, or a no on a terminal', async () => {
    const before = h.mailer.sent.length;
    const piped = await h.cli(['signup', '--email', freshEmail(), '--json']);
    expect(piped.code).toBe(1);
    expect(piped.json().error?.code).toBe('terms_not_accepted');
    expect(piped.json().error?.fix).toContain('--accept-terms');
    expect(piped.json().error?.fix).toContain('https://bookrail.dev/terms');

    const declined = await h.cli(['signup', '--email', freshEmail(), '--json'], {
      tty: true,
      answers: ['yes', 'no'],
    });
    expect(declined.code).toBe(1);
    expect(declined.json().error?.code).toBe('terms_not_accepted');

    // One flag is one tick: the approval of the clauses is never implied by the acceptance.
    const half = await h.cli(['signup', '--accept-terms', '--email', freshEmail(), '--json']);
    expect(half.code).toBe(1);
    expect(half.json().error?.code).toBe('terms_not_accepted');
    expect(half.json().error?.fix).toContain('missing: --approve-clauses');
    // Nothing was asked of the server: no message went out.
    expect(h.mailer.sent.length).toBe(before);
  });

  it('asks a terminal only for the tick its flags did not give, one question each', async () => {
    const email = freshEmail();
    const running = h.cli(['signup', '--accept-terms', '--email', email, '--json'], {
      tty: true,
      answers: ['yes'],
    });
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toContain('Articles 1341 and 1342 of the Italian Civil Code');
    expect(result.questions[0]).not.toContain('I accept the Terms of Service');
  });

  it('takes the names and the defaults of the project from the command line', async () => {
    const email = freshEmail();
    const running = h.cli(
      [
        'signup',
        '--accept-terms',
        '--approve-clauses',
        '--email',
        email,
        '--account-name',
        'Padel Roma',
        '--project-name',
        'Courts',
        '--timezone',
        'Europe/Rome',
        '--currency',
        'CHF',
        '--no-store',
        '--json',
      ],
      { env: { XDG_CONFIG_HOME: await h.workdir() } },
    );
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;

    expect(result.code).toBe(0);
    const data = result.json<SignupData>().data;
    expect(data?.account?.name).toBe('Padel Roma');
    expect(data?.project?.name).toBe('Courts');
  });

  it('says what to do when the address already has an account', async () => {
    const email = freshEmail();
    const firstSince = h.mailer.sent.length;
    const first = h.cli(
      ['signup', '--accept-terms', '--approve-clauses', '--email', email, '--no-store', '--json'],
      {
        env: { XDG_CONFIG_HOME: await h.workdir() },
      },
    );
    await openTheLink(h, await tokenFor(h, email, firstSince));
    expect((await first).code).toBe(0);

    const secondSince = h.mailer.sent.length;
    const again = h.cli(
      ['signup', '--accept-terms', '--approve-clauses', '--email', email, '--no-store', '--json'],
      {
        env: { XDG_CONFIG_HOME: await h.workdir() },
      },
    );
    const taken = await openTheLink(h, await tokenFor(h, email, secondSince));
    expect(taken.status).toBe('email_taken');
    const result = await again;

    expect(result.code).toBe(4);
    const error = result.json().error;
    expect(error?.code).toBe('signup_email_taken');
    expect(error?.message).toContain('already has a Bookrail account');
    expect(error?.message).toContain('https://bookrail.dev/dashboard/');
  });

  /**
   * Ctrl-C, delivered on a condition rather than after a delay.
   *
   * The handler exists only once the command has reached its polling loop, and getting there is
   * a real HTTP round trip plus a call into Postgres. A timer set to thirty milliseconds is
   * right on an idle laptop and wrong on a loaded runner, where it fires into an empty list and
   * the interrupt is lost for ever. The condition here is the thing that proves the loop is
   * running: the first `claim` the server has seen.
   */
  it('stops cleanly on Ctrl-C and calls nothing after it', async () => {
    const email = freshEmail();
    // Everything this test looks at is counted from where it started: `seenRequests` is the
    // recorder of the whole file, and a claim from an earlier test would otherwise satisfy the
    // condition before this invocation had made one.
    const before = h.seenRequests.length;
    const claims = (): number =>
      h.seenRequests.slice(before).filter((request) => request.endsWith('/claim')).length;
    let atInterrupt = -1;

    const result = await h.cli(
      ['signup', '--accept-terms', '--approve-clauses', '--email', email],
      {
        interruptWhen: () => {
          if (claims() === 0) return false;
          atInterrupt = h.seenRequests.length;
          return true;
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Stopped waiting.');
    expect(result.stdout).toContain('bookrail signup again');
    expect(result.stderr).not.toContain('Error');

    // The interrupt really was delivered while the loop was polling, and after it the command
    // asked the server for nothing at all: no second claim, and no confirm.
    expect(atInterrupt).toBeGreaterThan(before);
    expect(h.seenRequests.length).toBe(atInterrupt);
    expect(h.seenRequests.slice(atInterrupt)).toEqual([]);
    expect(h.seenRequests.slice(before).filter((r) => r.endsWith('/confirm'))).toEqual([]);
  });

  it('has no em dash and no key in anything it prints', async () => {
    const emDash = String.fromCharCode(0x2014);
    const email = freshEmail();
    const running = h.cli(['signup', '--accept-terms', '--approve-clauses', '--email', email], {
      env: { XDG_CONFIG_HOME: await h.workdir() },
    });
    await openTheLink(h, await tokenFor(h, email));
    const result = await running;

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(emDash);
    expect(result.stderr).not.toContain(emDash);
    expect(result.stdout).toContain('We sent a link to');
    expect(result.stdout).toMatch(/test key\s+sk_test_[A-Za-z0-9_-]{8}\.\.\./);
    expect(result.stdout).toMatch(/live key\s+sk_live_[A-Za-z0-9_-]{8}\.\.\./);
    // The masked prefixes only. The whole keys are never on a stream.
    expect(result.stdout).not.toMatch(/sk_(test|live)_[A-Za-z0-9_-]{20,}/);
  });

  it('says where it was looking when it cannot reach the API at all', async () => {
    const result = await h.cli(
      [
        'signup',
        '--accept-terms',
        '--approve-clauses',
        '--email',
        freshEmail(),
        '--api-url',
        'http://127.0.0.1:1',
        '--json',
      ],
      { env: { XDG_CONFIG_HOME: await h.workdir() } },
    );
    expect(result.code).toBe(3);
    expect(result.json().error?.code).toBe('network_error');
    expect(result.json().error?.fix).toContain('127.0.0.1:1');
  });

  /**
   * A limit between the terminal and the API is a pause, not the end.
   *
   * In production `nginx` is in front, and its answer to a limit is a page of HTML that the
   * CLI's error envelope reader cannot make sense of. A `429` there used to end the command
   * with «The API answered 429 with an unexpected body», seconds after it started and long
   * before anybody could open an email. The server here is a real one in the middle: it refuses
   * the first claim exactly as `nginx` would, HTML body and all, and forwards everything else.
   */
  it('waits out a 429 from something in the middle instead of giving up', async () => {
    const email = freshEmail();
    let refused = 0;
    const proxy = createServer((request, response) => {
      void (async () => {
        const url = `${h.url}${request.url ?? '/'}`;
        if (/\/claim$/.test(url) && refused === 0) {
          refused += 1;
          response.writeHead(429, { 'content-type': 'text/html', 'retry-after': '1' });
          response.end('<html><head><title>429 Too Many Requests</title></head></html>');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string' && name !== 'host') headers.set(name, value);
        }
        const forwarded = await fetch(url, {
          method: request.method ?? 'GET',
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        });
        const body = Buffer.from(await forwarded.arrayBuffer());
        response.writeHead(forwarded.status, {
          'content-type': forwarded.headers.get('content-type') ?? 'application/json',
        });
        response.end(body);
      })();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;

    try {
      const running = h.cli(
        [
          'signup',
          '--accept-terms',
          '--approve-clauses',
          '--email',
          email,
          '--api-url',
          `http://127.0.0.1:${String(port)}`,
          '--json',
        ],
        { env: { XDG_CONFIG_HOME: await h.workdir() } },
      );
      await openTheLink(h, await tokenFor(h, email));
      const result = await running;

      expect(refused).toBe(1);
      expect(result.code).toBe(0);
      expect(result.json<SignupData>().data?.status).toBe('confirmed');
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

describe('bookrail signup against a deployment with no sign up', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ mailer: false });
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * The one `fix` the CLI does not write itself.
   *
   * Everything an agent needs to recover normally lives in the CLI's own table, because the CLI
   * knows what to run next and the API does not. What to do about a deployment that has no sign
   * up is the other way round, and the server's sentence has to survive the trip: this is the
   * test for `FIX_BY_CODE[code] ?? error.fix`.
   */
  it('repeats the fix the server sent, word for word', async () => {
    const result = await h.cli([
      'signup',
      '--accept-terms',
      '--approve-clauses',
      '--email',
      freshEmail(),
      '--json',
    ]);
    expect(result.code).toBe(3);
    const error = result.json().error;
    expect(error?.code).toBe('signup_disabled');
    expect(error?.message).toContain('not enabled on this deployment');
    expect(error?.fix).toBe('Write to hello@bookrail.dev and say what you are building.');
  });
});

/**
 * How long the poll sleeps when something in the middle says «not so fast».
 *
 * The number is not ours: anything between the terminal and the API can write `Retry-After`, and
 * a reverse proxy that answers sixty for a limit whose token comes back in one would park a sign
 * up for a minute while the link in the mailbox is already valid. The cap is what keeps somebody
 * else's arithmetic from becoming our waiting time.
 */
describe('the pause a Retry-After buys', () => {
  it('waits as long as the answer asks, between a floor and a ceiling', () => {
    expect(rateLimitPauseMs(undefined)).toBe(RATE_LIMIT_PAUSE_MS);
    expect(rateLimitPauseMs(1)).toBe(1_000);
    expect(rateLimitPauseMs(12)).toBe(12_000);
    // The ceiling, and the two values worth naming: sixty is what the reverse proxy used to send
    // for the wide zone, and three hundred is the largest `Retry-After` the client's own parser
    // accepts, so it is the largest number that can ever reach this function from a header.
    expect(rateLimitPauseMs(60)).toBe(MAX_RATE_LIMIT_PAUSE_MS);
    expect(rateLimitPauseMs(300)).toBe(MAX_RATE_LIMIT_PAUSE_MS);
    // And the floor. `Retry-After: 0` is legal, and without it the poll would become a tight loop
    // of HTTP requests for as long as the sign up stays valid.
    expect(rateLimitPauseMs(0)).toBe(MIN_RATE_LIMIT_PAUSE_MS);
  });
});
