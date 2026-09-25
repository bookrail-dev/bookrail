/**
 * `/v1/dashboard`, against the real API, the real definer functions and a real Postgres.
 *
 * The accounts are made the way a person makes one: a sign up through `/v1/signups`, with the
 * link read out of the message the API actually wrote. The dashboard is then entered the same
 * way, with the sign in link out of the second message. The only thing replaced is the mail
 * server, by the `log` mailer that keeps what it would have sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { createLogger, decodeId } from '@bookrail/shared';
import type { RateLimitDecision, RateLimiter } from '../src/rate-limit.js';
import { DASHBOARD_RATE_LIMIT } from '../src/routes/dashboard.js';
import { createHarness, type Harness } from './harness.js';

interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string; fix?: string };
}

interface ApiKeyBody {
  id: string;
  object: 'api_key';
  environment: 'test' | 'live';
  kind: string;
  name: string | null;
  prefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  secret_key?: string;
}

interface AccountBody {
  object: 'dashboard_account';
  account: { id: string; name: string; plan: string; owner_email: string };
  usage: {
    month: string;
    bookings_confirmed: number;
    bookings_included: number | null;
    payment_volume: number;
    payment_volume_included: number | null;
    currency: string | null;
    blocks_at_limit: boolean;
  };
  reserved: { bookings_pending: number; payment_volume_pending: number };
  projects: { id: string; name: string; api_keys: ApiKeyBody[] }[];
  session: { expires_at: string };
}

interface SignedUp {
  email: string;
  accountId: string;
  projectId: string;
  testKey: string;
  liveKey: string;
}

let counter = 0;
function freshEmail(): string {
  counter += 1;
  return `dashboard-${String(counter)}-${String(process.pid)}@example.com`;
}

function freshCaller(): Record<string, string> {
  counter += 1;
  return { 'x-forwarded-for': `192.0.2.${String(counter % 250)}` };
}

/** The token out of the last link sent to that address. */
function tokenSentTo(h: Harness, email: string, path: string): string {
  const message = [...(h.mailer?.sent ?? [])].reverse().find((sent) => sent.to === email);
  if (message === undefined) throw new Error(`no message was sent to ${email}`);
  const match = new RegExp(`${path}#token=([A-Za-z0-9_%-]+)`).exec(message.text);
  if (match?.[1] === undefined) throw new Error(`no ${path} link in:\n${message.text}`);
  return decodeURIComponent(match[1]);
}

/** An account, made through the sign up endpoints as a browser makes it. */
async function signUp(h: Harness): Promise<SignedUp> {
  const email = freshEmail();
  const started = await h.call('POST', '/v1/signups', {
    body: { email, client: 'web', accept_terms: true, approve_clauses: true },
    headers: freshCaller(),
  });
  expect(started.status).toBe(202);
  const confirmed = await h.call<{
    account: { id: string };
    project: { id: string };
    secret_key: string;
    live_secret_key: string;
  }>('POST', '/v1/signups/confirm', {
    body: { token: tokenSentTo(h, email, '/signup/confirm') },
  });
  expect(confirmed.status).toBe(200);
  return {
    email,
    accountId: confirmed.body.account.id,
    projectId: confirmed.body.project.id,
    testKey: confirmed.body.secret_key,
    liveKey: confirmed.body.live_secret_key,
  };
}

/** A dashboard session for that address, through the two sign in endpoints. */
async function signIn(h: Harness, email: string): Promise<string> {
  const asked = await h.call('POST', '/v1/dashboard/login', {
    body: { email },
    headers: freshCaller(),
  });
  expect(asked.status).toBe(202);
  const opened = await h.call<{ session_token: string }>('POST', '/v1/dashboard/login/confirm', {
    body: { token: tokenSentTo(h, email, '/dashboard/confirm') },
  });
  expect(opened.status).toBe(200);
  return opened.body.session_token;
}

describe('signing in', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('sends a link to the owner address, and nothing to a stranger, with the same answer', async () => {
    const account = await signUp(h);
    const stranger = freshEmail();
    const before = h.mailer?.sent.length ?? 0;

    const mine = await h.call<Record<string, unknown>>('POST', '/v1/dashboard/login', {
      body: { email: account.email.toUpperCase() },
      headers: freshCaller(),
    });
    expect(mine.status).toBe(202);
    expect((h.mailer?.sent.length ?? 0) - before).toBe(1);
    const message = h.mailer?.last();
    expect(message?.to).toBe(account.email);
    expect(message?.subject).toBe('Your Bookrail dashboard link');
    expect(message?.text).toContain('https://bookrail.dev/dashboard/confirm#token=bls_');

    const theirs = await h.call<Record<string, unknown>>('POST', '/v1/dashboard/login', {
      body: { email: stranger },
      headers: freshCaller(),
    });
    expect(theirs.status).toBe(202);
    expect((h.mailer?.sent.length ?? 0) - before).toBe(1);
    expect(Object.keys(theirs.body).sort()).toEqual(Object.keys(mine.body).sort());
    expect(theirs.body.object).toBe('dashboard_login');
  });

  it('refuses the sixth request of the hour for an address, whether or not it is a customer', async () => {
    const account = await signUp(h);
    for (const email of [account.email, freshEmail()]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const accepted = await h.call('POST', '/v1/dashboard/login', {
          body: { email },
          headers: freshCaller(),
        });
        expect(accepted.status, `${email} ${String(attempt)}`).toBe(202);
      }
      const sixth = await h.call<ErrorBody>('POST', '/v1/dashboard/login', {
        body: { email },
        headers: freshCaller(),
      });
      expect(sixth.status, email).toBe(429);
      expect(sixth.body.error.code).toBe('dashboard_login_rate_limited');
    }
  });

  it('turns a link into a session once, even when it is opened twice at the same instant', async () => {
    const account = await signUp(h);
    await h.call('POST', '/v1/dashboard/login', {
      body: { email: account.email },
      headers: freshCaller(),
    });
    const token = tokenSentTo(h, account.email, '/dashboard/confirm');

    const [a, b] = await Promise.all([
      h.call<ErrorBody & { session_token?: string }>('POST', '/v1/dashboard/login/confirm', {
        body: { token },
      }),
      h.call<ErrorBody & { session_token?: string }>('POST', '/v1/dashboard/login/confirm', {
        body: { token },
      }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('dashboard_login_used');
    const winner = a.status === 200 ? a : b;
    expect(winner.body.session_token).toMatch(/^bds_[A-Za-z0-9_-]{43}$/);
    // The session token in clear text: nothing in between may keep a copy.
    expect(winner.headers.get('cache-control')).toBe('no-store');

    const unknown = await h.call<ErrorBody>('POST', '/v1/dashboard/login/confirm', {
      body: { token: `bls_${'a'.repeat(43)}` },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('dashboard_login_not_found');
  });

  it('refuses a link after fifteen minutes', async () => {
    let offset = 0;
    const clocked = createHarness({ now: () => Date.now() + offset });
    try {
      const account = await signUp(clocked);
      await clocked.call('POST', '/v1/dashboard/login', {
        body: { email: account.email },
        headers: freshCaller(),
      });
      offset = 16 * 60_000;
      const late = await clocked.call<ErrorBody>('POST', '/v1/dashboard/login/confirm', {
        body: { token: tokenSentTo(clocked, account.email, '/dashboard/confirm') },
      });
      expect(late.status).toBe(410);
      expect(late.body.error.code).toBe('dashboard_login_expired');
    } finally {
      await clocked.close();
    }
  });
});

describe('the session', () => {
  let h: Harness;
  let offset = 0;

  beforeAll(() => {
    h = createHarness({ now: () => Date.now() + offset });
  });

  afterAll(async () => {
    await h.close();
  });

  it('ends after twelve hours', async () => {
    offset = 0;
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    expect((await h.call('GET', '/v1/dashboard/account', { token: session })).status).toBe(200);

    offset = 13 * 3_600_000;
    try {
      const expired = await h.call<ErrorBody>('GET', '/v1/dashboard/account', { token: session });
      expect(expired.status).toBe(401);
      expect(expired.body.error.code).toBe('dashboard_session_invalid');
    } finally {
      offset = 0;
    }
  });

  it('ends on sign out', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    const out = await h.call('POST', '/v1/dashboard/logout', { token: session });
    expect(out.status).toBe(204);
    expect(out.body).toBeNull();
    const after = await h.call<ErrorBody>('GET', '/v1/dashboard/account', { token: session });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('dashboard_session_invalid');
  });

  it('is refused on the API, and an API key is refused on the dashboard', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);

    const onApi = await h.call<ErrorBody>('GET', '/v1/project', { token: session });
    expect(onApi.status).toBe(401);
    expect(onApi.body.error.code).toBe('invalid_api_key');

    for (const key of [account.testKey, account.liveKey]) {
      const onDashboard = await h.call<ErrorBody>('GET', '/v1/dashboard/account', { token: key });
      expect(onDashboard.status).toBe(401);
      expect(onDashboard.body.error.code).toBe('dashboard_session_invalid');
    }
    const none = await h.call<ErrorBody>('GET', '/v1/dashboard/account');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('dashboard_session_invalid');
  });
});

describe('the account', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('shows the plan, the usage, the projects and the keys, and never a secret', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    const response = await h.call<AccountBody>('GET', '/v1/dashboard/account', {
      token: session,
    });
    expect(response.status).toBe(200);
    const body = response.body;
    // An owner address and the list of the keys: not for any cache either.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.account).toMatchObject({
      id: account.accountId,
      plan: 'free',
      owner_email: account.email,
    });
    expect(body.usage).toMatchObject({
      bookings_confirmed: 0,
      bookings_included: 1000,
      payment_volume_included: 100_000,
      blocks_at_limit: true,
    });
    expect(body.reserved).toEqual({ bookings_pending: 0, payment_volume_pending: 0 });
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.id).toBe(account.projectId);
    const keys = body.projects[0]!.api_keys;
    expect(keys.map((key) => key.environment).sort()).toEqual(['live', 'test']);
    for (const key of keys) {
      expect(key.status).toBe('active');
      expect(key.secret_key).toBeUndefined();
    }

    // No secret and no hash anywhere in the answer.
    const text = JSON.stringify(body);
    expect(text).not.toContain(account.testKey);
    expect(text).not.toContain(account.liveKey);
    const { rows } = await createDatabase(h.pools.admin).execute<{ key_hash: string }>(sql`
      SELECT key_hash FROM api_keys WHERE project_id = ${decodeId('project', account.projectId)}
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(text).not.toContain(row.key_hash);
  });

  it('creates a live key that works, shown once, and refuses the sixth active one', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    const created = await h.call<ApiKeyBody>(
      'POST',
      `/v1/dashboard/projects/${account.projectId}/keys`,
      { token: session, body: { environment: 'live', name: 'production' } },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ environment: 'live', name: 'production', kind: 'secret' });
    const secret = created.body.secret_key ?? '';
    expect(secret).toMatch(/^sk_live_/);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(secret).toContain(created.body.prefix);

    const project = await h.call<{ id: string; environment: string }>('GET', '/v1/project', {
      token: secret,
    });
    expect(project.status).toBe(200);
    expect(project.body).toMatchObject({ id: account.projectId, environment: 'live' });

    // The overview lists it without the secret.
    const overview = await h.call<AccountBody>('GET', '/v1/dashboard/account', { token: session });
    expect(JSON.stringify(overview.body)).not.toContain(secret);

    // One from the sign up and one above: three more reach five, the next is refused.
    for (let n = 0; n < 3; n += 1) {
      const more = await h.call('POST', `/v1/dashboard/projects/${account.projectId}/keys`, {
        token: session,
        body: { environment: 'live' },
      });
      expect(more.status).toBe(201);
    }
    const sixth = await h.call<ErrorBody>(
      'POST',
      `/v1/dashboard/projects/${account.projectId}/keys`,
      { token: session, body: { environment: 'live' } },
    );
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('key_limit_reached');
  });

  it('refuses the twenty-first key created for the account in a day', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    // The sign up made two already: eighteen more reach twenty.
    for (let n = 0; n < 18; n += 1) {
      const created = await h.call<ApiKeyBody>(
        'POST',
        `/v1/dashboard/projects/${account.projectId}/keys`,
        { token: session, body: { environment: 'test' } },
      );
      expect(created.status, String(n)).toBe(201);
      const revoked = await h.call('DELETE', `/v1/dashboard/keys/${created.body.id}`, {
        token: session,
      });
      expect(revoked.status).toBe(200);
    }
    const refused = await h.call<ErrorBody>(
      'POST',
      `/v1/dashboard/projects/${account.projectId}/keys`,
      { token: session, body: { environment: 'test' } },
    );
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('key_creation_rate_limited');
  });

  it('revokes a key, which is refused on the next request', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    expect((await h.call('GET', '/v1/project', { token: account.liveKey })).status).toBe(200);

    const overview = await h.call<AccountBody>('GET', '/v1/dashboard/account', { token: session });
    const live = overview.body.projects[0]!.api_keys.find((key) => key.environment === 'live')!;
    const revoked = await h.call<ApiKeyBody>('DELETE', `/v1/dashboard/keys/${live.id}`, {
      token: session,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ id: live.id, status: 'revoked' });
    expect(revoked.body.revoked_at).not.toBeNull();

    const refused = await h.call<ErrorBody>('GET', '/v1/project', { token: account.liveKey });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('revoked_api_key');
  });

  /**
   * `404` and not `403`: a session of one account learns nothing about another, not even that
   * the identifier exists.
   */
  it('shows, creates and revokes nothing of another account', async () => {
    const mine = await signUp(h);
    const theirs = await signUp(h);
    const session = await signIn(h, mine.email);

    const overview = await h.call<AccountBody>('GET', '/v1/dashboard/account', { token: session });
    expect(overview.body.projects.map((project) => project.id)).toEqual([mine.projectId]);

    const create = await h.call<ErrorBody>(
      'POST',
      `/v1/dashboard/projects/${theirs.projectId}/keys`,
      { token: session, body: { environment: 'live' } },
    );
    expect(create.status).toBe(404);
    expect(create.body.error.code).toBe('resource_missing');

    const theirSession = await signIn(h, theirs.email);
    const theirKeys = await h.call<AccountBody>('GET', '/v1/dashboard/account', {
      token: theirSession,
    });
    const theirKey = theirKeys.body.projects[0]!.api_keys[0]!;
    const revoke = await h.call<ErrorBody>('DELETE', `/v1/dashboard/keys/${theirKey.id}`, {
      token: session,
    });
    expect(revoke.status).toBe(404);
    expect(revoke.body.error.code).toBe('resource_missing');
    expect((await h.call('GET', '/v1/project', { token: theirs.testKey })).status).toBe(200);
    expect((await h.call('GET', '/v1/project', { token: theirs.liveKey })).status).toBe(200);
  });
});

describe('the dashboard routes and the rest of the API', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('exempts exactly /v1/dashboard and what is under it from the API key', async () => {
    const nearMiss = await h.call<ErrorBody>('GET', '/v1/dashboardx');
    expect(nearMiss.status).toBe(401);
    expect(nearMiss.body.error.code).toBe('missing_api_key');
    const traversal = await h.call<ErrorBody>('GET', '/v1/dashboard/../resources');
    expect(traversal.status).toBe(401);
    expect(traversal.body.error.code).toBe('missing_api_key');
  });

  it('answers CORS to the site on every status, and to nobody on the rest of the API', async () => {
    const preflight = await h.call('OPTIONS', '/v1/dashboard/account', {
      headers: { origin: 'https://bookrail.dev' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://bookrail.dev');
    expect(preflight.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, DELETE, OPTIONS',
    );
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
    expect(preflight.headers.get('access-control-max-age')).toBe('600');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

    const account = await signUp(h);
    const session = await signIn(h, account.email);
    const answers: [string, { status: number; headers: Headers }][] = [
      ['202', await h.call('POST', '/v1/dashboard/login', { body: { email: freshEmail() } })],
      ['400', await h.call('POST', '/v1/dashboard/login', { body: { email: 'nope' } })],
      ['200', await h.call('GET', '/v1/dashboard/account', { token: session })],
      ['401', await h.call('GET', '/v1/dashboard/account')],
      [
        '404',
        await h.call('POST', '/v1/dashboard/login/confirm', {
          body: { token: `bls_${'b'.repeat(43)}` },
        }),
      ],
      [
        '404 key',
        await h.call('DELETE', `/v1/dashboard/keys/key_${'0'.repeat(32)}`, { token: session }),
      ],
    ];
    expect(answers.map(([, response]) => response.status)).toEqual([202, 400, 200, 401, 404, 404]);
    for (const [what, response] of answers) {
      expect(response.headers.get('access-control-allow-origin'), what).toBe(
        'https://bookrail.dev',
      );
      expect(response.headers.get('vary'), what).toBe('Origin');
    }

    const elsewhere = await h.call('GET', '/v1/project', {
      token: account.testKey,
      headers: { origin: 'https://bookrail.dev' },
    });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ignores an Idempotency-Key and writes no event in the project log', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    const key = `dash-${String(Date.now())}`;
    const first = await h.call<ApiKeyBody>(
      'POST',
      `/v1/dashboard/projects/${account.projectId}/keys`,
      { token: session, body: { environment: 'test' }, headers: { 'idempotency-key': key } },
    );
    const second = await h.call<ApiKeyBody>(
      'POST',
      `/v1/dashboard/projects/${account.projectId}/keys`,
      { token: session, body: { environment: 'test' }, headers: { 'idempotency-key': key } },
    );
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers.get('Idempotent-Replayed')).toBeNull();

    const { rows } = await createDatabase(h.pools.admin).execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM events
       WHERE project_id = ${decodeId('project', account.projectId)}
    `);
    expect(rows[0]?.n).toBe('0');
  });

  it('answers 503 dashboard_disabled on the sign in when there is no mailer', async () => {
    const off = createHarness({ mailer: false });
    try {
      const response = await off.call<ErrorBody>('POST', '/v1/dashboard/login', {
        body: { email: freshEmail() },
      });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('dashboard_disabled');
      expect(response.headers.get('access-control-allow-origin')).toBe('https://bookrail.dev');
    } finally {
      await off.close();
    }
  });

  /**
   * What must never reach the log: the link token, the session token, a key, or the address.
   * The `log` mailer writes the whole message on purpose (which is why it is refused in
   * production), so the lines looked at are the access log and the dashboard's own.
   */
  it('writes no token, no key and no address to the log', async () => {
    const lines: string[] = [];
    const logged = createHarness({
      logger: createLogger({ level: 'info', sink: (line) => lines.push(line) }),
    });
    try {
      const account = await signUp(logged);
      const session = await signIn(logged, account.email);
      const link = tokenSentTo(logged, account.email, '/dashboard/confirm');
      const created = await logged.call<ApiKeyBody>(
        'POST',
        `/v1/dashboard/projects/${account.projectId}/keys`,
        { token: session, body: { environment: 'live' } },
      );
      await logged.call('DELETE', `/v1/dashboard/keys/${created.body.id}`, { token: session });
      await logged.call('POST', '/v1/dashboard/logout', { token: session });

      const records = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.msg !== 'mail_logged');
      expect(records.some((record) => record.msg === 'dashboard_key_created')).toBe(true);
      const text = JSON.stringify(records);
      for (const secret of [
        link,
        session,
        created.body.secret_key ?? 'nothing',
        account.testKey,
        account.liveKey,
        account.email,
      ]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      await logged.close();
    }
  });
});

/**
 * The ceiling of a session, on the limiter of the per key rate limit.
 *
 * The limiter is a recording one rather than the real GCRA: the arithmetic is the one of the per
 * key limiter and is proved by its own suite, and what is asked here is the wiring, which a
 * limiter that answers exactly what the test tells it to proves without a clock.
 */
describe('the rate limit of a session', () => {
  const calls: { id: string; rate: number; burst: number }[] = [];
  let refuse = false;
  const limiter: RateLimiter = {
    kind: 'memory',
    check(id: string, rate: number, burst: number): Promise<RateLimitDecision> {
      calls.push({ id, rate, burst });
      return Promise.resolve(
        refuse
          ? { allowed: false, limit: burst, remaining: 0, resetMs: 2_000, retryAfterMs: 100 }
          : { allowed: true, limit: burst, remaining: burst - 1, resetMs: 100, retryAfterMs: 0 },
      );
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ rateLimit: { rate: 100, burst: 100, limiter } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('counts a session in a bucket of its own, and answers 429 with Retry-After and CORS', async () => {
    const account = await signUp(h);
    const session = await signIn(h, account.email);
    calls.length = 0;

    const allowed = await h.call('GET', '/v1/dashboard/account', { token: session });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('ratelimit-limit')).toBe(String(DASHBOARD_RATE_LIMIT.burst));
    expect(allowed.headers.get('bookrail-plan-usage')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      rate: DASHBOARD_RATE_LIMIT.rate,
      burst: DASHBOARD_RATE_LIMIT.burst,
    });
    expect(calls[0]?.id).toMatch(/^dash:[0-9a-f-]{36}$/);

    refuse = true;
    try {
      const refused = await h.call<ErrorBody>('GET', '/v1/dashboard/account', { token: session });
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('rate_limited');
      expect(refused.headers.get('retry-after')).toBe('1');
      expect(refused.headers.get('access-control-allow-origin')).toBe('https://bookrail.dev');
    } finally {
      refuse = false;
    }
    // The two that obtain a session are limited by nginx, by address, and not here.
    const before = calls.length;
    await h.call('POST', '/v1/dashboard/login', { body: { email: freshEmail() } });
    expect(calls.length).toBe(before);
  });
});
