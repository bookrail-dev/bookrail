/**
 * What an account has used of its plan this month, and the one place the free plan says no.
 *
 * ## Counting
 *
 * {@link recordPlanUsage} adds to the counter of one project, environment and UTC month
 * (`plan_usage`), inside the transaction of the thing it counts: the booking transaction that
 * writes a booking already `confirmed`, the transition that confirms a `pending` one, and the
 * payment webhook that records money arriving or going back. Nothing counts outside a
 * transaction and nothing counts in a cache: a count that could be lost, or be written for a
 * booking whose transaction then rolled back, would be a count nobody could bill from or stop
 * on.
 *
 * The test environment never counts. That is decided twice: here, by returning before any
 * statement, and in the database, where a CHECK makes a test row of `plan_usage` impossible.
 *
 * ## Refusing
 *
 * {@link lockPlanForBooking} is called by the creation, before any capacity is taken, and only
 * in the live environment of an account whose plan blocks at its limit (the free plan). It takes
 * a transaction scoped advisory lock on the **account** and then reads the month's usage of every
 * project of the account. The lock is what makes the number a fact rather than an estimate: two
 * creations at the edge of the threshold are serialised by it, and the second one reads the count
 * the first one committed. Without it both would read 999 of 1 000, both would pass, and the
 * account would have 1 001.
 *
 * The lock is of the same family as the resource and customer locks of the booking transaction
 * (`pg_advisory_xact_lock` on a 64 bit hash of a UUID) with seed 2, and it is always taken
 * **after** the resource locks (seed 0) and the customer lock (seed 1). Every transaction that
 * takes more than one of them takes them in that order, which is the whole of what keeps them
 * from deadlocking.
 *
 * What the check reads is the month's confirmed bookings **plus** the account's open `pending`
 * ones (and, for the paid volume, the money that arrived plus the payments still open), because
 * a `pending` booking holds its slot from the moment it is created and is counted in `plan_usage`
 * only when it is confirmed. A booking that is later confirmed is therefore **not** refused at
 * the confirmation, only counted: it already took its place against the threshold when it was
 * created, and refusing to confirm a booking a customer may already have paid for would be worse
 * than counting it.
 *
 * ## Warning
 *
 * After every increment of the bookings, the account's total is compared with 80 % and 100 % of
 * the included bookings. A threshold reached is claimed with `plan_usage_warning_claim`, which
 * answers "new" once per account, month and threshold; a new one becomes a `plan.usage_warning`
 * event in the same transaction, and a {@link PlanUsageWarning} for the caller, which sends the
 * email after the commit.
 */
import { sql, withProjectContext, type Database, type Transaction } from '@bookrail/db';
import {
  BookrailError,
  PLANS,
  encodeId,
  planMonthOf,
  planOf,
  reachedThresholds,
  uuidv7,
  type Environment,
  type PlanId,
  type PlanLimits,
  type PlanTable,
  type PlanWarningThreshold,
} from '@bookrail/shared';
import { insertEvent } from '../booking/queries.js';

/**
 * The seed of the account lock. Resources are 0 and customers 1: see the note above.
 *
 * The seeds after it belong to the database, not to this engine, and are listed here so that the
 * next one taken is taken knowingly (migration 0026): 3 is the address of a request for a sign up
 * or a dashboard link, 4 the hashed caller of the same requests, 5 the account whose keys the
 * dashboard creates.
 */
export const ACCOUNT_LOCK_SEED = 2;

/** The event written when an account reaches a warning threshold of its plan. */
export const PLAN_USAGE_WARNING_EVENT = 'plan.usage_warning';

/**
 * Where to go to leave the free plan: the dashboard, which opens the checkout of Pro after sign in.
 *
 * It is the operative sentence of the `402`, repeated by the CLI and its `doctor` before it
 * happens. The `402` stays stored on its `Idempotency-Key`, so after the upgrade the booking is
 * retried with a new one.
 */
export const PLAN_UPGRADE_FIX =
  'Upgrade in the dashboard: https://bookrail.dev/dashboard/?upgrade=pro. Then retry with a new Idempotency-Key.';

/** The account a project belongs to, and what its plan says. */
export interface AccountPlan {
  readonly accountId: string;
  readonly plan: PlanId;
  readonly limits: PlanLimits;
  readonly ownerEmail: string | null;
}

/** An account's usage of one month, summed over its projects. */
export interface AccountUsage {
  readonly month: string;
  readonly bookingsConfirmed: number;
  readonly paymentVolume: number;
  /** The one currency the month's payments were in, `mixed`, or `null` when none moved. */
  readonly currency: string | null;
}

/**
 * What an account has accepted and not yet counted: its open live `pending` bookings and the
 * amount of its open live payments, with no month (`plan_reserved_for_account`).
 */
export interface AccountReserved {
  readonly bookingsPending: number;
  readonly paymentVolumePending: number;
}

/** What the free plan's check read under the account lock, for the checks after it. */
export interface PlanGate {
  readonly account: AccountPlan;
  readonly usage: AccountUsage;
  readonly reserved: AccountReserved;
}

/** A warning that has just been claimed, for the caller to send after the commit. */
export interface PlanUsageWarning {
  readonly accountId: string;
  readonly projectId: string;
  readonly plan: PlanId;
  readonly month: string;
  readonly threshold: PlanWarningThreshold;
  readonly bookingsConfirmed: number;
  readonly bookingsIncluded: number;
  readonly paymentVolume: number;
  readonly paymentVolumeIncluded: number | null;
  readonly currency: string | null;
  /** Where the email goes. `null` for an account created by hand: the event is the warning. */
  readonly ownerEmail: string | null;
  /** The `plan.usage_warning` event written in the same transaction. */
  readonly eventId: string;
}

export interface RecordPlanUsageInput {
  readonly projectId: string;
  readonly environment: Environment;
  /** The instant counted at. Its UTC month is the row that moves. */
  readonly now: number;
  /** Confirmed bookings to add. */
  readonly bookings?: number;
  /** Paid volume to add, in the minor unit. Negative for a refund. */
  readonly paymentVolume?: number;
  /** The currency of {@link paymentVolume}. */
  readonly currency?: string | null;
  /** The plan table, overridable by a test that needs a threshold it can reach. */
  readonly plans?: PlanTable;
}

// --- Errors ------------------------------------------------------------------------------------

/**
 * `402 plan_limit_reached`. The one error of the `payment_required` family: the request is well
 * formed and the booking would be possible, and what stands in the way is the plan.
 */
export function planLimitReached(message: string, param?: string): BookrailError {
  return new BookrailError(
    'payment_required',
    'plan_limit_reached',
    message,
    param,
    PLAN_UPGRADE_FIX,
  );
}

function money(amount: number): string {
  return (amount / 100).toFixed(2);
}

// --- Reading -----------------------------------------------------------------------------------

/**
 * The account of a project, its plan and its owner, read inside the project's context.
 *
 * Row Level Security lets the application role see exactly one project and one account from
 * there, which are these. Read in the transaction rather than taken from the caller, so that a
 * plan changed a second ago applies to the next booking and not to the next process.
 */
export async function accountPlanOf(
  tx: Transaction,
  projectId: string,
  plans: PlanTable = PLANS,
): Promise<AccountPlan> {
  const { rows } = await tx.execute<{
    account_id: string;
    plan: string;
    owner_email: string | null;
  }>(sql`
    SELECT p.account_id, a.plan, a.owner_email
      FROM projects p
      JOIN accounts a ON a.id = p.account_id
     WHERE p.id = ${projectId}
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new BookrailError(
      'internal',
      'internal_error',
      'The account of this project could not be read.',
    );
  }
  const plan = planOf(row.plan);
  return { accountId: row.account_id, plan, limits: plans[plan], ownerEmail: row.owner_email };
}

/**
 * The month's usage of an account, through `plan_usage_for_account`.
 *
 * Callable from either environment of a project of the account: the numbers are always the
 * live ones, because the threshold is the account's and a key of the test environment is how
 * somebody exploring finds out where they stand.
 */
export async function accountUsage(
  tx: Transaction,
  accountId: string,
  month: string,
): Promise<AccountUsage> {
  const { rows } = await tx.execute<{
    bookings_confirmed: string;
    payment_volume: string;
    currency: string | null;
  }>(sql`SELECT * FROM plan_usage_for_account(${accountId}::uuid, ${month})`);
  const row = rows[0];
  return {
    month,
    bookingsConfirmed: Number(row?.bookings_confirmed ?? 0),
    paymentVolume: Number(row?.payment_volume ?? 0),
    currency: row?.currency ?? null,
  };
}

/**
 * The month's counter and what is accepted and not yet counted, **in one statement**.
 *
 * One statement is one snapshot, and that is the whole point. A confirmation moves a booking from
 * `pending` to the counter in one commit, and a payment that succeeds moves its amount from the
 * open payments to the month's volume in one commit; neither takes the account lock, because
 * neither makes the sum larger. That is true only if the sum is read at one instant: read in two
 * statements, a move committed between them has already left the first number when the second is
 * read and had not yet reached the second when the first was, and disappears from both.
 *
 * `afterRead` runs after the read and before the numbers are returned. It exists for the test
 * that commits a confirmation from another connection at that point: with one statement the
 * numbers are already taken and do not move, and with two statements the confirmation would
 * fall between them, which is exactly the failure the test is written to catch.
 */
export async function accountPosition(
  tx: Transaction,
  accountId: string,
  month: string,
  afterRead?: () => Promise<void>,
): Promise<{ usage: AccountUsage; reserved: AccountReserved }> {
  const { rows } = await tx.execute<{
    bookings_confirmed: string;
    payment_volume: string;
    currency: string | null;
    bookings_pending: string;
    payment_volume_pending: string;
  }>(sql`
    SELECT u.bookings_confirmed, u.payment_volume, u.currency,
           r.bookings_pending, r.payment_volume_pending
      FROM plan_usage_for_account(${accountId}::uuid, ${month}) u,
           plan_reserved_for_account(${accountId}::uuid) r
  `);
  if (afterRead !== undefined) await afterRead();
  const row = rows[0];
  return {
    usage: {
      month,
      bookingsConfirmed: Number(row?.bookings_confirmed ?? 0),
      paymentVolume: Number(row?.payment_volume ?? 0),
      currency: row?.currency ?? null,
    },
    reserved: {
      bookingsPending: Number(row?.bookings_pending ?? 0),
      paymentVolumePending: Number(row?.payment_volume_pending ?? 0),
    },
  };
}

// --- Refusing ----------------------------------------------------------------------------------

/**
 * The free plan's check, before a live booking takes any capacity.
 *
 * Returns `null` (and takes no lock and reads nothing beyond the plan) in the test environment
 * and for a plan that does not block. Otherwise takes the account lock, reads the month's counter
 * and what the account has accepted and not yet counted, and throws `402 plan_limit_reached` when
 * the confirmed bookings of the month plus the open `pending` ones reach the included bookings.
 * The returned gate is what {@link assertPlanVolume} checks the payment against, later in the
 * same transaction and under the same lock, once the amount is known.
 *
 * Every `pending` booking and every open payment of an account on a blocking plan is born under
 * this lock, and the lock is held until the transaction that writes it commits, so what is read
 * here cannot grow behind the check's back. What can only shrink it (a cancellation, an expiry,
 * a payment that fails) or move it from one number to the other (a confirmation, a payment that
 * succeeds) takes no lock, and needs none: it never makes the sum larger.
 */
export async function lockPlanForBooking(
  tx: Transaction,
  input: {
    projectId: string;
    environment: Environment;
    now: number;
    plans?: PlanTable;
    /** See {@link accountPosition}. Only a test passes it. */
    afterRead?: () => Promise<void>;
  },
): Promise<PlanGate | null> {
  if (input.environment !== 'live') return null;
  const account = await accountPlanOf(tx, input.projectId, input.plans);
  if (!account.limits.blocksAtLimit) return null;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.accountId}::text, ${ACCOUNT_LOCK_SEED}))`,
  );
  const { usage, reserved } = await accountPosition(
    tx,
    account.accountId,
    planMonthOf(input.now),
    input.afterRead,
  );
  const included = account.limits.bookingsIncluded;
  if (included !== null && usage.bookingsConfirmed + reserved.bookingsPending >= included) {
    const pending =
      reserved.bookingsPending === 0
        ? ''
        : ` (${String(usage.bookingsConfirmed)} confirmed this month and ${String(reserved.bookingsPending)} pending)`;
    throw planLimitReached(
      `The ${account.plan} plan includes ${String(included)} confirmed live bookings a month and this account has used them${pending}; upgrade to keep taking bookings.`,
    );
  }
  return { account, usage, reserved };
}

/**
 * The free plan's paid volume, for a booking that takes money.
 *
 * The question is whether this payment, added to the money that arrived this month and to the
 * payments that are still open, would take the month past what the plan includes. Asked once the
 * amount is known, which is after the price has been frozen, and still before any row is written:
 * a refusal here rolls the whole transaction back and the slot stays free. The open payments are
 * in the sum because every one of them was created under the same account lock, so two deposits
 * made at once cannot each find room for itself in the same space.
 */
export function assertPlanVolume(gate: PlanGate | null, amount: number): void {
  if (gate === null) return;
  const included = gate.account.limits.paymentVolumeIncluded;
  if (included === null) return;
  const taken = gate.usage.paymentVolume + gate.reserved.paymentVolumePending;
  if (taken + amount > included) {
    const open =
      gate.reserved.paymentVolumePending === 0
        ? ''
        : ` (${money(gate.reserved.paymentVolumePending)} of it in payments still open)`;
    throw planLimitReached(
      `The ${gate.account.plan} plan includes ${money(included)} of paid volume a month; this account has taken ${money(taken)}${open} and this payment of ${money(amount)} would go past it. Upgrade to keep taking payments.`,
      'payment.mode',
    );
  }
}

/**
 * The warnings an account has reached and nobody has claimed yet, claimed in a transaction of
 * their own.
 *
 * Called by the creation routes after a `402` for the bookings (the transaction that refused has
 * rolled back, and with it anything it could have claimed). Without it an account on the free
 * plan could reach its threshold through two increments on two projects at the same instant, each
 * of which saw the total without the other, and then be refused all month without the warning
 * that announces it: after the threshold nothing else increments. `plan_usage_warning_claim` is
 * idempotent, so a warning already sent is not sent again.
 */
export async function claimReachedWarnings(
  db: Database,
  input: { projectId: string; environment: Environment; now: number; plans?: PlanTable },
): Promise<PlanUsageWarning[]> {
  if (input.environment !== 'live') return [];
  return withProjectContext(
    db,
    { projectId: input.projectId, environment: input.environment },
    (tx) =>
      claimWarnings(
        tx,
        {
          projectId: input.projectId,
          environment: input.environment,
          now: input.now,
          ...(input.plans === undefined ? {} : { plans: input.plans }),
        },
        planMonthOf(input.now),
      ),
  );
}

// --- Counting ----------------------------------------------------------------------------------

/**
 * Whether a booking chain has already been counted.
 *
 * A reschedule writes a new booking and closes the old one, and a reschedule is a change, not a
 * new booking: the chain counts once, the first time any booking in it reaches `confirmed`. So
 * a booking about to reach `confirmed` asks whether one of the bookings it replaces (directly or
 * through earlier reschedules) already did. `confirmed_at` stays on a booking after it is
 * rescheduled, which is what makes the answer a read and not a second counter.
 */
export async function chainAlreadyConfirmed(
  tx: Transaction,
  fromBookingId: string | null,
): Promise<boolean> {
  if (fromBookingId === null) return false;
  const { rows } = await tx.execute<{ counted: boolean }>(sql`
    WITH RECURSIVE chain (id, from_id, confirmed_at, depth) AS (
      SELECT id, rescheduled_from_booking_id, confirmed_at, 1
        FROM bookings WHERE id = ${fromBookingId}
      UNION ALL
      SELECT b.id, b.rescheduled_from_booking_id, b.confirmed_at, c.depth + 1
        FROM bookings b
        JOIN chain c ON b.id = c.from_id
       WHERE c.depth < 1000
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE confirmed_at IS NOT NULL) AS counted
  `);
  return rows[0]?.counted === true;
}

/**
 * Adds to the month's counter of a live project, and claims the warnings a booking increment
 * has reached.
 *
 * Returns the warnings that are new, each with its event already written in this transaction.
 * The caller sends the emails after the commit; a warning of a transaction that rolls back is
 * never sent, because its claim rolled back with it.
 */
export async function recordPlanUsage(
  tx: Transaction,
  input: RecordPlanUsageInput,
): Promise<PlanUsageWarning[]> {
  const bookings = input.bookings ?? 0;
  const volume = input.paymentVolume ?? 0;
  if (input.environment !== 'live') return [];
  if (bookings === 0 && volume === 0) return [];

  const month = planMonthOf(input.now);
  const currency = volume === 0 ? null : (input.currency ?? null);
  await tx.execute(sql`
    INSERT INTO plan_usage AS u (id, project_id, environment, month, bookings_confirmed,
                                 payment_volume, currency)
    VALUES (${uuidv7()}, ${input.projectId}, 'live', ${month}, ${bookings}, ${volume},
            ${currency})
    ON CONFLICT (project_id, environment, month) DO UPDATE
       SET bookings_confirmed = u.bookings_confirmed + EXCLUDED.bookings_confirmed,
           payment_volume = u.payment_volume + EXCLUDED.payment_volume,
           currency = CASE
                        WHEN EXCLUDED.currency IS NULL THEN u.currency
                        WHEN u.currency IS NULL THEN EXCLUDED.currency
                        WHEN upper(u.currency) = upper(EXCLUDED.currency) THEN u.currency
                        ELSE 'mixed'
                      END
  `);

  if (bookings <= 0) return [];
  return claimWarnings(tx, input, month);
}

async function claimWarnings(
  tx: Transaction,
  input: RecordPlanUsageInput,
  month: string,
): Promise<PlanUsageWarning[]> {
  const account = await accountPlanOf(tx, input.projectId, input.plans);
  const included = account.limits.bookingsIncluded;
  if (included === null) return [];
  const usage = await accountUsage(tx, account.accountId, month);
  const warnings: PlanUsageWarning[] = [];
  for (const threshold of reachedThresholds(usage.bookingsConfirmed, included)) {
    const { rows } = await tx.execute<{ threshold: number }>(sql`
      SELECT threshold FROM plan_usage_warning_claim(${account.accountId}::uuid, ${month}, ${threshold})
    `);
    if (rows.length === 0) continue;
    const object = {
      object: 'plan_usage',
      account_id: encodeId('account', account.accountId),
      plan: account.plan,
      month,
      threshold,
      bookings_confirmed: usage.bookingsConfirmed,
      bookings_included: included,
      payment_volume: usage.paymentVolume,
      payment_volume_included: account.limits.paymentVolumeIncluded,
    };
    const eventId = await insertEvent(
      tx,
      input.projectId,
      input.environment,
      PLAN_USAGE_WARNING_EVENT,
      object,
      { actor: { type: 'system', id: null }, occurredAt: input.now },
    );
    warnings.push({
      accountId: account.accountId,
      projectId: input.projectId,
      plan: account.plan,
      month,
      threshold,
      bookingsConfirmed: usage.bookingsConfirmed,
      bookingsIncluded: included,
      paymentVolume: usage.paymentVolume,
      paymentVolumeIncluded: account.limits.paymentVolumeIncluded,
      currency: usage.currency,
      ownerEmail: account.ownerEmail,
      eventId,
    });
  }
  return warnings;
}
