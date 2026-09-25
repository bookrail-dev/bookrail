/**
 * The plan, from the terminal: `bookrail whoami` prints it, `bookrail doctor` says how close the
 * account is to its threshold, and `bookrail bookings create --live` shows the `402` with the
 * sentence that repairs it.
 *
 * The API is the real one on the real Postgres, with the free plan's threshold lowered to five
 * bookings through the plan table it accepts. The month's usage is written straight into
 * `plan_usage` through the privileged pool where a test only needs the account to be at a given
 * point, because what the CLI owes is the rendering and the exit code, and the counting is proved
 * in `@bookrail/api` and `@bookrail/engine`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANS, decodeId, planMonthOf, uuidv7, type PlanTable } from '@bookrail/shared';
import { PLAN_UPGRADE_FIX as ENGINE_UPGRADE_FIX } from '@bookrail/engine';
import { PLAN_IDS, PLAN_UPGRADE_FIX, PLAN_WARNING_THRESHOLDS } from '../src/plans.js';
import { createHarness, type Harness, type Project } from './harness.js';
import { nextMonday, plusDays } from './fixtures.js';
import {
  PLAN_IDS as SHARED_PLAN_IDS,
  PLAN_WARNING_THRESHOLDS as SHARED_THRESHOLDS,
} from '@bookrail/shared';

const FIVE: PlanTable = { ...PLANS, free: { ...PLANS.free, bookingsIncluded: 5 } };

interface Check {
  name: string;
  status: string;
  message: string;
  fix?: string;
}

describe('what the CLI redeclares about the plans', () => {
  it('is what @bookrail/shared and the engine define', () => {
    expect([...PLAN_IDS]).toEqual([...SHARED_PLAN_IDS]);
    expect([...PLAN_WARNING_THRESHOLDS]).toEqual([...SHARED_THRESHOLDS]);
    expect(PLAN_UPGRADE_FIX).toBe(ENGINE_UPGRADE_FIX);
  });
});

describe('bookrail and the plan', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ plans: FIVE });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  /** The account of a project at `count` confirmed live bookings this month. */
  async function atCount(project: Project, count: number): Promise<void> {
    await h.adminPool.query(
      `INSERT INTO plan_usage (id, project_id, environment, month, bookings_confirmed)
       VALUES ($1, $2, 'live', $3, $4)
       ON CONFLICT (project_id, environment, month) DO UPDATE SET bookings_confirmed = $4`,
      [uuidv7(), decodeId('project', project.projectId), planMonthOf(Date.now()), count],
    );
  }

  async function doctorCheck(project: Project): Promise<{ code: number; check: Check }> {
    const result = await h.cli(['doctor', '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    const checks = result.json<{ checks: Check[] }>().data!.checks;
    const check = checks.find((candidate) => candidate.name === 'plan_usage');
    if (check === undefined) throw new Error('doctor has no plan_usage check');
    return { code: result.code, check };
  }

  it('whoami prints the plan and the live usage of the account, even with a test key', async () => {
    const project = await h.bootstrap('Plan whoami');
    await atCount(project, 3);
    const json = await h.cli(['whoami', '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    expect(json.code).toBe(0);
    const data = json.json<{
      plan: string;
      usage: { bookings_confirmed: number; bookings_included: number };
    }>().data!;
    expect(data.plan).toBe('free');
    expect(data.usage.bookings_confirmed).toBe(3);
    expect(data.usage.bookings_included).toBe(5);

    const human = await h.cli(['whoami'], { env: { BOOKRAIL_SECRET_KEY: project.testKey } });
    expect(human.stdout).toContain('plan     free, stops new live bookings at the limit');
    expect(human.stdout).toMatch(
      /usage {4}3 of 5 confirmed live bookings in [0-9]{4}-[0-9]{2} \(UTC\)/,
    );
  });

  it('doctor says ok below 80 %, warn from 80 %, and fail at the threshold of the free plan', async () => {
    const project = await h.bootstrap('Plan doctor');
    await atCount(project, 3);
    expect((await doctorCheck(project)).check.status).toBe('ok');

    await atCount(project, 4);
    const warned = await doctorCheck(project);
    expect(warned.check.status).toBe('warn');
    expect(warned.check.fix).toBe(PLAN_UPGRADE_FIX);

    await atCount(project, 5);
    const failed = await doctorCheck(project);
    expect(failed.check.status).toBe('fail');
    expect(failed.check.message).toContain('402 plan_limit_reached');
    expect(failed.check.fix).toBe(PLAN_UPGRADE_FIX);
    // A failed check is exit 1, which is what a script branches on.
    expect(failed.code).toBe(1);
  });

  it('doctor only warns on a paying plan past its included bookings', async () => {
    const project = await h.bootstrap('Plan doctor pro');
    await h.adminPool.query(
      `UPDATE accounts SET plan = 'pro'
        WHERE id = (SELECT account_id FROM projects WHERE id = $1)`,
      [decodeId('project', project.projectId)],
    );
    await atCount(project, 6_000);
    const { check } = await doctorCheck(project);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('nothing is refused');
  });

  it('bookings create --live shows the 402 with the sentence that repairs it', async () => {
    const project = await h.bootstrap('Plan create');
    const serviceId = await liveService(h.url, project.liveKey);
    await atCount(project, 5);
    const start = await firstLiveSlot(h.url, project.liveKey, serviceId);

    const result = await h.cli(
      ['bookings', 'create', '--live', '--service', serviceId, '--start', start, '--json'],
      { env: { BOOKRAIL_SECRET_KEY: project.liveKey } },
    );
    expect(result.code).toBe(1);
    const error = result.json().error!;
    expect(error.code).toBe('plan_limit_reached');
    expect(error.fix).toBe(PLAN_UPGRADE_FIX);

    const human = await h.cli(
      ['bookings', 'create', '--live', '--service', serviceId, '--start', start],
      { env: { BOOKRAIL_SECRET_KEY: project.liveKey } },
    );
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('plan_limit_reached');
    expect(human.stderr).toContain('https://bookrail.dev/dashboard/?upgrade=pro');
  });
});

/**
 * A live service, built over HTTP with the live key: the CLI refuses to act on the live
 * environment without `--live`, and the fixtures of this package build in the test one.
 */
async function liveService(url: string, key: string): Promise<string> {
  const post = async (path: string, body: unknown): Promise<{ id: string }> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 201)
      throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
    return (await response.json()) as { id: string };
  };
  const location = await post('/v1/locations', { name: 'Live club', timezone: 'Europe/Rome' });
  const schedule = await post('/v1/schedules', {
    name: 'Hours',
    timezone: 'Europe/Rome',
    rules: [{ days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '09:00', end_time: '18:00' }],
  });
  const resource = await post('/v1/resources', {
    name: 'Court',
    type: 'room',
    schedule_id: schedule.id,
    location_id: location.id,
    capacity: 1,
  });
  const service = await post('/v1/services', {
    name: 'Hour',
    duration: 60,
    requirements: [{ resource_id: resource.id }],
  });
  return service.id;
}

async function firstLiveSlot(url: string, key: string, serviceId: string): Promise<string> {
  const from = nextMonday();
  const response = await fetch(`${url}/v1/availability`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      from: from.toISOString(),
      to: plusDays(from, 1).toISOString(),
    }),
  });
  const body = (await response.json()) as { slots: { start: string }[] };
  const slot = body.slots[0];
  if (slot === undefined) throw new Error('no live slot');
  return slot.start;
}
