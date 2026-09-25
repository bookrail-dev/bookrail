/**
 * The plans, through HTTP: what counts, when the free plan answers `402`, what `GET
 * /v1/project` and the `Bookrail-Plan-Usage` header say, how fast a live key of each plan may
 * go, and the warning at 80 % and 100 %.
 *
 * Nothing is mocked: the real app, the real Postgres, the application role, and for the paid
 * volume the fake Stripe of `stripe-server.ts` with real signed webhooks. The threshold of the
 * free plan is lowered through the plan table the app accepts in its dependencies, from a
 * thousand bookings to five, so that a test reaches it in five requests.
 *
 * The counts are read back through the privileged pool as the sum of every month of the
 * project, so that no assertion depends on which UTC month the suite happens to run in. The
 * warning events are read the same way, straight from the table, rather than through `GET
 * /v1/events`, which answers only below the horizon of the whole cluster.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { PLANS, decodeId, planMonthOf, uuidv7, type PlanTable } from '@bookrail/shared';
import type { StripePlatformConfig } from '../src/config.js';
import { buildScenario, nextMonday, plusDays, slotsFor } from './booking-fixtures.js';
import {
  BOOTSTRAP_TOKEN,
  createHarness,
  type BootstrappedProject,
  type Harness,
} from './harness.js';
import { until } from './until.js';
import { startFakeStripe, type FakeStripe } from './stripe-server.js';

/** Five bookings a month on the free and on the pro plan; the published volume. */
const FIVE: PlanTable = {
  ...PLANS,
  free: { ...PLANS.free, bookingsIncluded: 5 },
  pro: { ...PLANS.pro, bookingsIncluded: 5 },
};

interface ErrorBody {
  error: { type: string; code: string; message: string; param?: string; fix?: string };
}

interface BookingBody {
  id: string;
  status: string;
  payment_intent?: { id: string; payment_id: string; amount: number } | null;
}

interface ProjectBody {
  plan: string;
  environment: string;
  usage: {
    month: string;
    bookings_confirmed: number;
    bookings_included: number | null;
    payment_volume: number;
    payment_volume_included: number | null;
    currency: string | null;
    blocks_at_limit: boolean;
  };
}

function admin(h: Harness): ReturnType<typeof createDatabase> {
  return createDatabase(h.pools.admin);
}

async function setPlan(h: Harness, p: BootstrappedProject, plan: string): Promise<void> {
  await admin(h).execute(sql`
    UPDATE accounts SET plan = ${plan}
     WHERE id = (SELECT account_id FROM projects WHERE id = ${decodeId('project', p.projectId)})
  `);
}

async function setOwner(h: Harness, p: BootstrappedProject, email: string | null): Promise<void> {
  await admin(h).execute(sql`
    UPDATE accounts SET owner_email = ${email}
     WHERE id = (SELECT account_id FROM projects WHERE id = ${decodeId('project', p.projectId)})
  `);
}

/** Confirmed bookings and paid volume of a project, every month and environment summed. */
async function counted(
  h: Harness,
  p: BootstrappedProject,
): Promise<{ bookings: number; volume: number }> {
  const { rows } = await admin(h).execute<{ bookings: string; volume: string }>(sql`
    SELECT COALESCE(sum(bookings_confirmed), 0)::text AS bookings,
           COALESCE(sum(payment_volume), 0)::text AS volume
      FROM plan_usage WHERE project_id = ${decodeId('project', p.projectId)}
  `);
  return { bookings: Number(rows[0]?.bookings ?? 0), volume: Number(rows[0]?.volume ?? 0) };
}

async function warningEvents(
  h: Harness,
  p: BootstrappedProject,
): Promise<{ environment: string; data: Record<string, unknown> }[]> {
  const { rows } = await admin(h).execute<{
    environment: string;
    data: Record<string, unknown>;
  }>(sql`
    SELECT environment, data FROM events
     WHERE project_id = ${decodeId('project', p.projectId)} AND type = 'plan.usage_warning'
     ORDER BY seq
  `);
  return rows;
}

/** A service with `count` courts in a group, and one slot everybody can aim at. */
async function courts(
  h: Harness,
  token: string,
  count: number,
  extra: Parameters<typeof buildScenario>[2] = {},
): Promise<{ serviceId: string; resourceIds: string[]; slots: string[] }> {
  const scenario = await buildScenario(h, token, { resources: count, group: {}, ...extra });
  const monday = nextMonday();
  const slots = await slotsFor(h, token, scenario.serviceId, monday, plusDays(monday, 1));
  return {
    serviceId: scenario.serviceId,
    resourceIds: scenario.resourceIds,
    slots: slots.map((slot) => slot.start),
  };
}

function bookOn(
  h: Harness,
  token: string,
  serviceId: string,
  start: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  return h.call<unknown>('POST', '/v1/bookings', {
    token,
    body: { service_id: serviceId, start, ...extra },
  });
}

describe('plans, counting and the free plan', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ plans: FIVE });
  });

  afterAll(async () => {
    await h.close();
  });

  it('counts a live booking born confirmed, once, and never a test one', async () => {
    const p = await h.bootstrap('Plan counting');
    const live = await courts(h, p.liveKey, 2);
    const test = await courts(h, p.testKey, 2);

    const created = await bookOn(h, p.liveKey, live.serviceId, live.slots[0]!);
    expect(created.status).toBe(201);
    expect(await counted(h, p)).toEqual({ bookings: 1, volume: 0 });

    for (const slot of test.slots.slice(0, 3)) {
      expect((await bookOn(h, p.testKey, test.serviceId, slot)).status).toBe(201);
    }
    expect(await counted(h, p)).toEqual({ bookings: 1, volume: 0 });
  });

  it('counts a pending booking at its confirmation, once; cancel, no-show and reschedule add nothing', async () => {
    const p = await h.bootstrap('Plan lifecycle');
    const pending = await courts(h, p.liveKey, 1, {
      policy: { require_provider_confirmation: true },
    });
    const booked = await bookOn(h, p.liveKey, pending.serviceId, pending.slots[0]!);
    expect((booked.body as BookingBody).status).toBe('pending');
    expect((await counted(h, p)).bookings).toBe(0);

    const id = (booked.body as BookingBody).id;
    expect((await h.call('POST', `/v1/bookings/${id}/confirm`, { token: p.liveKey })).status).toBe(
      200,
    );
    expect((await counted(h, p)).bookings).toBe(1);
    expect((await h.call('POST', `/v1/bookings/${id}/confirm`, { token: p.liveKey })).status).toBe(
      409,
    );
    expect((await counted(h, p)).bookings).toBe(1);

    const plain = await courts(h, p.liveKey, 1);
    const a = (await bookOn(h, p.liveKey, plain.serviceId, plain.slots[0]!)).body as BookingBody;
    const b = (await bookOn(h, p.liveKey, plain.serviceId, plain.slots[2]!)).body as BookingBody;
    expect((await counted(h, p)).bookings).toBe(3);

    expect((await h.call('POST', `/v1/bookings/${a.id}/cancel`, { token: p.liveKey })).status).toBe(
      200,
    );
    const moved = await h.call<BookingBody>('POST', `/v1/bookings/${b.id}/reschedule`, {
      token: p.liveKey,
      body: { start: plain.slots[4]! },
    });
    expect(moved.status).toBe(200);
    // A no-show needs a booking whose time has come: age the row the reschedule produced.
    const newId = moved.body.id;
    await admin(h).execute(sql`
      UPDATE bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour',
                          next_transition = NULL, next_transition_at = NULL
       WHERE id = ${decodeId('booking', newId)}
    `);
    expect(
      (await h.call('POST', `/v1/bookings/${newId}/no_show`, { token: p.liveKey })).status,
    ).toBe(200);
    expect((await counted(h, p)).bookings).toBe(3);
  });

  it('answers 402 plan_limit_reached at the threshold, and leaves the slot free', async () => {
    const p = await h.bootstrap('Plan threshold');
    const live = await courts(h, p.liveKey, 1);
    for (const slot of live.slots.slice(0, 5)) {
      expect((await bookOn(h, p.liveKey, live.serviceId, slot)).status).toBe(201);
    }

    const refused = await bookOn(h, p.liveKey, live.serviceId, live.slots[6]!);
    expect(refused.status).toBe(402);
    const error = (refused.body as ErrorBody).error;
    expect(error.type).toBe('payment_required');
    expect(error.code).toBe('plan_limit_reached');
    expect(error.param).toBeUndefined();
    expect(error.message).toContain('The free plan includes 5 confirmed live bookings a month');
    expect(error.fix).toContain('https://bookrail.dev/dashboard/?upgrade=pro');
    // The header says where the account stood when the request started.
    expect(refused.headers.get('Bookrail-Plan-Usage')).toBe('5/5');

    // Nothing was taken: a hold on the same slot goes through.
    const hold = await h.call('POST', '/v1/holds', {
      token: p.liveKey,
      body: { service_id: live.serviceId, start: live.slots[6]! },
    });
    expect(hold.status).toBe(201);
    expect((await counted(h, p)).bookings).toBe(5);

    // The test environment of the same account is not stopped.
    const test = await courts(h, p.testKey, 1);
    expect((await bookOn(h, p.testKey, test.serviceId, test.slots[0]!)).status).toBe(201);
  });

  it('does not stop a pro account at the same count', async () => {
    const p = await h.bootstrap('Plan pro');
    await setPlan(h, p, 'pro');
    const live = await courts(h, p.liveKey, 1);
    for (const slot of live.slots.slice(0, 7)) {
      expect((await bookOn(h, p.liveKey, live.serviceId, slot)).status).toBe(201);
    }
    expect((await counted(h, p)).bookings).toBe(7);
  });

  it('counts only the current month against the threshold', async () => {
    const p = await h.bootstrap('Plan month');
    // A month long gone, at the threshold and past it.
    await admin(h).execute(sql`
      INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
      VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'live', '2020-01', 50)
    `);
    const live = await courts(h, p.liveKey, 1);
    expect((await bookOn(h, p.liveKey, live.serviceId, live.slots[0]!)).status).toBe(201);
    const project = await h.call<ProjectBody>('GET', '/v1/project', { token: p.liveKey });
    expect(project.body.usage.bookings_confirmed).toBe(1);
  });

  it('shares one threshold between two projects of the same account', async () => {
    const first = await h.bootstrap('Plan shared one');
    const second = await h.bootstrap('Plan shared two');
    await admin(h).execute(sql`
      UPDATE projects
         SET account_id = (SELECT account_id FROM projects WHERE id = ${decodeId('project', first.projectId)})
       WHERE id = ${decodeId('project', second.projectId)}
    `);
    const one = await courts(h, first.liveKey, 1);
    const two = await courts(h, second.liveKey, 1);
    for (const slot of one.slots.slice(0, 3)) {
      expect((await bookOn(h, first.liveKey, one.serviceId, slot)).status).toBe(201);
    }
    for (const slot of two.slots.slice(0, 2)) {
      expect((await bookOn(h, second.liveKey, two.serviceId, slot)).status).toBe(201);
    }
    const refused = await bookOn(h, second.liveKey, two.serviceId, two.slots[4]!);
    expect(refused.status).toBe(402);
    const project = await h.call<ProjectBody>('GET', '/v1/project', { token: first.liveKey });
    expect(project.body.usage.bookings_confirmed).toBe(5);
  });

  /**
   * The lock is what makes the threshold exact. Twenty bookings on twenty different courts share
   * no resource lock and no customer, so the only thing that can stop the second one of them is
   * the account lock; with one booking left before the threshold, exactly one of the twenty gets
   * through.
   */
  /**
   * Seeds the account at four confirmed bookings in the month of now **and** in the month of an
   * hour from now, so that a run that crosses midnight UTC on the first of a month still finds the
   * account one booking from the threshold whichever month the requests land in.
   */
  async function atFour(p: BootstrappedProject): Promise<void> {
    for (const at of [Date.now(), Date.now() + 3_600_000]) {
      await admin(h).execute(sql`
        INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'live', ${planMonthOf(at)}, 4)
        ON CONFLICT (project_id, environment, month) DO NOTHING
      `);
    }
  }

  it.each([
    ['born confirmed', {}],
    [
      'born pending, with a policy that asks for confirmation',
      { require_provider_confirmation: true },
    ],
  ])(
    'lets exactly one of twenty simultaneous bookings take the last one left, %s',
    async (_label, policy) => {
      const p = await h.bootstrap('Plan race');
      const live = await courts(
        h,
        p.liveKey,
        20,
        Object.keys(policy).length === 0 ? {} : { policy },
      );
      await atFour(p);
      const start = live.slots[0]!;
      const responses = await Promise.all(
        live.resourceIds.map((resourceId) =>
          bookOn(h, p.liveKey, live.serviceId, start, { resource_ids: [resourceId] }),
        ),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 402)).toHaveLength(19);
    },
  );

  it('does not count a replayed POST /v1/bookings a second time', async () => {
    const p = await h.bootstrap('Plan replay');
    const live = await courts(h, p.liveKey, 1);
    const key = `plan-${uuidv7()}`;
    const first = await h.call('POST', '/v1/bookings', {
      token: p.liveKey,
      headers: { 'idempotency-key': key },
      body: { service_id: live.serviceId, start: live.slots[0]! },
    });
    const again = await h.call('POST', '/v1/bookings', {
      token: p.liveKey,
      headers: { 'idempotency-key': key },
      body: { service_id: live.serviceId, start: live.slots[0]! },
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await counted(h, p)).bookings).toBe(1);
  });
});

describe('what the API says about the plan', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ plans: FIVE, rateLimit: { rate: 20, burst: 40, live: 'plan' } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('returns the plan and the live usage of the account from GET /v1/project, to either key', async () => {
    const p = await h.bootstrap('Plan project');
    const live = await courts(h, p.liveKey, 1);
    await bookOn(h, p.liveKey, live.serviceId, live.slots[0]!);
    await bookOn(h, p.liveKey, live.serviceId, live.slots[2]!);

    for (const token of [p.liveKey, p.testKey]) {
      const project = await h.call<ProjectBody>('GET', '/v1/project', { token });
      expect(project.status).toBe(200);
      expect(project.body.plan).toBe('free');
      expect(project.body.usage).toEqual({
        month: expect.stringMatching(/^[0-9]{4}-[0-9]{2}$/) as unknown as string,
        bookings_confirmed: 2,
        bookings_included: 5,
        payment_volume: 0,
        payment_volume_included: 100_000,
        currency: null,
        blocks_at_limit: true,
      });
    }
  });

  it('puts Bookrail-Plan-Usage on every live response, and on no test one', async () => {
    const p = await h.bootstrap('Plan header');
    const live = await courts(h, p.liveKey, 1);
    const before = await h.call('GET', '/v1/bookings', { token: p.liveKey });
    expect(before.headers.get('Bookrail-Plan-Usage')).toBe('0/5');
    const created = await bookOn(h, p.liveKey, live.serviceId, live.slots[0]!);
    // The count at the start of the request: this booking shows in the next one.
    expect(created.headers.get('Bookrail-Plan-Usage')).toBe('0/5');
    const after = await h.call('GET', '/v1/project', { token: p.liveKey });
    expect(after.headers.get('Bookrail-Plan-Usage')).toBe('1/5');
    // An error envelope carries it too.
    const missing = await h.call('GET', `/v1/bookings/bkg_${'0'.repeat(26)}`, { token: p.liveKey });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Bookrail-Plan-Usage')).toBe('1/5');

    const test = await h.call('GET', '/v1/project', { token: p.testKey });
    expect(test.headers.get('Bookrail-Plan-Usage')).toBeNull();

    // A plan whose bookings are negotiated has no denominator, and no header.
    await setPlan(h, p, 'enterprise');
    const enterprise = await h.call('GET', '/v1/project', { token: p.liveKey });
    expect(enterprise.headers.get('Bookrail-Plan-Usage')).toBeNull();
  });

  it('keeps the usage of the account from a key scoped to a tenant', async () => {
    const created = await h.call<{ secrets: { test: string; live: string } }>(
      'POST',
      '/internal/bootstrap',
      {
        token: BOOTSTRAP_TOKEN,
        body: {
          account_name: 'Plan tenant',
          project_name: 'Plan tenant',
          default_timezone: 'Europe/Rome',
          tenant_id: 'salon-7',
        },
      },
    );
    expect(created.status).toBe(201);
    const response = await h.call<{ plan: string; usage: unknown; api_key: { tenant_id: string } }>(
      'GET',
      '/v1/project',
      { token: created.body.secrets.live },
    );
    expect(response.status).toBe(200);
    expect(response.body.api_key.tenant_id).toBe('salon-7');
    expect(response.body.plan).toBe('free');
    expect(response.body.usage).toBeNull();
    expect(response.headers.get('Bookrail-Plan-Usage')).toBeNull();
  });

  it("gives a live key the rate limit of its account's plan, and a test key the test one", async () => {
    const p = await h.bootstrap('Plan rate');
    const limitOf = async (token: string): Promise<string | null> =>
      (await h.call('GET', '/v1/project', { token })).headers.get('RateLimit-Limit');

    expect(await limitOf(p.liveKey)).toBe(String(PLANS.free.rateLimit.burst));
    await setPlan(h, p, 'pro');
    expect(await limitOf(p.liveKey)).toBe('500');
    await setPlan(h, p, 'scale');
    expect(await limitOf(p.liveKey)).toBe('2500');
    // The test key of a scale account is still a test key.
    expect(await limitOf(p.testKey)).toBe('40');
  });

  it('lets RATE_LIMIT_LIVE_* override the plan for every live key', async () => {
    const overridden = createHarness({
      plans: FIVE,
      rateLimit: { rate: 20, burst: 40, live: { rate: 7, burst: 9 } },
    });
    try {
      const p = await overridden.bootstrap('Plan override');
      await setPlan(overridden, p, 'scale');
      const response = await overridden.call('GET', '/v1/project', { token: p.liveKey });
      expect(response.headers.get('RateLimit-Limit')).toBe('9');
    } finally {
      await overridden.close();
    }
  });
});

describe('the usage warnings', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness({ plans: FIVE });
  });

  afterAll(async () => {
    await h.close();
  });

  it('warns at 80 % and at 100 %, once each, with an event and an email', async () => {
    const p = await h.bootstrap('Plan warnings');
    const owner = `owner-${uuidv7()}@example.com`;
    await setOwner(h, p, owner);
    await setPlan(h, p, 'pro');
    const live = await courts(h, p.liveKey, 1);
    // Seven bookings: the fourth is 80 %, the fifth 100 %, the sixth and seventh are past both.
    for (const slot of live.slots.slice(0, 7)) {
      expect((await bookOn(h, p.liveKey, live.serviceId, slot)).status).toBe(201);
    }

    const events = await warningEvents(h, p);
    expect(events.map((event) => event.data.threshold)).toEqual([80, 100]);
    expect(events.every((event) => event.environment === 'live')).toBe(true);
    expect(events[0]?.data).toMatchObject({
      object: 'plan_usage',
      plan: 'pro',
      threshold: 80,
      bookings_confirmed: 4,
      bookings_included: 5,
      payment_volume: 0,
      payment_volume_included: null,
    });

    const mails = (h.mailer?.sent ?? []).filter((message) => message.to === owner);
    expect(mails.map((mail) => mail.subject)).toEqual([
      expect.stringContaining('80% of the pro plan used') as unknown as string,
      expect.stringContaining('100% of the pro plan used') as unknown as string,
    ]);
    expect(mails[0]?.text).toContain('Confirmed live bookings  4 of 5');
    expect(mails[1]?.text).toContain('Confirmed live bookings  5 of 5');
    expect(mails.every((mail) => !mail.text.includes(String.fromCharCode(0x2014)))).toBe(true);
  });

  /**
   * The race the review found: two projects of one account reach the threshold at the same
   * instant, each increment sees the total without the other, and nobody claims 100 %. After the
   * threshold every creation is refused before it counts, so without a claim at the refusal the
   * account would be refused all month without the warning that announces it. The race's outcome
   * is written directly (five confirmed over two projects, no warning claimed); the first `402`
   * claims what was reached, and the second claims nothing new.
   */
  it('claims the warnings the account has reached when it refuses, once', async () => {
    const first = await h.bootstrap('Plan refusal warnings one');
    const second = await h.bootstrap('Plan refusal warnings two');
    await admin(h).execute(sql`
      UPDATE projects
         SET account_id = (SELECT account_id FROM projects WHERE id = ${decodeId('project', first.projectId)})
       WHERE id = ${decodeId('project', second.projectId)}
    `);
    const owner = `owner-${uuidv7()}@example.com`;
    await setOwner(h, first, owner);
    for (const [p, count] of [
      [first, 3],
      [second, 2],
    ] as const) {
      await admin(h).execute(sql`
        INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'live', ${planMonthOf(Date.now())}, ${count})
      `);
    }
    const live = await courts(h, first.liveKey, 1);
    expect((await bookOn(h, first.liveKey, live.serviceId, live.slots[0]!)).status).toBe(402);
    const events = await warningEvents(h, first);
    expect(events.map((event) => event.data.threshold)).toEqual([80, 100]);
    expect(events[1]?.data).toMatchObject({ bookings_confirmed: 5, bookings_included: 5 });
    const mails = (h.mailer?.sent ?? []).filter((message) => message.to === owner);
    expect(mails.map((mail) => mail.subject)).toEqual([
      expect.stringContaining('80% of the free plan used') as unknown as string,
      expect.stringContaining('100% of the free plan used') as unknown as string,
    ]);
    expect(mails[1]?.text).toContain('402 plan_limit_reached');

    expect((await bookOn(h, first.liveKey, live.serviceId, live.slots[2]!)).status).toBe(402);
    expect(await warningEvents(h, first)).toHaveLength(2);
    expect((h.mailer?.sent ?? []).filter((message) => message.to === owner)).toHaveLength(2);
  });

  it('writes the event and sends nothing for an account with no owner address', async () => {
    const p = await h.bootstrap('Plan warnings anonymous');
    const live = await courts(h, p.liveKey, 1);
    const before = h.mailer?.sent.length ?? 0;
    for (const slot of live.slots.slice(0, 4)) {
      expect((await bookOn(h, p.liveKey, live.serviceId, slot)).status).toBe(201);
    }
    expect((await warningEvents(h, p)).map((event) => event.data.threshold)).toEqual([80]);
    expect(h.mailer?.sent.length ?? 0).toBe(before);
  });
});

describe('a mail server that refuses the warning', () => {
  it('logs a warn line and keeps the event', async () => {
    const lines: { level: string; message: string }[] = [];
    const record =
      (level: string) =>
      (message: string): void => {
        lines.push({ level, message });
      };
    const logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      child() {
        return this;
      },
    };
    const failing = createHarness({ plans: FIVE, mailer: 'failing', logger });
    try {
      const p = await failing.bootstrap('Plan warning smtp');
      await setOwner(failing, p, `owner-${uuidv7()}@example.com`);
      await admin(failing).execute(sql`
        INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
        VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'live', ${planMonthOf(Date.now())}, 3)
      `);
      const live = await courts(failing, p.liveKey, 1);
      // The fourth of five is 80 %: the booking is made, the event is written, the mail fails.
      expect((await bookOn(failing, p.liveKey, live.serviceId, live.slots[0]!)).status).toBe(201);
      expect((await warningEvents(failing, p)).map((event) => event.data.threshold)).toEqual([80]);
      // The send is not awaited by the route; the failure is logged when the rejection lands,
      // which is this condition and not a duration.
      await until(
        () =>
          Promise.resolve(lines.some((line) => line.message === 'plan_usage_warning_mail_failed')),
        (seen) => seen,
        'the warn line of the refused warning mail',
      );
      expect(lines.find((line) => line.message === 'plan_usage_warning_mail_failed')?.level).toBe(
        'warn',
      );
    } finally {
      await failing.close();
    }
  });
});

// --- The paid volume -------------------------------------------------------------------------

// The same fixtures as the payments suite, which the secret scanner of the public tree knows.
const PLATFORM_TEST_KEY = 'rk_test_paymentTestsOnly';
const PLATFORM_LIVE_KEY = 'rk_live_paymentTestsOnly';
const WEBHOOK_SECRET_TEST = 'whsec_obviouslyFakeTestSigningSecret';
const WEBHOOK_SECRET_LIVE = 'whsec_obviouslyFakeLiveSigningSecret';
const ACCOUNT = 'acct_1PlanFake';

function stripeConfig(stripe: FakeStripe): StripePlatformConfig {
  return {
    redirectUrl: 'https://api.bookrail.dev/v1/stripe/callback',
    environments: {
      test: {
        clientId: stripe.clientIds.test,
        secretKey: PLATFORM_TEST_KEY,
        publishableKey: 'pk_test_platform',
      },
      live: {
        clientId: stripe.clientIds.live,
        secretKey: PLATFORM_LIVE_KEY,
        publishableKey: 'pk_live_platform',
      },
    },
    webhookSecrets: { test: WEBHOOK_SECRET_TEST, live: WEBHOOK_SECRET_LIVE },
    apiBase: stripe.url,
    connectBase: stripe.url,
  };
}

describe('the paid volume', () => {
  let h: Harness;
  let stripe: FakeStripe;

  beforeAll(async () => {
    stripe = await startFakeStripe();
    h = createHarness({ plans: FIVE, stripe: stripeConfig(stripe) });
  });

  afterAll(async () => {
    await h.close();
    await stripe.close();
  });

  async function connect(p: BootstrappedProject, environment: 'test' | 'live'): Promise<void> {
    await admin(h).execute(sql`
      INSERT INTO payment_provider_connections
        (id, project_id, environment, provider, provider_account_id, status, connected_at,
         livemode)
      VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, ${environment}, 'stripe',
              ${ACCOUNT}, 'connected', now(), ${environment === 'live'})
    `);
  }

  async function sendEvent(
    mode: 'test' | 'live',
    type: string,
    object: Record<string, unknown>,
  ): Promise<number> {
    const event = {
      id: `evt_${uuidv7().replaceAll('-', '')}`,
      object: 'event',
      type,
      livemode: mode === 'live',
      account: ACCOUNT,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    };
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const secret = mode === 'live' ? WEBHOOK_SECRET_LIVE : WEBHOOK_SECRET_TEST;
    const signature = createHmac('sha256', secret)
      .update(`${String(t)}.${raw}`, 'utf8')
      .digest('hex');
    const response = await h.call('POST', `/v1/stripe/webhook/${mode}`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${String(t)},v1=${signature}`,
      },
      body: event,
    });
    return response.status;
  }

  async function paidBooking(
    token: string,
    serviceId: string,
    start: string,
  ): Promise<{ status: number; body: BookingBody | ErrorBody }> {
    const response = await bookOn(h, token, serviceId, start, { payment: { mode: 'deposit' } });
    return { status: response.status, body: response.body as BookingBody | ErrorBody };
  }

  it('adds succeeded live payments, takes refunds off, and refuses a payment past the included volume', async () => {
    const p = await h.bootstrap('Plan volume');
    await connect(p, 'live');
    // A deposit of the whole price, 600 euro: one fits in the free plan's 1 000, two do not.
    const live = await courts(h, p.liveKey, 1, {
      policy: {
        deposit: { type: 'percent', value: 100 },
        cancellation: [{ before: '1h', refund_percent: 100 }],
      },
      service: { price: { amount: 60_000, currency: 'EUR' } },
    });

    const first = await paidBooking(p.liveKey, live.serviceId, live.slots[0]!);
    expect(first.status).toBe(201);
    const intent = (first.body as BookingBody).payment_intent!;
    stripe.succeed(intent.id, 60_000);
    expect(
      await sendEvent('live', 'payment_intent.succeeded', {
        object: 'payment_intent',
        id: intent.id,
        amount: 60_000,
        amount_received: 60_000,
        currency: 'eur',
        status: 'succeeded',
      }),
    ).toBe(200);
    // The money is counted, and the booking it confirmed is too.
    expect(await counted(h, p)).toEqual({ bookings: 1, volume: 60_000 });
    const project = await h.call<ProjectBody>('GET', '/v1/project', { token: p.liveKey });
    expect(project.body.usage.payment_volume).toBe(60_000);
    expect(project.body.usage.currency).toBe('EUR');

    // 600 + 600 is past the 1 000 the free plan includes.
    const second = await paidBooking(p.liveKey, live.serviceId, live.slots[2]!);
    expect(second.status).toBe(402);
    expect((second.body as ErrorBody).error.code).toBe('plan_limit_reached');
    expect((second.body as ErrorBody).error.param).toBe('payment.mode');
    // A booking with no money is not about the volume.
    expect((await bookOn(h, p.liveKey, live.serviceId, live.slots[2]!)).status).toBe(201);

    // The refund of the first comes off the month.
    expect(
      await sendEvent('live', 'charge.refunded', {
        object: 'charge',
        id: 'ch_plan',
        payment_intent: intent.id,
        amount: 60_000,
        amount_refunded: 60_000,
        refunded: true,
      }),
    ).toBe(200);
    expect((await counted(h, p)).volume).toBe(0);
    const third = await paidBooking(p.liveKey, live.serviceId, live.slots[4]!);
    expect(third.status).toBe(201);
  });

  /** A paid booking, and the `payment_intent.succeeded` that pays it, with a fresh event id. */
  async function paidAndSucceeded(
    p: BootstrappedProject,
    price: number,
  ): Promise<{ intentId: string; succeed: () => Promise<number> }> {
    const live = await courts(h, p.liveKey, 1, {
      policy: { deposit: { type: 'percent', value: 100 } },
      service: { price: { amount: price, currency: 'EUR' } },
    });
    const booked = await paidBooking(p.liveKey, live.serviceId, live.slots[0]!);
    expect(booked.status).toBe(201);
    const intent = (booked.body as BookingBody).payment_intent!;
    stripe.succeed(intent.id, price);
    return {
      intentId: intent.id,
      succeed: () =>
        sendEvent('live', 'payment_intent.succeeded', {
          object: 'payment_intent',
          id: intent.id,
          amount: price,
          amount_received: price,
          currency: 'eur',
          status: 'succeeded',
        }),
    };
  }

  it('does not count a second payment_intent.succeeded for the same intent', async () => {
    const p = await h.bootstrap('Plan volume replay');
    await connect(p, 'live');
    const paid = await paidAndSucceeded(p, 20_000);
    expect(await paid.succeed()).toBe(200);
    // The same intent again, under a different event id: the payment is already succeeded.
    expect(await paid.succeed()).toBe(200);
    expect(await counted(h, p)).toEqual({ bookings: 1, volume: 20_000 });
  });

  /**
   * A refund counts in the month it is made. The receiver reads its own clock, so the payment's
   * month is moved into the past instead of moving the clock forward: the row that the payment
   * wrote becomes a row of an earlier month, and the refund that follows lands in the month of
   * now, below zero, without touching the earlier one.
   */
  it('takes a refund off the month of the refund, not the month of the payment', async () => {
    const p = await h.bootstrap('Plan volume refund month');
    await connect(p, 'live');
    const paid = await paidAndSucceeded(p, 20_000);
    expect(await paid.succeed()).toBe(200);
    await admin(h).execute(sql`
      UPDATE plan_usage SET month = '2020-01' WHERE project_id = ${decodeId('project', p.projectId)}
    `);
    expect(
      await sendEvent('live', 'charge.refunded', {
        object: 'charge',
        id: 'ch_plan_month',
        payment_intent: paid.intentId,
        amount: 20_000,
        amount_refunded: 20_000,
        refunded: true,
      }),
    ).toBe(200);
    const { rows } = await admin(h).execute<{ month: string; payment_volume: string }>(sql`
      SELECT month, payment_volume::text AS payment_volume FROM plan_usage
       WHERE project_id = ${decodeId('project', p.projectId)} ORDER BY month
    `);
    expect(rows).toEqual([
      { month: '2020-01', payment_volume: '20000' },
      {
        month: expect.stringMatching(/^[0-9]{4}-[0-9]{2}$/) as unknown as string,
        payment_volume: '-20000',
      },
    ]);
    expect(rows[1]?.month).not.toBe('2020-01');
  });

  it('mails the warning that the confirmation of a paid booking claims', async () => {
    const p = await h.bootstrap('Plan volume warning');
    await connect(p, 'live');
    const owner = `owner-${uuidv7()}@example.com`;
    await setOwner(h, p, owner);
    await admin(h).execute(sql`
      INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
      VALUES (${uuidv7()}, ${decodeId('project', p.projectId)}, 'live', ${planMonthOf(Date.now())}, 3)
    `);
    const paid = await paidAndSucceeded(p, 10_000);
    // The webhook confirms the booking: the fourth of five, 80 %.
    expect(await paid.succeed()).toBe(200);
    expect((await warningEvents(h, p)).map((event) => event.data.threshold)).toEqual([80]);
    const mails = (h.mailer?.sent ?? []).filter((message) => message.to === owner);
    expect(mails.map((mail) => mail.subject)).toEqual([
      expect.stringContaining('80% of the free plan used') as unknown as string,
    ]);
  });

  it('counts no money in the test environment', async () => {
    const p = await h.bootstrap('Plan volume test');
    await connect(p, 'test');
    const test = await courts(h, p.testKey, 1, {
      policy: { deposit: { type: 'percent', value: 100 } },
      service: { price: { amount: 60_000, currency: 'EUR' } },
    });
    const booked = await paidBooking(p.testKey, test.serviceId, test.slots[0]!);
    expect(booked.status).toBe(201);
    const intent = (booked.body as BookingBody).payment_intent!;
    stripe.succeed(intent.id, 60_000);
    expect(
      await sendEvent('test', 'payment_intent.succeeded', {
        object: 'payment_intent',
        id: intent.id,
        amount: 60_000,
        amount_received: 60_000,
        currency: 'eur',
        status: 'succeeded',
      }),
    ).toBe(200);
    expect(await counted(h, p)).toEqual({ bookings: 0, volume: 0 });
  });
});
