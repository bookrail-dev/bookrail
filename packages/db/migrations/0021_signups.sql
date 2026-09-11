-- 0021: self service sign up for a test key.
--
-- Until now an account, a project and a pair of keys came into being in exactly one way: a
-- human ran `bookrail-bootstrap` over SSH, on the connection that bypasses Row Level Security.
-- That connection is not in the process exposed to the internet and must not come back, so an
-- endpoint that creates an account for whoever asks cannot be written the way the bootstrap is
-- written. It is written the way the cross project questions of migration 0013 are: as
-- `SECURITY DEFINER` functions owned by the migration role, each doing one thing, each checking
-- everything it needs to check inside itself, and each returning a fixed row shape that cannot
-- carry somebody else's data out.
--
-- The four functions below are the entire surface. The application role is granted `EXECUTE` on
-- them and nothing at all on the table they read and write.
--
-- ## The shape of the flow
--
--   1. `signup_start`   records an intent: an address, the hash of a token that only the owner
--                       of that address will ever see, and the names the account will get. It
--                       says nothing about whether the address is already taken.
--   2. `signup_confirm`  is reached only by somebody holding the token, that is by whoever
--                       opened the mailbox. It creates the account, the project and one test
--                       key, in one transaction, or reports that the address already has an
--                       account and creates nothing.
--   3. `signup_claim`   hands the encrypted key to the terminal that is waiting for it, once.
--   4. `signups_purge`  is housekeeping, called by the hourly job.
--
-- ## Why the table has no policy at all
--
-- Every other table here answers "which rows may this request see" with a policy keyed on the
-- project of the request. A sign up row belongs to no project: it exists precisely because
-- there is not one yet. There is no context to key a policy on, so instead of inventing one the
-- table is closed: row security is enabled and forced, no policy is created, and no privilege
-- is granted to the application role or to the job role. The failure mode of a mistake in the
-- application is therefore zero rows and a permission error, never a list of everybody who has
-- ever asked for a key.
--
-- The migration role owns the table and the functions and carries `BYPASSRLS`, which is what
-- lets a `SECURITY DEFINER` function read the rows that the forced policy hides from everybody
-- else, including from the owner.
--
-- ## Anti enumeration
--
-- `signup_start` deliberately does not look at `accounts`. Answering differently for an address
-- that already has an account would turn the endpoint into a way of asking "is this person a
-- customer", and it is an endpoint with no key in front of it. The collision is reported by
-- `signup_confirm`, which is reached only by whoever can read the mailbox.
--
-- ## The secret in flight
--
-- A key created for a terminal cannot be returned in the answer to the browser that clicked the
-- link: the two are different processes on possibly different machines. So the confirm stores
-- it, encrypted by the application under the key that already encrypts webhook signing secrets,
-- and `signup_claim` returns it exactly once and clears the column in the same statement. The
-- clear text never exists in this database, and the envelope never lives longer than fifteen
-- minutes.

-- --- accounts: where an account came from, and who owns it -------------------------------------
--
-- `origin` separates the accounts a human created from the ones the endpoint created. It is not
-- decoration: the unique index below applies to the second kind only, so that the founder can
-- still create a second account by hand for somebody who asks for one.
--
-- `owner_email` is stored in lower case, enforced by a CHECK rather than by the application,
-- because the uniqueness of an address is the whole guarantee and a guarantee that depends on
-- the caller having normalised its input is not a guarantee.

ALTER TABLE accounts
  ADD COLUMN origin text NOT NULL DEFAULT 'bootstrap'
    CHECK (origin IN ('bootstrap', 'self_serve')),
  ADD COLUMN owner_email text
    CHECK (owner_email IS NULL OR owner_email = lower(owner_email));

CREATE UNIQUE INDEX accounts_self_serve_owner_email_idx
  ON accounts (owner_email)
  WHERE origin = 'self_serve';

COMMENT ON COLUMN accounts.origin IS
  'How the account came into being: bootstrap (a human ran the command) or self_serve (the '
  'sign up endpoint created it). Only the second kind is unique per owner_email.';
COMMENT ON COLUMN accounts.owner_email IS
  'The address that confirmed the sign up, in lower case. NULL for an account created by hand.';

-- --- signups -----------------------------------------------------------------------------------

CREATE TABLE signups (
  id                        uuid PRIMARY KEY,
  email                     text NOT NULL
                              CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  -- SHA-256, hex. The clear text token exists only in the message that was sent.
  token_hash                text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Present only for a terminal: the browser is handed the key in the confirm response and has
  -- nothing to come back for.
  poll_token_hash           text UNIQUE CHECK (poll_token_hash ~ '^[0-9a-f]{64}$'),
  client                    text NOT NULL CHECK (client IN ('cli', 'web')),
  -- SHA-256 of the caller's address. The address itself is never written down: the rate limit
  -- needs to compare two requests, not to know where they came from.
  ip_hash                   text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  account_name              text NOT NULL CHECK (length(account_name) BETWEEN 1 AND 200),
  project_name              text NOT NULL CHECK (length(project_name) BETWEEN 1 AND 200),
  default_timezone          text NOT NULL,
  default_currency          text NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  status                    text NOT NULL
                              CHECK (status IN ('pending', 'confirmed', 'claimed',
                                                'email_taken', 'expired')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL,
  confirmed_at              timestamptz,
  account_id                uuid REFERENCES accounts (id) ON DELETE SET NULL,
  project_id                uuid REFERENCES projects (id) ON DELETE SET NULL,
  -- The key this sign up minted. It is written by the confirm and read back by the claim, and
  -- it is not a convenience: it is the additional authenticated data of the envelope below, so
  -- deriving it again later (the newest test key of the project, say) would decrypt with the
  -- wrong value the day a project has two of them.
  api_key_id                uuid REFERENCES api_keys (id) ON DELETE SET NULL,
  -- The AES-256-GCM envelope of the test key, written by the confirm and cleared by the first
  -- claim. Only ever set for a terminal.
  pending_secret            text,
  pending_secret_expires_at timestamptz,
  CHECK ((poll_token_hash IS NULL) = (client <> 'cli')),
  CHECK ((pending_secret IS NULL) OR (client = 'cli' AND pending_secret_expires_at IS NOT NULL))
);

CREATE INDEX signups_email_created_at_idx ON signups (email, created_at DESC);
CREATE INDEX signups_ip_hash_created_at_idx ON signups (ip_hash, created_at DESC);
CREATE INDEX signups_housekeeping_idx ON signups (created_at);

COMMENT ON TABLE signups IS
  'One row per request for a test key. Reachable only through the four SECURITY DEFINER '
  'functions of this migration: row security is forced and there is no policy, so the '
  'application role sees nothing here even by mistake.';

ALTER TABLE signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE signups FORCE ROW LEVEL SECURITY;

-- --- 1. signup_start ----------------------------------------------------------------------------

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
  p_default_currency text
)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- The two ceilings, declared here so that reading the function is reading the policy.
  max_per_email  constant integer := 3;
  max_per_ip     constant integer := 10;
  window_length  constant interval := interval '24 hours';
  link_lifetime  constant interval := interval '1 hour';
  used_by_email  integer;
  used_by_ip     integer;
  v_expires_at   timestamptz;
BEGIN
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
  'Records one request for a test key and returns its identifier and the moment the link stops '
  'working. Refuses with SQLSTATE P0429 past three requests a day for one address or ten for '
  'one caller. It never looks at accounts: the answer is the same whether or not the address '
  'already has one.';

-- --- 2. signup_confirm --------------------------------------------------------------------------
--
-- Everything happens inside one transaction, and the row is taken `FOR UPDATE` before anything
-- is read from it, so two clicks on the same link cannot both create an account: the second one
-- waits, finds the status already moved and is refused.

CREATE FUNCTION signup_confirm(
  p_token_hash text,
  p_account_id uuid,
  p_project_id uuid,
  p_key_id uuid,
  p_key_prefix text,
  p_key_hash text,
  p_key_name text,
  p_pending_secret text
)
RETURNS TABLE (
  id uuid,
  status text,
  client text,
  account_id uuid,
  project_id uuid,
  api_key_id uuid,
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
    -- Not an error: the person did everything right, and the caller has something kind to say.
    -- Nothing is created, and the row is closed so the link cannot be used again.
    UPDATE signups s
       SET status = 'email_taken', confirmed_at = now()
     WHERE s.id = row_signup.id;
    RETURN QUERY SELECT row_signup.id, 'email_taken'::text, row_signup.client,
                        NULL::uuid, NULL::uuid, NULL::uuid,
                        row_signup.account_name, row_signup.project_name,
                        row_signup.default_timezone, row_signup.default_currency;
    RETURN;
  END IF;

  -- The read above answers for the state it saw. Two sign ups of the **same** address, opened
  -- at the same instant, lock two different rows, so both read `taken = false` and both try to
  -- insert; the partial unique index on `accounts` is what actually stops the second, and this
  -- block is what turns that refusal into the documented answer instead of letting a raw
  -- `unique_violation` out as a generic conflict. The subtransaction rolls back the whole
  -- attempt, so nothing half made survives.
  BEGIN
    INSERT INTO accounts (id, name, origin, owner_email)
    VALUES (p_account_id, row_signup.account_name, 'self_serve', row_signup.email);

    INSERT INTO projects (id, account_id, name, default_timezone, default_currency)
    VALUES (p_project_id, p_account_id, row_signup.project_name,
            row_signup.default_timezone, row_signup.default_currency);

    -- One key, and it is a test key. A live key still comes from a person.
    INSERT INTO api_keys (id, project_id, environment, kind, name, prefix, key_hash,
                          scopes, tenant_id)
    VALUES (p_key_id, p_project_id, 'test', 'secret', p_key_name, p_key_prefix, p_key_hash,
            '{}'::text[], NULL);
  EXCEPTION WHEN unique_violation THEN
    UPDATE signups s
       SET status = 'email_taken', confirmed_at = now()
     WHERE s.id = row_signup.id;
    RETURN QUERY SELECT row_signup.id, 'email_taken'::text, row_signup.client,
                        NULL::uuid, NULL::uuid, NULL::uuid,
                        row_signup.account_name, row_signup.project_name,
                        row_signup.default_timezone, row_signup.default_currency;
    RETURN;
  END;

  -- A browser is holding the answer open, so the key travels in the response and is never
  -- stored. A terminal is not, so the envelope waits for it.
  final_status := CASE WHEN row_signup.client = 'cli' THEN 'confirmed' ELSE 'claimed' END;

  UPDATE signups s
     SET status = final_status,
         confirmed_at = now(),
         account_id = p_account_id,
         project_id = p_project_id,
         api_key_id = p_key_id,
         pending_secret = CASE WHEN row_signup.client = 'cli' THEN p_pending_secret END,
         pending_secret_expires_at =
           CASE WHEN row_signup.client = 'cli' THEN now() + secret_lifetime END
   WHERE s.id = row_signup.id;

  RETURN QUERY SELECT row_signup.id, final_status, row_signup.client,
                      p_account_id, p_project_id, p_key_id,
                      row_signup.account_name, row_signup.project_name,
                      row_signup.default_timezone, row_signup.default_currency;
END
$$;

COMMENT ON FUNCTION signup_confirm(text, uuid, uuid, uuid, text, text, text, text) IS
  'Turns a confirmed request into an account, a project and one test key, in one transaction, '
  'or reports email_taken and creates nothing. The row is locked FOR UPDATE first, so two '
  'clicks on the same link produce one account and one refusal.';

-- --- 3. signup_claim ----------------------------------------------------------------------------
--
-- The identifier alone is not enough to claim: the poll token has to match as well, and both
-- are in the `WHERE`, so a wrong token is indistinguishable from a wrong identifier.

CREATE FUNCTION signup_claim(p_id uuid, p_poll_token_hash text)
RETURNS TABLE (
  status text,
  -- What the row was before this call. It is the only thing that separates "somebody already
  -- collected this key" from "nobody came within fifteen minutes", and the caller says
  -- something different for each.
  previous_status text,
  pending_secret text,
  expires_at timestamptz,
  account_id uuid,
  project_id uuid,
  api_key_id uuid,
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
    -- Cleared either way, and in the same statement that moves the status: a secret that has
    -- been handed over once, and a secret nobody came for in time, are both gone from here.
    UPDATE signups s
       SET status = 'claimed', pending_secret = NULL, pending_secret_expires_at = NULL
     WHERE s.id = row_signup.id;
    row_signup.status := 'claimed';
  END IF;

  -- The three identifiers come off the row the confirm wrote, never from a second lookup: the
  -- one in `api_key_id` is the additional authenticated data the envelope was sealed with, and
  -- a value derived again from the project would be the wrong one as soon as a project has a
  -- second test key.
  RETURN QUERY SELECT row_signup.status, was, envelope, row_signup.expires_at,
                      row_signup.account_id, row_signup.project_id, row_signup.api_key_id,
                      row_signup.account_name, row_signup.project_name,
                      row_signup.default_timezone, row_signup.default_currency;
END
$$;

COMMENT ON FUNCTION signup_claim(uuid, text) IS
  'Hands the waiting terminal the encrypted key, once, and clears it. A second call finds the '
  'status claimed and no envelope. Both the identifier and the poll token have to match.';

-- --- 4. signups_purge ---------------------------------------------------------------------------

CREATE FUNCTION signups_purge(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  retention constant interval := interval '7 days';
  touched   integer := 0;
  affected  integer;
BEGIN
  UPDATE signups s
     SET pending_secret = NULL, pending_secret_expires_at = NULL
   WHERE s.pending_secret IS NOT NULL AND s.pending_secret_expires_at <= p_now;
  GET DIAGNOSTICS affected = ROW_COUNT;
  touched := touched + affected;

  UPDATE signups s
     SET status = 'expired'
   WHERE s.status = 'pending' AND s.expires_at <= p_now;
  GET DIAGNOSTICS affected = ROW_COUNT;
  touched := touched + affected;

  DELETE FROM signups s WHERE s.created_at < p_now - retention;
  GET DIAGNOSTICS affected = ROW_COUNT;
  touched := touched + affected;

  RETURN touched;
END
$$;

COMMENT ON FUNCTION signups_purge(timestamptz) IS
  'Housekeeping for the sign up table: clears every envelope past its fifteen minutes, marks '
  'the unconfirmed requests whose hour has run out, and deletes everything older than seven '
  'days. Returns how many rows were touched. The instant is a parameter so that a test can ask '
  'what next week does without waiting for it.';

-- --- privileges ---------------------------------------------------------------------------------
--
-- `EXECUTE` on the four functions, and nothing on the table. The job role gets nothing at all:
-- the purge is called by the worker on the application pool, like every other sweep.

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'signup_start(uuid, text, text, text, text, text, text, text, text, text)',
    'signup_confirm(text, uuid, uuid, uuid, text, text, text, text)',
    'signup_claim(uuid, text)',
    'signups_purge(timestamptz)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
