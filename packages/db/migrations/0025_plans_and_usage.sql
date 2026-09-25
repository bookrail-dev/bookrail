-- 0025: plans, and what an account has used of its plan this month (brief 024a).
--
-- Every account has had a `plan` column since the first control plane migration, defaulting to
-- 'free', constrained by nothing and read by nobody. This migration makes it mean something:
-- the plan decides how many confirmed live bookings and how much paid volume a month are
-- included, and the free plan refuses the next live booking once the included bookings are used.
--
-- A limit that decides whether a real booking exists cannot live in a cache that may lose a key
-- or answer late. It lives here, in the same database and in the same transaction as the thing
-- it counts: the booking transaction increments the counter in the transaction that writes the
-- confirmed booking, and the free plan's check reads the counter in the transaction that is
-- about to write the next one, under a lock that holds it still.
--
-- ## What is here
--
--   1. a CHECK on `accounts.plan`, so the four plan names are the only ones that can exist;
--   2. `plan_usage`, one row per (project, environment, month), live only, under the ordinary
--      project policy: the counter;
--   3. `plan_usage_warnings`, one row per (account, month, threshold): the memory of "this
--      warning has already been sent", closed to everybody, reached through one function;
--   4. `plan_usage_for_account`, the one read of the counter across projects: the threshold is
--      the account's, and an account with two projects has one threshold, not two;
--   4b. `plan_reserved_for_account`, what the account has accepted and not yet counted: its open
--      live `pending` bookings and the amount of its open live payments. The free plan's check
--      adds them to the counter, because a booking that is `pending` holds a slot now and is
--      counted only when it is confirmed, and a check that ignored it would let an account create
--      any number of them under a threshold that only looks at confirmed ones;
--   5. `plan_usage_warning_claim`, the one write to the warnings, which says whether a warning
--      is new in the same statement that records it;
--   6. `auth_lookup_api_key`, replaced by a version that also returns the account and its plan,
--      because the rate limiter and the usage header need the plan on every request and a
--      second lookup per request would be a second query for a fact the first one can carry.
--
-- The four functions carry the four properties of every definer function before them:
-- `SECURITY DEFINER` owned by the migration role, `SET search_path = public, pg_temp`, `EXECUTE`
-- revoked from `PUBLIC` and granted to the application role only, and a fixed return type.
--
-- ## One property more: the account has to be the account of the request
--
-- `plan_usage_for_account`, `plan_reserved_for_account` and `plan_usage_warning_claim` take an
-- account identifier chosen by the caller. All three answer only for the account that owns the
-- project named by `app.project_id`, the same setting every policy of this schema is keyed on:
-- for any other account the reads are zeros and the claim writes nothing. What this protects
-- against is a caller passing the wrong argument, a programming mistake, which becomes zeros
-- instead of somebody else's numbers, exactly as a wrong id becomes zero rows under Row Level
-- Security. It is not a defence against a compromised application role: that role sets
-- `app.project_id` itself, and one that knows a project id of another account can read what the
-- policies of that project let it read, here as on every project table. Every legitimate caller
-- runs inside the context of a project of the account it asks about, so the guard costs nothing.

-- --- 1. the plan names --------------------------------------------------------------------------

ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_known CHECK (plan IN ('free', 'pro', 'scale', 'enterprise'));

COMMENT ON COLUMN accounts.plan IS
  'free, pro, scale or enterprise. Decides the included monthly quantities, whether reaching '
  'them refuses the next live booking (free only), and the rate limit of the live keys.';

-- --- 2. the counter ----------------------------------------------------------------------------
--
-- One row per project, environment and UTC month. `environment` can only be 'live': the test
-- environment never counts, so it has no rows, by construction rather than by a branch in the
-- code that somebody could remove.
--
-- `payment_volume` has no lower bound on purpose. A refund lands in the month it is made, and a
-- refund of a payment taken last month can take this month's volume below zero. The number is
-- the net of what moved this month, which is what the plan measures.
--
-- `currency` is the currency of the first payment of the month. A payment in a different
-- currency in the same month and project is added all the same and the row says 'mixed': there
-- is no conversion, and the threshold of the free plan reads the number as if it were euro.

CREATE TABLE plan_usage (
  id                 uuid PRIMARY KEY,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment        text NOT NULL CHECK (environment = 'live'),
  month              text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  bookings_confirmed integer NOT NULL DEFAULT 0 CHECK (bookings_confirmed >= 0),
  payment_volume     bigint NOT NULL DEFAULT 0,
  currency           text CHECK (currency IS NULL OR currency = 'mixed'
                                 OR currency ~ '^[A-Za-z]{3}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment, month)
);

COMMENT ON TABLE plan_usage IS
  'What a project used of its account''s plan in one UTC month, live only: confirmed bookings '
  '(each booking once, when it first reaches confirmed) and paid volume net of refunds, in the '
  'minor unit. Written by the application role with INSERT ... ON CONFLICT DO UPDATE, inside '
  'the transaction of the booking or payment it counts.';
COMMENT ON COLUMN plan_usage.payment_volume IS
  'Succeeded live payments of the month minus the refunds made in the month. Can be negative: '
  'a refund of a payment of an earlier month is counted in the month it is made.';
COMMENT ON COLUMN plan_usage.currency IS
  'The currency of the first payment of the month, or mixed when a second currency arrived. '
  'No conversion is made.';

ALTER TABLE plan_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY plan_usage_project_isolation ON plan_usage
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

-- No DELETE: a month that happened is not undone by the application.
GRANT SELECT, INSERT, UPDATE ON plan_usage TO ${APP_ROLE};

CREATE TRIGGER plan_usage_set_updated_at
  BEFORE UPDATE ON plan_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- 3. the warnings that have been sent -------------------------------------------------------
--
-- An account is told once at 80 % of its included bookings and once at 100 %, per month. The
-- row is the memory of that, and its UNIQUE is what makes "once" true when two bookings cross
-- the threshold at the same instant: the second insert finds the first and writes nothing.
--
-- The table belongs to an account, not to a project, so there is no project to key a policy on.
-- Like `signups` it is closed instead: row security enabled and forced, no policy, no grant.
-- `plan_usage_warning_claim` is the only way in.

CREATE TABLE plan_usage_warnings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  month      text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  threshold  integer NOT NULL CHECK (threshold IN (80, 100)),
  sent_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, month, threshold)
);

COMMENT ON TABLE plan_usage_warnings IS
  'One row per account, month and threshold (80 or 100 percent of the included bookings): '
  'the warning has been claimed. Closed to every role; plan_usage_warning_claim is the only '
  'writer and reader.';

ALTER TABLE plan_usage_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_usage_warnings FORCE ROW LEVEL SECURITY;

-- --- 4. the read across projects ---------------------------------------------------------------
--
-- The sum over the live rows of every project of the account, for one month, as exactly one row
-- (zeros when nothing was counted). `currency` is the one currency of those rows, 'mixed' when
-- they disagree, NULL when no money moved.

CREATE FUNCTION plan_usage_for_account(p_account_id uuid, p_month text)
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
     AND EXISTS (
       SELECT 1 FROM projects c
        WHERE c.id = nullif(current_setting('app.project_id', true), '')::uuid
          AND c.account_id = p_account_id
     )
$$;

COMMENT ON FUNCTION plan_usage_for_account(uuid, text) IS
  'The confirmed live bookings and the net paid volume of every project of an account in one '
  'UTC month, as one row. Answers only for the account of the project named by app.project_id; '
  'for any other account the answer is zeros.';

-- --- 4b. what has been accepted and not yet counted ----------------------------------------------
--
-- Two numbers, over the live rows of every project of the account, with **no month**: a booking
-- that is `pending` today will be counted in the month it is confirmed, and until then it takes a
-- place in the quota of the month in which the check runs.
--
--   * `bookings_pending`: live bookings in `pending`. Conservative on purpose: a `pending` born
--     from a reschedule of a booking that had already been confirmed (and therefore already
--     counted) is counted here as well. That overestimates by at most one per reschedule chain,
--     and an overestimate brings a `402` forward; it never lets one through late.
--   * `payment_volume_pending`: the amount of the live payments that are still open, which in the
--     states of `payments` is `pending` (a card that was refused leaves the intent, and the row,
--     `pending` until the booking's deadline), not a refund, and **of a booking that is itself
--     still `pending`**: the money of a booking that has been cancelled is no longer expected,
--     even while its intent waits to be cancelled at Stripe (or never is, when the worker runs
--     out of attempts), and if it arrives all the same the receiver records it and refunds it. A
--     payment that succeeds moves into `plan_usage.payment_volume` in the same transaction that
--     sets it `succeeded`, so the two numbers never count the same money twice.
--
-- The free plan's check reads this function **in the same statement** as
-- `plan_usage_for_account`, so that both see one snapshot: a confirmation or a payment that
-- commits between two separate statements would leave the pending side before the check read it
-- and reach the counted side after, and disappear from both.

CREATE FUNCTION plan_reserved_for_account(p_account_id uuid)
RETURNS TABLE (bookings_pending bigint, payment_volume_pending bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH account AS (
    SELECT p_account_id AS id
     WHERE EXISTS (
       SELECT 1 FROM projects c
        WHERE c.id = nullif(current_setting('app.project_id', true), '')::uuid
          AND c.account_id = p_account_id
     )
  )
  SELECT (SELECT count(*)
            FROM bookings b
            JOIN projects p ON p.id = b.project_id
            JOIN account a ON a.id = p.account_id
           WHERE b.environment = 'live'
             AND b.status = 'pending')::bigint,
         (SELECT COALESCE(sum(y.amount), 0)
            FROM payments y
            JOIN bookings b ON b.id = y.booking_id
            JOIN projects p ON p.id = y.project_id
            JOIN account a ON a.id = p.account_id
           WHERE y.environment = 'live'
             AND y.status = 'pending'
             AND y.type <> 'refund'
             AND b.status = 'pending')::bigint
$$;

COMMENT ON FUNCTION plan_reserved_for_account(uuid) IS
  'The open live pending bookings and the amount of the open live payments of every project of '
  'an account, as one row, with no month: what the account has accepted and not yet counted. '
  'Only the payments of a booking that is still pending are open money. Counts a pending born from a reschedule of a confirmed booking too (at most one too many per '
  'chain, which brings a refusal forward and never delays one). Answers only for the account of '
  'the project named by app.project_id; for any other account the answer is zeros.';

-- --- 5. the write to the warnings --------------------------------------------------------------
--
-- Records that a warning is being sent, and says whether it is new: one row back to the first
-- caller, zero rows to every caller after it, which is the discipline of `signup_claim`. Refuses
-- (zero rows, nothing written) for an account that is not the account of the request.

CREATE FUNCTION plan_usage_warning_claim(p_account_id uuid, p_month text, p_threshold integer)
RETURNS TABLE (threshold integer, sent_at timestamptz)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO plan_usage_warnings AS w (account_id, month, threshold)
  SELECT p_account_id, p_month, p_threshold
   WHERE EXISTS (
     SELECT 1 FROM projects c
      WHERE c.id = nullif(current_setting('app.project_id', true), '')::uuid
        AND c.account_id = p_account_id
   )
  ON CONFLICT (account_id, month, threshold) DO NOTHING
  RETURNING w.threshold, w.sent_at
$$;

COMMENT ON FUNCTION plan_usage_warning_claim(uuid, text, integer) IS
  'Claims the warning of one account, month and threshold. One row when the claim is new, zero '
  'when it had already been made or when the account is not the account of app.project_id.';

-- --- 6. the key lookup, with the account and its plan ------------------------------------------
--
-- The same function as migration 0013, with two columns more. Its return type changes, which
-- `CREATE OR REPLACE` cannot do, so it is dropped and created again in this same transaction:
-- no caller can see the moment in between. A process of the previous release that is still
-- running reads the result with `SELECT *` and ignores the two columns it does not know.

DROP FUNCTION auth_lookup_api_key(text, text);

CREATE FUNCTION auth_lookup_api_key(p_key_hash text, p_prefix text)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  environment text,
  kind text,
  scopes text[],
  tenant_id text,
  revoked_at timestamptz,
  account_id uuid,
  plan text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.project_id, k.environment, k.kind, k.scopes, k.tenant_id, k.revoked_at,
         a.id, a.plan
    FROM api_keys k
    JOIN projects p ON p.id = k.project_id
    JOIN accounts a ON a.id = p.account_id
   WHERE k.key_hash = p_key_hash
     AND k.prefix = p_prefix
   LIMIT 1
$$;

COMMENT ON FUNCTION auth_lookup_api_key(text, text) IS
  'Resolves a presented secret key to the row authentication needs, or to nothing: the key, its '
  'project and environment, and the account and plan the project belongs to. The only read of '
  'api_keys that is allowed outside a project context, and it returns at most one row. Both the '
  'hash and the prefix are matched: the prefix is part of the key text the caller sent, and '
  'matching it as well keeps a hash collision from resolving to another key.';

-- --- privileges -----------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'plan_usage_for_account(uuid, text)',
    'plan_reserved_for_account(uuid)',
    'plan_usage_warning_claim(uuid, text, integer)',
    'auth_lookup_api_key(text, text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
