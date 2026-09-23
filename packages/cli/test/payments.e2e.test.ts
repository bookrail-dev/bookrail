/**
 * `bookrail payments get|list`, and `bookrail bookings create --payment`, end to end.
 *
 * The CLI runs in process against the real API on the real Postgres, as every other suite here
 * does. What is **not** here is the payment flow itself: creating a payment needs a Stripe
 * platform and a connected account, and proving that flow is `@bookrail/api`'s job, which it
 * does against a fake Stripe in `packages/api/test/payments.test.ts`. What the CLI owes is
 * narrower and is all here: the flag reaches the body, the two reads reach the right paths, the
 * renderer prints what came back, and an error the server explains is reported as the server
 * explained it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql } from '@bookrail/db';
import { decodeId, encodeId, uuidv7 } from '@bookrail/shared';
import { createHarness, type Harness, type Project } from './harness.js';
import { buildScenario, firstSlot, nextMonday, plusDays } from './fixtures.js';

describe('bookrail payments', () => {
  let h: Harness;
  let project: Project;
  let paymentId: string;

  beforeAll(async () => {
    h = await createHarness();
    project = await h.bootstrap('CLI payments');

    // The one fixture written directly: see `Harness.adminPool` for why.
    const admin = createDatabase(h.adminPool);
    const id = uuidv7();
    await admin.execute(sql`
      INSERT INTO payments (id, project_id, environment, booking_id, provider,
                            provider_account_id, provider_payment_id, type, amount, currency,
                            status, amount_refunded)
      VALUES (${id}, ${decodeId('project', project.projectId)}, 'test', NULL, 'stripe',
              'acct_CliPayments', 'pi_CliPayments', 'deposit', 1500, 'EUR', 'succeeded', 500)
    `);
    paymentId = encodeId('payment', id);
  });

  afterAll(async () => {
    await h.close();
  });

  it('reads one payment as JSON and as a table', async () => {
    const json = await h.cli(['payments', 'get', paymentId, '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    expect(json.code).toBe(0);
    const data = json.json() as { data: Record<string, unknown> };
    expect(data.data.id).toBe(paymentId);
    expect(data.data.type).toBe('deposit');
    expect(data.data.amount).toBe(1500);
    expect(data.data.amount_refunded).toBe(500);
    // Not pending, so nothing was asked of Stripe and there is no secret to show.
    expect(data.data.client_secret).toBeNull();

    const human = await h.cli(['payments', 'get', paymentId], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('1500 EUR');
    expect(human.stdout).toContain('pi_CliPayments');
    expect(human.stdout).toContain('acct_CliPayments');
  });

  it('lists payments, and pushes the filters to the server', async () => {
    const before = h.seenUrls.length;
    const listed = await h.cli(['payments', 'list', '--status', 'succeeded', '--json'], {
      env: { BOOKRAIL_SECRET_KEY: project.testKey },
    });
    expect(listed.code).toBe(0);
    const body = listed.json() as { data: { data: { id: string }[] } };
    expect(body.data.data.map((row) => row.id)).toContain(paymentId);
    expect(h.seenUrls.slice(before).join(' ')).toContain('status=succeeded');
  });

  /** A `404` is a user error in the CLI's exit taxonomy: the identifier was wrong. */
  it('reports resource_missing for a payment that is not there', async () => {
    const missing = await h.cli(
      ['payments', 'get', 'pay_0193f0c2a1b47e2e9a1c0f4d5e6a7b8c', '--json'],
      { env: { BOOKRAIL_SECRET_KEY: project.testKey } },
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr + missing.stdout).toContain('resource_missing');
  });

  /**
   * The flag reaches the body. This harness is **not** a Stripe platform, so the API answers
   * `503 stripe_not_configured`, which is exactly the right assertion: the CLI is reporting a
   * refusal only the server could have produced, from a request only the flag could have made.
   */
  it('sends payment.mode from --payment, and reports what the server says about it', async () => {
    const scenario = await buildScenario(h, project.testKey, {
      service: { price: { amount: 4000, currency: 'EUR' } },
    });
    const monday = nextMonday();
    const slot = await firstSlot(
      h,
      project.testKey,
      scenario.serviceId,
      monday,
      plusDays(monday, 1),
    );

    const created = await h.cli(
      [
        'bookings',
        'create',
        '--service',
        scenario.serviceId,
        '--start',
        slot.start,
        '--payment',
        'deposit',
        '--json',
      ],
      { env: { BOOKRAIL_SECRET_KEY: project.testKey } },
    );
    expect(created.code).not.toBe(0);
    expect(created.stderr + created.stdout).toContain('stripe_not_configured');
  });
});
