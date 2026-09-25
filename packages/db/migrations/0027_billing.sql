-- 0027: Stripe Billing, the terms a customer accepts, and the plan that follows a subscription.
--
-- Until now an account changed plan in one way: an operator ran `bookrail-plan` on the machine.
-- From here an account on the free plan buys Pro or Scale through Stripe Checkout, the plan
-- follows the subscription through signed events of Stripe, the bookings over the included
-- quantity and the price of the orchestrated payments go on the invoice of the renewal, and every
-- paid invoice leaves a row with what an Italian electronic invoice needs.
--
-- ## Two uses of one Stripe account, and they must never meet
--
-- The Stripe account of Bookrail is already a Connect **platform**: it acts for the connected
-- accounts of its customers with a `Stripe-Account` header, and it receives their events on the
-- two receivers of migration 0024. Billing uses the **same** account as a **seller**: no
-- `Stripe-Account`, the account's own events, a receiver and a signing secret of their own. The
-- tables below belong to that second use and to nothing else: `billing_events` is not
-- `payment_provider_events`, and no function here reads a connection or a payment.
--
-- ## What is here
--
--   1. `accounts.stripe_customer_id`: the Stripe customer of an account, once it has one.
--   2. `billing_subscriptions`: one row per account, the subscription that decides its plan.
--   3. `billing_events`: the idempotency of the Billing receiver.
--   4. `billing_overages`: the claim of a month's overage, taken before Stripe is called.
--   5. `billing_invoices`: one row per paid invoice, with the data of the electronic invoice;
--      `billing_unpaid_invoices`: the invoices a closed subscription left open.
--   6. `terms_acceptances`: who accepted which version of the terms and of the DPA, where, when.
--   7. `signups` learns to carry an acceptance from the request to the account it creates.
--   8. The functions, the only way into all of the above.
--
-- Every table is **closed**: row security enabled and forced, no policy, no grant. They belong to
-- an account and not to a project, like `plan_usage_warnings` and the dashboard tables, and the
-- `SECURITY DEFINER` functions below are the only way in. Each has the four properties of every
-- definer function before it: owned by the migration role, `SET search_path = public, pg_temp`,
-- `EXECUTE` revoked from `PUBLIC` and granted to the application role only (one of them, the
-- writer of the `plan.changed` events, to nobody), and a fixed return type.
--
-- ## The plan changes here and only here
--
-- `accounts.plan` is written by `billing_subscription_apply`, which runs only after the Billing
-- receiver has verified a signature over the raw body of a Stripe event, and by `bookrail-plan`
-- on the machine, with the owner connection. Every change writes one `plan.changed` event in the
-- live log of every project of the account, in the same transaction. An account on the
-- `enterprise` plan is a contract, and no subscription event changes its plan.
--
-- ## What these functions trust
--
-- The functions executable by the application role take their arguments as given. They are the
-- only way into the tables, and they check what can be checked (a customer bound to one account
-- is never applied to another, a live subscription never replaces another live one), but they
-- cannot tell a subscription state read from Stripe from one made up by a caller. An SQL
-- injection in the API process, which runs as the application role, could therefore change a
-- plan, move the start of a failed payment, claim an overage of nothing or read the fiscal data
-- of the invoices. The defence is in the code that calls them: no SQL built from strings, and no
-- Billing function called before the signature of a Stripe event has been verified.
--
-- ## Time
--
-- The instant a change is recorded at is the instant Stripe says the event happened (`p_at`,
-- from the event's `created`), not the instant it was processed: two events processed out of
-- order must not reorder history, and a Stripe test clock must be able to move a subscription
-- through months that have not happened yet. The deadline of the fourteen days is compared with
-- the database's `now()` by `billing_overdue_subscriptions`.
--
-- ## A live subscription
--
-- One definition, `billing_subscription_is_live`: `incomplete`, `trialing`, `active`,
-- `past_due`. The receiver, the dashboard, `bookrail-plan` and the jobs all ask this function.
-- `unpaid` and `paused` are dead: the account is on the free plan, and the daily job cancels the
-- subscription at Stripe so that it stops invoicing.

-- --- 1. the customer of an account --------------------------------------------------------------

ALTER TABLE accounts
  ADD COLUMN stripe_customer_id text UNIQUE
    CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]+$');

COMMENT ON COLUMN accounts.stripe_customer_id IS
  'The Stripe customer of this account in Billing (Bookrail as the seller), created before its '
  'first checkout. Never a connected account: those are in payment_provider_connections.';

-- The last Checkout Session opened for the account. One open session per account: the API
-- expires the previous one before it opens another, so two tabs cannot pay twice.
ALTER TABLE accounts
  ADD COLUMN stripe_checkout_session_id text
    CHECK (stripe_checkout_session_id IS NULL
           OR stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$');

COMMENT ON COLUMN accounts.stripe_checkout_session_id IS
  'The last Stripe Checkout Session opened for this account, expired before another is opened.';

-- --- the one definition of a live subscription ---------------------------------------------------

CREATE FUNCTION billing_subscription_is_live(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_status IN ('incomplete', 'trialing', 'active', 'past_due'), false)
$$;

COMMENT ON FUNCTION billing_subscription_is_live(text) IS
  'Whether a Stripe subscription in this status is one the account still has: incomplete, '
  'trialing, active or past_due. The one definition, asked by the receiver, the dashboard, '
  'bookrail-plan and the jobs.';

-- --- 2. the subscription of an account ----------------------------------------------------------
--
-- One per account. A second subscription for the same account can only come from a second
-- checkout, which the API refuses while one is live (in this table or at Stripe) and prevents by
-- expiring the previous session; a subscription that ended is replaced by the next one in the
-- same row, and its history is in Stripe. A second **live** one never replaces the first: it is
-- recorded in `duplicate_subscription_id` and reported, for a person to cancel and refund.
--
-- `previous_plan` and `plan_since` answer one question: which plan served the last day of a
-- closed month. They are written every time the plan of the account moves because of this
-- subscription: `previous_plan` is the plan it moved from, `plan_since` the instant Stripe says
-- the move happened. A move up applies at once and a move down applies on the first of the next
-- month, so the plan of the last day is `plan` when it began before the end of the month, and
-- `previous_plan` otherwise. That is the plan whose included quantities and prices the overage
-- of that month is computed with.

CREATE TABLE billing_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  stripe_subscription_id  text NOT NULL UNIQUE CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  plan                    text NOT NULL CHECK (plan IN ('pro', 'scale')),
  status                  text NOT NULL
                            CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing',
                                              'active', 'past_due', 'canceled', 'unpaid',
                                              'paused')),
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  scheduled_plan          text CHECK (scheduled_plan IS NULL OR scheduled_plan IN ('pro', 'scale')),
  -- The first failed payment of the current period; cleared when the subscription is active again.
  past_due_since          timestamptz,
  previous_plan           text NOT NULL DEFAULT 'free'
                            CHECK (previous_plan IN ('free', 'pro', 'scale', 'enterprise')),
  plan_since              timestamptz NOT NULL DEFAULT now(),
  -- The SdI recipient code or PEC address an Italian company typed at checkout, if any.
  sdi_or_pec              text CHECK (sdi_or_pec IS NULL OR length(sdi_or_pec) BETWEEN 1 AND 200),
  -- A second live subscription of the same account, reported and never applied.
  duplicate_subscription_id text
    CHECK (duplicate_subscription_id IS NULL OR duplicate_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_subscriptions_past_due_idx
  ON billing_subscriptions (past_due_since) WHERE status = 'past_due';

COMMENT ON TABLE billing_subscriptions IS
  'The Stripe subscription of an account: its plan (pro or scale, from the lookup key of its '
  'price), its status, the end of the period, the scheduled move down and the start of a payment '
  'failure. Closed; written only by billing_subscription_apply and billing_payment_failed.';

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;

CREATE TRIGGER billing_subscriptions_set_updated_at
  BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- 3. the events of the Billing receiver ------------------------------------------------------
--
-- The same discipline as `payment_provider_events`: a row that exists and is processed is a
-- duplicate; a row that exists and is not processed is an attempt that failed halfway, and the
-- next delivery carries on.

CREATE TABLE billing_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  text NOT NULL UNIQUE CHECK (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  type             text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  livemode         boolean NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  outcome          text CHECK (outcome IS NULL OR outcome IN ('applied', 'ignored', 'unmatched'))
);

COMMENT ON TABLE billing_events IS
  'One row per Stripe Billing event received with a valid signature, claimed before it is '
  'applied. Closed; billing_event_claim and billing_event_settle are the only way in.';

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;

-- --- 4. the overage of a month -------------------------------------------------------------------
--
-- Taken **before** Stripe is called, under a UNIQUE on (account, month): a second
-- `invoice.created` for the same renewal, or a retry after a timeout, finds the row and adds
-- nothing a second time. The amounts are whole numbers of cents; the price of the orchestrated
-- payments is per mille of the volume, rounded half up to the cent by the caller.
--
-- The row is what the lines are built from, always: the quantities, the amounts and the invoice
-- as they were when the claim was taken, never the usage read again later. The tax is Stripe
-- Tax's, computed on the invoice the lines go on. Only
-- the caller that took the claim (`claimed = true`) goes on to Stripe, under a lease of ten
-- minutes; a claim whose lease has run out without being settled is taken again by the daily
-- reconciliation, so no claim stays open for ever.
--
-- Two origins: `renewal`, the month before a renewal, on the draft of that renewal; `final`, the
-- last months of a subscription that has ended, on an invoice of their own.

CREATE TABLE billing_overages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  month                  text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  plan                   text NOT NULL CHECK (plan IN ('pro', 'scale')),
  origin                 text NOT NULL DEFAULT 'renewal' CHECK (origin IN ('renewal', 'final')),
  -- The draft invoice the lines were meant for (a renewal), or the invoice made for them (final).
  stripe_invoice_id      text CHECK (stripe_invoice_id IS NULL OR stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  bookings_confirmed     bigint NOT NULL CHECK (bookings_confirmed >= 0),
  bookings_included      bigint NOT NULL CHECK (bookings_included >= 0),
  bookings_over          bigint NOT NULL CHECK (bookings_over >= 0),
  booking_unit_amount    integer NOT NULL CHECK (booking_unit_amount >= 0),
  bookings_amount        bigint NOT NULL CHECK (bookings_amount >= 0),
  payment_volume         bigint NOT NULL,
  payments_per_mille     integer NOT NULL CHECK (payments_per_mille >= 0),
  payments_amount        bigint NOT NULL CHECK (payments_amount >= 0),
  -- The currency of the counted volume ('mixed' when it was more than one); the lines are in euro.
  volume_currency        text,
  status                 text NOT NULL CHECK (status IN ('claimed', 'applied', 'nothing_due')),
  -- Where the lines went: the draft of the renewal, the next invoice of the customer when the
  -- draft was no longer a draft, or an invoice of their own for a subscription that has ended.
  placement              text CHECK (placement IS NULL
                                     OR placement IN ('invoice', 'next_invoice', 'final_invoice')),
  stripe_booking_item_id text,
  stripe_payment_item_id text,
  claimed_at             timestamptz NOT NULL DEFAULT now(),
  -- Until when the caller working on a claim has it; a claim past its lease is taken again.
  leased_until           timestamptz,
  -- How many times the claim was taken again after a caller did not finish it: after five, a
  -- person is told, because a claim that cannot close fails every day in silence otherwise.
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  applied_at             timestamptz,
  UNIQUE (account_id, month),
  CHECK (bookings_over = greatest(0, bookings_confirmed - bookings_included)),
  CHECK (bookings_amount = bookings_over * booking_unit_amount)
);

CREATE INDEX billing_overages_open_idx
  ON billing_overages (leased_until) WHERE status = 'claimed';

COMMENT ON TABLE billing_overages IS
  'The overage of one account and one closed UTC month, claimed once before Stripe is called: '
  'bookings over the included quantity times the unit price, and the per mille of the paid '
  'volume. The lines are built from this row. Closed; billing_overage_claim, '
  'billing_overage_take and billing_overage_settle are the only way in.';

ALTER TABLE billing_overages ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_overages FORCE ROW LEVEL SECURITY;

-- --- 5. the paid invoices ------------------------------------------------------------------------
--
-- One row per paid Stripe invoice with an amount, written from `invoice.paid`: everything the
-- electronic invoice issued from the accounting software needs, in the form an automation will
-- read later. The row outlives the account (`ON DELETE SET NULL`): it is a fiscal record, and
-- Italian law asks for ten years.

CREATE TABLE billing_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid REFERENCES accounts (id) ON DELETE SET NULL,
  stripe_invoice_id     text NOT NULL UNIQUE CHECK (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  stripe_customer_id    text NOT NULL,
  number                text,
  hosted_invoice_url    text,
  paid_at               timestamptz NOT NULL,
  currency              text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  customer_name         text,
  customer_email        text,
  tax_id_type           text,
  tax_id_value          text,
  -- Stripe's verification of the tax id: verified, unverified, pending, unavailable, or NULL.
  tax_id_verification   text,
  country               text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  address               jsonb NOT NULL DEFAULT '{}'::jsonb,
  sdi_or_pec            text,
  vat_treatment         text NOT NULL
                          CHECK (vat_treatment IN ('it_vat', 'eu_reverse_charge', 'outside_eu')),
  -- [{description, amount, tax_amount, tax_rate_percent, period_start, period_end}], cents.
  lines                 jsonb NOT NULL,
  subtotal              bigint NOT NULL,
  tax                   bigint NOT NULL,
  total                 bigint NOT NULL CHECK (total > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  mailed_at             timestamptz
);

CREATE INDEX billing_invoices_paid_at_idx ON billing_invoices (paid_at);

COMMENT ON TABLE billing_invoices IS
  'One row per paid Stripe invoice: the data of the Italian electronic invoice to issue for it. '
  'Kept after the account is gone. Closed; written by billing_invoice_record.';

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;

-- --- 5b. the invoices left unpaid ------------------------------------------------------------
--
-- When a subscription is closed for a payment that never came, its last invoice stays open at
-- Stripe, and Stripe no longer collects it. The dashboard shows it with the link to pay it, and a
-- new checkout is refused until it is paid. A row per open invoice, settled when Stripe says it
-- was paid, voided or marked uncollectible.

CREATE TABLE billing_unpaid_invoices (
  stripe_invoice_id   text PRIMARY KEY CHECK (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  number              text,
  amount_due          bigint NOT NULL CHECK (amount_due >= 0),
  currency            text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  hosted_invoice_url  text CHECK (hosted_invoice_url IS NULL OR hosted_invoice_url ~ '^https://'),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz
);

CREATE INDEX billing_unpaid_invoices_open_idx
  ON billing_unpaid_invoices (account_id) WHERE settled_at IS NULL;

COMMENT ON TABLE billing_unpaid_invoices IS
  'The invoices left open when a subscription was closed for non payment: shown in the dashboard '
  'with their payment link until Stripe says they were paid, voided or marked uncollectible. '
  'Closed; billing_unpaid_invoice_record and billing_unpaid_invoice_settle are the only way in.';

ALTER TABLE billing_unpaid_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_unpaid_invoices FORCE ROW LEVEL SECURITY;

-- --- 6. the acceptances of the terms -------------------------------------------------------------
--
-- Two ticks, both required: the terms with the DPA, and the specific approval of the clauses of
-- articles 1341 and 1342 of the Italian civil code. The two booleans can only be true, so a row is
-- the proof that both were ticked, with the versions shown, the instant, the channel and the hash
-- of the caller's address.
--
-- The row outlives the account (`ON DELETE SET NULL`), with a copy of the account's identifier
-- and of the owner's address at the time: the proof of the specific approval of articles 1341 and
-- 1342 may be needed after an account is gone, for as long as the invoices it paid are kept. How
-- long it is kept is a question for the lawyer, written in the notes for the lawyer.

CREATE TABLE terms_acceptances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid REFERENCES accounts (id) ON DELETE SET NULL,
  -- The account the acceptance was given for, kept when the account is deleted.
  account_ref       uuid NOT NULL,
  -- The owner's address when the terms were accepted.
  owner_email       text CHECK (owner_email IS NULL OR length(owner_email) BETWEEN 3 AND 320),
  terms_version     text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 100),
  dpa_version       text NOT NULL CHECK (length(dpa_version) BETWEEN 1 AND 100),
  terms_accepted    boolean NOT NULL CHECK (terms_accepted),
  clauses_approved  boolean NOT NULL CHECK (clauses_approved),
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  ip_hash           text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  channel           text NOT NULL CHECK (channel IN ('web', 'cli', 'dashboard'))
);

CREATE INDEX terms_acceptances_account_idx ON terms_acceptances (account_id, accepted_at DESC);

COMMENT ON TABLE terms_acceptances IS
  'One row per acceptance of the terms of service and the DPA by an account: both versions, the '
  'two ticks, the instant, the hash of the caller and the channel (web sign up, terminal, '
  'dashboard), with a copy of the account id and the owner address that survives the account. '
  'Closed; written by signup_confirm and terms_accept_dashboard.';

ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_acceptances FORCE ROW LEVEL SECURITY;

-- --- 7. a sign up carries its acceptance ----------------------------------------------------------
--
-- The ticks happen when the request is made (the form, or `bookrail signup --accept-terms`), and
-- the account exists only when the link is opened. So the request remembers what was accepted,
-- and the confirm writes it next to the account it creates, in the same transaction.

ALTER TABLE signups
  ADD COLUMN terms_version text CHECK (terms_version IS NULL OR length(terms_version) BETWEEN 1 AND 100),
  ADD COLUMN dpa_version text CHECK (dpa_version IS NULL OR length(dpa_version) BETWEEN 1 AND 100),
  ADD COLUMN terms_accepted_at timestamptz,
  ADD CONSTRAINT signups_terms_together
    CHECK ((terms_version IS NULL) = (dpa_version IS NULL)
       AND (terms_version IS NULL) = (terms_accepted_at IS NULL));

COMMENT ON COLUMN signups.terms_version IS
  'The version of the terms accepted with this request, written into terms_acceptances when the '
  'account is created. NULL for a request made before migration 0027.';

-- --- 8. the functions ----------------------------------------------------------------------------

-- 8.1 The writer of `plan.changed`, in the live log of every project of an account.
--
-- Executable by **nobody** but its owner: the definer functions below call it as the owner, and
-- `bookrail-plan` calls it on the owner connection. One writer, so the event has one shape.

CREATE FUNCTION billing_write_plan_changed(
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

COMMENT ON FUNCTION billing_write_plan_changed(uuid, text, text, text, timestamptz, jsonb) IS
  'Writes one plan.changed event in the live log of every project of an account. Called by the '
  'Billing functions of this migration and by bookrail-plan; executable by its owner only.';

-- 8.2 A sign up request that carries the acceptance.
--
-- A new signature beside the one of migration 0026, which is kept for the same reason the
-- one-key `signup_confirm` is: the previous release calls it, and a rollback by symlink must still
-- work. The ceilings are not written twice: this calls the ten-argument version and then records
-- the acceptance on the row it created, in the same transaction.

CREATE FUNCTION signup_start(
  p_id uuid,
  p_email text,
  p_token_hash text,
  p_poll_token_hash text,
  p_client text,
  p_ip_hash text,
  p_account_name text,
  p_project_name text,
  p_default_timezone text,
  p_default_currency text,
  p_terms_version text,
  p_dpa_version text
)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  started record;
BEGIN
  IF coalesce(p_terms_version, '') = '' OR coalesce(p_dpa_version, '') = '' THEN
    RAISE EXCEPTION 'terms_not_accepted' USING ERRCODE = 'P0400';
  END IF;

  SELECT s.id, s.expires_at INTO started
    FROM signup_start(p_id, p_email, p_token_hash, p_poll_token_hash, p_client, p_ip_hash,
                      p_account_name, p_project_name, p_default_timezone,
                      p_default_currency) s;

  UPDATE signups s
     SET terms_version = p_terms_version,
         dpa_version = p_dpa_version,
         terms_accepted_at = now()
   WHERE s.id = started.id;

  RETURN QUERY SELECT started.id, started.expires_at;
END
$$;

COMMENT ON FUNCTION signup_start(uuid, text, text, text, text, text, text, text, text, text, text,
                                 text) IS
  'Records a request for a sign up together with the versions of the terms and of the DPA that '
  'were accepted with it, which the confirm writes next to the account. The ceilings are those '
  'of the ten-argument version, which this calls.';

-- 8.3 The confirm writes the acceptance next to the account.
--
-- Same signature and same answer as migration 0026, so `CREATE OR REPLACE`: the body is that of
-- 0026 with one statement more, inside the subtransaction that creates the account, so that an
-- address already taken leaves no acceptance behind either.

CREATE OR REPLACE FUNCTION signup_confirm(
  p_token_hash text,
  p_account_id uuid,
  p_project_id uuid,
  p_test_key_id uuid,
  p_test_key_prefix text,
  p_test_key_hash text,
  p_test_key_name text,
  p_live_key_id uuid,
  p_live_key_prefix text,
  p_live_key_hash text,
  p_live_key_name text,
  p_pending_secret text
)
RETURNS TABLE (
  id uuid,
  status text,
  client text,
  account_id uuid,
  project_id uuid,
  api_key_id uuid,
  live_api_key_id uuid,
  account_name text,
  project_name text,
  default_timezone text,
  default_currency text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  secret_lifetime constant interval := interval '15 minutes';
  row_signup      signups%ROWTYPE;
  taken           boolean;
  final_status    text;
BEGIN
  SELECT * INTO row_signup FROM signups s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signup_not_found' USING ERRCODE = 'P0404';
  END IF;
  IF row_signup.status <> 'pending' THEN
    RAISE EXCEPTION 'signup_already_confirmed' USING ERRCODE = 'P0409';
  END IF;
  IF row_signup.expires_at < now() THEN
    UPDATE signups s SET status = 'expired' WHERE s.id = row_signup.id;
    RAISE EXCEPTION 'signup_expired' USING ERRCODE = 'P0410';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM accounts a
     WHERE a.origin = 'self_serve' AND a.owner_email = row_signup.email
  ) INTO taken;

  IF taken THEN
    UPDATE signups s
       SET status = 'email_taken', confirmed_at = now()
     WHERE s.id = row_signup.id;
    RETURN QUERY SELECT row_signup.id, 'email_taken'::text, row_signup.client,
                        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
                        row_signup.account_name, row_signup.project_name,
                        row_signup.default_timezone, row_signup.default_currency;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO accounts (id, name, origin, owner_email)
    VALUES (p_account_id, row_signup.account_name, 'self_serve', row_signup.email);

    INSERT INTO projects (id, account_id, name, default_timezone, default_currency)
    VALUES (p_project_id, p_account_id, row_signup.project_name,
            row_signup.default_timezone, row_signup.default_currency);

    INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash,
                          scopes, tenant_id)
    VALUES (p_test_key_id, p_project_id, 'test', 'secret', p_test_key_name, p_test_key_prefix,
            p_test_key_hash, '{}'::text[], NULL),
           (p_live_key_id, p_project_id, 'live', 'secret', p_live_key_name, p_live_key_prefix,
            p_live_key_hash, '{}'::text[], NULL);

    -- The acceptance that came with the request, written next to the account that now exists.
    -- A request made before migration 0027 carries none, and the dashboard asks for one before
    -- the account's first checkout.
    IF row_signup.terms_version IS NOT NULL THEN
      INSERT INTO terms_acceptances (account_id, account_ref, owner_email, terms_version,
                                     dpa_version, terms_accepted, clauses_approved, accepted_at,
                                     ip_hash, channel)
      VALUES (p_account_id, p_account_id, row_signup.email, row_signup.terms_version,
              row_signup.dpa_version, true, true, row_signup.terms_accepted_at, row_signup.ip_hash,
              CASE WHEN row_signup.client = 'cli' THEN 'cli' ELSE 'web' END);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    UPDATE signups s
       SET status = 'email_taken', confirmed_at = now()
     WHERE s.id = row_signup.id;
    RETURN QUERY SELECT row_signup.id, 'email_taken'::text, row_signup.client,
                        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
                        row_signup.account_name, row_signup.project_name,
                        row_signup.default_timezone, row_signup.default_currency;
    RETURN;
  END;

  final_status := CASE WHEN row_signup.client = 'cli' THEN 'confirmed' ELSE 'claimed' END;

  UPDATE signups s
     SET status = final_status,
         confirmed_at = now(),
         account_id = p_account_id,
         project_id = p_project_id,
         api_key_id = p_test_key_id,
         live_api_key_id = p_live_key_id,
         pending_secret = CASE WHEN row_signup.client = 'cli' THEN p_pending_secret END,
         pending_secret_expires_at =
           CASE WHEN row_signup.client = 'cli' THEN now() + secret_lifetime END
   WHERE s.id = row_signup.id;

  RETURN QUERY SELECT row_signup.id, final_status, row_signup.client,
                      p_account_id, p_project_id, p_test_key_id, p_live_key_id,
                      row_signup.account_name, row_signup.project_name,
                      row_signup.default_timezone, row_signup.default_currency;
END
$$;

-- 8.4 An acceptance from the dashboard, before a checkout.

CREATE FUNCTION terms_accept_dashboard(
  p_session_token_hash text,
  p_terms_version text,
  p_dpa_version text,
  p_ip_hash text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (id uuid, account_id uuid, accepted_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now     timestamptz := greatest(coalesce(p_now, now()), now());
  v_account uuid;
  v_email   text;
BEGIN
  SELECT s.account_id, a.owner_email INTO v_account, v_email
    FROM dashboard_sessions s
    JOIN accounts a ON a.id = s.account_id
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'dashboard_session_invalid' USING ERRCODE = 'P0401';
  END IF;

  RETURN QUERY
  INSERT INTO terms_acceptances AS t (account_id, account_ref, owner_email, terms_version,
                                      dpa_version, terms_accepted, clauses_approved, accepted_at,
                                      ip_hash, channel)
  VALUES (v_account, v_account, v_email, p_terms_version, p_dpa_version, true, true, now(),
          p_ip_hash, 'dashboard')
  RETURNING t.id, t.account_id, t.accepted_at;
END
$$;

COMMENT ON FUNCTION terms_accept_dashboard(text, text, text, text, timestamptz) IS
  'Records that the account of a live dashboard session accepted these versions of the terms and '
  'of the DPA, with both ticks. Refuses with P0401 when the session is not live.';

-- 8.5 What the dashboard needs to know about billing: the account, its customer, its
-- subscription, and whether it has accepted the versions in force.

CREATE FUNCTION billing_account_state(
  p_session_token_hash text,
  p_terms_version text,
  p_dpa_version text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  account_id uuid,
  account_name text,
  owner_email text,
  plan text,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  subscription_plan text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  scheduled_plan text,
  past_due_since timestamptz,
  terms_accepted_at timestamptz,
  subscription_live boolean,
  checkout_session_id text,
  unpaid_invoice_id text,
  unpaid_invoice_number text,
  unpaid_amount_due bigint,
  unpaid_currency text,
  unpaid_invoice_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.owner_email, a.plan, a.stripe_customer_id,
         b.stripe_subscription_id, b.status, b.plan, b.current_period_end,
         b.cancel_at_period_end, b.scheduled_plan, b.past_due_since,
         (SELECT max(t.accepted_at)
            FROM terms_acceptances t
           WHERE t.account_id = a.id
             AND t.terms_version = p_terms_version
             AND t.dpa_version = p_dpa_version),
         billing_subscription_is_live(b.status),
         a.stripe_checkout_session_id,
         u.stripe_invoice_id, u.number, u.amount_due, u.currency, u.hosted_invoice_url
    FROM dashboard_sessions s
    JOIN accounts a ON a.id = s.account_id
    LEFT JOIN billing_subscriptions b ON b.account_id = a.id
    LEFT JOIN LATERAL (
      SELECT i.stripe_invoice_id, i.number, i.amount_due, i.currency, i.hosted_invoice_url
        FROM billing_unpaid_invoices i
       WHERE i.account_id = a.id AND i.settled_at IS NULL
       ORDER BY i.recorded_at DESC, i.stripe_invoice_id
       LIMIT 1
    ) u ON true
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > greatest(coalesce(p_now, now()), now())
$$;

COMMENT ON FUNCTION billing_account_state(text, text, text, timestamptz) IS
  'The billing state of the account of a live dashboard session: plan, Stripe customer, '
  'subscription and whether it is live, the last checkout session, and the last acceptance of '
  'the given versions of the terms and the DPA. Zero rows for a session that is not live.';

-- 8.5b The checkout session of an account, one at a time.
--
-- Records the session just opened and answers the one it replaces, if any, so that the API
-- expires it: of two sessions opened at once by two tabs, the second to be recorded expires the
-- first. The row lock on the account orders them.

CREATE FUNCTION billing_checkout_record(
  p_session_token_hash text,
  p_stripe_session_id text,
  p_now timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now      timestamptz := greatest(coalesce(p_now, now()), now());
  v_account  uuid;
  v_previous text;
BEGIN
  SELECT s.account_id INTO v_account
    FROM dashboard_sessions s
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'dashboard_session_invalid' USING ERRCODE = 'P0401';
  END IF;

  SELECT a.stripe_checkout_session_id INTO v_previous
    FROM accounts a WHERE a.id = v_account FOR UPDATE;
  UPDATE accounts a
     SET stripe_checkout_session_id = p_stripe_session_id, updated_at = now()
   WHERE a.id = v_account;
  RETURN CASE WHEN v_previous = p_stripe_session_id THEN NULL ELSE v_previous END;
END
$$;

COMMENT ON FUNCTION billing_checkout_record(text, text, timestamptz) IS
  'Records the Checkout Session just opened for the account of a live dashboard session and '
  'returns the one it replaces, which the caller expires at Stripe. P0401 for a session that is '
  'not live.';

-- 8.6 The customer of an account, set once.
--
-- The API creates the customer at Stripe with an idempotency key derived from the account, and
-- then records it here. Two checkouts opened at once create one customer at Stripe (the same key)
-- and one row here; the first identifier recorded is the one that stays, and the answer is always
-- the identifier in force.

CREATE FUNCTION billing_customer_bind(
  p_session_token_hash text,
  p_stripe_customer_id text,
  p_now timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now      timestamptz := greatest(coalesce(p_now, now()), now());
  v_account  uuid;
  v_customer text;
BEGIN
  SELECT s.account_id INTO v_account
    FROM dashboard_sessions s
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'dashboard_session_invalid' USING ERRCODE = 'P0401';
  END IF;

  UPDATE accounts a
     SET stripe_customer_id = p_stripe_customer_id, updated_at = now()
   WHERE a.id = v_account AND a.stripe_customer_id IS NULL;

  SELECT a.stripe_customer_id INTO v_customer FROM accounts a WHERE a.id = v_account;
  RETURN v_customer;
END
$$;

COMMENT ON FUNCTION billing_customer_bind(text, text, timestamptz) IS
  'Records the Stripe customer of the account of a live dashboard session when it has none, and '
  'returns the customer in force. Refuses with P0401 when the session is not live.';

-- 8.7 The claim of an event, and its settlement.

CREATE FUNCTION billing_event_claim(p_event_id text, p_type text, p_livemode boolean)
RETURNS TABLE (id uuid, duplicate boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO billing_events (stripe_event_id, type, livemode)
  VALUES (p_event_id, p_type, p_livemode)
  ON CONFLICT (stripe_event_id) DO NOTHING;

  RETURN QUERY
  SELECT e.id, e.processed_at IS NOT NULL
    FROM billing_events e
   WHERE e.stripe_event_id = p_event_id;
END
$$;

COMMENT ON FUNCTION billing_event_claim(text, text, boolean) IS
  'Records a Billing event once and says whether it had already been processed. An event that '
  'was recorded and not processed (a previous attempt failed) is not a duplicate.';

CREATE FUNCTION billing_event_settle(p_id uuid, p_outcome text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE billing_events
     SET processed_at = now(), outcome = p_outcome
   WHERE id = p_id AND processed_at IS NULL
$$;

COMMENT ON FUNCTION billing_event_settle(uuid, text) IS
  'Marks a Billing event processed, once, with its outcome.';

-- 8.8 A subscription, as Stripe says it is now, applied to its account.
--
-- The account is the one whose customer the subscription belongs to. `p_account_reference` is
-- the account the checkout was opened for (`client_reference_id`, or the metadata of the
-- subscription), and it is **verified**: a customer bound to one account and a reference to
-- another is a mismatch, and nothing is applied.
--
-- The plan of the account follows the status:
--
--   active, trialing                       the plan of the price
--   past_due, incomplete                   unchanged (a failed payment has its fourteen days;
--                                          a first payment still in progress changes nothing)
--   canceled, unpaid, incomplete_expired,  free
--   paused
--
-- A subscription other than the one on file:
--
--   both live                  `duplicate_subscription`: nothing is applied, the second one is
--                              recorded, and the caller reports it (the first report of each
--                              duplicate says `first_notice`), for a person to cancel and refund;
--   it is dead, the file live  `stale`: the late death of an old subscription does not take the
--                              plan away from the live one;
--   otherwise                  it replaces the one on file.
--
-- When the subscription on file ends while a duplicate is recorded, the answer names the
-- duplicate (`other_subscription_id`), for the caller to read it back and apply it.

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
  p_at timestamptz
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
  first_notice boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account       accounts%ROWTYPE;
  v_row           billing_subscriptions%ROWTYPE;
  v_has_row       boolean;
  v_target        text;
  v_reason        text;
  v_was_past_due  boolean;
  v_first         boolean;
  v_duplicate     text;
BEGIN
  SELECT * INTO v_account FROM accounts a
   WHERE a.stripe_customer_id = p_stripe_customer_id
     FOR UPDATE;

  IF NOT FOUND THEN
    IF p_account_reference IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'unmatched'::text, NULL::text, NULL::text, NULL::text,
                          NULL::text, NULL::text, NULL::text, false;
      RETURN;
    END IF;
    -- The customer is not bound yet: bind it to the referenced account, if that account has no
    -- customer of its own.
    UPDATE accounts a
       SET stripe_customer_id = p_stripe_customer_id, updated_at = now()
     WHERE a.id = p_account_reference AND a.stripe_customer_id IS NULL;
    SELECT * INTO v_account FROM accounts a
     WHERE a.id = p_account_reference AND a.stripe_customer_id = p_stripe_customer_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT p_account_reference, 'mismatch'::text, NULL::text, NULL::text,
                          NULL::text, NULL::text, NULL::text, NULL::text, false;
      RETURN;
    END IF;
  ELSIF p_account_reference IS NOT NULL AND p_account_reference <> v_account.id THEN
    RETURN QUERY SELECT v_account.id, 'mismatch'::text, NULL::text, NULL::text, NULL::text,
                        NULL::text, NULL::text, NULL::text, false;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM billing_subscriptions b WHERE b.account_id = v_account.id FOR UPDATE;
  v_has_row := FOUND;

  IF v_has_row AND v_row.stripe_subscription_id <> p_stripe_subscription_id
     AND billing_subscription_is_live(v_row.status) THEN
    IF billing_subscription_is_live(p_status) THEN
      -- Two live subscriptions for one account: two checkouts were paid. Never swap one for the
      -- other in silence; keep the one on file and report the second.
      v_first := v_row.duplicate_subscription_id IS DISTINCT FROM p_stripe_subscription_id;
      UPDATE billing_subscriptions b
         SET duplicate_subscription_id = p_stripe_subscription_id
       WHERE b.account_id = v_account.id;
      RETURN QUERY SELECT v_account.id, 'duplicate_subscription'::text, v_account.plan,
                          v_account.plan, NULL::text, v_account.owner_email, v_account.name,
                          v_row.stripe_subscription_id, v_first;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_account.id, 'stale'::text, v_account.plan, v_account.plan, NULL::text,
                        v_account.owner_email, v_account.name, v_row.stripe_subscription_id,
                        false;
    RETURN;
  END IF;

  IF p_plan IS NULL AND NOT v_has_row THEN
    RETURN QUERY SELECT v_account.id, 'unknown_price'::text, v_account.plan, v_account.plan,
                        NULL::text, v_account.owner_email, v_account.name, NULL::text, false;
    RETURN;
  END IF;

  v_was_past_due := v_has_row AND v_row.stripe_subscription_id = p_stripe_subscription_id
                    AND v_row.past_due_since IS NOT NULL;
  -- The subscription on file has ended while a duplicate was recorded: the caller reads the
  -- duplicate back and applies it at once, instead of waiting for its next event.
  v_duplicate := CASE
    WHEN v_has_row AND v_row.stripe_subscription_id = p_stripe_subscription_id
         AND NOT billing_subscription_is_live(p_status)
    THEN v_row.duplicate_subscription_id
  END;

  IF NOT v_has_row THEN
    INSERT INTO billing_subscriptions (account_id, stripe_subscription_id, plan, status,
                                       current_period_end, cancel_at_period_end, scheduled_plan,
                                       past_due_since, previous_plan, plan_since, sdi_or_pec)
    VALUES (v_account.id, p_stripe_subscription_id, p_plan, p_status, p_current_period_end,
            coalesce(p_cancel_at_period_end, false), p_scheduled_plan,
            CASE WHEN p_status = 'past_due' THEN p_at END,
            v_account.plan, p_at, p_sdi_or_pec);
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
           sdi_or_pec = coalesce(p_sdi_or_pec, b.sdi_or_pec),
           duplicate_subscription_id = CASE
             WHEN b.stripe_subscription_id <> p_stripe_subscription_id THEN NULL
             ELSE b.duplicate_subscription_id
           END
     WHERE b.account_id = v_account.id;
  END IF;

  -- The plan the account should now be on.
  IF p_status IN ('active', 'trialing') THEN
    v_target := coalesce(p_plan, v_row.plan);
  ELSIF p_status IN ('past_due', 'incomplete') THEN
    v_target := v_account.plan;
  ELSE
    v_target := 'free';
  END IF;

  -- A contract is not a subscription: nothing Stripe says moves an account off enterprise.
  IF v_account.plan = 'enterprise' OR v_target = v_account.plan THEN
    RETURN QUERY SELECT v_account.id,
                        CASE WHEN v_account.plan = 'enterprise' AND v_target <> 'enterprise'
                             THEN 'enterprise_untouched' ELSE 'unchanged' END,
                        v_account.plan, v_account.plan, NULL::text,
                        v_account.owner_email, v_account.name, v_duplicate, false;
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
  -- The history the overage of a closed month reads: which plan served until when.
  UPDATE billing_subscriptions b
     SET previous_plan = v_account.plan, plan_since = p_at
   WHERE b.account_id = v_account.id;
  PERFORM billing_write_plan_changed(v_account.id, v_account.plan, v_target, v_reason, p_at,
                                     '{"type": "provider", "id": null}'::jsonb);

  RETURN QUERY SELECT v_account.id, 'changed'::text, v_account.plan, v_target, v_reason,
                      v_account.owner_email, v_account.name, v_duplicate, false;
END
$$;

COMMENT ON FUNCTION billing_subscription_apply(text, text, uuid, text, text, timestamptz, boolean,
                                               text, text, timestamptz) IS
  'Applies the state of a Stripe subscription to the account of its customer: the subscription '
  'row, and the plan of the account (active or trialing: the plan of the price; past_due or '
  'incomplete: unchanged; otherwise free), with one plan.changed event per project in the same '
  'transaction. A second live subscription is never applied. Outcome: changed, unchanged, '
  'unmatched, mismatch, stale, duplicate_subscription, unknown_price or enterprise_untouched.';

-- 8.9 A failed payment: the start of the fourteen days, once per period.

CREATE FUNCTION billing_payment_failed(
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
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
  SELECT b.* INTO v_row
    FROM billing_subscriptions b
    JOIN accounts a ON a.id = b.account_id
   WHERE b.stripe_subscription_id = p_stripe_subscription_id
     AND a.stripe_customer_id = p_stripe_customer_id
     FOR UPDATE OF b;
  IF NOT FOUND OR v_row.status IN ('incomplete', 'incomplete_expired', 'canceled') THEN
    RETURN;
  END IF;

  v_first := v_row.past_due_since IS NULL;
  IF v_first THEN
    UPDATE billing_subscriptions b SET past_due_since = p_at WHERE b.id = v_row.id;
    v_row.past_due_since := p_at;
  END IF;

  RETURN QUERY
  SELECT a.id, a.owner_email, a.name, v_first, v_row.past_due_since,
         v_row.past_due_since + grace
    FROM accounts a
   WHERE a.id = v_row.account_id;
END
$$;

COMMENT ON FUNCTION billing_payment_failed(text, text, timestamptz) IS
  'Records the first failed payment of the current period of a subscription (it stays until the '
  'subscription is active again) and returns the account, whether this was the first failure, '
  'and the end of the fourteen days of grace.';

-- 8.10 The usage of an account in a month, across its projects, without a project in context.
--
-- The arithmetic of `plan_usage_for_account` of migration 0025, without its guard on
-- `app.project_id`: here the account comes from a signed Stripe event, not from a request of one
-- of its projects. A test computes both on the same data.

CREATE FUNCTION billing_usage_for_month(p_account_id uuid, p_month text)
RETURNS TABLE (bookings_confirmed bigint, payment_volume bigint, currency text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(u.bookings_confirmed), 0)::bigint,
         COALESCE(sum(u.payment_volume), 0)::bigint,
         CASE count(DISTINCT u.currency)
           WHEN 0 THEN NULL
           WHEN 1 THEN min(u.currency)
           ELSE 'mixed'
         END
    FROM plan_usage u
    JOIN projects p ON p.id = u.project_id
   WHERE p.account_id = p_account_id
     AND u.environment = 'live'
     AND u.month = p_month
$$;

COMMENT ON FUNCTION billing_usage_for_month(uuid, text) IS
  'The confirmed live bookings and the net paid volume of every project of an account in one UTC '
  'month, as one row, for the overage of a renewal. The arithmetic of plan_usage_for_account, '
  'without its guard on the project in context.';

-- 8.11 What the overage of a closed month is computed from.
--
-- The account of the customer and the plan it is on now (an `enterprise` account is billed by
-- contract and gets no overage, even with a subscription left over), the plan that served the
-- last day of the month (see `billing_subscriptions`), and the month's usage. The caller computes
-- the amounts from the prices, which live in the code, and claims them with 8.12.

CREATE FUNCTION billing_overage_context(
  p_stripe_customer_id text,
  p_month text,
  p_month_end timestamptz
)
RETURNS TABLE (
  account_id uuid,
  account_plan text,
  plan text,
  bookings_confirmed bigint,
  payment_volume bigint,
  currency text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.plan,
         CASE WHEN b.plan_since < p_month_end THEN b.plan ELSE b.previous_plan END,
         u.bookings_confirmed, u.payment_volume, u.currency
    FROM accounts a
    JOIN billing_subscriptions b ON b.account_id = a.id
   CROSS JOIN LATERAL billing_usage_for_month(a.id, p_month) u
   WHERE a.stripe_customer_id = p_stripe_customer_id
$$;

COMMENT ON FUNCTION billing_overage_context(text, text, timestamptz) IS
  'The account of a Stripe customer and its plan now, the plan that served the last instant '
  'before p_month_end, and the usage of the month: what the overage of a closed month is '
  'computed from.';

-- 8.12 The claim of a month's overage, before Stripe is called, and everything after it.
--
-- `billing_overage_claim` writes the row once and answers it; `claimed` is true for the one
-- caller that wrote it, which holds a lease of ten minutes and is the only one that goes on to
-- Stripe. `billing_overage_take` gives the daily reconciliation the claims whose lease has run
-- out without being settled (a process that died halfway), with a new lease each.
-- `billing_overage_settle` records each Stripe item as it is created, and closes the claim.
--
-- The three answer the same row, which is what the lines are built from.

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
  p_payments_per_mille integer,
  p_payments_amount bigint,
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
  v_over    bigint := greatest(0, p_bookings_confirmed - p_bookings_included);
  v_new     uuid;
BEGIN
  INSERT INTO billing_overages AS o (account_id, month, plan, origin, stripe_invoice_id,
                                     bookings_confirmed, bookings_included,
                                     bookings_over, booking_unit_amount, bookings_amount,
                                     payment_volume, payments_per_mille, payments_amount,
                                     volume_currency, status, leased_until)
  VALUES (p_account_id, p_month, p_plan, p_origin, p_stripe_invoice_id,
          p_bookings_confirmed, p_bookings_included, v_over, p_booking_unit_amount,
          v_over * p_booking_unit_amount, p_payment_volume, p_payments_per_mille,
          p_payments_amount, p_volume_currency,
          CASE WHEN v_over * p_booking_unit_amount = 0 AND p_payments_amount = 0
               THEN 'nothing_due' ELSE 'claimed' END,
          now() + interval '10 minutes')
  ON CONFLICT ON CONSTRAINT billing_overages_account_id_month_key DO NOTHING
  RETURNING o.id INTO v_new;

  RETURN QUERY
  SELECT o.id, v_new IS NOT NULL, o.account_id, a.stripe_customer_id, o.month, o.plan, o.origin,
         o.status, o.placement, o.stripe_invoice_id, o.attempts, o.leased_until, o.bookings_included,
         o.bookings_over, o.booking_unit_amount, o.bookings_amount, o.payment_volume,
         o.payments_per_mille, o.payments_amount, o.stripe_booking_item_id,
         o.stripe_payment_item_id
    FROM billing_overages o
    JOIN accounts a ON a.id = o.account_id
   WHERE o.account_id = p_account_id AND o.month = p_month;
END
$$;

COMMENT ON FUNCTION billing_overage_claim(uuid, text, text, text, text, bigint, bigint, integer,
                                          bigint, integer, bigint, text) IS
  'Claims the overage of one account and one month, once: the first call writes the row with a '
  'lease of ten minutes and answers claimed = true; every later call answers the row as it is, '
  'claimed = false. A month with nothing to bill is recorded as nothing_due.';

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
         l.payments_per_mille, l.payments_amount, l.stripe_booking_item_id,
         l.stripe_payment_item_id
    FROM leased l
    JOIN accounts a ON a.id = l.account_id
   ORDER BY l.claimed_at;
END
$$;

COMMENT ON FUNCTION billing_overage_take(integer, uuid) IS
  'The claims of overage left open by a caller that did not finish, whose lease has run out '
  '(all of them, or the one of p_id): each is leased again for ten minutes, its attempts counted, '
  'and answered, for the reconciliation or a redelivery to finish.';

CREATE FUNCTION billing_overage_settle(
  p_id uuid,
  p_placement text,
  p_stripe_invoice_id text,
  p_stripe_booking_item_id text,
  p_stripe_payment_item_id text,
  p_done boolean
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE billing_overages
     SET placement = coalesce(p_placement, placement),
         stripe_invoice_id = coalesce(p_stripe_invoice_id, stripe_invoice_id),
         stripe_booking_item_id = coalesce(stripe_booking_item_id, p_stripe_booking_item_id),
         stripe_payment_item_id = coalesce(stripe_payment_item_id, p_stripe_payment_item_id),
         status = CASE WHEN p_done THEN 'applied' ELSE status END,
         applied_at = CASE WHEN p_done THEN now() ELSE applied_at END,
         leased_until = CASE WHEN p_done THEN NULL ELSE leased_until END
   WHERE id = p_id AND status = 'claimed'
$$;

COMMENT ON FUNCTION billing_overage_settle(uuid, text, text, text, text, boolean) IS
  'Records the Stripe invoice items of a claimed overage as they are created (an item already '
  'recorded is never replaced, so a retry skips it), the invoice they went on, and marks the '
  'overage applied when done.';

-- 8.13 A paid invoice, recorded once.

CREATE FUNCTION billing_invoice_record(
  p_stripe_invoice_id text,
  p_stripe_customer_id text,
  p_number text,
  p_hosted_invoice_url text,
  p_paid_at timestamptz,
  p_currency text,
  p_customer_name text,
  p_customer_email text,
  p_tax_id_type text,
  p_tax_id_value text,
  p_tax_id_verification text,
  p_country text,
  p_address jsonb,
  p_vat_treatment text,
  p_lines jsonb,
  p_subtotal bigint,
  p_tax bigint,
  p_total bigint
)
RETURNS TABLE (
  id uuid,
  recorded boolean,
  account_id uuid,
  sdi_or_pec text,
  mailed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_sdi     text;
  v_new     uuid;
BEGIN
  SELECT a.id, b.sdi_or_pec INTO v_account, v_sdi
    FROM accounts a
    LEFT JOIN billing_subscriptions b ON b.account_id = a.id
   WHERE a.stripe_customer_id = p_stripe_customer_id;

  INSERT INTO billing_invoices AS i (account_id, stripe_invoice_id, stripe_customer_id, number,
                                     hosted_invoice_url, paid_at, currency, customer_name,
                                     customer_email, tax_id_type, tax_id_value,
                                     tax_id_verification, country, address, sdi_or_pec,
                                     vat_treatment, lines, subtotal, tax, total)
  VALUES (v_account, p_stripe_invoice_id, p_stripe_customer_id, p_number, p_hosted_invoice_url,
          p_paid_at, p_currency, p_customer_name, p_customer_email, p_tax_id_type, p_tax_id_value,
          p_tax_id_verification, p_country, coalesce(p_address, '{}'::jsonb), v_sdi,
          p_vat_treatment, p_lines, p_subtotal, p_tax, p_total)
  ON CONFLICT (stripe_invoice_id) DO NOTHING
  RETURNING i.id INTO v_new;

  RETURN QUERY
  SELECT i.id, v_new IS NOT NULL, i.account_id, i.sdi_or_pec, i.mailed_at IS NOT NULL
    FROM billing_invoices i
   WHERE i.stripe_invoice_id = p_stripe_invoice_id;
END
$$;

COMMENT ON FUNCTION billing_invoice_record(text, text, text, text, timestamptz, text, text, text,
                                           text, text, text, text, jsonb, text, jsonb, bigint,
                                           bigint, bigint) IS
  'Records a paid invoice once, with the data of the electronic invoice, and says whether it is '
  'new and whether its message has been sent.';

CREATE FUNCTION billing_invoice_mailed(p_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE billing_invoices SET mailed_at = now() WHERE id = p_id AND mailed_at IS NULL
$$;

COMMENT ON FUNCTION billing_invoice_mailed(uuid) IS
  'Marks the message with the data of a paid invoice as sent.';

-- 8.14 The paid invoices of a month, in the calendar of the Italian accounts (Europe/Rome).

CREATE FUNCTION billing_invoices_of_month(p_month text)
RETURNS TABLE (
  stripe_invoice_id text,
  number text,
  paid_at timestamptz,
  customer_name text,
  tax_id_value text,
  tax_id_verification text,
  country text,
  sdi_or_pec text,
  vat_treatment text,
  currency text,
  subtotal bigint,
  tax bigint,
  total bigint,
  hosted_invoice_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.stripe_invoice_id, i.number, i.paid_at, i.customer_name, i.tax_id_value,
         i.tax_id_verification, i.country, i.sdi_or_pec, i.vat_treatment, i.currency,
         i.subtotal, i.tax, i.total, i.hosted_invoice_url
    FROM billing_invoices i
   WHERE to_char(i.paid_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM') = p_month
   ORDER BY i.paid_at, i.stripe_invoice_id
$$;

COMMENT ON FUNCTION billing_invoices_of_month(text) IS
  'The paid invoices of one month of the Europe/Rome calendar, oldest first: the monthly list '
  'of electronic invoices to issue.';

-- 8.15 The subscriptions the daily job cancels at Stripe.
--
-- Past due for more than fourteen days, compared with the database's own `now()`; and every
-- `unpaid` or `paused` one, which are dead (the account is already on the free plan) but would
-- otherwise stay at Stripe and keep invoicing.

CREATE FUNCTION billing_overdue_subscriptions()
RETURNS TABLE (
  account_id uuid,
  stripe_subscription_id text,
  status text,
  past_due_since timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.account_id, b.stripe_subscription_id, b.status, b.past_due_since
    FROM billing_subscriptions b
   WHERE (b.status = 'past_due' AND b.past_due_since < now() - interval '14 days')
      OR b.status IN ('unpaid', 'paused')
   ORDER BY b.past_due_since NULLS LAST, b.stripe_subscription_id
$$;

COMMENT ON FUNCTION billing_overdue_subscriptions() IS
  'The subscriptions the worker cancels at Stripe: past due for more than fourteen days, and '
  'every unpaid or paused one. The cancellation, read back from Stripe, moves the account to '
  'the free plan.';

-- 8.16 The subscriptions the daily reconciliation reads back from Stripe.
--
-- Every subscription the database holds as live: if an event about it was lost, reading it back
-- and applying it with the receiver's own code puts the account where Stripe says it is.

CREATE FUNCTION billing_live_subscriptions()
RETURNS TABLE (account_id uuid, stripe_subscription_id text, stripe_customer_id text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.account_id, b.stripe_subscription_id, a.stripe_customer_id, b.status
    FROM billing_subscriptions b
    JOIN accounts a ON a.id = b.account_id
   WHERE billing_subscription_is_live(b.status)
  UNION ALL
  -- A recorded duplicate is read back too: it may be the one that is still taking money.
  SELECT b.account_id, b.duplicate_subscription_id, a.stripe_customer_id, 'duplicate'
    FROM billing_subscriptions b
    JOIN accounts a ON a.id = b.account_id
   WHERE b.duplicate_subscription_id IS NOT NULL
$$;

COMMENT ON FUNCTION billing_live_subscriptions() IS
  'Every subscription the database holds as live, and every recorded duplicate (status '
  'duplicate), with its customer: what the daily reconciliation reads back from Stripe.';

-- 8.17 The account of a Stripe customer, for a notice about its fiscal data.

CREATE FUNCTION billing_customer_account(p_stripe_customer_id text)
RETURNS TABLE (
  account_id uuid,
  account_name text,
  account_plan text,
  stripe_subscription_id text,
  subscription_status text,
  subscription_live boolean,
  subscription_created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.plan, b.stripe_subscription_id, b.status,
         billing_subscription_is_live(b.status), greatest(b.created_at, b.plan_since)
    FROM accounts a
    LEFT JOIN billing_subscriptions b ON b.account_id = a.id
   WHERE a.stripe_customer_id = p_stripe_customer_id
$$;

COMMENT ON FUNCTION billing_customer_account(text) IS
  'The account of a Stripe customer, with its subscription and whether it is live: whether a '
  'change of the fiscal data of the customer has to be reported.';

-- 8.18 The invoices left unpaid by a subscription closed for non payment.

CREATE FUNCTION billing_unpaid_invoice_record(
  p_stripe_customer_id text,
  p_stripe_invoice_id text,
  p_number text,
  p_amount_due bigint,
  p_currency text,
  p_hosted_invoice_url text
)
RETURNS TABLE (account_id uuid, recorded boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_new     text;
BEGIN
  SELECT a.id INTO v_account FROM accounts a WHERE a.stripe_customer_id = p_stripe_customer_id;
  IF v_account IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO billing_unpaid_invoices AS i (stripe_invoice_id, account_id, number, amount_due,
                                            currency, hosted_invoice_url)
  VALUES (p_stripe_invoice_id, v_account, p_number, p_amount_due, lower(p_currency),
          p_hosted_invoice_url)
  ON CONFLICT ON CONSTRAINT billing_unpaid_invoices_pkey DO NOTHING
  RETURNING i.stripe_invoice_id INTO v_new;
  RETURN QUERY SELECT v_account, v_new IS NOT NULL;
END
$$;

COMMENT ON FUNCTION billing_unpaid_invoice_record(text, text, text, bigint, text, text) IS
  'Records an invoice left open by a subscription closed for non payment, once, for the account '
  'of the customer. Nothing for a customer no account has.';

CREATE FUNCTION billing_unpaid_invoice_settle(p_stripe_invoice_id text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  settled integer;
BEGIN
  UPDATE billing_unpaid_invoices i
     SET settled_at = now()
   WHERE i.stripe_invoice_id = p_stripe_invoice_id AND i.settled_at IS NULL;
  GET DIAGNOSTICS settled = ROW_COUNT;
  RETURN settled;
END
$$;

COMMENT ON FUNCTION billing_unpaid_invoice_settle(text) IS
  'Marks an unpaid invoice as no longer due (paid, voided or uncollectible). Answers 1 or 0.';

-- --- privileges ---------------------------------------------------------------------------------
--
-- `EXECUTE` on the functions to the application role, and nothing on the tables. The writer of
-- the events is executable by its owner alone. `billing_subscription_is_live` reads nothing and
-- is not a definer; it is granted like the others so that nobody else calls into this family.

REVOKE ALL ON FUNCTION billing_write_plan_changed(uuid, text, text, text, timestamptz, jsonb)
  FROM PUBLIC;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'signup_start(uuid, text, text, text, text, text, text, text, text, text, text, text)',
    'signup_confirm(text, uuid, uuid, uuid, text, text, text, uuid, text, text, text, text)',
    'terms_accept_dashboard(text, text, text, text, timestamptz)',
    'billing_account_state(text, text, text, timestamptz)',
    'billing_customer_bind(text, text, timestamptz)',
    'billing_checkout_record(text, text, timestamptz)',
    'billing_event_claim(text, text, boolean)',
    'billing_event_settle(uuid, text)',
    'billing_subscription_apply(text, text, uuid, text, text, timestamptz, boolean, text, text, timestamptz)',
    'billing_payment_failed(text, text, timestamptz)',
    'billing_usage_for_month(uuid, text)',
    'billing_overage_context(text, text, timestamptz)',
    'billing_overage_claim(uuid, text, text, text, text, bigint, bigint, integer, bigint, integer, bigint, text)',
    'billing_overage_take(integer, uuid)',
    'billing_overage_settle(uuid, text, text, text, text, boolean)',
    'billing_invoice_record(text, text, text, text, timestamptz, text, text, text, text, text, text, text, jsonb, text, jsonb, bigint, bigint, bigint)',
    'billing_invoice_mailed(uuid)',
    'billing_invoices_of_month(text)',
    'billing_overdue_subscriptions()',
    'billing_live_subscriptions()',
    'billing_customer_account(text)',
    'billing_unpaid_invoice_record(text, text, text, bigint, text, text)',
    'billing_unpaid_invoice_settle(text)',
    'billing_subscription_is_live(text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
