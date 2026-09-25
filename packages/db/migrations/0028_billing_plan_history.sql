-- 0028: Stripe Billing, fourth round (brief 024c): the history of the plan of an account, the
-- overage of a month pro rata by days, and what the proof in the Stripe sandbox and the third
-- review found in the functions of migration 0027.
--
-- Migration 0027 has never been released. This is a migration of its own, and not an edit of
-- 0027, because 0027 is applied on the development database of the Mac with the state of the
-- proof in the Stripe sandbox (customers and subscriptions that exist at Stripe), and the
-- checksum guard would force that database to be dropped to take an edited 0027. The two ship
-- in the same release.
--
-- ## What is here
--
--   1. `billing_plan_history`: one row per change of the plan of an account, written by the one
--      writer of `plan.changed` (so by a signed Stripe event and by `bookrail-plan` alike), at
--      the instant the change took effect. It is what the overage of a month reads to know which
--      plan served which day (decision of the founder of 25 September 2026: the included
--      quantities of a month are pro rata by days).
--   2. `billing_subscriptions` learns the instant of the last reading of Stripe it applied (a
--      reading older than that is refused, `stale_read`) and when the owner was told of a failed
--      payment (so that the message goes once whatever the order of the events), and two row
--      checks.
--   3. `billing_overages` learns the volume included in the month, and five row checks: the
--      price of the orchestrated payments is now computed by the database, not given by the
--      caller.
--   4. The functions whose arguments or answers change, dropped and created again with the four
--      properties of every definer function; and `billing_invoice_sdi`, which records the SdI
--      code or PEC read from the Checkout Session when the paid invoice arrives before the
--      event of the checkout.
--
-- ## The plan of a day
--
-- A day of the month (UTC) belongs to the plan in force at its **end**: the plan of the last
-- change strictly before the next midnight, or, before the first change, the plan that change
-- moved from, or, with no change at all, the plan of the account. A move up applies at once, so
-- the day of the move counts on the new plan; a move down or a cancellation at the end of a
-- period takes effect at midnight of the first, so the last day of the month counts on the old
-- plan. The history starts with this migration: for the accounts that already have a
-- subscription, the change recorded in `billing_subscriptions` (`previous_plan`, `plan_since`)
-- is copied in.

-- --- 1. the history of the plan of an account ----------------------------------------------------

CREATE TABLE billing_plan_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  plan_from   text NOT NULL CHECK (plan_from IN ('free', 'pro', 'scale', 'enterprise')),
  plan_to     text NOT NULL CHECK (plan_to IN ('free', 'pro', 'scale', 'enterprise')),
  reason      text NOT NULL
                CHECK (reason IN ('checkout', 'subscription_update', 'payment_failed', 'canceled',
                                  'admin', 'backfill')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (plan_from <> plan_to)
);

CREATE INDEX billing_plan_history_account_at_idx ON billing_plan_history (account_id, at, id);

COMMENT ON TABLE billing_plan_history IS
  'One row per change of the plan of an account, at the instant it took effect: what the overage '
  'of a month reads to know which plan served which day. Written by billing_write_plan_changed '
  'only, in the transaction that changes accounts.plan. Closed.';

ALTER TABLE billing_plan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plan_history FORCE ROW LEVEL SECURITY;

INSERT INTO billing_plan_history (account_id, at, plan_from, plan_to, reason)
SELECT b.account_id, b.plan_since, b.previous_plan,
       CASE WHEN billing_subscription_is_live(b.status) THEN b.plan ELSE a.plan END, 'backfill'
  FROM billing_subscriptions b
  JOIN accounts a ON a.id = b.account_id
 WHERE b.previous_plan <> CASE WHEN billing_subscription_is_live(b.status) THEN b.plan ELSE a.plan END;

-- --- 2. the one writer of plan.changed, which now writes the history too ------------------------

CREATE OR REPLACE FUNCTION billing_write_plan_changed(
  p_account_id uuid,
  p_from text,
  p_to text,
  p_reason text,
  p_at timestamptz,
  p_actor jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  written integer;
BEGIN
  IF p_reason NOT IN ('checkout', 'subscription_update', 'payment_failed', 'canceled', 'admin') THEN
    RAISE EXCEPTION 'unknown plan change reason: %', p_reason;
  END IF;
  IF p_from IS DISTINCT FROM p_to THEN
    INSERT INTO billing_plan_history (account_id, at, plan_from, plan_to, reason)
    VALUES (p_account_id, p_at, p_from, p_to, p_reason);
  END IF;
  INSERT INTO events (id, project_id, environment, type, data, actor, occurred_at)
  SELECT gen_random_uuid(), p.id, 'live', 'plan.changed',
         jsonb_build_object(
           'object', 'plan_change',
           'account_id', 'acct_' || replace(p_account_id::text, '-', ''),
           'from', p_from,
           'to', p_to,
           'reason', p_reason,
           'effective_at', to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ),
         p_actor,
         p_at
    FROM projects p
   WHERE p.account_id = p_account_id;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

-- --- 3. the subscription of an account: the last reading, the notice, two checks ---------------

ALTER TABLE billing_subscriptions
  ADD COLUMN last_read_at timestamptz,
  ADD COLUMN past_due_notified_at timestamptz,
  ADD CONSTRAINT billing_subscriptions_duplicate_differs
    CHECK (duplicate_subscription_id IS NULL OR duplicate_subscription_id <> stripe_subscription_id),
  ADD CONSTRAINT billing_subscriptions_active_not_past_due
    CHECK (status NOT IN ('active', 'trialing') OR (past_due_since IS NULL AND past_due_notified_at IS NULL));

COMMENT ON COLUMN billing_subscriptions.last_read_at IS
  'The instant of the reading of Stripe last applied to this row; an older reading is refused.';
COMMENT ON COLUMN billing_subscriptions.past_due_notified_at IS
  'When the owner was told of the failed payment of the current period, once.';

-- --- 4. the overage of a month: the included volume, and five checks ---------------------------

ALTER TABLE billing_overages
  ADD COLUMN payment_volume_included bigint NOT NULL DEFAULT 0 CHECK (payment_volume_included >= 0),
  ADD CONSTRAINT billing_overages_nothing_due_is_zero
    CHECK (status <> 'nothing_due' OR (bookings_amount = 0 AND payments_amount = 0)),
  ADD CONSTRAINT billing_overages_applied_has_placement
    CHECK (status <> 'applied' OR placement IS NOT NULL),
  ADD CONSTRAINT billing_overages_final_placement
    CHECK (placement IS DISTINCT FROM 'final_invoice' OR origin = 'final'),
  ADD CONSTRAINT billing_overages_final_origin
    CHECK (origin <> 'final' OR placement IS NULL OR placement = 'final_invoice'),
  ADD CONSTRAINT billing_overages_claimed_is_leased
    CHECK (status <> 'claimed' OR leased_until IS NOT NULL),
  ADD CONSTRAINT billing_overages_payments_amount
    CHECK (payments_amount = (greatest(payment_volume - payment_volume_included, 0)
                              * payments_per_mille + 500) / 1000);

-- --- 5. a subscription, as Stripe says it is now, applied to its account ------------------------
--
-- As in 0027, with three changes:
--   - `p_read_at`, the instant the caller read the subscription from Stripe: a reading older than
--     the last one applied to the row is refused (`stale_read`), so that of two readings made
--     around a change the older one, committed second, does not undo it;
--   - `ended_unpaid` in the answer: the subscription on file has ended after a failed payment,
--     which the caller follows with the invoices left open, on every delivery and not only on
--     the one that moved the plan;
--   - the notice of a failed payment is cleared with the failure.

DROP FUNCTION billing_subscription_apply(text, text, uuid, text, text, timestamptz, boolean, text,
                                         text, timestamptz);

CREATE FUNCTION billing_subscription_apply(
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_account_reference uuid,
  p_plan text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_scheduled_plan text,
  p_sdi_or_pec text,
  p_at timestamptz,
  p_read_at timestamptz
)
RETURNS TABLE (
  account_id uuid,
  outcome text,
  plan_from text,
  plan_to text,
  reason text,
  owner_email text,
  account_name text,
  other_subscription_id text,
  first_notice boolean,
  ended_unpaid boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account       accounts%ROWTYPE;
  v_row           billing_subscriptions%ROWTYPE;
  v_after         billing_subscriptions%ROWTYPE;
  v_has_row       boolean;
  v_target        text;
  v_reason        text;
  v_was_past_due  boolean;
  v_first         boolean;
  v_duplicate     text;
  v_ended_unpaid  boolean;
BEGIN
  SELECT * INTO v_account FROM accounts a
   WHERE a.stripe_customer_id = p_stripe_customer_id
     FOR UPDATE;

  IF NOT FOUND THEN
    IF p_account_reference IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'unmatched'::text, NULL::text, NULL::text, NULL::text,
                          NULL::text, NULL::text, NULL::text, false, false;
      RETURN;
    END IF;
    UPDATE accounts a
       SET stripe_customer_id = p_stripe_customer_id, updated_at = now()
     WHERE a.id = p_account_reference AND a.stripe_customer_id IS NULL;
    SELECT * INTO v_account FROM accounts a
     WHERE a.id = p_account_reference AND a.stripe_customer_id = p_stripe_customer_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT p_account_reference, 'mismatch'::text, NULL::text, NULL::text,
                          NULL::text, NULL::text, NULL::text, NULL::text, false, false;
      RETURN;
    END IF;
  ELSIF p_account_reference IS NOT NULL AND p_account_reference <> v_account.id THEN
    RETURN QUERY SELECT v_account.id, 'mismatch'::text, NULL::text, NULL::text, NULL::text,
                        NULL::text, NULL::text, NULL::text, false, false;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM billing_subscriptions b WHERE b.account_id = v_account.id FOR UPDATE;
  v_has_row := FOUND;

  -- A reading of Stripe older than the one already applied: it would undo a newer state.
  IF v_has_row AND p_read_at IS NOT NULL AND v_row.last_read_at IS NOT NULL
     AND p_read_at < v_row.last_read_at THEN
    RETURN QUERY SELECT v_account.id, 'stale_read'::text, v_account.plan, v_account.plan,
                        NULL::text, v_account.owner_email, v_account.name, NULL::text, false,
                        false;
    RETURN;
  END IF;

  IF v_has_row AND v_row.stripe_subscription_id <> p_stripe_subscription_id
     AND billing_subscription_is_live(v_row.status) THEN
    IF billing_subscription_is_live(p_status) THEN
      v_first := v_row.duplicate_subscription_id IS DISTINCT FROM p_stripe_subscription_id;
      UPDATE billing_subscriptions b
         SET duplicate_subscription_id = p_stripe_subscription_id
       WHERE b.account_id = v_account.id;
      RETURN QUERY SELECT v_account.id, 'duplicate_subscription'::text, v_account.plan,
                          v_account.plan, NULL::text, v_account.owner_email, v_account.name,
                          v_row.stripe_subscription_id, v_first, false;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_account.id, 'stale'::text, v_account.plan, v_account.plan, NULL::text,
                        v_account.owner_email, v_account.name, v_row.stripe_subscription_id,
                        false, false;
    RETURN;
  END IF;

  IF p_plan IS NULL AND NOT v_has_row THEN
    RETURN QUERY SELECT v_account.id, 'unknown_price'::text, v_account.plan, v_account.plan,
                        NULL::text, v_account.owner_email, v_account.name, NULL::text, false,
                        false;
    RETURN;
  END IF;

  v_was_past_due := v_has_row AND v_row.stripe_subscription_id = p_stripe_subscription_id
                    AND v_row.past_due_since IS NOT NULL;
  v_duplicate := CASE
    WHEN v_has_row AND v_row.stripe_subscription_id = p_stripe_subscription_id
         AND NOT billing_subscription_is_live(p_status)
    THEN v_row.duplicate_subscription_id
  END;

  IF NOT v_has_row THEN
    INSERT INTO billing_subscriptions (account_id, stripe_subscription_id, plan, status,
                                       current_period_end, cancel_at_period_end, scheduled_plan,
                                       past_due_since, previous_plan, plan_since, sdi_or_pec,
                                       last_read_at)
    VALUES (v_account.id, p_stripe_subscription_id, p_plan, p_status, p_current_period_end,
            coalesce(p_cancel_at_period_end, false), p_scheduled_plan,
            CASE WHEN p_status = 'past_due' THEN p_at END,
            v_account.plan, p_at, p_sdi_or_pec, p_read_at);
  ELSE
    UPDATE billing_subscriptions b
       SET stripe_subscription_id = p_stripe_subscription_id,
           plan = coalesce(p_plan, b.plan),
           status = p_status,
           current_period_end = p_current_period_end,
           cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
           scheduled_plan = p_scheduled_plan,
           past_due_since = CASE
             WHEN p_status IN ('active', 'trialing') THEN NULL
             WHEN b.stripe_subscription_id <> p_stripe_subscription_id THEN
               CASE WHEN p_status = 'past_due' THEN p_at END
             WHEN p_status = 'past_due' THEN coalesce(b.past_due_since, p_at)
             ELSE b.past_due_since
           END,
           past_due_notified_at = CASE
             WHEN p_status IN ('active', 'trialing') THEN NULL
             WHEN b.stripe_subscription_id <> p_stripe_subscription_id THEN NULL
             ELSE b.past_due_notified_at
           END,
           sdi_or_pec = coalesce(p_sdi_or_pec, b.sdi_or_pec),
           duplicate_subscription_id = CASE
             WHEN b.stripe_subscription_id <> p_stripe_subscription_id THEN NULL
             ELSE b.duplicate_subscription_id
           END,
           last_read_at = greatest(b.last_read_at, p_read_at)
     WHERE b.account_id = v_account.id;
  END IF;

  SELECT * INTO v_after FROM billing_subscriptions b WHERE b.account_id = v_account.id;
  v_ended_unpaid := NOT billing_subscription_is_live(p_status)
                    AND v_after.past_due_since IS NOT NULL;

  IF p_status IN ('active', 'trialing') THEN
    v_target := coalesce(p_plan, v_row.plan);
  ELSIF p_status IN ('past_due', 'incomplete') THEN
    v_target := v_account.plan;
  ELSE
    v_target := 'free';
  END IF;

  IF v_account.plan = 'enterprise' OR v_target = v_account.plan THEN
    RETURN QUERY SELECT v_account.id,
                        CASE WHEN v_account.plan = 'enterprise' AND v_target <> 'enterprise'
                             THEN 'enterprise_untouched' ELSE 'unchanged' END,
                        v_account.plan, v_account.plan, NULL::text,
                        v_account.owner_email, v_account.name, v_duplicate, false, v_ended_unpaid;
    RETURN;
  END IF;

  IF v_target = 'free' THEN
    v_reason := CASE
      WHEN v_was_past_due OR p_status IN ('unpaid', 'incomplete_expired') THEN 'payment_failed'
      ELSE 'canceled'
    END;
  ELSIF v_account.plan = 'free' THEN
    v_reason := 'checkout';
  ELSE
    v_reason := 'subscription_update';
  END IF;

  UPDATE accounts a SET plan = v_target, updated_at = now() WHERE a.id = v_account.id;
  UPDATE billing_subscriptions b
     SET previous_plan = v_account.plan, plan_since = p_at
   WHERE b.account_id = v_account.id;
  PERFORM billing_write_plan_changed(v_account.id, v_account.plan, v_target, v_reason, p_at,
                                     '{"type": "provider", "id": null}'::jsonb);

  RETURN QUERY SELECT v_account.id, 'changed'::text, v_account.plan, v_target, v_reason,
                      v_account.owner_email, v_account.name, v_duplicate, false, v_ended_unpaid;
END
$$;

COMMENT ON FUNCTION billing_subscription_apply(text, text, uuid, text, text, timestamptz, boolean,
                                               text, text, timestamptz, timestamptz) IS
  'Applies the state of a Stripe subscription, read at p_read_at, to the account of its customer: '
  'the subscription row, and the plan of the account (active or trialing: the plan of the price; '
  'past_due or incomplete: unchanged; otherwise free), with one plan.changed event per project and '
  'one row of billing_plan_history in the same transaction. A reading older than the last one '
  'applied is refused (stale_read); a second live subscription is never applied. ended_unpaid: '
  'the subscription on file ended after a failed payment.';

-- --- 6. a failed payment, from a reading of the subscription ------------------------------------
--
-- The caller reads the subscription from Stripe and passes its status: only a subscription that
-- Stripe holds `past_due` starts the fourteen days (a failed payment of a move up that waits for
-- its payment, `pending_if_incomplete`, leaves the subscription `active`). The status is written
-- with the start, so that the row never says `active` with a start of a failure; the owner is
-- told once per period (`past_due_notified_at`), whether this event or the update of the
-- subscription is processed first.

DROP FUNCTION billing_payment_failed(text, text, timestamptz);

CREATE FUNCTION billing_payment_failed(
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_at timestamptz
)
RETURNS TABLE (
  account_id uuid,
  owner_email text,
  account_name text,
  first_failure boolean,
  past_due_since timestamptz,
  grace_ends_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  grace constant interval := interval '14 days';
  v_row   billing_subscriptions%ROWTYPE;
  v_first boolean;
BEGIN
  IF p_status IS DISTINCT FROM 'past_due' THEN
    RETURN;
  END IF;
  SELECT b.* INTO v_row
    FROM billing_subscriptions b
    JOIN accounts a ON a.id = b.account_id
   WHERE b.stripe_subscription_id = p_stripe_subscription_id
     AND a.stripe_customer_id = p_stripe_customer_id
     FOR UPDATE OF b;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_first := v_row.past_due_notified_at IS NULL;
  UPDATE billing_subscriptions b
     SET status = 'past_due',
         past_due_since = coalesce(b.past_due_since, p_at),
         past_due_notified_at = coalesce(b.past_due_notified_at, now())
   WHERE b.id = v_row.id
  RETURNING * INTO v_row;

  RETURN QUERY
  SELECT a.id, a.owner_email, a.name, v_first, v_row.past_due_since,
         v_row.past_due_since + grace
    FROM accounts a
   WHERE a.id = v_row.account_id;
END
$$;

COMMENT ON FUNCTION billing_payment_failed(text, text, text, timestamptz) IS
  'Records a failed payment of a subscription that Stripe holds past_due: the start of the '
  'fourteen days (kept until it is active again) and whether the owner is told now (once per '
  'period). Nothing for any other status.';

-- --- 7. what the overage of a closed month is computed from -------------------------------------
--
-- The days of the month on each plan (see "The plan of a day" above), the plan whose prices the
-- overage is billed at (the plan of the last day when it is paid, otherwise the last paid plan
-- that served the month: a subscription closed in the middle of a month is billed at its own
-- prices for the days it served), and the usage of the month. The caller computes the included
-- quantities, pro rata, from the quantities of each plan, which live in the code.

DROP FUNCTION billing_overage_context(text, text, timestamptz);

CREATE FUNCTION billing_overage_context(p_stripe_customer_id text, p_month text)
RETURNS TABLE (
  account_id uuid,
  account_plan text,
  plan text,
  days_in_month integer,
  free_days integer,
  pro_days integer,
  scale_days integer,
  enterprise_days integer,
  bookings_confirmed bigint,
  payment_volume bigint,
  currency text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH acct AS (
    SELECT a.id, a.plan FROM accounts a WHERE a.stripe_customer_id = p_stripe_customer_id
  ), days AS (
    SELECT d::date AS day,
           coalesce(
             (SELECT h.plan_to FROM billing_plan_history h
               WHERE h.account_id = acct.id
                 AND h.at < ((d::date + 1)::timestamp AT TIME ZONE 'UTC')
               ORDER BY h.at DESC, h.id DESC LIMIT 1),
             (SELECT h.plan_from FROM billing_plan_history h
               WHERE h.account_id = acct.id
                 AND h.at >= ((d::date + 1)::timestamp AT TIME ZONE 'UTC')
               ORDER BY h.at, h.id LIMIT 1),
             acct.plan
           ) AS plan
      FROM acct,
           generate_series((p_month || '-01')::date,
                           ((p_month || '-01')::date + interval '1 month' - interval '1 day')::date,
                           interval '1 day') AS d
  )
  SELECT acct.id, acct.plan,
         (SELECT dd.plan FROM days dd WHERE dd.plan IN ('pro', 'scale')
           ORDER BY dd.day DESC LIMIT 1),
         (SELECT count(*) FROM days)::integer,
         (SELECT count(*) FROM days dd WHERE dd.plan = 'free')::integer,
         (SELECT count(*) FROM days dd WHERE dd.plan = 'pro')::integer,
         (SELECT count(*) FROM days dd WHERE dd.plan = 'scale')::integer,
         (SELECT count(*) FROM days dd WHERE dd.plan = 'enterprise')::integer,
         u.bookings_confirmed, u.payment_volume, u.currency
    FROM acct
   CROSS JOIN LATERAL billing_usage_for_month(acct.id, p_month) u
$$;

COMMENT ON FUNCTION billing_overage_context(text, text) IS
  'The account of a Stripe customer and its plan now, the days of one UTC month on each plan '
  '(from billing_plan_history, each day on the plan in force at its end), the paid plan whose '
  'prices bill the month, and the usage of the month: what the overage is computed from.';

-- --- 8. the claim of a month's overage: the included volume, and the price computed here -------

DROP FUNCTION billing_overage_claim(uuid, text, text, text, text, bigint, bigint, integer, bigint,
                                    integer, bigint, text);
DROP FUNCTION billing_overage_take(integer, uuid);

CREATE FUNCTION billing_overage_claim(
  p_account_id uuid,
  p_month text,
  p_plan text,
  p_origin text,
  p_stripe_invoice_id text,
  p_bookings_confirmed bigint,
  p_bookings_included bigint,
  p_booking_unit_amount integer,
  p_payment_volume bigint,
  p_payment_volume_included bigint,
  p_payments_per_mille integer,
  p_volume_currency text
)
RETURNS TABLE (
  id uuid,
  claimed boolean,
  account_id uuid,
  stripe_customer_id text,
  month text,
  plan text,
  origin text,
  status text,
  placement text,
  stripe_invoice_id text,
  attempts integer,
  leased_until timestamptz,
  bookings_included bigint,
  bookings_over bigint,
  booking_unit_amount integer,
  bookings_amount bigint,
  payment_volume bigint,
  payment_volume_included bigint,
  payments_per_mille integer,
  payments_amount bigint,
  stripe_booking_item_id text,
  stripe_payment_item_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_over     bigint := greatest(0, p_bookings_confirmed - p_bookings_included);
  v_payments bigint := (greatest(p_payment_volume - p_payment_volume_included, 0)
                        * p_payments_per_mille + 500) / 1000;
  v_new      uuid;
BEGIN
  INSERT INTO billing_overages AS o (account_id, month, plan, origin, stripe_invoice_id,
                                     bookings_confirmed, bookings_included,
                                     bookings_over, booking_unit_amount, bookings_amount,
                                     payment_volume, payment_volume_included, payments_per_mille,
                                     payments_amount, volume_currency, status, leased_until)
  VALUES (p_account_id, p_month, p_plan, p_origin, p_stripe_invoice_id,
          p_bookings_confirmed, p_bookings_included, v_over, p_booking_unit_amount,
          v_over * p_booking_unit_amount, p_payment_volume, p_payment_volume_included,
          p_payments_per_mille, v_payments, p_volume_currency,
          CASE WHEN v_over * p_booking_unit_amount = 0 AND v_payments = 0
               THEN 'nothing_due' ELSE 'claimed' END,
          now() + interval '10 minutes')
  ON CONFLICT ON CONSTRAINT billing_overages_account_id_month_key DO NOTHING
  RETURNING o.id INTO v_new;

  RETURN QUERY
  SELECT o.id, v_new IS NOT NULL, o.account_id, a.stripe_customer_id, o.month, o.plan, o.origin,
         o.status, o.placement, o.stripe_invoice_id, o.attempts, o.leased_until, o.bookings_included,
         o.bookings_over, o.booking_unit_amount, o.bookings_amount, o.payment_volume,
         o.payment_volume_included, o.payments_per_mille, o.payments_amount,
         o.stripe_booking_item_id, o.stripe_payment_item_id
    FROM billing_overages o
    JOIN accounts a ON a.id = o.account_id
   WHERE o.account_id = p_account_id AND o.month = p_month;
END
$$;

COMMENT ON FUNCTION billing_overage_claim(uuid, text, text, text, text, bigint, bigint, integer,
                                          bigint, bigint, integer, text) IS
  'Claims the overage of one account and one month, once: the first call writes the row with a '
  'lease of ten minutes and answers claimed = true; every later call answers the row as it is, '
  'claimed = false. The price of the orchestrated payments is computed here, half up to the cent, '
  'on the volume beyond the included volume. A month with nothing to bill is nothing_due.';

CREATE FUNCTION billing_overage_take(p_limit integer, p_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  claimed boolean,
  account_id uuid,
  stripe_customer_id text,
  month text,
  plan text,
  origin text,
  status text,
  placement text,
  stripe_invoice_id text,
  attempts integer,
  leased_until timestamptz,
  bookings_included bigint,
  bookings_over bigint,
  booking_unit_amount integer,
  bookings_amount bigint,
  payment_volume bigint,
  payment_volume_included bigint,
  payments_per_mille integer,
  payments_amount bigint,
  stripe_booking_item_id text,
  stripe_payment_item_id text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM billing_overages o
     WHERE o.status = 'claimed'
       AND (o.leased_until IS NULL OR o.leased_until < now())
       AND (p_id IS NULL OR o.id = p_id)
     ORDER BY o.claimed_at
     LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
       FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE billing_overages o
       SET leased_until = now() + interval '10 minutes',
           attempts = o.attempts + 1
      FROM picked
     WHERE o.id = picked.id
    RETURNING o.*
  )
  SELECT l.id, true, l.account_id, a.stripe_customer_id, l.month, l.plan, l.origin, l.status,
         l.placement, l.stripe_invoice_id, l.attempts, l.leased_until, l.bookings_included,
         l.bookings_over, l.booking_unit_amount, l.bookings_amount, l.payment_volume,
         l.payment_volume_included, l.payments_per_mille, l.payments_amount,
         l.stripe_booking_item_id, l.stripe_payment_item_id
    FROM leased l
    JOIN accounts a ON a.id = l.account_id
   ORDER BY l.claimed_at;
END
$$;

COMMENT ON FUNCTION billing_overage_take(integer, uuid) IS
  'The claims of overage left open by a caller that did not finish, whose lease has run out '
  '(all of them, or the one of p_id): each is leased again for ten minutes, its attempts counted, '
  'and answered, for the reconciliation or a redelivery to finish.';

-- --- 9. the SdI code or PEC of a paid invoice, read from its Checkout Session -------------------
--
-- Stripe does not deliver events in order: the `invoice.paid` of the first invoice can arrive
-- before the `checkout.session.completed` that carries the code. The caller then reads the
-- session of the subscription and records the code here, on the invoice and on the
-- subscription of its account, where neither has one yet.

CREATE FUNCTION billing_invoice_sdi(p_stripe_invoice_id text, p_sdi_or_pec text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_sdi     text;
BEGIN
  IF p_sdi_or_pec IS NULL OR length(p_sdi_or_pec) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'an SdI code or PEC is 1 to 200 characters';
  END IF;
  UPDATE billing_invoices i
     SET sdi_or_pec = coalesce(i.sdi_or_pec, p_sdi_or_pec)
   WHERE i.stripe_invoice_id = p_stripe_invoice_id
  RETURNING i.account_id, i.sdi_or_pec INTO v_account, v_sdi;
  IF v_account IS NOT NULL THEN
    UPDATE billing_subscriptions b
       SET sdi_or_pec = coalesce(b.sdi_or_pec, p_sdi_or_pec)
     WHERE b.account_id = v_account;
  END IF;
  RETURN v_sdi;
END
$$;

COMMENT ON FUNCTION billing_invoice_sdi(text, text) IS
  'Records the SdI code or PEC read from the Checkout Session on a paid invoice, and on the '
  'subscription of its account, where they have none yet. Answers the code in force on the invoice.';

-- --- privileges ---------------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'billing_subscription_apply(text, text, uuid, text, text, timestamptz, boolean, text, text, timestamptz, timestamptz)',
    'billing_payment_failed(text, text, text, timestamptz)',
    'billing_overage_context(text, text)',
    'billing_overage_claim(uuid, text, text, text, text, bigint, bigint, integer, bigint, bigint, integer, text)',
    'billing_overage_take(integer, uuid)',
    'billing_invoice_sdi(text, text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
