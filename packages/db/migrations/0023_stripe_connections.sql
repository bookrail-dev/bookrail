-- 0023: the link between a project and the Stripe account its money goes to (brief 009a).
--
-- Bookrail is a Connect platform of the SaaS kind: the customer stays the merchant, charges are
-- made directly on the customer's own account with `Stripe-Account`, and Bookrail never holds a
-- key of theirs and never holds funds. What this migration stores is therefore not a credential
-- but an identifier, `acct_...`, plus the state of the link and the moments it changed.
--
-- ## Why a table of its own, and not `projects.settings`
--
-- `projects` is control plane: it carries no `project_id` column, it has no per project policy,
-- and the application role holds `SELECT` on it and nothing else (migration 0007). A connection
-- written there would be readable by every request of every project and writable by none, which
-- is the opposite of what it needs. The connection is project data, so it lives in a project
-- table, under the same forced policy as every other one, keyed on both `project_id` and
-- `environment`.
--
-- ## What is deliberately not here
--
-- The OAuth exchange answers with `access_token` and `refresh_token` next to `stripe_user_id`.
-- Neither is stored. For a Standard account they are a deprecated second way of doing what the
-- platform key plus `Stripe-Account` already does, so keeping them would mean holding a secret
-- of somebody else's for no gain, and the safest secret is the one that was never written down.
--
-- ## livemode
--
-- The OAuth answer says which mode the authorisation was granted in, and a test authorisation
-- attached to the live environment (or the other way round) is not a case to handle at run time
-- but a row that must not be able to exist. `CHECK (livemode = (environment = 'live'))` is that
-- rule, in the one place that cannot be bypassed.
--
-- ## The state of the OAuth flow
--
-- `stripe_oauth_states` holds the CSRF token of a single authorisation attempt, as a SHA-256
-- digest: the value itself travels in a URL and in a browser and never reaches this database.
-- The callback arrives from a browser with no API key at all, so the one read of that table is
-- `stripe_oauth_state_claim`, a `SECURITY DEFINER` function of the same shape as the ones in
-- 0013 and 0021: it resolves a digest to the project, the environment and the API key that
-- asked, and nothing else; it deletes the row in the same statement, so a replay finds nothing;
-- and it ignores a row whose fifteen minutes have run out.

-- --- payment_provider_connections ---------------------------------------------------------
--
-- Named for the provider in general, because `07-pagamenti-e-policy.md` expects others, and
-- constrained to `stripe` because that is the only one this build knows. A second provider
-- widens the CHECK; nothing else about the shape changes.

CREATE TABLE payment_provider_connections (
  id                  uuid PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment         text NOT NULL CHECK (environment IN ('test', 'live')),
  provider            text NOT NULL CHECK (provider = 'stripe'),
  -- `acct_...`: an identifier, not a secret. It is what goes into `Stripe-Account`.
  -- The shape as well as the length. This value goes into the `Stripe-Account` header of every
  -- call made for this customer, so what it is allowed to be is worth pinning down in the one
  -- place that cannot be bypassed rather than trusting every future writer of that header.
  provider_account_id text NOT NULL
                        CHECK (provider_account_id ~ '^acct_[A-Za-z0-9]+$'
                               AND length(provider_account_id) <= 255),
  status              text NOT NULL CHECK (status IN ('connected', 'disconnected')),
  connected_at        timestamptz NOT NULL,
  disconnected_at     timestamptz,
  -- 'user' when the customer ran `bookrail stripe disconnect`, 'deauthorized' when Stripe told
  -- us the account was unlinked from its own dashboard (the webhook arrives with brief 009b).
  disconnect_reason   text CHECK (disconnect_reason IN ('user', 'deauthorized')),
  livemode            boolean NOT NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (livemode = (environment = 'live')),
  CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
  -- One connection per project, environment and provider. A project that disconnects and
  -- reconnects reuses this row rather than growing a second one.
  UNIQUE (project_id, environment, provider),
  -- The composite a future foreign key from `payments` needs, so that a payment can never
  -- reference a connection of another project or of the other environment.
  UNIQUE (id, project_id, environment)
);

-- How brief 009b resolves an incoming Stripe webhook, which names an account and not a project.
CREATE INDEX payment_provider_connections_account_idx
  ON payment_provider_connections (provider, provider_account_id);

COMMENT ON TABLE payment_provider_connections IS
  'One row per project, environment and payment provider: the account charges are made on. It '
  'holds an identifier and a state, never a credential: the OAuth tokens the authorisation '
  'returns are deliberately not stored.';
COMMENT ON COLUMN payment_provider_connections.provider_account_id IS
  'The provider''s own account identifier (acct_... for Stripe). Public by nature: it is sent '
  'as a request header, not as a secret.';
COMMENT ON COLUMN payment_provider_connections.livemode IS
  'What the authorisation was granted in. A CHECK ties it to the environment, so a test '
  'account can never be attached to the live environment.';

-- --- stripe_oauth_states --------------------------------------------------------------------

CREATE TABLE stripe_oauth_states (
  id          uuid PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  -- SHA-256 of the 32 random bytes that travelled in the authorisation URL. The clear text
  -- never reaches this database, so a dump of this table cannot be replayed into a connection.
  state_hash  bytea NOT NULL UNIQUE CHECK (length(state_hash) = 32),
  -- Which credential asked for the link. It becomes the `actor` of the `stripe.connected`
  -- event, because the browser that comes back carries no credential of its own.
  api_key_id  uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stripe_oauth_states_housekeeping_idx ON stripe_oauth_states (expires_at);

COMMENT ON TABLE stripe_oauth_states IS
  'One row per authorisation attempt: the SHA-256 of the state parameter, the project it binds '
  'the callback to, and fifteen minutes. Consumed exactly once, by stripe_oauth_state_claim.';

-- --- row level security and privileges ------------------------------------------------------
--
-- The same loop as migration 0007, with the same policy text. Both tables carry `project_id`
-- and `environment`, so both are ordinary project tables: an empty RLS context sees zero rows.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_provider_connections', 'stripe_oauth_states']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        FOR ALL
        TO ${APP_ROLE}
        USING (
          project_id = nullif(current_setting('app.project_id', true), '')::uuid
          AND environment = nullif(current_setting('app.environment', true), '')
        )
        WITH CHECK (
          project_id = nullif(current_setting('app.project_id', true), '')::uuid
          AND environment = nullif(current_setting('app.environment', true), '')
        )
    $p$, t || '_project_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ${APP_ROLE}', t);
  END LOOP;
END
$$;

-- --- updated_at ------------------------------------------------------------------------------
--
-- Only the connection has one: a state row is written once and deleted, never updated.

CREATE TRIGGER payment_provider_connections_set_updated_at
  BEFORE UPDATE ON payment_provider_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- stripe_oauth_state_claim -----------------------------------------------------------------
--
-- The one read the callback can make, and the only thing in this migration that runs with more
-- privilege than the caller has.
--
-- The four properties every definer function here carries (0013, 0014, 0015, 0016, 0021, 0022):
--   * `SECURITY DEFINER`, owned by the migration role;
--   * `SET search_path = public, pg_temp`;
--   * `EXECUTE` revoked from `PUBLIC` and granted to the application role alone;
--   * a fixed return type that cannot carry a row of anybody's data out. Here that is three
--     columns: the project, the environment, and the API key that asked for the link. The third
--     one is there because the callback has to write a `stripe.connected` event and an event
--     records who did it; the browser that completes the flow carries no credential, so the
--     only honest actor is the key that started the flow. Nothing else of the row comes out:
--     not the moment it was created, not the digest that was passed in.
--
-- `DELETE ... RETURNING` rather than a SELECT then a DELETE, for the reason `signup_claim`
-- gives: one statement, so two browsers arriving with the same state cannot both be told which
-- project it belonged to. The loser gets zero rows, which the route answers as "this link has
-- already been used".
--
-- An expired row is deleted all the same and simply not returned: a state past its fifteen
-- minutes is usable by nobody, so there is nothing to keep, and from the caller's side it is
-- indistinguishable from a state that never existed. That is why the expiry is a filter on the
-- `RETURNING` of the delete rather than a condition of the delete itself.
--
-- The same is true of a state whose API key has since been **revoked**. The callback carries no
-- credential of its own, so the credential that asked for the link is the only one there is to
-- check, and a link minted by a key that has since been taken away must stop working at that
-- moment rather than fifteen minutes later. The join is here, inside the definer function,
-- because the caller has no project context yet and could not read `api_keys` at all; and it is
-- a filter on the `RETURNING` for the same reason as the expiry, so the row is consumed either
-- way and a revoked link cannot be retried.

CREATE FUNCTION stripe_oauth_state_claim(p_state_hash bytea, p_now timestamptz DEFAULT now())
RETURNS TABLE (project_id uuid, environment text, api_key_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH claimed AS (
    DELETE FROM stripe_oauth_states s
     WHERE s.state_hash = p_state_hash
    RETURNING s.project_id, s.environment, s.api_key_id, s.expires_at
  )
  SELECT c.project_id, c.environment, c.api_key_id
    FROM claimed c
    JOIN api_keys k ON k.id = c.api_key_id
   WHERE c.expires_at > p_now
     AND k.revoked_at IS NULL
$$;

COMMENT ON FUNCTION stripe_oauth_state_claim(bytea, timestamptz) IS
  'Consumes one OAuth state, by the SHA-256 of its clear text, and answers the project, the '
  'environment and the API key it was created for. Zero rows when it never existed, when '
  'somebody else got there first, when it had expired, or when the key that asked for it has '
  'been revoked since. The row is gone in every one of those cases.';

-- --- housekeeping -----------------------------------------------------------------------------
--
-- Called by the hourly purge job next to the idempotency keys and the sign ups: the same
-- sweep, one statement more. A state row carries no address and no secret, so this is tidiness
-- rather than retention, but an unbounded table of dead rows is its own kind of bug.

CREATE FUNCTION stripe_oauth_states_purge(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM stripe_oauth_states s WHERE s.expires_at <= p_now;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;

COMMENT ON FUNCTION stripe_oauth_states_purge(timestamptz) IS
  'Deletes every OAuth state whose fifteen minutes have run out and returns how many. The '
  'instant is a parameter so that a test can ask what an hour from now does.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'stripe_oauth_state_claim(bytea, timestamptz)',
    'stripe_oauth_states_purge(timestamptz)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
