/**
 * Migration 0024: the constraints that make the payment flow safe, and the five functions that
 * are the only way past Row Level Security.
 *
 * The definer functions are called as `bookrail_app`, a role with neither `SUPERUSER` nor
 * `BYPASSRLS`, for the reason the whole RLS suite does: an assertion made by a superuser proves
 * nothing at all. What is checked here is the half of the design that lives in the database
 * rather than in TypeScript, because that half is the one a future route cannot get wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { uuidv7 } from '@bookrail/shared';
import { adminClient, appClient, asProject, expectPgError } from './helpers.js';
import { createProject, seedProjectData, type SeededRows } from './fixtures.js';

describe('payments and provider events (migration 0024)', () => {
  let admin: Client;
  let app: Client;
  let projectA: string;
  let projectB: string;
  let rowsA: SeededRows;
  let rowsB: SeededRows;
  let accountA: string;

  beforeAll(async () => {
    admin = await adminClient();
    app = await appClient();
    projectA = (await createProject(admin, 'Payments A')).projectId;
    projectB = (await createProject(admin, 'Payments B')).projectId;
    rowsA = await seedProjectData(admin, projectA, 'test');
    rowsB = await seedProjectData(admin, projectB, 'test');
    const { rows } = await admin.query<{ provider_account_id: string }>(
      `SELECT provider_account_id FROM payments WHERE id = $1`,
      [rowsA.payments],
    );
    accountA = rows[0]!.provider_account_id;
  });

  afterAll(async () => {
    await app.end();
    await admin.end();
  });

  // --- The constraints ------------------------------------------------------------------------

  it('refuses a negative amount and a refund larger than what was paid', async () => {
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET amount = -1 WHERE id = $1`, [rowsA.payments]),
        )
      ).code,
    ).toBe('23514');
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET amount_refunded = amount + 1 WHERE id = $1`, [
            rowsA.payments,
          ]),
        )
      ).code,
    ).toBe('23514');
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET amount_refunded = -1 WHERE id = $1`, [rowsA.payments]),
        )
      ).code,
    ).toBe('23514');
  });

  /**
   * The value goes into the `Stripe-Account` header of every call made about this payment, so
   * what it is allowed to be is pinned in the one place no future writer of that header can
   * bypass. The same constraint migration 0023 puts on the connection.
   */
  it('refuses an account identifier that is not shaped like one', async () => {
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET provider_account_id = 'not-an-account' WHERE id = $1`, [
            rowsA.payments,
          ]),
        )
      ).code,
    ).toBe('23514');
  });

  it('refuses a pending action it does not know', async () => {
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET pending_action = 'send_a_letter' WHERE id = $1`, [
            rowsA.payments,
          ]),
        )
      ).code,
    ).toBe('23514');
  });

  /**
   * A refund of a payment of **another project** must not be expressible. The foreign key is
   * composite against `(id, project_id, environment)`, so the database refuses it whatever the
   * RLS context of the writer is, which is what makes it an invariant rather than a habit.
   */
  it('refuses a refund whose parent belongs to another project', async () => {
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE payments SET parent_payment_id = $2 WHERE id = $1`, [
            rowsA.payments,
            rowsB.payments,
          ]),
        )
      ).code,
    ).toBe('23503');
    // The same parent, in the same project, is accepted.
    await admin.query(`UPDATE payments SET parent_payment_id = $1 WHERE id = $1`, [rowsA.payments]);
    await admin.query(`UPDATE payments SET parent_payment_id = NULL WHERE id = $1`, [
      rowsA.payments,
    ]);
  });

  it('accepts expire_payment as a fourth automatic transition and nothing else', async () => {
    await admin.query(
      `UPDATE bookings SET next_transition = 'expire_payment', next_transition_at = now()
        WHERE id = $1`,
      [rowsA.bookings],
    );
    expect(
      (
        await expectPgError(
          admin.query(`UPDATE bookings SET next_transition = 'expire_wallet' WHERE id = $1`, [
            rowsA.bookings,
          ]),
        )
      ).code,
    ).toBe('23514');
    await admin.query(
      `UPDATE bookings SET next_transition = NULL, next_transition_at = NULL WHERE id = $1`,
      [rowsA.bookings],
    );
  });

  // --- payment_provider_events ----------------------------------------------------------------

  /**
   * The dedupe is global, not per project: an event identifier is Stripe's, it is unique across
   * its whole platform, and the project it belongs to is exactly what the receiver has not
   * worked out yet when it claims the row.
   */
  it('refuses the same provider event twice, across projects', async () => {
    const eventId = `evt_${uuidv7().replaceAll('-', '')}`;
    await admin.query(
      `INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                            provider_event_id, type)
       VALUES ($1, $2, 'test', 'stripe', $3, 'payment_intent.succeeded')`,
      [uuidv7(), projectA, eventId],
    );
    expect(
      (
        await expectPgError(
          admin.query(
            `INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                                  provider_event_id, type)
             VALUES ($1, $2, 'test', 'stripe', $3, 'payment_intent.succeeded')`,
            [uuidv7(), projectB, eventId],
          ),
        )
      ).code,
    ).toBe('23505');
  });

  it('refuses a half scope, and a processed row with no outcome', async () => {
    expect(
      (
        await expectPgError(
          admin.query(
            `INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                                  provider_event_id, type)
             VALUES ($1, $2, NULL, 'stripe', $3, 'x')`,
            [uuidv7(), projectA, `evt_${uuidv7().replaceAll('-', '')}`],
          ),
        )
      ).code,
    ).toBe('23514');
    expect(
      (
        await expectPgError(
          admin.query(
            `INSERT INTO payment_provider_events (id, provider, provider_event_id, type,
                                                  processed_at)
             VALUES ($1, 'stripe', $2, 'x', now())`,
            [uuidv7(), `evt_${uuidv7().replaceAll('-', '')}`],
          ),
        )
      ).code,
    ).toBe('23514');
  });

  /**
   * The policy is false for a NULL project, so a row that belongs to nobody is invisible and
   * unwritable to the application role. That is the point of the definer function: without it
   * an unattributable event could not be recorded at all.
   */
  it('hides a project-less event from the application role, in both directions', async () => {
    const eventId = `evt_${uuidv7().replaceAll('-', '')}`;
    await admin.query(
      `INSERT INTO payment_provider_events (id, provider, provider_event_id, type)
       VALUES ($1, 'stripe', $2, 'payment_intent.succeeded')`,
      [uuidv7(), eventId],
    );
    await asProject(app, { projectId: projectA, environment: 'test' }, async () => {
      const { rows } = await app.query(
        `SELECT id FROM payment_provider_events WHERE provider_event_id = $1`,
        [eventId],
      );
      expect(rows).toHaveLength(0);
      // And it cannot write one either: the WITH CHECK is the same predicate.
      const failure = await expectPgError(
        app.query(
          `INSERT INTO payment_provider_events (id, provider, provider_event_id, type)
           VALUES ($1, 'stripe', $2, 'x')`,
          [uuidv7(), `evt_${uuidv7().replaceAll('-', '')}`],
        ),
      );
      expect(failure.code).toBe('42501');
    });
  });

  // --- The definer functions --------------------------------------------------------------------

  /**
   * `stripe_payment_scope` is the one cross project read the **public** webhook receiver makes,
   * from a request with no API key at all. Two properties matter: it answers from an empty RLS
   * context, or the receiver could not use it; and it answers only when both halves of the pair
   * match, or an event carrying somebody else's intent identifier would resolve to whatever
   * project happened to hold that string.
   */
  it('resolves an account and an intent to a project, from an empty context', async () => {
    await admin.query(`UPDATE payments SET provider_payment_id = 'pi_scopeTest' WHERE id = $1`, [
      rowsA.payments,
    ]);
    const { rows } = await app.query<{
      project_id: string;
      environment: string;
      payment_id: string;
    }>(`SELECT project_id, environment, payment_id FROM stripe_payment_scope($1, 'pi_scopeTest')`, [
      accountA,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBe(projectA);
    expect(rows[0]?.environment).toBe('test');
    expect(rows[0]?.payment_id).toBe(rowsA.payments);

    const wrongAccount = await app.query(
      `SELECT project_id FROM stripe_payment_scope('acct_SomebodyElse', 'pi_scopeTest')`,
    );
    expect(wrongAccount.rows).toHaveLength(0);
    const wrongIntent = await app.query(
      `SELECT project_id FROM stripe_payment_scope($1, 'pi_neverCreated')`,
      [accountA],
    );
    expect(wrongIntent.rows).toHaveLength(0);
  });

  /**
   * `stripe_account_scope` answers a **set**, because nothing stops two projects connecting the
   * same Stripe account and a deauthorisation ends the platform's access to all of them.
   */
  it('answers every project that connected one account', async () => {
    const shared = 'acct_1SharedByTwoProjects';
    for (const project of [projectA, projectB]) {
      await admin.query(
        `UPDATE payment_provider_connections SET provider_account_id = $2
          WHERE project_id = $1 AND environment = 'test'`,
        [project, shared],
      );
    }
    const { rows } = await app.query<{ project_id: string }>(
      `SELECT project_id FROM stripe_account_scope($1)`,
      [shared],
    );
    expect(rows.map((row) => row.project_id).sort()).toEqual([projectA, projectB].sort());
  });

  /**
   * The claim of an unattributable event, and the two halves of it: recording does **not**
   * settle, because a claim that settled itself would mark an event processed before the work
   * was done, and a delivery that failed halfway would come back as a duplicate for ever.
   */
  it('records an unattributable event once, and settles it separately', async () => {
    const eventId = `evt_${uuidv7().replaceAll('-', '')}`;
    const first = await app.query<{ id: string; duplicate: boolean }>(
      `SELECT id, duplicate
         FROM stripe_event_record_unmatched($1, $2, 'payment_intent.succeeded', 'acct_Unknown')`,
      [uuidv7(), eventId],
    );
    expect(first.rows[0]?.duplicate).toBe(false);
    const claimId = first.rows[0]!.id;

    // A redelivery of an attempt that was never settled is **not** a duplicate: that is what
    // makes a retry a retry.
    const retry = await app.query<{ id: string; duplicate: boolean }>(
      `SELECT id, duplicate
         FROM stripe_event_record_unmatched($1, $2, 'payment_intent.succeeded', 'acct_Unknown')`,
      [uuidv7(), eventId],
    );
    expect(retry.rows[0]?.id).toBe(claimId);
    expect(retry.rows[0]?.duplicate).toBe(false);

    await app.query(`SELECT stripe_event_settle_unmatched($1, 'unmatched')`, [claimId]);

    const settled = await app.query<{ duplicate: boolean }>(
      `SELECT duplicate
         FROM stripe_event_record_unmatched($1, $2, 'payment_intent.succeeded', 'acct_Unknown')`,
      [uuidv7(), eventId],
    );
    expect(settled.rows[0]?.duplicate).toBe(true);

    const { rows } = await admin.query<{ outcome: string; project_id: string | null }>(
      `SELECT outcome, project_id FROM payment_provider_events WHERE id = $1`,
      [claimId],
    );
    expect(rows[0]?.outcome).toBe('unmatched');
    expect(rows[0]?.project_id).toBeNull();
  });

  /** It settles only rows that belong to nobody: a project's own row is the project's to settle. */
  it('refuses to settle an event that belongs to a project', async () => {
    const id = uuidv7();
    await admin.query(
      `INSERT INTO payment_provider_events (id, project_id, environment, provider,
                                            provider_event_id, type)
       VALUES ($1, $2, 'test', 'stripe', $3, 'x')`,
      [id, projectA, `evt_${uuidv7().replaceAll('-', '')}`],
    );
    await app.query(`SELECT stripe_event_settle_unmatched($1, 'applied')`, [id]);
    const { rows } = await admin.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM payment_provider_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.processed_at).toBeNull();
  });

  /**
   * `pending_action_scopes` is the worker's discovery query, and the instant is the caller's:
   * a test asks what would happen in an hour without waiting an hour.
   *
   * It also pins the meaning of a NULL in `pending_action_next_at`, which is the whole reason
   * the column exists in the shape it does. NULL means one thing: the retry ladder ran out and
   * this row is out of the queue for good. It does **not** mean "due now". When it meant both,
   * an exhausted row was picked up again on every tick, called out to the provider again, and
   * logged as exhausted again, for ever.
   */
  it('answers which projects owe the provider a call, at an instant the caller chooses', async () => {
    await admin.query(
      `UPDATE payments SET pending_action = 'create_refund',
                           pending_action_next_at = now() + interval '30 minutes'
        WHERE id = $1`,
      [rowsA.payments],
    );

    const now = await app.query<{ project_id: string }>(
      `SELECT project_id FROM pending_action_scopes(now(), 100)`,
    );
    expect(now.rows.map((row) => row.project_id)).not.toContain(projectA);

    const later = await app.query<{ project_id: string }>(
      `SELECT project_id FROM pending_action_scopes(now() + interval '1 hour', 100)`,
    );
    expect(later.rows.map((row) => row.project_id)).toContain(projectA);

    // A row with no `pending_action_next_at` is an **exhausted** row, and it is never due: not
    // now, not in an hour, not in a century. This is the negation of the query the operator runs
    // to find the rows nothing will pick up again, and the two have to agree.
    await admin.query(`UPDATE payments SET pending_action_next_at = NULL WHERE id = $1`, [
      rowsA.payments,
    ]);
    for (const instant of ['now()', `now() + interval '1 hour'`, `now() + interval '100 years'`]) {
      const exhausted = await app.query<{ project_id: string }>(
        `SELECT project_id FROM pending_action_scopes(${instant}, 100)`,
      );
      expect(
        exhausted.rows.map((row) => row.project_id),
        instant,
      ).not.toContain(projectA);
    }

    await admin.query(`UPDATE payments SET pending_action = NULL WHERE id = $1`, [rowsA.payments]);
  });
});
