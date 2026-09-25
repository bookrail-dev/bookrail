-- 0026: a live key at sign up, and a dashboard to see and manage keys (brief 024b).
--
-- Two things change here, and they are in one migration because they are one decision: the
-- live key stops coming from a person, so the person who receives it needs a place to see it,
-- to see what the account has used of its plan, and to create and revoke keys without writing
-- to anybody.
--
--   1. `signup_confirm` mints **two** keys, a test one and a live one, in the transaction that
--      creates the account. The previous version, which minted one, is **kept** beside it (the
--      two signatures differ): the release before this one still calls it, and a rollback to
--      that release is a symlink that does not touch the database. A later migration removes it,
--      once this release and the next one are out together. `signup_start` gets the lock its
--      ceilings needed from the start (see "The ceilings" below).
--   2. The dashboard: two closed tables (`dashboard_logins`, `dashboard_sessions`) and the
--      eight `SECURITY DEFINER` functions that are the only way in, with the four properties of
--      every definer function before them (owned by the migration role, `SET search_path =
--      public, pg_temp`, `EXECUTE` revoked from `PUBLIC` and granted to the application role
--      only, a fixed return type).
--
-- ## Two credentials, two doors
--
-- The dashboard belongs to an **account**, not to a project, and it can do the one thing an API
-- key must never do: create another key, live ones included. So an API key does not open it,
-- and a dashboard session does not open `/v1`. A session is proved by a token (`bds_...`) whose
-- SHA-256 is the only thing this database holds; it is obtained by opening a link sent to the
-- owner address of the account (`bls_...`, hashed the same way), and it lasts twelve hours,
-- absolute, with no renewal.
--
-- ## The session is the argument, not the account
--
-- Every function that reads or writes on behalf of a session takes the **hash of the session
-- token**, resolves it inside itself and works on the account it finds, instead of taking an
-- account identifier chosen by the caller. What this protects against is a **programming
-- mistake**: a wrong identifier passed by the application cannot act on another account, the
-- way a wrong id becomes zero rows under Row Level Security. It is **not** a defence against a
-- compromised API process, or against somebody running SQL as the application role: that role
-- generates the link token itself, so it can open a session for any self service address it
-- knows (`dashboard_login_start`, `dashboard_login_confirm`) and then act with it. The barrier
-- against that stays where it was: the application role and the isolation of the process.
--
-- ## The ceilings
--
-- The requests for a link (and, redefined here, the requests for a sign up of migration 0021)
-- are limited by counting rows and then inserting one. Counted without a lock, twenty requests
-- at the same instant all read the same count and all get in. So each function first takes two
-- transaction advisory locks, always in this order: one on the address, then one on the
-- caller's hash. Everybody takes the address first, so no two transactions can wait on each
-- other in a cycle. The key creations of an account are serialised the same way.
--
-- The seeds of `hashtextextended`, next to the ones of the booking engine (0 for a resource,
-- 1 for a customer, 2 for an account in the plan gate):
--
--   3  the address of a request for a sign up or a dashboard link
--   4  the hashed caller of the same requests
--   5  the account whose keys the dashboard creates
--
-- ## Time
--
-- The instant a session or a link is checked against is `greatest(p_now, now())`: a caller can
-- move the clock **forward**, which is how a test asks what happens in thirteen hours without
-- waiting for them, and never backward, so no argument can make an expired session or an
-- expired link valid again. Everything that is **written** (the creation of a session, its
-- expiry, `used_at`, `revoked_at`) uses the real `now()`, so no argument can lengthen a session
-- either. The purge takes no instant at all: for a deletion, forward is the dangerous direction.

-- --- 1. two keys at sign up ---------------------------------------------------------------------
--
-- The sign up remembers the live key it minted as well as the test one. The test key's
-- identifier stays the additional authenticated data of the envelope a terminal collects, which
-- now carries both keys; the live one is here so that the claim can name it without deriving it
-- again from the project.

ALTER TABLE signups
  ADD COLUMN live_api_key_id uuid REFERENCES api_keys (id) ON DELETE SET NULL;

COMMENT ON COLUMN signups.live_api_key_id IS
  'The live key this sign up minted, next to the test one in api_key_id. NULL for a sign up '
  'confirmed before migration 0026, which minted a test key only.';

-- The one-key `signup_confirm(text, uuid, uuid, uuid, text, text, text, text)` of migration 0021
-- is left in place on purpose, with its grant: it is what the previous release calls, and after
-- a rollback by symlink that release must still be able to create an account (with its test key
-- alone, which is the state of the day before). It is removed by a later migration, after this
-- release and the one that follows it are out together. The gate (`check-db.mjs`, question 6g)
-- expects exactly these two signatures until then.

CREATE FUNCTION signup_confirm(
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

  -- The same subtransaction as migration 0021, for the same reason: two different links for the
  -- same address, opened at the same instant, both read `taken = false`, and the partial unique
  -- index on `accounts` is what stops the second. Nothing half made survives the rollback, the
  -- two keys included.
  BEGIN
    INSERT INTO accounts (id, name, origin, owner_email)
    VALUES (p_account_id, row_signup.account_name, 'self_serve', row_signup.email);

    INSERT INTO projects (id, account_id, name, default_timezone, default_currency)
    VALUES (p_project_id, p_account_id, row_signup.project_name,
            row_signup.default_timezone, row_signup.default_currency);

    -- Two keys, both secret, with no scopes and no tenant. The live one books for real and
    -- counts against the free plan the account is born on, which refuses the next live booking
    -- at its threshold (migration 0025): that refusal is what makes it safe to hand the key out
    -- without a person in between.
    INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash,
                          scopes, tenant_id)
    VALUES (p_test_key_id, p_project_id, 'test', 'secret', p_test_key_name, p_test_key_prefix,
            p_test_key_hash, '{}'::text[], NULL),
           (p_live_key_id, p_project_id, 'live', 'secret', p_live_key_name, p_live_key_prefix,
            p_live_key_hash, '{}'::text[], NULL);
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

COMMENT ON FUNCTION signup_confirm(text, uuid, uuid, uuid, text, text, text, uuid, text, text,
                                   text, text) IS
  'Turns a confirmed request into an account on the free plan, a project, a test key and a live '
  'key, in one transaction, or reports email_taken and creates nothing. The row is locked FOR '
  'UPDATE first, so two clicks on the same link produce one account and one refusal.';

-- The claim returns the live key's identifier as well. Its return type changes, which `CREATE OR
-- REPLACE` cannot do, so it is dropped and created again in this same transaction. The body is
-- the one of migration 0021 with one column more.

DROP FUNCTION signup_claim(uuid, text);

CREATE FUNCTION signup_claim(p_id uuid, p_poll_token_hash text)
RETURNS TABLE (
  status text,
  previous_status text,
  pending_secret text,
  expires_at timestamptz,
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
  row_signup signups%ROWTYPE;
  envelope   text;
  was        text;
BEGIN
  SELECT * INTO row_signup
    FROM signups s
   WHERE s.id = p_id AND s.poll_token_hash = p_poll_token_hash
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signup_not_found' USING ERRCODE = 'P0404';
  END IF;
  was := row_signup.status;

  IF row_signup.status = 'pending' AND row_signup.expires_at < now() THEN
    UPDATE signups s SET status = 'expired' WHERE s.id = row_signup.id;
    row_signup.status := 'expired';
  END IF;

  IF row_signup.status = 'confirmed' THEN
    IF row_signup.pending_secret IS NOT NULL
       AND row_signup.pending_secret_expires_at > now() THEN
      envelope := row_signup.pending_secret;
    END IF;
    UPDATE signups s
       SET status = 'claimed', pending_secret = NULL, pending_secret_expires_at = NULL
     WHERE s.id = row_signup.id;
    row_signup.status := 'claimed';
  END IF;

  RETURN QUERY SELECT row_signup.status, was, envelope, row_signup.expires_at,
                      row_signup.account_id, row_signup.project_id, row_signup.api_key_id,
                      row_signup.live_api_key_id,
                      row_signup.account_name, row_signup.project_name,
                      row_signup.default_timezone, row_signup.default_currency;
END
$$;

COMMENT ON FUNCTION signup_claim(uuid, text) IS
  'Hands the waiting terminal the encrypted keys, once, and clears them. A second call finds the '
  'status claimed and no envelope. Both the identifier and the poll token have to match.';

-- The ceilings of `signup_start` (migration 0021) counted and inserted without a lock, so a
-- burst of simultaneous requests for one address all read the same count. Same function, same
-- signature and same answer, with the two locks of "The ceilings" taken before the count.

CREATE OR REPLACE FUNCTION signup_start(
  p_id uuid,
  p_email text,
  p_token_hash text,
  p_poll_token_hash text,
  p_client text,
  p_ip_hash text,
  p_account_name text,
  p_project_name text,
  p_default_timezone text,
  p_default_currency text
)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_per_email  constant integer := 3;
  max_per_ip     constant integer := 10;
  window_length  constant interval := interval '24 hours';
  link_lifetime  constant interval := interval '1 hour';
  used_by_email  integer;
  used_by_ip     integer;
  v_expires_at   timestamptz;
BEGIN
  -- The address first, then the caller: always in this order (seeds 3 and 4).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_email, 3));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ip_hash, 4));

  SELECT count(*) INTO used_by_email
    FROM signups s
   WHERE s.email = p_email AND s.created_at > now() - window_length;
  SELECT count(*) INTO used_by_ip
    FROM signups s
   WHERE s.ip_hash = p_ip_hash AND s.created_at > now() - window_length;

  IF used_by_email >= max_per_email OR used_by_ip >= max_per_ip THEN
    RAISE EXCEPTION 'signup_rate_limited' USING ERRCODE = 'P0429';
  END IF;

  INSERT INTO signups (
    id, email, token_hash, poll_token_hash, client, ip_hash,
    account_name, project_name, default_timezone, default_currency,
    status, created_at, expires_at
  )
  VALUES (
    p_id, p_email, p_token_hash, p_poll_token_hash, p_client, p_ip_hash,
    p_account_name, p_project_name, p_default_timezone, p_default_currency,
    'pending', now(), now() + link_lifetime
  )
  RETURNING signups.expires_at INTO v_expires_at;

  RETURN QUERY SELECT p_id, v_expires_at;
END
$$;

COMMENT ON FUNCTION signup_start(uuid, text, text, text, text, text, text, text, text, text) IS
  'Records one request for a sign up and returns its identifier and the moment the link stops '
  'working. Refuses with SQLSTATE P0429 past three requests a day for one address or ten for '
  'one caller, counted under two advisory locks so that simultaneous requests cannot all pass. '
  'It never looks at accounts: the answer is the same whether or not the address already has '
  'one.';

-- --- 2. dashboard_logins ------------------------------------------------------------------------
--
-- One row per request for a link. **Every** request is recorded, whether or not the address
-- belongs to an account: the two ceilings below count rows, and a ceiling that counted only the
-- addresses that have an account would answer the sixth request differently for a customer and
-- for a stranger, which is the question this endpoint must never answer. A row with no account
-- can never be confirmed; its token was generated and never sent.
--
-- Rows live for as long as the ceilings look back (one hour) and the hourly purge deletes them
-- after that. The address is kept that long and no longer.

CREATE TABLE dashboard_logins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  -- The account of that address when the request was made, NULL when there was none.
  account_id  uuid REFERENCES accounts (id) ON DELETE CASCADE,
  -- SHA-256 of the `bls_` token, hex. The clear text exists only in the message that was sent.
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ip_hash     text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX dashboard_logins_email_created_at_idx ON dashboard_logins (email, created_at DESC);
CREATE INDEX dashboard_logins_ip_hash_created_at_idx ON dashboard_logins (ip_hash, created_at DESC);
CREATE INDEX dashboard_logins_housekeeping_idx ON dashboard_logins (created_at);

COMMENT ON TABLE dashboard_logins IS
  'One row per request for a dashboard link, for an address with an account or without one. '
  'Reachable only through the SECURITY DEFINER functions of migration 0026: row security is '
  'forced and there is no policy and no grant.';

ALTER TABLE dashboard_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_logins FORCE ROW LEVEL SECURITY;

-- --- 3. dashboard_sessions ----------------------------------------------------------------------

CREATE TABLE dashboard_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- SHA-256 of the `bds_` token, hex. The clear text exists only in the answer to the confirm
  -- and in the browser tab that received it.
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Twelve hours after created_at, absolute. Nothing renews it.
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX dashboard_sessions_account_id_idx ON dashboard_sessions (account_id);
CREATE INDEX dashboard_sessions_housekeeping_idx ON dashboard_sessions (expires_at);

COMMENT ON TABLE dashboard_sessions IS
  'One row per dashboard session: an account, the hash of its token, twelve hours of life with '
  'no renewal. Reachable only through the SECURITY DEFINER functions of migration 0026.';

ALTER TABLE dashboard_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_sessions FORCE ROW LEVEL SECURITY;

-- --- 4. dashboard_login_start ------------------------------------------------------------------
--
-- Records the request and says whether a message should be sent. The HTTP answer is the same
-- either way; only the process that sends mail learns the difference, and it sends without
-- making the caller wait for it.

CREATE FUNCTION dashboard_login_start(p_email text, p_token_hash text, p_ip_hash text)
RETURNS TABLE (send_email boolean, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- The two ceilings, declared here so that reading the function is reading the policy.
  max_per_email  constant integer := 5;
  max_per_ip     constant integer := 20;
  window_length  constant interval := interval '1 hour';
  link_lifetime  constant interval := interval '15 minutes';
  used_by_email  integer;
  used_by_ip     integer;
  v_account      uuid;
  v_expires_at   timestamptz;
BEGIN
  -- The address first, then the caller: always in this order (seeds 3 and 4), so that
  -- simultaneous requests are counted one after the other and cannot wait on each other.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_email, 3));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ip_hash, 4));

  SELECT count(*) INTO used_by_email
    FROM dashboard_logins l
   WHERE l.email = p_email AND l.created_at > now() - window_length;
  SELECT count(*) INTO used_by_ip
    FROM dashboard_logins l
   WHERE l.ip_hash = p_ip_hash AND l.created_at > now() - window_length;

  IF used_by_email >= max_per_email OR used_by_ip >= max_per_ip THEN
    RAISE EXCEPTION 'dashboard_login_rate_limited' USING ERRCODE = 'P0429';
  END IF;

  -- Only a self service account has an owner address. An account created by hand has none and
  -- has no dashboard: it is managed by hand.
  SELECT a.id INTO v_account
    FROM accounts a
   WHERE a.origin = 'self_serve' AND a.owner_email = p_email;

  INSERT INTO dashboard_logins (email, account_id, token_hash, ip_hash, created_at, expires_at)
  VALUES (p_email, v_account, p_token_hash, p_ip_hash, now(), now() + link_lifetime)
  RETURNING dashboard_logins.expires_at INTO v_expires_at;

  RETURN QUERY SELECT v_account IS NOT NULL, v_expires_at;
END
$$;

COMMENT ON FUNCTION dashboard_login_start(text, text, text) IS
  'Records one request for a dashboard link and says whether the address has a self service '
  'account, that is whether a message should be sent. Refuses with SQLSTATE P0429 past five '
  'requests an hour for one address or twenty for one caller, counting every request, under two '
  'advisory locks.';

-- --- 5. dashboard_login_confirm ----------------------------------------------------------------
--
-- The link was opened. The row is taken `FOR UPDATE` before anything is read from it, so two
-- clicks on the same link produce one session and one refusal: the second waits on the lock
-- and finds `used_at` already set.

CREATE FUNCTION dashboard_login_confirm(
  p_token_hash text,
  p_session_token_hash text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (session_id uuid, account_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  session_lifetime constant interval := interval '12 hours';
  v_now            timestamptz := greatest(coalesce(p_now, now()), now());
  row_login        dashboard_logins%ROWTYPE;
  v_session_id     uuid;
  v_expires_at     timestamptz;
BEGIN
  SELECT * INTO row_login FROM dashboard_logins l WHERE l.token_hash = p_token_hash FOR UPDATE;
  -- A link that was never sent (no account behind the address) is indistinguishable from one
  -- that does not exist.
  IF NOT FOUND OR row_login.account_id IS NULL THEN
    RAISE EXCEPTION 'dashboard_login_not_found' USING ERRCODE = 'P0404';
  END IF;
  IF row_login.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'dashboard_login_used' USING ERRCODE = 'P0409';
  END IF;
  IF row_login.expires_at <= v_now THEN
    RAISE EXCEPTION 'dashboard_login_expired' USING ERRCODE = 'P0410';
  END IF;
  -- The account must still be the one of that address.
  IF NOT EXISTS (
    SELECT 1 FROM accounts a
     WHERE a.id = row_login.account_id
       AND a.origin = 'self_serve'
       AND a.owner_email = row_login.email
  ) THEN
    RAISE EXCEPTION 'dashboard_login_not_found' USING ERRCODE = 'P0404';
  END IF;

  UPDATE dashboard_logins l SET used_at = now() WHERE l.id = row_login.id;

  INSERT INTO dashboard_sessions (account_id, token_hash, created_at, expires_at)
  VALUES (row_login.account_id, p_session_token_hash, now(), now() + session_lifetime)
  RETURNING dashboard_sessions.id, dashboard_sessions.expires_at INTO v_session_id, v_expires_at;

  RETURN QUERY SELECT v_session_id, row_login.account_id, v_expires_at;
END
$$;

COMMENT ON FUNCTION dashboard_login_confirm(text, text, timestamptz) IS
  'Turns an unused, unexpired dashboard link into a session of twelve hours, once. Refuses with '
  'P0404 (unknown link), P0409 (already used) or P0410 (expired). p_now can only move the clock '
  'forward.';

-- --- 6. dashboard_session_resolve --------------------------------------------------------------

CREATE FUNCTION dashboard_session_resolve(
  p_session_token_hash text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (session_id uuid, account_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now       timestamptz := greatest(coalesce(p_now, now()), now());
  row_session dashboard_sessions%ROWTYPE;
BEGIN
  SELECT s.* INTO row_session
    FROM dashboard_sessions s
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- At most one write a minute per session, like `last_used_at` of an API key.
  UPDATE dashboard_sessions s
     SET last_seen_at = now()
   WHERE s.id = row_session.id
     AND (s.last_seen_at IS NULL OR s.last_seen_at < now() - interval '1 minute');

  RETURN QUERY SELECT row_session.id, row_session.account_id, row_session.expires_at;
END
$$;

COMMENT ON FUNCTION dashboard_session_resolve(text, timestamptz) IS
  'The session behind a token hash, as one row, or nothing when it is unknown, expired or '
  'revoked. Records last_seen_at at most once a minute. p_now can only move the clock forward.';

-- --- 7. dashboard_session_revoke ---------------------------------------------------------------

CREATE FUNCTION dashboard_session_revoke(p_session_token_hash text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE dashboard_sessions s
     SET revoked_at = now()
   WHERE s.token_hash = p_session_token_hash AND s.revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

COMMENT ON FUNCTION dashboard_session_revoke(text) IS
  'Ends a session. Returns 1 when a live session was revoked, 0 when there was nothing to end.';

-- --- 8. dashboard_account_overview -------------------------------------------------------------
--
-- What the dashboard shows: the account, its plan, this month's usage and what is accepted and
-- not yet counted, and every project with every key. Never `key_hash`: the object below lists
-- its fields by name, and the hash is not one of them.
--
-- ## The arithmetic of the usage
--
-- It is the arithmetic of `plan_usage_for_account` and `plan_reserved_for_account` (migration
-- 0025), written again here **without their guard**: those two answer only for the account of
-- the project in `app.project_id`, and here there is no project in context, there is a session.
-- The two copies are kept equal by a test that computes both on the same data, including rows
-- of another account, of the test environment and of another month
-- (`packages/db/test/dashboard.test.ts`), rather than by a shared inner function: the two of
-- 0025 are the gate of the free plan, and this brief reads them and does not change them.
--
-- `STABLE` and plain SQL: one statement, one snapshot, so the confirmed and the pending numbers
-- cannot disagree about a confirmation that commits in between.

CREATE FUNCTION dashboard_account_overview(
  p_session_token_hash text,
  p_month text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  account_id uuid,
  account_name text,
  plan text,
  owner_email text,
  session_expires_at timestamptz,
  bookings_confirmed bigint,
  payment_volume bigint,
  currency text,
  bookings_pending bigint,
  payment_volume_pending bigint,
  projects jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH live_session AS (
    SELECT s.account_id, s.expires_at
      FROM dashboard_sessions s
     WHERE s.token_hash = p_session_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > greatest(coalesce(p_now, now()), now())
  )
  SELECT a.id,
         a.name,
         a.plan,
         a.owner_email,
         s.expires_at,
         -- plan_usage_for_account, without the guard
         (SELECT COALESCE(sum(u.bookings_confirmed), 0)::bigint
            FROM plan_usage u JOIN projects p ON p.id = u.project_id
           WHERE p.account_id = a.id AND u.environment = 'live' AND u.month = p_month),
         (SELECT COALESCE(sum(u.payment_volume), 0)::bigint
            FROM plan_usage u JOIN projects p ON p.id = u.project_id
           WHERE p.account_id = a.id AND u.environment = 'live' AND u.month = p_month),
         (SELECT CASE count(DISTINCT u.currency)
                   WHEN 0 THEN NULL
                   WHEN 1 THEN min(u.currency)
                   ELSE 'mixed'
                 END
            FROM plan_usage u JOIN projects p ON p.id = u.project_id
           WHERE p.account_id = a.id AND u.environment = 'live' AND u.month = p_month),
         -- plan_reserved_for_account, without the guard
         (SELECT count(*)
            FROM bookings b JOIN projects p ON p.id = b.project_id
           WHERE p.account_id = a.id AND b.environment = 'live' AND b.status = 'pending')::bigint,
         (SELECT COALESCE(sum(y.amount), 0)
            FROM payments y
            JOIN bookings b ON b.id = y.booking_id
            JOIN projects p ON p.id = y.project_id
           WHERE p.account_id = a.id
             AND y.environment = 'live'
             AND y.status = 'pending'
             AND y.type <> 'refund'
             AND b.status = 'pending')::bigint,
         COALESCE((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', p.id,
                      'name', p.name,
                      'default_timezone', p.default_timezone,
                      'default_currency', p.default_currency,
                      'created_at', p.created_at,
                      'api_keys', COALESCE((
                        SELECT jsonb_agg(
                                 jsonb_build_object(
                                   'id', k.id,
                                   'environment', k.environment,
                                   'kind', k.kind,
                                   'name', k.name,
                                   'prefix', k.prefix,
                                   'tenant_id', k.tenant_id,
                                   'created_at', k.created_at,
                                   'last_used_at', k.last_used_at,
                                   'revoked_at', k.revoked_at
                                 )
                                 ORDER BY k.environment, k.created_at, k.id
                               )
                          FROM api_keys k
                         WHERE k.project_id = p.id
                      ), '[]'::jsonb)
                    )
                    ORDER BY p.created_at, p.id
                  )
             FROM projects p
            WHERE p.account_id = a.id
         ), '[]'::jsonb)
    FROM live_session s
    JOIN accounts a ON a.id = s.account_id
$$;

COMMENT ON FUNCTION dashboard_account_overview(text, text, timestamptz) IS
  'The account of a live dashboard session: name, plan, owner address, the confirmed live '
  'bookings and paid volume of one UTC month, the open live pending bookings and payments, and '
  'every project with every key (never the key hash). Zero rows for an unknown, expired or '
  'revoked session.';

-- --- 9. dashboard_key_create -------------------------------------------------------------------
--
-- A secret key for a project of the session's account, with no scopes and no tenant. At most
-- five active secret keys per project and environment: enough to rotate one without downtime and
-- to keep a staging and a production deployment apart, and a ceiling on what a stolen session
-- can mint in the twelve hours it lives.
--
-- The project row is taken `FOR NO KEY UPDATE` first, so two creations for the same project are
-- serialised and cannot both count four and both insert. `NO KEY` because it must not wait on
-- (or make wait) the `FOR KEY SHARE` locks that every insert into a table referencing the
-- project takes: key creation must not stall bookings.

CREATE FUNCTION dashboard_key_create(
  p_session_token_hash text,
  p_project_id uuid,
  p_environment text,
  p_key_id uuid,
  p_prefix text,
  p_key_hash text,
  p_name text,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  environment text,
  kind text,
  name text,
  prefix text,
  created_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  max_active    constant integer := 5;
  -- Keys created for one account in a day, revoked ones included: creating and revoking in a
  -- loop would otherwise grow a shared table without end.
  max_created   constant integer := 20;
  created_window constant interval := interval '24 hours';
  v_now         timestamptz := greatest(coalesce(p_now, now()), now());
  v_account     uuid;
  active        integer;
  created_today integer;
BEGIN
  SELECT s.account_id INTO v_account
    FROM dashboard_sessions s
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'dashboard_session_invalid' USING ERRCODE = 'P0401';
  END IF;

  PERFORM 1 FROM projects p
    WHERE p.id = p_project_id AND p.account_id = v_account
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    -- Another account's project and a project that does not exist are the same answer.
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0404';
  END IF;

  -- The creations of the whole account, serialised (seed 5), so that two projects of the same
  -- account cannot both count nineteen.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account::text, 5));
  SELECT count(*) INTO created_today
    FROM api_keys k
    JOIN projects p ON p.id = k.project_id
   WHERE p.account_id = v_account
     AND k.created_at > now() - created_window;
  IF created_today >= max_created THEN
    RAISE EXCEPTION 'key_creation_rate_limited' USING ERRCODE = 'P0429';
  END IF;

  SELECT count(*) INTO active
    FROM api_keys k
   WHERE k.project_id = p_project_id
     AND k.environment = p_environment
     AND k.kind = 'secret'
     AND k.revoked_at IS NULL;
  IF active >= max_active THEN
    RAISE EXCEPTION 'key_limit_reached' USING ERRCODE = 'P0409';
  END IF;

  RETURN QUERY
  WITH created AS (
    INSERT INTO api_keys AS k (id, project_id, environment, kind, name, prefix, key_hash,
                               scopes, tenant_id)
    VALUES (p_key_id, p_project_id, p_environment, 'secret', p_name, p_prefix, p_key_hash,
            '{}'::text[], NULL)
    RETURNING k.id, k.project_id, k.environment, k.kind, k.name, k.prefix, k.created_at
  )
  SELECT c.id, c.project_id, c.environment, c.kind, c.name, c.prefix, c.created_at
    FROM created c;
END
$$;

COMMENT ON FUNCTION dashboard_key_create(text, uuid, text, uuid, text, text, text, timestamptz) IS
  'Creates a secret key with no scopes and no tenant for a project of the account of a live '
  'dashboard session. Refuses with P0401 (no live session), P0404 (not a project of that '
  'account), P0429 (twenty keys already created for the account in the last 24 hours, revoked '
  'ones included) or P0409 (five active secret keys already exist for that project and '
  'environment).';

-- --- 10. dashboard_key_revoke ------------------------------------------------------------------
--
-- Revoking the last active key of an environment is allowed: the dashboard warns first, and an
-- account that wants its live traffic stopped at once has every right to stop it. A key already
-- revoked is returned as it is, with its original `revoked_at`.

CREATE FUNCTION dashboard_key_revoke(
  p_session_token_hash text,
  p_key_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  environment text,
  kind text,
  name text,
  prefix text,
  tenant_id text,
  created_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now     timestamptz := greatest(coalesce(p_now, now()), now());
  v_account uuid;
  v_key     uuid;
BEGIN
  SELECT s.account_id INTO v_account
    FROM dashboard_sessions s
   WHERE s.token_hash = p_session_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > v_now;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'dashboard_session_invalid' USING ERRCODE = 'P0401';
  END IF;

  SELECT k.id INTO v_key
    FROM api_keys k
    JOIN projects p ON p.id = k.project_id
   WHERE k.id = p_key_id AND p.account_id = v_account
     FOR UPDATE OF k;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'key_not_found' USING ERRCODE = 'P0404';
  END IF;

  UPDATE api_keys k SET revoked_at = now() WHERE k.id = v_key AND k.revoked_at IS NULL;

  RETURN QUERY
  SELECT k.id, k.project_id, k.environment, k.kind, k.name, k.prefix, k.tenant_id,
         k.created_at, k.last_used_at, k.revoked_at
    FROM api_keys k
   WHERE k.id = v_key;
END
$$;

COMMENT ON FUNCTION dashboard_key_revoke(text, uuid, timestamptz) IS
  'Revokes a key of a project of the account of a live dashboard session and returns it. '
  'Refuses with P0401 (no live session) or P0404 (not a key of that account).';

-- --- 11. dashboard_purge -----------------------------------------------------------------------

CREATE FUNCTION dashboard_purge()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- A link lives fifteen minutes and is counted by the ceilings for an hour: past the hour it
  -- is neither usable nor counted, and its address has no reason to stay.
  login_retention   constant interval := interval '1 hour';
  session_retention constant interval := interval '7 days';
  touched           integer := 0;
  affected          integer;
BEGIN
  DELETE FROM dashboard_logins l WHERE l.created_at < now() - login_retention;
  GET DIAGNOSTICS affected = ROW_COUNT;
  touched := touched + affected;

  DELETE FROM dashboard_sessions s
   WHERE s.expires_at < now() - session_retention
      OR s.revoked_at < now() - session_retention;
  GET DIAGNOSTICS affected = ROW_COUNT;
  touched := touched + affected;

  RETURN touched;
END
$$;

COMMENT ON FUNCTION dashboard_purge() IS
  'Housekeeping for the dashboard tables: deletes the link requests older than an hour, and the '
  'sessions that expired or were revoked more than seven days ago. Returns how many rows went. '
  'It takes no instant: a purge that could be told the time could be told to delete more.';

-- --- privileges ---------------------------------------------------------------------------------
--
-- `EXECUTE` on the functions, and nothing on the two tables. The job role gets nothing: the purge
-- runs in the worker on the application pool, like the sign up purge.

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'signup_confirm(text, uuid, uuid, uuid, text, text, text, uuid, text, text, text, text)',
    'signup_claim(uuid, text)',
    'signup_start(uuid, text, text, text, text, text, text, text, text, text)',
    'dashboard_login_start(text, text, text)',
    'dashboard_login_confirm(text, text, timestamptz)',
    'dashboard_session_resolve(text, timestamptz)',
    'dashboard_session_revoke(text)',
    'dashboard_account_overview(text, text, timestamptz)',
    'dashboard_key_create(text, uuid, text, uuid, text, text, text, timestamptz)',
    'dashboard_key_revoke(text, uuid, timestamptz)',
    'dashboard_purge()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
