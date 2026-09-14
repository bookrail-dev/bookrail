/**
 * The daily usage digest: the text it produces, the rows it reads, and the job that sends it.
 *
 * Three layers, and they are separated because they fail for different reasons.
 *
 *   1. {@link buildUsageDigest} is pure, so every shape of day is a fixed input and a fixed
 *      expectation: nothing happened, something happened, a lot happened, no Redis at all.
 *      This is where the promises about the message live (no address of a stranger, no key, no
 *      hash, 78 columns, the three numbers in the subject).
 *   2. `collectUsageDigest` against the real Postgres, through the RLS-bound application role
 *      and the three `SECURITY DEFINER` functions of migration 0022, with real rows.
 *   3. The job on the real pg-boss queue, with the `log` mailer, which proves the only thing
 *      left: that a tick reaches the digest and a message comes out addressed where it should
 *      be, and that with no address configured the queue does not exist at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, resolveDatabaseUrls, sql } from '@bookrail/db';
import { createLogger, decodeId, silentLogger, uuidv7 } from '@bookrail/shared';
import { MemoryAvailabilityCache } from '@bookrail/engine';
import {
  buildUsageDigest,
  collectUsageDigest,
  DIGEST_MAX_ROWS,
  DIGEST_SIGNUP_WINDOW_HOURS,
  DIGEST_WIDTH,
  REQUESTS_NO_REDIS,
  runUsageDigest,
  startWorker,
  USAGE_DIGEST_QUEUE,
  usageDigestOffReason,
  DEFAULT_USAGE_DIGEST_CRON,
  USAGE_DIGEST_TIMEZONE,
  type UsageDigestData,
  type Worker,
} from '../src/jobs/index.js';
import { createLogMailer } from '../src/mail/index.js';
import { createHarness, type BootstrappedProject, type Harness } from './harness.js';
import { TEST_DB_NAME } from './db-name.js';
import { until } from './until.js';

/** Assembled from its code point, so that this file is not itself an occurrence of it. */
const EM_DASH = String.fromCharCode(0x2014);

/** Friday 14 September 2026, 07:00 Europe/Rome, which is 05:00 UTC. */
const NOW = new Date('2026-09-14T05:00:00.000Z');

function emptyData(overrides: Partial<UsageDigestData> = {}): UsageDigestData {
  return {
    signups: [],
    accounts: [],
    keys: [],
    requests: null,
    requestsUnavailable: REQUESTS_NO_REDIS,
    host: 'worker-1',
    timezone: 'Europe/Rome',
    signupWindowHours: 25,
    keyWindowDays: 7,
    ...overrides,
  };
}

function busyData(): UsageDigestData {
  return emptyData({
    signups: [
      {
        createdAt: new Date('2026-09-13T18:02:00.000Z'),
        client: 'web',
        status: 'claimed',
        email: 'ada@example.com',
        accountName: "Ada's club",
        projectName: 'Padel',
      },
      {
        createdAt: new Date('2026-09-13T19:40:00.000Z'),
        client: 'cli',
        status: 'email_taken',
        email: null,
        accountName: 'A very long account name that nobody would really type here',
        projectName: 'Another very long project name for the same reason',
      },
    ],
    accounts: [
      {
        name: "Ada's club",
        origin: 'self_serve',
        ownerEmail: 'ada@example.com',
        createdAt: new Date('2026-09-13T18:05:00.000Z'),
        projects: 1,
      },
    ],
    keys: [
      {
        accountName: "Ada's club",
        accountOrigin: 'self_serve',
        projectId: 'aaaaaaaa-0000-0000-0000-000000000001',
        projectName: 'Padel',
        environment: 'test',
        kind: 'secret',
        lastUsedAt: new Date('2026-09-14T05:12:00.000Z'),
        createdAt: new Date('2026-09-13T18:05:00.000Z'),
      },
      {
        accountName: 'Bookrail',
        accountOrigin: 'bootstrap',
        projectId: 'aaaaaaaa-0000-0000-0000-000000000002',
        projectName: 'Bookrail smoke',
        environment: 'test',
        kind: 'secret',
        lastUsedAt: new Date('2026-09-12T04:00:00.000Z'),
        createdAt: new Date('2026-09-07T10:00:00.000Z'),
      },
    ],
    requests: {
      day: '2026-09-13',
      rows: [
        {
          projectId: 'aaaaaaaa-0000-0000-0000-000000000001',
          projectName: 'Padel',
          environment: 'test',
          requests: 400,
          err4xx: 9,
          err5xx: 0,
        },
        {
          projectId: 'aaaaaaaa-0000-0000-0000-000000000002',
          projectName: 'Bookrail smoke',
          environment: 'test',
          requests: 12,
          err4xx: 0,
          err5xx: 0,
        },
      ],
      week: [
        { day: '2026-09-07', requests: 240 },
        { day: '2026-09-08', requests: 301 },
        { day: '2026-09-09', requests: 0 },
        { day: '2026-09-10', requests: 0 },
        { day: '2026-09-11', requests: 850 },
        { day: '2026-09-12', requests: 0 },
        { day: '2026-09-13', requests: 412 },
      ],
    },
    requestsUnavailable: undefined,
  });
}

describe('the text of the usage digest', () => {
  it('says nothing happened, rather than saying nothing', () => {
    const { subject, text } = buildUsageDigest(emptyData(), NOW);
    expect(subject).toBe(
      'Bookrail usage, 14 September 2026: 0 sign ups, 0 keys used, requests unavailable',
    );
    expect(text).toContain('Bookrail usage digest, Monday 14 September 2026, 07:00 Europe/Rome');
    expect(text).toContain('Sign ups in the last 25 hours: 0');
    expect(text).toContain('New accounts in the last 25 hours: 0');
    expect(text).toContain('Keys used in the last 7 days: 0');
    expect(text).toContain(REQUESTS_NO_REDIS);
    expect(text).toContain('Sent by the Bookrail worker on worker-1.');
    expect(text).toContain('usage_digest_* (migration 0022).');
  });

  it('puts the three numbers of the day in the subject', () => {
    const { subject } = buildUsageDigest(busyData(), NOW);
    expect(subject).toBe(
      'Bookrail usage, 14 September 2026: 2 sign ups, 2 keys used, 412 requests',
    );
  });

  it('counts one of a thing in the singular', () => {
    const data = busyData();
    data.signups = [data.signups[0]!];
    data.keys = [data.keys[0]!];
    data.requests = {
      day: '2026-09-13',
      rows: [{ ...data.requests!.rows[0]!, requests: 1, err4xx: 0 }],
      week: [{ day: '2026-09-13', requests: 1 }],
    };
    const { subject } = buildUsageDigest(data, NOW);
    expect(subject).toBe('Bookrail usage, 14 September 2026: 1 sign up, 1 key used, 1 request');
  });

  it('prints the address of a sign up that became an account, and withholds the other', () => {
    const { text } = buildUsageDigest(busyData(), NOW);
    expect(text).toContain('ada@example.com');
    expect(text).toContain('(address withheld)');
    expect(text).toContain('claimed');
    expect(text).toContain('email_taken');
  });

  it('carries no key, no hash and no token', () => {
    const { text } = buildUsageDigest(busyData(), NOW);
    for (const forbidden of ['key_hash', 'token', 'ip_hash', 'prefix', 'bk_test_', 'bk_live_']) {
      expect(text, `the digest mentions ${forbidden}`).not.toContain(forbidden);
    }
    // A sixty-four character run of hex is what every hash in this schema looks like.
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('is never wider than 78 columns, however long the names are', () => {
    for (const data of [emptyData(), busyData()]) {
      const { text } = buildUsageDigest(data, NOW);
      const tooWide = text.split('\n').filter((line) => line.length > DIGEST_WIDTH);
      expect(tooWide).toEqual([]);
    }
  });

  it('has no em-dash in it', () => {
    for (const data of [emptyData(), busyData()]) {
      const { subject, text } = buildUsageDigest(data, NOW);
      expect(text.includes(EM_DASH)).toBe(false);
      expect(subject.includes(EM_DASH)).toBe(false);
    }
  });

  it('reports the requests of the last whole UTC day and the week behind it', () => {
    const { text } = buildUsageDigest(busyData(), NOW);
    expect(text).toContain(
      'Requests by project, 2026-09-13 UTC: 2 projects, 412 requests, 9 4xx, 0 5xx',
    );
    expect(text).toContain('Last 7 days: 1803 requests (a day: 240, 301, 0, 0, 850, 0, 412)');
    // Busiest first, so the first line under the heading is the one worth reading.
    const rows = text.split('\n');
    const padel = rows.findIndex((line) => line.includes('Padel  '));
    const smoke = rows.findIndex((line) => line.includes('Bookrail smoke'));
    expect(padel).toBeGreaterThan(0);
    expect(padel).toBeLessThan(smoke);
  });

  /**
   * An address is never shortened, whatever it costs.
   *
   * `una.persona.con.indirizzo.lungo@esempio-molto-lungo.example.com` is 63 characters, which is
   * longer than the whole address column used to be. A shortened address reads exactly like a
   * whole one and is a wrong answer to the only question this section exists to answer.
   */
  it('never shortens an address, and wraps the row instead', () => {
    const long = 'una.persona.con.indirizzo.lungo@esempio-molto-lungo.example.com';
    const data = emptyData({
      signups: [
        {
          createdAt: new Date('2026-09-13T18:02:00.000Z'),
          client: 'web',
          status: 'claimed',
          email: long,
          accountName: 'Palestra Fitness Roma Centro Storico',
          projectName: 'Prenotazioni sale corsi',
        },
      ],
      accounts: [
        {
          name: 'Palestra Fitness Roma Centro Storico',
          origin: 'self_serve',
          ownerEmail: long,
          createdAt: new Date('2026-09-13T18:05:00.000Z'),
          projects: 1,
        },
      ],
    });
    const { text } = buildUsageDigest(data, NOW);
    // Both sections carry the whole address, and neither line is wider than the message.
    expect(text.split(long).length - 1).toBe(2);
    expect(text.split('\n').filter((line) => line.length > DIGEST_WIDTH)).toEqual([]);
    // The names that no longer fit are marked as shortened, never silently cut.
    expect(text).toContain('...');
  });

  it('marks a shortened name with three dots', () => {
    const data = emptyData({
      keys: [
        {
          accountName: 'A club whose name is far longer than the column it has to live in',
          accountOrigin: 'self_serve',
          projectId: 'aaaaaaaa-0000-0000-0000-000000000001',
          projectName: 'Padel',
          environment: 'test',
          kind: 'secret',
          lastUsedAt: new Date('2026-09-14T05:12:00.000Z'),
          createdAt: new Date('2026-09-13T18:05:00.000Z'),
        },
      ],
    });
    const { text } = buildUsageDigest(data, NOW);
    expect(text).toMatch(/A club whose name is far lo\.\.\./);
  });

  /**
   * A burst of sign ups must not drown the one channel that is supposed to notice it, nor grow
   * a body an SMTP server would refuse.
   */
  it('prints at most fifty rows a section and says how many it left out', () => {
    const data = emptyData({
      signups: Array.from({ length: 60 }, (_unused, index) => ({
        createdAt: new Date(Date.parse('2026-09-13T00:00:00.000Z') + index * 60_000),
        client: 'web',
        status: 'pending',
        email: null,
        accountName: `Account ${String(index)}`,
        projectName: 'Default',
      })),
    });
    const { subject, text } = buildUsageDigest(data, NOW);
    // The counts stay true: sixty in the heading and in the subject.
    expect(text).toContain('Sign ups in the last 25 hours: 60');
    expect(subject).toContain('60 sign ups');
    expect(text).toContain('... and 10 more');
    const printed = text.split('\n').filter((line) => /^ {2}\d{4}-\d{2}-\d{2} /.test(line));
    expect(printed).toHaveLength(DIGEST_MAX_ROWS);
  });

  /** The one hour of overlap, stated in the message itself. */
  it('declares the one hour overlap in the footer, and looks 25 hours back', () => {
    expect(DIGEST_SIGNUP_WINDOW_HOURS).toBe(25);
    const { text } = buildUsageDigest(emptyData(), NOW);
    expect(text).toContain('The window overlaps the previous digest by one hour');
    // 14 September 07:00 Rome minus 25 hours is 13 September 06:00 Rome.
    expect(text).toContain('Window: 13 Sep 06:00 to 14 Sep 07:00');
  });

  it('falls back to the project identifier when no key of that project was used', () => {
    const data = busyData();
    data.requests!.rows[0]!.projectName = null;
    const { text } = buildUsageDigest(data, NOW);
    expect(text).toContain('aaaaaaaa-0000-0000-0000-000');
  });
});

describe('collecting the usage digest from the database', () => {
  let h: Harness;
  let p: BootstrappedProject;
  let projectId: string;
  const accountName = `Digest account ${uuidv7().slice(-6)}`;
  const signupId = uuidv7();

  beforeAll(async () => {
    h = createHarness();
    p = await h.bootstrap(accountName);
    projectId = decodeId('project', p.projectId) ?? p.projectId;
    // One authenticated call, so the project's key has a `last_used_at` inside the window.
    const ok = await h.call('GET', '/v1/project', { token: p.testKey });
    expect(ok.status).toBe(200);

    const admin = createDatabase(h.pools.admin);
    const hex = signupId.replace(/-/g, '').repeat(3).slice(0, 64);
    await admin.execute(sql`
      INSERT INTO signups (id, email, token_hash, client, ip_hash, account_name, project_name,
                           default_timezone, default_currency, status, created_at, expires_at)
      VALUES (${signupId}, ${`digest-${signupId}@example.com`}, ${hex}, 'web', ${hex},
              ${accountName}, 'Padel', 'Europe/Rome', 'EUR', 'pending',
              now() - interval '1 hour', now() + interval '1 hour')
    `);
  });

  afterAll(async () => {
    const admin = createDatabase(h.pools.admin);
    await admin.execute(sql`DELETE FROM signups WHERE id = ${signupId}`);
    await h.close();
  });

  it('reads the account, the key and the sign up on the application connection', async () => {
    const data = await collectUsageDigest(
      { db: createDatabase(h.pools.app), logger: h.logger },
      { to: 'hello@bookrail.dev', host: 'test-host' },
    );

    expect(data.accounts.map((row) => row.name)).toContain(accountName);
    expect(data.keys.some((row) => row.projectId === projectId)).toBe(true);
    const mine = data.signups.find((row) => row.accountName === accountName);
    expect(mine).toBeDefined();
    // `pending`, so no address: the sign up did not conclude.
    expect(mine?.email).toBeNull();
    expect(mine?.status).toBe('pending');
    // No Redis was handed over, so the counts are absent and the digest says why.
    expect(data.requests).toBeNull();
    expect(data.requestsUnavailable).toBe(REQUESTS_NO_REDIS);
  });

  it('runs on a connection that cannot bypass row security', async () => {
    const db = createDatabase(h.pools.app);
    const { rows } = await db.execute<{ bypass: boolean }>(sql`
      SELECT r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user
    `);
    expect(rows[0]?.bypass).toBe(false);
  });

  it('hands the built message to the mailer, once', async () => {
    const mailer = createLogMailer(silentLogger);
    const result = await runUsageDigest(
      { db: createDatabase(h.pools.app), logger: h.logger, mailer },
      { to: 'hello@bookrail.dev', host: 'test-host' },
    );
    expect(result.sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.last()?.to).toBe('hello@bookrail.dev');
    expect(mailer.last()?.subject).toBe(result.subject);
    expect(mailer.last()?.subject).toMatch(/^Bookrail usage, /);
  });

  it('turns a mail server that is down into one line, not into a thrown job', async () => {
    const mailer = createLogMailer(silentLogger);
    mailer.send = (): Promise<void> => Promise.reject(new Error('connection refused'));
    const result = await runUsageDigest(
      { db: createDatabase(h.pools.app), logger: h.logger, mailer },
      { to: 'hello@bookrail.dev', host: 'test-host' },
    );
    expect(result.sent).toBe(false);
    expect(result.subject).toMatch(/^Bookrail usage, /);
  });
});

describe('the usage digest on the queue', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * Two different omissions switch the digest off, and they are fixed in two different files:
   * a line that always blames `USAGE_DIGEST_TO` sends whoever reads it at release time to the
   * wrong variable. The deployment scripts produce exactly the second case on a first run,
   * because they always write the address and leave the mailer empty until somebody has put the
   * mailbox password in.
   */
  it('names the variable that is actually missing', () => {
    const mailer = createLogMailer(silentLogger);
    expect(usageDigestOffReason({ to: undefined, mailer })).toBe('USAGE_DIGEST_TO is not set');
    expect(usageDigestOffReason({ to: 'hello@bookrail.dev', mailer: undefined })).toBe(
      'BOOKRAIL_MAILER is not set',
    );
    expect(usageDigestOffReason({ to: undefined, mailer: undefined })).toBe(
      'USAGE_DIGEST_TO is not set and BOOKRAIL_MAILER is not set',
    );
    expect(usageDigestOffReason({ to: 'hello@bookrail.dev', mailer })).toBeNull();
  });

  it('writes the reason it was given at start-up', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', sink: (line) => lines.push(line) });
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: new MemoryAvailabilityCache(),
          logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        {
          connectionString: urls.admin,
          maxConnections: 2,
          schedule: false,
          usageDigestOffReason: 'BOOKRAIL_MAILER is not set',
        },
      );
      const off = lines
        .map((line) => JSON.parse(line) as { msg: string; reason?: string })
        .find((record) => record.msg === 'usage_digest_off');
      expect(off?.reason).toBe('BOOKRAIL_MAILER is not set');
    } finally {
      if (worker) await worker.stop();
    }
  }, 60_000);

  it('keeps the documented hour and time zone as the defaults', () => {
    expect(DEFAULT_USAGE_DIGEST_CRON).toBe('0 7 * * *');
    expect(USAGE_DIGEST_TIMEZONE).toBe('Europe/Rome');
  });

  /**
   * Declared before the case below on purpose: it deletes the queue first, so what it asserts
   * is that a worker without an address **creates nothing**, rather than that it happened to
   * run before anything else did. `deleteQueue` is idempotent on a queue that is not there.
   */
  it('does not create the queue at all when no address is configured', async () => {
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: new MemoryAvailabilityCache(),
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        { connectionString: urls.admin, maxConnections: 2, schedule: false },
      );
      await worker.boss.unschedule(USAGE_DIGEST_QUEUE).catch(() => undefined);
      await worker.boss.deleteQueue(USAGE_DIGEST_QUEUE).catch(() => undefined);
      await worker.stop();

      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: new MemoryAvailabilityCache(),
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        { connectionString: urls.admin, maxConnections: 2, schedule: true },
      );
      expect(await worker.boss.getQueue(USAGE_DIGEST_QUEUE)).toBeNull();
      const schedules = await worker.boss.getSchedules();
      expect(schedules.some((entry) => entry.name === USAGE_DIGEST_QUEUE)).toBe(false);
    } finally {
      if (worker) await worker.stop();
    }
  }, 60_000);

  it('registers the queue, schedules it in Europe/Rome, and sends the message', async () => {
    const mailer = createLogMailer(silentLogger);
    const urls = resolveDatabaseUrls({ databaseName: TEST_DB_NAME });
    let worker: Worker | null = null;
    try {
      worker = await startWorker(
        {
          db: createDatabase(h.pools.app),
          cache: new MemoryAvailabilityCache(),
          logger: h.logger,
          webhookSecretKey: h.webhookSecretKey,
        },
        {
          connectionString: urls.admin,
          maxConnections: 2,
          usageDigest: { to: 'digest@example.com', host: 'test-host', mailer },
        },
      );

      expect(await worker.boss.getQueue(USAGE_DIGEST_QUEUE)).not.toBeNull();
      const schedule = (await worker.boss.getSchedules()).find(
        (entry) => entry.name === USAGE_DIGEST_QUEUE,
      );
      expect(schedule?.cron).toBe(DEFAULT_USAGE_DIGEST_CRON);
      // `timezone` is a column of `pgboss.schedule` and comes back from `getSchedules`, but the
      // published `Schedule` type does not declare it. Read through the row rather than
      // trusting the type: the time zone is the whole point of this schedule, and asserting it
      // is what proves the `tz` option reached the database rather than being ignored.
      expect((schedule as unknown as { timezone?: string } | undefined)?.timezone).toBe(
        USAGE_DIGEST_TIMEZONE,
      );

      // The run a cron would have caused at seven, asked for by hand.
      await worker.boss.send(USAGE_DIGEST_QUEUE, {});
      const sent = await until(
        () => Promise.resolve(mailer.last()),
        (message) => message !== undefined,
        'the worker to send the usage digest',
        { timeoutMs: 20_000 },
      );
      expect(sent?.to).toBe('digest@example.com');
      expect(sent?.subject).toMatch(/^Bookrail usage, /);
      expect(sent?.text).toContain('Sent by the Bookrail worker on test-host.');
    } finally {
      if (worker) {
        await worker.boss.unschedule(USAGE_DIGEST_QUEUE).catch(() => undefined);
        await worker.stop();
      }
    }
  }, 60_000);
});
