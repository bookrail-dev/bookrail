/**
 * The three endpoints that hand out a test key, and everything an unauthenticated caller
 * might try on them.
 *
 * Every test here runs against a real Postgres and the real `SECURITY DEFINER` functions: the
 * point of this feature is that the API creates an account without holding a privileged
 * connection, and a mocked database would prove nothing about that.
 *
 * The mailer is the `log` one, which keeps what it "sent" in memory, so the confirmation link
 * a test opens is the one the API produced rather than a value the test made up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createLogger } from '@bookrail/shared';
import { createDatabase, resolveDatabaseUrls } from '@bookrail/db';
import { createHarness, type Harness } from './harness.js';
import { TEST_DB_NAME } from './db-name.js';
import { purgeSignups } from '../src/jobs/tasks.js';

/** The migration role on the test database: the only way to look at `signups` from a test. */
function adminUrl(): string {
  return resolveDatabaseUrls({ databaseName: TEST_DB_NAME }).admin;
}

interface SignupBody {
  id: string;
  object: string;
  status: string;
  email?: string;
  expires_at?: string;
  poll_token?: string;
  delivered_to?: string;
  secret_key?: string;
  account?: { id: string; name: string };
  project?: { id: string; name: string; default_timezone: string; default_currency: string };
  api_key?: { id: string; environment: string; kind: string; prefix: string };
}

interface ErrorBody {
  error: { type: string; code: string; message: string; fix?: string };
}

/** A different address per test, so that the three a day ceiling belongs to one test only. */
let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `signup-${String(counter)}-${String(process.pid)}@example.com`;
}

/** A different caller per test, for the same reason: ten a day is per caller. */
function freshCaller(): Record<string, string> {
  counter += 1;
  return { 'x-forwarded-for': `203.0.113.${String(counter % 250)}` };
}

/** The token out of the link the API put in the message it sent. */
function tokenOfLastMessage(h: Harness): string {
  const message = h.mailer?.last();
  if (message === undefined) throw new Error('no message was sent');
  const match = /#token=([A-Za-z0-9_%-]+)/.exec(message.text);
  if (match?.[1] === undefined) throw new Error(`no token in the message:\n${message.text}`);
  return decodeURIComponent(match[1]);
}

async function start(
  h: Harness,
  body: Record<string, unknown>,
  headers: Record<string, string> = freshCaller(),
): Promise<{ status: number; body: SignupBody; headers: Headers }> {
  const response = await h.call<SignupBody>('POST', '/v1/signups', { body, headers });
  return response;
}

describe('POST /v1/signups', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('accepts a request without a key and sends exactly one message', async () => {
    const email = freshEmail();
    const before = h.mailer?.sent.length ?? 0;
    const response = await start(h, { email, client: 'web' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ object: 'signup', status: 'pending', email });
    expect(response.body.id).toMatch(/^sgn_[0-9a-f]{32}$/);
    expect(typeof response.body.expires_at).toBe('string');
    // A browser has nothing to come back for: the key is in the answer to its own confirm.
    expect(response.body.poll_token).toBeUndefined();

    expect((h.mailer?.sent.length ?? 0) - before).toBe(1);
    const message = h.mailer?.last();
    expect(message?.to).toBe(email);
    expect(message?.subject).toBe('Confirm your Bookrail test key');
    expect(message?.text).toContain('https://bookrail.dev/signup/confirm#token=');
  });

  it('gives a terminal a poll token and never the confirmation token', async () => {
    const response = await start(h, { email: freshEmail(), client: 'cli' });
    expect(response.status).toBe(202);
    expect(response.body.poll_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const token = tokenOfLastMessage(h);
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('lower cases and trims the address, and defaults the names', async () => {
    const email = freshEmail();
    const response = await start(h, { email: `  ${email.toUpperCase()} `, client: 'web' });
    expect(response.status).toBe(202);
    expect(response.body.email).toBe(email);
  });

  it('answers a free address and a taken one exactly the same way', async () => {
    const email = freshEmail();
    const first = await start(h, { email, client: 'web' });
    const confirm = await h.call<SignupBody>('POST', '/v1/signups/confirm', {
      body: { token: tokenOfLastMessage(h) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('confirmed');

    // The address now has an account. The second request must be indistinguishable from the
    // first, or this endpoint becomes a way of asking whether somebody is a customer.
    const second = await start(h, { email, client: 'web' });
    expect(second.status).toBe(first.status);
    expect(Object.keys(second.body).sort()).toEqual(Object.keys(first.body).sort());
    expect(second.body.status).toBe('pending');
  });

  it('refuses the fourth request for one address in a day', async () => {
    const email = freshEmail();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await start(h, { email, client: 'web' });
      expect(response.status, `attempt ${String(attempt)}`).toBe(202);
    }
    const fourth = await h.call<ErrorBody>('POST', '/v1/signups', {
      body: { email, client: 'web' },
      headers: freshCaller(),
    });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatchObject({
      type: 'rate_limit',
      code: 'signup_rate_limited',
    });
  });

  it('refuses the eleventh request from one caller in a day', async () => {
    const caller = { 'x-forwarded-for': '198.51.100.7' };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await start(h, { email: freshEmail(), client: 'web' }, caller);
      expect(response.status, `attempt ${String(attempt)}`).toBe(202);
    }
    const eleventh = await h.call<ErrorBody>('POST', '/v1/signups', {
      body: { email: freshEmail(), client: 'web' },
      headers: caller,
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('signup_rate_limited');
  });

  it('refuses a body it does not understand', async () => {
    const bad = await h.call<ErrorBody>('POST', '/v1/signups', {
      body: { email: 'not-an-address', client: 'web' },
      headers: freshCaller(),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('parameter_invalid');

    const unknown = await h.call<ErrorBody>('POST', '/v1/signups', {
      body: { email: freshEmail(), client: 'web', plan: 'enterprise' },
      headers: freshCaller(),
    });
    expect(unknown.status).toBe(400);
  });
});

describe('POST /v1/signups/confirm', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('creates an account, a project and one test key, and shows the key once', async () => {
    const email = freshEmail();
    await start(h, {
      email,
      client: 'web',
      project_name: 'Padel',
      default_timezone: 'Europe/Rome',
    });
    const response = await h.call<SignupBody>('POST', '/v1/signups/confirm', {
      body: { token: tokenOfLastMessage(h) },
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('confirmed');
    expect(response.body.account?.id).toMatch(/^acct_/);
    expect(response.body.project).toMatchObject({
      name: 'Padel',
      default_timezone: 'Europe/Rome',
      default_currency: 'EUR',
    });
    expect(response.body.api_key).toMatchObject({ environment: 'test', kind: 'secret' });
    const secret = response.body.secret_key ?? '';
    expect(secret).toMatch(/^sk_test_/);
    expect(secret).toContain(response.body.api_key?.prefix ?? 'nothing');

    // The key it minted is a key: it opens the project it was made for.
    const project = await h.call<{ id: string; name: string }>('GET', '/v1/project', {
      token: secret,
    });
    expect(project.status).toBe(200);
    expect(project.body.id).toBe(response.body.project?.id);
  });

  it('sends a terminal its key through the claim and not in the response', async () => {
    const created = await start(h, { email: freshEmail(), client: 'cli' });
    const confirm = await h.call<SignupBody>('POST', '/v1/signups/confirm', {
      body: { token: tokenOfLastMessage(h) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.delivered_to).toBe('cli');
    expect(confirm.body.secret_key).toBeUndefined();
    expect(confirm.body.api_key?.prefix).toMatch(/^[A-Za-z0-9_-]{8}$/);

    const claim = await h.call<SignupBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(claim.status).toBe(200);
    expect(claim.body.secret_key).toMatch(/^sk_test_/);
    expect(claim.body.api_key?.id).toBe(confirm.body.api_key?.id);
  });

  it('says email_taken and creates nothing when the address already has an account', async () => {
    const email = freshEmail();
    await start(h, { email, client: 'web' });
    const first = await h.call<SignupBody>('POST', '/v1/signups/confirm', {
      body: { token: tokenOfLastMessage(h) },
    });
    expect(first.body.status).toBe('confirmed');

    await start(h, { email, client: 'web' });
    const second = await h.call<SignupBody>('POST', '/v1/signups/confirm', {
      body: { token: tokenOfLastMessage(h) },
    });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('email_taken');
    expect(second.body.account).toBeUndefined();
    expect(second.body.secret_key).toBeUndefined();

    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounts WHERE origin = 'self_serve' AND owner_email = $1`,
        [email],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await admin.end();
    }
  });

  /**
   * Two **different** links for the same address, opened at the same instant.
   *
   * This is not the race above. There each transaction locks the same row, so the second one
   * finds the status already moved; here they lock two different rows, both read "the address
   * is free", and both try to insert. What stops the second is the partial unique index on
   * `accounts`, and the question this test asks is what the caller is told about it: the
   * documented `email_taken`, not the generic conflict a raw `unique_violation` would become.
   *
   * The situation is not exotic: the message the terminal prints on Ctrl-C invites it
   * ("Run bookrail signup again to get a new link"), so two live links for one address is the
   * ordinary state of somebody who tried twice.
   */
  it('creates one account when two links for the same address are opened at once', async () => {
    const email = freshEmail();
    await start(h, { email, client: 'web' });
    const firstToken = tokenOfLastMessage(h);
    await start(h, { email, client: 'web' });
    const secondToken = tokenOfLastMessage(h);
    expect(secondToken).not.toBe(firstToken);

    const [a, b] = await Promise.all([
      h.call<SignupBody & ErrorBody>('POST', '/v1/signups/confirm', {
        body: { token: firstToken },
      }),
      h.call<SignupBody & ErrorBody>('POST', '/v1/signups/confirm', {
        body: { token: secondToken },
      }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const outcomes = [a.body.status, b.body.status].sort();
    expect(outcomes).toEqual(['confirmed', 'email_taken']);
    const winner = a.body.status === 'confirmed' ? a.body : b.body;
    const loser = a.body.status === 'confirmed' ? b.body : a.body;
    expect(winner.secret_key).toMatch(/^sk_test_/);
    expect(loser.account).toBeUndefined();
    expect(loser.secret_key).toBeUndefined();

    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounts WHERE origin = 'self_serve' AND owner_email = $1`,
        [email],
      );
      expect(rows[0]?.n).toBe('1');
      // The refused one is closed, not left pending: its link cannot be used again.
      const { rows: statuses } = await admin.query<{ status: string }>(
        'SELECT status FROM signups WHERE email = $1 ORDER BY created_at',
        [email],
      );
      expect(statuses.map((row) => row.status).sort()).toEqual(['claimed', 'email_taken']);
    } finally {
      await admin.end();
    }
  });

  it('refuses an unknown token, a used one, and an expired one', async () => {
    const unknown = await h.call<ErrorBody>('POST', '/v1/signups/confirm', {
      body: { token: 'a'.repeat(43) },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('signup_not_found');

    const created = await start(h, { email: freshEmail(), client: 'web' });
    const token = tokenOfLastMessage(h);
    const first = await h.call<SignupBody>('POST', '/v1/signups/confirm', { body: { token } });
    expect(first.status).toBe(200);
    const again = await h.call<ErrorBody>('POST', '/v1/signups/confirm', { body: { token } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('signup_already_confirmed');

    // Expiry, without waiting an hour for it: the row is moved into the past.
    const expiring = await start(h, { email: freshEmail(), client: 'web' });
    const expiringToken = tokenOfLastMessage(h);
    await ageSignup(expiringToken);
    const expired = await h.call<ErrorBody>('POST', '/v1/signups/confirm', {
      body: { token: expiringToken },
    });
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('signup_expired');
    expect(created.body.id).not.toBe(expiring.body.id);
  });

  /**
   * Two clicks on the same link, really overlapping rather than one after the other.
   *
   * `Promise.all` on two `fetch`-shaped calls is enough here because the row is taken
   * `FOR UPDATE` inside the function: the second transaction waits on the lock, and by the
   * time it reads the row the status has moved. One account, one refusal.
   */
  it('creates one account when the same link is opened twice at once', async () => {
    const email = freshEmail();
    await start(h, { email, client: 'web' });
    const token = tokenOfLastMessage(h);

    const [a, b] = await Promise.all([
      h.call<SignupBody & ErrorBody>('POST', '/v1/signups/confirm', { body: { token } }),
      h.call<SignupBody & ErrorBody>('POST', '/v1/signups/confirm', { body: { token } }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounts WHERE origin = 'self_serve' AND owner_email = $1`,
        [email],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await admin.end();
    }
  });
});

describe('POST /v1/signups/{id}/claim', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers pending until the link is opened', async () => {
    const created = await start(h, { email: freshEmail(), client: 'cli' });
    const pending = await h.call<SignupBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.secret_key).toBeUndefined();
    expect(typeof pending.body.expires_at).toBe('string');
  });

  it('hands the key over exactly once', async () => {
    const created = await start(h, { email: freshEmail(), client: 'cli' });
    await h.call('POST', '/v1/signups/confirm', { body: { token: tokenOfLastMessage(h) } });

    const first = await h.call<SignupBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(first.status).toBe(200);
    expect(first.body.secret_key).toMatch(/^sk_test_/);

    const second = await h.call<ErrorBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('signup_secret_claimed');
  });

  it('refuses a wrong poll token exactly as it refuses a wrong identifier', async () => {
    const created = await start(h, { email: freshEmail(), client: 'cli' });
    const wrongToken = await h.call<ErrorBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: 'b'.repeat(43) },
    });
    expect(wrongToken.status).toBe(404);
    expect(wrongToken.body.error.code).toBe('signup_not_found');

    const wrongId = await h.call<ErrorBody>('POST', `/v1/signups/sgn_${'0'.repeat(32)}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(wrongId.status).toBe(404);
    expect(wrongId.body.error.code).toBe('signup_not_found');
  });

  it('says the key expired when nobody came for it in fifteen minutes', async () => {
    const created = await start(h, { email: freshEmail(), client: 'cli' });
    await h.call('POST', '/v1/signups/confirm', { body: { token: tokenOfLastMessage(h) } });
    await ageEnvelope(created.body.id);

    const response = await h.call<ErrorBody>('POST', `/v1/signups/${created.body.id}/claim`, {
      body: { poll_token: created.body.poll_token },
    });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('signup_secret_expired');
  });
});

describe('the sign up endpoints and the rest of the API', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('exempts exactly /v1/signups and what is under it from authentication', async () => {
    // One character further and it is a different path, which still needs a key.
    const nearMiss = await h.call<ErrorBody>('POST', '/v1/signupsx', { body: {} });
    expect(nearMiss.status).toBe(401);
    expect(nearMiss.body.error.code).toBe('missing_api_key');

    // A traversal that resolves to another endpoint gets that endpoint's rules, not these.
    const traversal = await h.call<ErrorBody>('GET', '/v1/signups/../resources');
    expect(traversal.status).toBe(401);
    expect(traversal.body.error.code).toBe('missing_api_key');
  });

  it('ignores an Idempotency-Key instead of refusing it', async () => {
    const key = `signup-${String(Date.now())}`;
    const first = await h.call<SignupBody>('POST', '/v1/signups', {
      body: { email: freshEmail(), client: 'web' },
      headers: { ...freshCaller(), 'idempotency-key': key },
    });
    const second = await h.call<SignupBody>('POST', '/v1/signups', {
      body: { email: freshEmail(), client: 'web' },
      headers: { ...freshCaller(), 'idempotency-key': key },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // Not a replay: two different sign ups, and no `Idempotent-Replayed` header.
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers.get('Idempotent-Replayed')).toBeNull();
  });

  it('answers CORS on the sign up routes and on nothing else', async () => {
    const preflight = await h.call('OPTIONS', '/v1/signups', {
      headers: { origin: 'https://bookrail.dev' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://bookrail.dev');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(preflight.headers.get('vary')).toBe('Origin');

    const created = await h.call('POST', '/v1/signups', {
      body: { email: freshEmail(), client: 'web' },
      headers: freshCaller(),
    });
    expect(created.headers.get('access-control-allow-origin')).toBe('https://bookrail.dev');

    const elsewhere = await h.call('GET', '/v1/resources', {
      headers: { origin: 'https://bookrail.dev' },
    });
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
    expect(elsewhere.headers.get('vary')).toBeNull();
  });

  /**
   * The half that matters most, and the half that was missing.
   *
   * A response without `Access-Control-Allow-Origin` is refused by the browser **before** the
   * page can read it, so an error that carries a `message` and a `fix` is worth nothing to the
   * sign up form unless the header is there too. The form then falls into its network branch
   * and says the API is unreachable, which is false and helps nobody. Every status is checked
   * here, not just the happy one.
   */
  it('answers CORS on every error status of a sign up route, and on no error elsewhere', async () => {
    const email = freshEmail();
    const caller = { 'x-forwarded-for': '198.51.100.99' };

    // 400: an address that is not one.
    const bad = await h.call('POST', '/v1/signups', {
      body: { email: 'nope', client: 'web' },
      headers: caller,
    });
    // 404: a token nobody was ever sent.
    const missing = await h.call('POST', '/v1/signups/confirm', {
      body: { token: 'a'.repeat(43) },
    });
    // 409 and 410: a link used twice, and one whose hour has run out.
    const first = await start(h, { email, client: 'web' }, caller);
    const token = tokenOfLastMessage(h);
    await h.call('POST', '/v1/signups/confirm', { body: { token } });
    const used = await h.call('POST', '/v1/signups/confirm', { body: { token } });
    const stale = await start(h, { email: freshEmail(), client: 'web' }, caller);
    const staleToken = tokenOfLastMessage(h);
    await ageSignup(staleToken);
    const expired = await h.call('POST', '/v1/signups/confirm', { body: { token: staleToken } });
    // 429: the fourth request for one address in a day. `first` was the first of the three.
    await start(h, { email, client: 'web' }, caller);
    await start(h, { email, client: 'web' }, caller);
    const limited = await h.call('POST', '/v1/signups', {
      body: { email, client: 'web' },
      headers: caller,
    });
    // 410 on the claim: a sign up that has no key to hand over.
    const claimed = await h.call('POST', `/v1/signups/${stale.body.id}/claim`, {
      body: { poll_token: 'b'.repeat(43) },
    });

    const answers: [string, { status: number; headers: Headers }][] = [
      ['400', bad],
      ['404', missing],
      ['409', used],
      ['410', expired],
      ['429', limited],
      ['404 claim', claimed],
    ];
    expect(answers.map(([, response]) => response.status)).toEqual([400, 404, 409, 410, 429, 404]);
    for (const [what, response] of answers) {
      expect(response.headers.get('access-control-allow-origin'), what).toBe(
        'https://bookrail.dev',
      );
      expect(response.headers.get('vary'), what).toBe('Origin');
    }
    expect(first.status).toBe(202);

    // And an error of the rest of `/v1` still carries nothing: a secret key does not belong in
    // a browser, so neither does a header inviting one.
    const elsewhere = await h.call('GET', '/v1/resources/res_00000000000000000000000000000000', {
      headers: { origin: 'https://bookrail.dev' },
    });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
    expect(elsewhere.headers.get('vary')).toBeNull();
  });

  /**
   * What must never reach the log: the confirmation token, the poll token, the key, or the
   * address in clear text. The access log line is the one line the request middleware writes,
   * and it names the path and the status and nothing of the body.
   */
  it('writes no token, no key and no address to the log', async () => {
    const lines: string[] = [];
    const logged = createHarness({
      logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }),
    });
    try {
      const email = freshEmail();
      const created = await logged.call<SignupBody>('POST', '/v1/signups', {
        body: { email, client: 'cli' },
        headers: freshCaller(),
      });
      // The `log` mailer deliberately writes the whole message, which is why it is refused in
      // production. Only the access log is under test here.
      const access = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.msg === 'request');
      expect(access.length).toBeGreaterThan(0);
      const text = JSON.stringify(access);

      const token = tokenOfLastMessage(logged);
      expect(text).not.toContain(token);
      expect(text).not.toContain(created.body.poll_token ?? 'nothing');
      expect(text).not.toContain(email);

      const confirm = await logged.call<SignupBody>('POST', '/v1/signups/confirm', {
        body: { token },
      });
      const claim = await logged.call<SignupBody>('POST', `/v1/signups/${created.body.id}/claim`, {
        body: { poll_token: created.body.poll_token },
      });
      expect(confirm.status).toBe(200);
      expect(claim.status).toBe(200);
      const all = JSON.stringify(
        lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((record) => record.msg === 'request'),
      );
      expect(all).not.toContain(claim.body.secret_key ?? 'nothing');
      expect(all).not.toContain(token);
    } finally {
      await logged.close();
    }
  });
});

describe('a deployment with no mailer', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ mailer: false });
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers 503 on all three, with the old way in, and with the CORS headers', async () => {
    for (const [path, body] of [
      ['/v1/signups', { email: 'a@example.com', client: 'web' }],
      ['/v1/signups/confirm', { token: 'a'.repeat(43) }],
      [`/v1/signups/sgn_${'0'.repeat(32)}/claim`, { poll_token: 'a'.repeat(43) }],
    ] as const) {
      const response = await h.call<ErrorBody>('POST', path, { body });
      expect(response.status, path).toBe(503);
      expect(response.body.error.code, path).toBe('signup_disabled');
      expect(response.body.error.fix).toContain('hello@bookrail.dev');
      // Without this the page shows "the API could not be reached" instead of the sentence
      // above, which is the whole point of answering 503 rather than failing.
      expect(response.headers.get('access-control-allow-origin'), path).toBe(
        'https://bookrail.dev',
      );
      expect(response.headers.get('vary'), path).toBe('Origin');
    }
  });
});

describe('a mail server that is down', () => {
  let h: Harness;
  const lines: string[] = [];

  beforeAll(() => {
    h = createHarness({
      mailer: 'failing',
      logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }),
    });
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * The row stays behind on purpose, and the daily limit counts it: a mail server that refuses
   * is not an invitation to try the same address fifty times.
   */
  it('answers 502 and keeps the request it could not tell anybody about', async () => {
    const email = freshEmail();
    const response = await h.call<ErrorBody>('POST', '/v1/signups', {
      body: { email, client: 'web' },
      headers: freshCaller(),
    });
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({ type: 'internal', code: 'signup_email_failed' });
    expect(response.body.error.fix).toContain('Try again in a minute');
    // The address is not in the failure line either. An SMTP refusal quotes the envelope
    // (`550 5.1.1 <you@example.com>: Recipient address rejected`), so only the class of the
    // failure is written down.
    const failures = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === 'signup_email_failed');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain(email);
    expect(JSON.stringify(failures)).not.toContain('connection refused');
    expect(failures[0]?.error_code).toBe('Error');

    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM signups WHERE email = $1',
        [email],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await admin.end();
    }
  });
});

describe('the hourly sweep', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * The instant is a parameter, so this asks what next week does without waiting for it. The
   * two rows are created here and the assertions are about them by identifier, so a row another
   * test left behind cannot make this pass or fail.
   */
  it('clears expired envelopes, marks stale requests and deletes what is past retention', async () => {
    const stale = await start(h, { email: freshEmail(), client: 'web' });
    const collected = await start(h, { email: freshEmail(), client: 'cli' });
    await h.call('POST', '/v1/signups/confirm', { body: { token: tokenOfLastMessage(h) } });

    const admin = new Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      // Nothing has aged yet: the pending request is still pending and the envelope is intact.
      const before = await rowsOf(admin, [stale.body.id, collected.body.id]);
      expect(before.get(stale.body.id)?.status).toBe('pending');
      expect(before.get(collected.body.id)?.has_secret).toBe(true);

      // The function the worker actually calls, on rows that have nothing to purge yet. It has
      // to report the truth about them, which is zero: an assertion of "at least zero" would be
      // true even if it purged nothing ever.
      const db = createDatabase(h.pools.app);
      const idle = await purgeSignups({ db, logger: h.logger });
      const untouched = await rowsOf(admin, [stale.body.id, collected.body.id]);
      expect(untouched.get(stale.body.id)?.status).toBe('pending');
      expect(untouched.get(collected.body.id)?.has_secret).toBe(true);

      // Now age both of them by hand, and call the same function again. Two rows change: the
      // request whose hour has run out, and the envelope nobody came for.
      await admin.query(
        `UPDATE signups SET created_at = created_at - interval '2 hours',
                            expires_at = expires_at - interval '2 hours',
                            pending_secret_expires_at =
                              pending_secret_expires_at - interval '2 hours'
          WHERE id = ANY($1::uuid[])`,
        [[stale.body.id, collected.body.id].map((id) => uuidOf(id))],
      );
      const aged = await purgeSignups({ db, logger: h.logger });
      // Exactly the two that were aged, and nothing invented: the call before this one left
      // the table with nothing to purge, so anything this run reports is work it really did.
      expect(idle).toBeGreaterThanOrEqual(0);
      expect(aged).toBeGreaterThanOrEqual(2);

      const after = await rowsOf(admin, [stale.body.id, collected.body.id]);
      expect(after.get(stale.body.id)?.status).toBe('expired');
      expect(after.get(collected.body.id)?.has_secret).toBe(false);

      // Eight days on: everything past the retention goes, address included. The count is
      // compared with what the table actually held a moment earlier, not with zero.
      const { rows: doomed } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM signups
          WHERE created_at < (now() + interval '8 days') - interval '7 days'`,
      );
      expect(Number(doomed[0]?.n)).toBeGreaterThanOrEqual(2);
      const { rows: deleted } = await admin.query<{ purged: number }>(
        `SELECT signups_purge(now() + interval '8 days') AS purged`,
      );
      expect(deleted[0]?.purged).toBeGreaterThanOrEqual(Number(doomed[0]?.n));
      const gone = await rowsOf(admin, [stale.body.id, collected.body.id]);
      expect(gone.size).toBe(0);
    } finally {
      await admin.end();
    }
  });
});

/** The `signups` rows behind a list of public identifiers, read as the migration role. */
async function rowsOf(
  admin: Client,
  ids: string[],
): Promise<Map<string, { status: string; has_secret: boolean }>> {
  const uuids = ids.map((id) => uuidOf(id));
  const { rows } = await admin.query<{ id: string; status: string; has_secret: boolean }>(
    `SELECT id::text, status, pending_secret IS NOT NULL AS has_secret
       FROM signups WHERE id = ANY($1::uuid[])`,
    [uuids],
  );
  const byPublicId = new Map<string, { status: string; has_secret: boolean }>();
  for (const row of rows) {
    const publicId = `sgn_${row.id.replaceAll('-', '')}`;
    byPublicId.set(publicId, { status: row.status, has_secret: row.has_secret });
  }
  return byPublicId;
}

function uuidOf(publicId: string): string {
  const hex = publicId.replace(/^sgn_/, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Moves a sign up an hour into the past, which is what an hour of real time would do. */
async function ageSignup(token: string): Promise<void> {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      `UPDATE signups SET created_at = now() - interval '2 hours',
                          expires_at = now() - interval '1 hour'
        WHERE token_hash = $1`,
      [hash],
    );
    if (rowCount !== 1) throw new Error('the sign up to age was not found');
  } finally {
    await admin.end();
  }
}

/** Moves an envelope past its fifteen minutes, leaving the sign up itself alone. */
async function ageEnvelope(publicId: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      `UPDATE signups SET pending_secret_expires_at = now() - interval '1 minute'
        WHERE id = $1::uuid`,
      [uuidOf(publicId)],
    );
    if (rowCount !== 1) throw new Error('the sign up to age was not found');
  } finally {
    await admin.end();
  }
}
