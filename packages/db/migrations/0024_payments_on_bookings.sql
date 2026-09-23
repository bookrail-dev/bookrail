-- 0024: the deposit, the balance and the refund on a booking (brief 009b).
--
-- Migration 0023 gave a project a Stripe account to charge on. This one gives it the rows that
-- record what was charged, what came back, and what is still owed, plus the two things a
-- payment flow needs that no table had: a way to dedupe an incoming provider event, and a queue
-- of calls the worker still owes the provider.
--
-- ## The rule the whole shape serves
--
-- `bookings.amount_paid`, `amount_due` and `amount_refunded` change in exactly two places: the
-- creation of a booking (which sets `amount_due` and nothing else) and the webhook receiver,
-- **after** a verified `Stripe-Signature`. No route accepts them, no worker writes them, and
-- nothing in this schema lets a caller set them. That is invariant 9 of `04-modello-dati.md`,
-- and everything below exists so that it can be true.
--
-- ## Why `payments` can take a NOT NULL column with no default
--
-- `provider_account_id` is added `NOT NULL` without a default, which is normally a migration
-- that fails on the first row it meets. The table is empty in every database that exists,
-- production included: nothing has ever written a `payments` row, because until this brief no
-- code did. Verified on the development database before the migration was written, and stated
-- here so that a reader of the ledger in two years does not have to guess why it was allowed.
--
-- ## No `provider_client_secret`
--
-- A PaymentIntent's `client_secret` completes a payment from a front end. It is handed to the
-- caller once, in the body of `POST /v1/bookings`, and it is read back from Stripe by
-- `GET /v1/payments/{id}`. It is in no column here, in no log line and in no
-- `idempotency_keys` row, for the reason migration 0012 keeps a webhook signing secret out of
-- the same places: a secret that is written down is a secret that has to be protected for as
-- long as the row lives, in exchange for saving one HTTP request.
--
-- ## The pending action queue lives on the payment row
--
-- `cancel_intent` and `create_refund` are calls Bookrail owes Stripe as a consequence of a
-- transaction that has already committed (a cancellation, an expiry). They cannot be made
-- inside that transaction: a Postgres transaction that waits on somebody else's network is a
-- lock held for as long as that network takes, and the booking transaction holds advisory locks
-- on every candidate resource of a service. So the intent to call is written as four columns on
-- the row the call is about, and the worker drains them. One queue, no second table, and the
-- state of the call is next to the state of the money.

-- --- payments ---------------------------------------------------------------------------------

ALTER TABLE payments
  -- The `acct_...` the intent lives on. A PaymentIntent of a connected account is invisible
  -- without it: every call about it carries `Stripe-Account: acct_...`, so a row that did not
  -- record which account it belongs to would be a row nothing could act on again.
  ADD COLUMN provider_account_id text NOT NULL,
  -- The refund that this row is a refund of. Composite, against the composite unique of 0004,
  -- so a refund can never point at a payment of another project or of the other environment.
  ADD COLUMN parent_payment_id uuid,
  ADD COLUMN amount_refunded integer NOT NULL DEFAULT 0,
  -- The last failure Stripe reported for this intent, for a human and for a support ticket.
  -- The message is Stripe's own, written for the payer, and capped: it is shown in an API
  -- response and in a terminal.
  ADD COLUMN failure_code text,
  ADD COLUMN failure_message text,
  -- The worker's queue. `pending_action_next_at` carries the instant from which the worker may
  -- act, written by whoever queues the action; NULL with an action still set is the one and
  -- only mark of a ladder that ran out: twenty attempts, and nothing will try again without a
  -- person.
  ADD COLUMN pending_action text,
  ADD COLUMN pending_action_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN pending_action_next_at timestamptz,
  ADD COLUMN pending_action_error text;

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_non_negative CHECK (amount >= 0),
  -- The same shape migration 0023 pins on the connection, for the same reason: this value goes
  -- into the `Stripe-Account` header of every call made about this payment.
  ADD CONSTRAINT payments_provider_account_shape
    CHECK (provider_account_id ~ '^acct_[A-Za-z0-9]+$' AND length(provider_account_id) <= 255),
  ADD CONSTRAINT payments_amount_refunded_bounded
    CHECK (amount_refunded >= 0 AND amount_refunded <= amount),
  ADD CONSTRAINT payments_failure_message_length CHECK (length(failure_message) <= 500),
  ADD CONSTRAINT payments_pending_action_known
    CHECK (pending_action IN ('cancel_intent', 'create_refund')),
  ADD CONSTRAINT payments_pending_action_attempts_non_negative
    CHECK (pending_action_attempts >= 0),
  ADD CONSTRAINT payments_parent_scope
    FOREIGN KEY (parent_payment_id, project_id, environment)
    REFERENCES payments (id, project_id, environment) ON DELETE RESTRICT;

-- The worker reads exactly this set and nothing else, so the index is the set. A row whose
-- ladder ran out keeps its NULL here and is still in the index, which is what lets the
-- diagnostic query for abandoned rows use it too.
CREATE INDEX payments_pending_action_idx
  ON payments (pending_action_next_at)
  WHERE pending_action IS NOT NULL;

CREATE INDEX payments_parent_idx ON payments (parent_payment_id);

COMMENT ON COLUMN payments.provider_account_id IS
  'The connected account this payment lives on (acct_... for Stripe). An identifier, not a '
  'secret: it travels as the Stripe-Account header.';
COMMENT ON COLUMN payments.parent_payment_id IS
  'For a row of type refund: the payment it gives back. NULL for everything else.';
COMMENT ON COLUMN payments.amount_refunded IS
  'How much of this payment has come back, cumulative. Written only by the webhook receiver, '
  'from the amount Stripe reports on the charge, which is itself cumulative.';
COMMENT ON COLUMN payments.pending_action IS
  'A call this row still owes Stripe: cancel its intent, or create its refund. Drained by the '
  'payment-actions queue of the worker, outside every Postgres transaction.';
COMMENT ON COLUMN payments.pending_action_next_at IS
  'When the worker may try again. Every queueing writes the instant of its own transaction, so '
  'a row waiting to be picked up always has one. NULL with an action still set means one thing '
  'only: the retry ladder is exhausted, the row is out of the queue for good, and nothing will '
  'try again without a person. The selection therefore asks for IS NOT NULL AND <= now, which '
  'makes the query that finds the abandoned rows the exact negation of the one that works them.';

-- --- bookings ----------------------------------------------------------------------------------
--
-- A booking that is waiting for a payment occupies its slot: a `pending` booking holds its
-- occupancies like a `confirmed` one does (`lifecycle.ts`, OCCUPYING). Without a deadline, a
-- customer who closes the browser holds that slot for ever. `payment_expires_at` is the
-- deadline, and `expire_payment` is the transition the scheduler fires at it.

ALTER TABLE bookings ADD COLUMN payment_expires_at timestamptz;

COMMENT ON COLUMN bookings.payment_expires_at IS
  'The instant a pending booking waiting for a payment is cancelled at. NULL for every other '
  'booking, and cleared the moment the payment succeeds.';

-- `next_transition` gains a fourth value. The inline CHECK of migration 0011 is replaced rather
-- than added to: two CHECKs on one column, one of which forbids what the other allows, is a
-- column nobody can reason about.
ALTER TABLE bookings DROP CONSTRAINT bookings_next_transition_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_next_transition_check
  CHECK (next_transition IN ('start', 'complete', 'no_show', 'expire_payment'));

-- --- payment_provider_events --------------------------------------------------------------------
--
-- One row per event the provider sent us, and the reason a replay costs nothing.
--
-- Stripe retries an event until it gets a 2xx, and it may deliver the same event twice even
-- after a 2xx. Applying `payment_intent.succeeded` twice would add the amount to
-- `bookings.amount_paid` twice, which is the one class of bug a payment system may not have. So
-- the receiver claims `(provider, provider_event_id)` before it dispatches, and an event that
-- is already there **and already processed** is answered `200 {duplicate: true}` without
-- touching anything.
--
-- `processed_at` is what makes a failed attempt retryable: the claim row is written and stays
-- unprocessed, the receiver answers 500, Stripe tries again, and the second attempt finds a row
-- that exists and is not processed, which is not a duplicate.
--
-- ## project_id is nullable, and the policy does not cover the rows where it is null
--
-- An event about an intent we never created (an account of ours charged from the Stripe
-- dashboard, or an account we do not know) belongs to no project. It is still recorded, because
-- "we saw this and could not attribute it" is the fact a reconciliation will one day need, and
-- it is written by `stripe_event_record_unmatched`, a definer function, because the isolation
-- policy below is false for a NULL project and would refuse the insert. Nothing reads those
-- rows through the API: there is no endpoint for them and no policy that would show them.

CREATE TABLE payment_provider_events (
  id                  uuid PRIMARY KEY,
  -- Nullable on purpose: see the note above.
  project_id          uuid REFERENCES projects (id) ON DELETE CASCADE,
  environment         text CHECK (environment IN ('test', 'live')),
  provider            text NOT NULL CHECK (provider = 'stripe'),
  provider_event_id   text NOT NULL CHECK (length(provider_event_id) BETWEEN 3 AND 255),
  type                text NOT NULL,
  -- The connected account the event came from (`event.account` of a Connect event).
  provider_account_id text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  outcome             text CHECK (outcome IN ('applied', 'ignored', 'unmatched')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- The dedupe. Global rather than per project: an event identifier is Stripe's, it is unique
  -- across the whole platform, and the project it belongs to is exactly what the receiver has
  -- not worked out yet when it claims the row.
  UNIQUE (provider, provider_event_id),
  -- Either both scope columns or neither: a row with a project and no environment would be a
  -- row no policy could place.
  CHECK ((project_id IS NULL) = (environment IS NULL)),
  -- A processed row says how it went, and an unprocessed one does not pretend to.
  CHECK ((processed_at IS NULL) = (outcome IS NULL))
);

CREATE INDEX payment_provider_events_scope_idx
  ON payment_provider_events (project_id, environment, received_at DESC);
CREATE INDEX payment_provider_events_unprocessed_idx
  ON payment_provider_events (received_at)
  WHERE processed_at IS NULL;

COMMENT ON TABLE payment_provider_events IS
  'One row per incoming provider event, claimed before it is dispatched. It is what makes a '
  'redelivery free: an event that exists and is processed is answered duplicate: true.';

ALTER TABLE payment_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_events FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_provider_events_project_isolation ON payment_provider_events
  FOR ALL
  TO ${APP_ROLE}
  USING (
    project_id = nullif(current_setting('app.project_id', true), '')::uuid
    AND environment = nullif(current_setting('app.environment', true), '')
  )
  WITH CHECK (
    project_id = nullif(current_setting('app.project_id', true), '')::uuid
    AND environment = nullif(current_setting('app.environment', true), '')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_provider_events TO ${APP_ROLE};

CREATE TRIGGER payment_provider_events_set_updated_at
  BEFORE UPDATE ON payment_provider_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- the definer functions ------------------------------------------------------------------------
--
-- The four properties every definer function in this schema carries (0013, 0014, 0015, 0016,
-- 0021, 0022, 0023):
--   * `SECURITY DEFINER`, owned by the migration role;
--   * `SET search_path = public, pg_temp`;
--   * `EXECUTE` revoked from `PUBLIC` and granted to the application role alone;
--   * a fixed return type that cannot carry a row of anybody's data out.

-- 1. stripe_payment_scope: the one cross project read the webhook receiver makes.
--
-- A Stripe webhook names an account and an intent. It does not name a project, and Row Level
-- Security makes "which project owns this intent" unanswerable to the application role by
-- construction, which is the property that keeps a forged event from reaching a project of the
-- attacker's choosing. So it is asked here, of a function whose answer is three identifiers and
-- nothing else: not the amount, not the booking, not the customer.
--
-- The account is part of the lookup and not decoration: without it an event that carried
-- somebody else's intent identifier would resolve to whatever project happened to hold that
-- string. With it, an event has to name both halves of a pair only the real Stripe knows.
--
-- `LIMIT 2`, and not `LIMIT 1`, although the pair is unique in practice
-- (`payments_provider_ref_key` is unique per project, and an account belongs to one project in
-- every case that exists). One row is the answer. Two rows is a state that cannot happen, and
-- the caller turns it into "not attributable" rather than picking the older one: a function
-- that silently chose would send an event to one project instead of another and leave nothing
-- behind. Refusing records the event as `unmatched`, which is a row somebody can read.

CREATE FUNCTION stripe_payment_scope(p_account_id text, p_payment_intent_id text)
RETURNS TABLE (project_id uuid, environment text, payment_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.project_id, p.environment, p.id
    FROM payments p
   WHERE p.provider = 'stripe'
     AND p.provider_account_id = p_account_id
     AND p.provider_payment_id = p_payment_intent_id
   ORDER BY p.created_at, p.id
   LIMIT 2
$$;

COMMENT ON FUNCTION stripe_payment_scope(text, text) IS
  'Resolves (connected account, PaymentIntent) to the project, the environment and the payment '
  'row. Zero rows for an intent this deployment never created, and at most two so that the '
  'caller can tell one answer from an ambiguity and refuse the second. Three identifiers out, '
  'nothing else: it is the only cross project read the public webhook receiver can make.';

-- 2. stripe_account_scope: the same question for an event that names only an account.
--
-- `account.application.deauthorized` is about the link itself and carries no payment. It can
-- legitimately answer more than one row (nothing stops two projects connecting the same Stripe
-- account), and all of them have to be disconnected, so unlike the function above this one
-- returns a set.

CREATE FUNCTION stripe_account_scope(p_account_id text)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.project_id, c.environment
    FROM payment_provider_connections c
   WHERE c.provider = 'stripe'
     AND c.provider_account_id = p_account_id
   ORDER BY c.project_id, c.environment
$$;

COMMENT ON FUNCTION stripe_account_scope(text) IS
  'Every (project, environment) whose Stripe connection names this account. A set, because two '
  'projects may legitimately have connected the same account and a deauthorisation ends both.';

-- 3. stripe_event_record_unmatched: the claim row of an event no project's policy can write.
--
-- Two kinds of event land here. One is an event about an intent this deployment never created,
-- which belongs to no project and is settled `unmatched`. The other is
-- `account.application.deauthorized`, which names an account and no payment: it may concern
-- **several** projects at once (nothing stops two projects connecting the same Stripe account),
-- so there is no single project to key the row on, and it is recorded without one.
--
-- It claims and does **not** settle, which is the whole reason it is split from
-- `stripe_event_settle_unmatched` below. A claim that settled itself would mark an event
-- processed before the work was done, and a delivery that failed halfway would come back as a
-- duplicate and never be applied. Unprocessed is what makes a retry a retry.
--
-- `ON CONFLICT DO NOTHING` then a read, so the first delivery inserts, a redelivery reads what
-- the first one left, and `duplicate` is "exists **and** is processed".

CREATE FUNCTION stripe_event_record_unmatched(
  p_id uuid,
  p_provider_event_id text,
  p_type text,
  p_account_id text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (id uuid, duplicate boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  found_id uuid;
  found_processed boolean;
BEGIN
  INSERT INTO payment_provider_events (id, provider, provider_event_id, type,
                                       provider_account_id, received_at)
  VALUES (p_id, 'stripe', p_provider_event_id, p_type, p_account_id, p_now)
  ON CONFLICT (provider, provider_event_id) DO NOTHING;

  SELECT e.id, e.processed_at IS NOT NULL
    INTO found_id, found_processed
    FROM payment_provider_events e
   WHERE e.provider = 'stripe' AND e.provider_event_id = p_provider_event_id;

  RETURN QUERY SELECT found_id, found_processed;
END
$$;

COMMENT ON FUNCTION stripe_event_record_unmatched(uuid, text, text, text, timestamptz) IS
  'Claims an incoming provider event that belongs to no single project, and says whether it '
  'had already been processed. The isolation policy is false for a NULL project, so this is '
  'the only way such a row can exist.';

-- 3b. stripe_event_settle_unmatched: the other half, for the same reason.

CREATE FUNCTION stripe_event_settle_unmatched(
  p_id uuid,
  p_outcome text,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE payment_provider_events
     SET processed_at = p_now, outcome = p_outcome
   WHERE id = p_id AND project_id IS NULL AND processed_at IS NULL
$$;

COMMENT ON FUNCTION stripe_event_settle_unmatched(uuid, text, timestamptz) IS
  'Marks a project-less event row processed. Restricted to rows with no project: a row that '
  'belongs to one is settled by the application role under its own policy.';

-- 4. pending_action_scopes: which projects have a call owing to Stripe.
--
-- The same shape, and the same justification, as `due_transition_scopes` of migration 0013:
-- *which* projects have work is a cross project question that Row Level Security makes
-- unanswerable to the application role, so it is asked of a definer function whose answer is a
-- list of scope pairs. Everything the worker then does goes back through the application role
-- inside `withProjectContext`.
--
-- The instant is the caller's, never `now()`, for the reason 0013 gives: a test asks what would
-- happen in an hour without waiting an hour.

CREATE FUNCTION pending_action_scopes(p_now timestamptz, max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT p.project_id, p.environment
    FROM payments p
   WHERE p.pending_action IS NOT NULL
     AND p.pending_action_next_at IS NOT NULL
     AND p.pending_action_next_at <= p_now
   ORDER BY p.project_id, p.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION pending_action_scopes(timestamptz, integer) IS
  'The (project, environment) pairs with at least one payment owing a call to the provider. '
  'Ordered so the answer is stable, capped so one tick cannot hold the worker for minutes.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'stripe_payment_scope(text, text)',
    'stripe_account_scope(text)',
    'stripe_event_record_unmatched(uuid, text, text, text, timestamptz)',
    'stripe_event_settle_unmatched(uuid, text, timestamptz)',
    'pending_action_scopes(timestamptz, integer)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
