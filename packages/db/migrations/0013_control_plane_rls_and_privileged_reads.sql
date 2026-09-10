-- 0013 — Row Level Security on the control plane, and the three reads that used to need a
-- privileged connection (brief 007a, points 1, 2 and 3).
--
-- Everything here answers the same question in three places: *who* is allowed to see a row
-- that does not belong to the project of the current request. Until now the answer was "the
-- application role, if it happens to be outside a project context" (the api_keys lookup
-- policy) or "a superuser connection the worker keeps open" (the cross-project sweeps). Both
-- are answers the database cannot check. From this migration on the answer is a named
-- function with a fixed result shape, and the application role gets nothing else.
--
-- ## Why SECURITY DEFINER and not a second role
--
-- A second login role would need its own credentials, its own rotation and its own place in
-- every deployment description; and it would still be able to read *whole tables*, because a
-- role is not a query. A `SECURITY DEFINER` function is the smallest thing that answers
-- exactly one question: `due_hold_expiry_scopes` can return (project_id, environment) pairs
-- and nothing else, whatever the caller does with it. `12-sicurezza-e-compliance.md
-- § Segreti e accesso alla produzione` asks for least privilege; a function whose return type
-- is `TABLE(project_id uuid, environment text)` is the least privilege that answers "which
-- projects have work".
--
-- Every function below therefore carries the same four properties:
--   * `SECURITY DEFINER`, owned by the migration role, so it is not subject to the policies
--     that make the question unanswerable to the application role;
--   * `SET search_path = public, pg_temp`, so a caller cannot shadow a table or an operator
--     with something of its own and have it run with the definer's privileges;
--   * `EXECUTE` revoked from `PUBLIC` and granted to the application role only;
--   * a return type that carries no tenant data. Scope pairs, or a count of deleted rows.

-- --- 1. accounts and projects ------------------------------------------------------------------
--
-- `12 § Isolamento dei dati` promises Row Level Security on every table a request can reach,
-- and these two were the exception: control plane, read-only for the application role, and
-- visible in full from any context. Nothing needed the whole table — `GET /v1/project` reads
-- the single row named by the authenticated key — so the exception bought nothing and cost the
-- one sentence in `12` that was not true.
--
-- The policies are the same shape as every other one: the failure mode of a missing context is
-- *zero rows*, never the whole table. `projects` pins its own `id` to `app.project_id`;
-- `accounts` is reachable only through the project that belongs to it, which is why its policy
-- is an `EXISTS` over `projects` rather than a second copy of the same condition. That
-- subquery is itself subject to the `projects` policy, so the two can never drift.
--
-- There is deliberately no `environment` in either condition: neither table has the column.
-- An account and a project exist once and serve both environments; the environment barrier is
-- on the rows that carry data, where `04 § Invarianti` (7) puts it.

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_control_plane_isolation ON projects
  FOR ALL
  TO ${APP_ROLE}
  USING (id = nullif(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK (false);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY accounts_control_plane_isolation ON accounts
  FOR ALL
  TO ${APP_ROLE}
  USING (
    EXISTS (
      SELECT 1 FROM projects p
       WHERE p.account_id = accounts.id
         AND p.id = nullif(current_setting('app.project_id', true), '')::uuid
    )
  )
  WITH CHECK (false);

COMMENT ON POLICY projects_control_plane_isolation ON projects IS
  'The application role sees the single project named by app.project_id, and nothing with an '
  'empty context. Writes stay with the admin connection (POST /internal/bootstrap).';
COMMENT ON POLICY accounts_control_plane_isolation ON accounts IS
  'The account of the project named by app.project_id, through the projects policy.';

-- --- 2. The API key lookup ----------------------------------------------------------------------
--
-- `api_keys_auth_lookup` (migration 0007) granted `SELECT` on the **whole** table whenever no
-- project context was set. It was the only policy in the system whose failure mode was "sees
-- everything" rather than "sees nothing": authentication has to find the key before it knows
-- the project, so there was no context to pin it to. The single caller filtered on a UNIQUE
-- `key_hash`, so nothing ever read more than one row — but that was a property of the code,
-- not of the database, and `STATO-APP § Debito tecnico` has said so since brief 001.
--
-- The policy is replaced by a function that *is* the filter. It returns one row or none, and
-- the columns it returns are exactly the ones `middleware/auth.ts` reads. With the policy gone
-- the application role sees zero rows in `api_keys` outside a project context, like every
-- other table.
--
-- `last_used_at` stays where it is: an `UPDATE (last_used_at)` by the application role, inside
-- the project context the request has just adopted, under `api_keys_project_isolation`. It
-- needs no elevation — by then the project is known — and moving it into a second definer
-- function would take a write that Row Level Security currently checks and put it beyond it,
-- which is the wrong direction for the only write the runtime has on this table.

DROP POLICY api_keys_auth_lookup ON api_keys;

CREATE FUNCTION auth_lookup_api_key(p_key_hash text, p_prefix text)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  environment text,
  kind text,
  scopes text[],
  tenant_id text,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.project_id, k.environment, k.kind, k.scopes, k.tenant_id, k.revoked_at
    FROM api_keys k
   WHERE k.key_hash = p_key_hash
     AND k.prefix = p_prefix
   LIMIT 1
$$;

COMMENT ON FUNCTION auth_lookup_api_key(text, text) IS
  'Resolves a presented secret key to the row authentication needs, or to nothing. The only '
  'read of api_keys that is allowed outside a project context, and it returns at most one row. '
  'Both the hash and the prefix are matched: the prefix is part of the key text the caller '
  'sent, and matching it as well keeps a hash collision from resolving to another key.';

REVOKE ALL ON FUNCTION auth_lookup_api_key(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_api_key(text, text) TO ${APP_ROLE};

-- --- 3. The worker's cross-project questions ----------------------------------------------------
--
-- Four sweeps ask *which* projects have work, and one deletes rows that belong to no project in
-- particular. Row Level Security makes all five unanswerable to the application role by
-- construction — it sees one project at a time — so until now the worker kept a superuser pool
-- open beside its application pool. `11 § Il worker dei job` and `12 § Segreti` both want that
-- pool gone: a long-lived privileged connection in a process whose whole job is to run
-- unattended is the largest privilege in the deployment and the least watched.
--
-- Each function is the discovery query that used to run on that connection, with the same
-- ordering, the same limit and the same reasoning; what changes is that its result type cannot
-- carry a booking, a customer or an event. Everything the worker then reads or writes still
-- goes through the application role, inside `withProjectContext`, exactly as before.
--
-- `LIMIT` is a parameter rather than a constant because the callers already own those numbers
-- (`MAX_SCOPES_PER_TICK` and friends), and a limit that lived in two places would drift.

CREATE FUNCTION due_hold_expiry_scopes(max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT o.project_id, o.environment
    FROM occupancies o
   WHERE o.kind = 'hold' AND o.active AND o.expires_at <= now()
   ORDER BY o.project_id, o.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION due_hold_expiry_scopes(integer) IS
  'The (project, environment) pairs with at least one hold occupancy past its expiry. Ordered '
  'so the answer is stable, capped so one tick cannot hold the worker for minutes.';

CREATE FUNCTION due_transition_scopes(due_at timestamptz, max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT b.project_id, b.environment
    FROM bookings b
   WHERE b.next_transition IS NOT NULL
     AND b.next_transition_at <= due_at
   ORDER BY b.project_id, b.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION due_transition_scopes(timestamptz, integer) IS
  'The (project, environment) pairs with a booking whose automatic transition is due at `at`. '
  'The instant is the caller''s, not now(): a test asks what would happen next Monday.';

CREATE FUNCTION webhook_outbox_scopes(max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.project_id, s.environment
    FROM (
      SELECT w.project_id, w.environment,
             COALESCE(c.updated_at, '-infinity'::timestamptz) AS last_visit
        FROM (SELECT DISTINCT wh.project_id, wh.environment FROM webhooks wh) w
        LEFT JOIN outbox_cursor c
          ON c.project_id = w.project_id AND c.environment = w.environment
    ) s
   ORDER BY s.last_visit ASC, s.project_id, s.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION webhook_outbox_scopes(integer) IS
  'The scopes with at least one webhook endpoint, oldest visit first. The rotation of brief '
  '004b (I5): the set does not drain, so a fixed order plus a fixed LIMIT would starve '
  'everything past the limit for ever.';

CREATE FUNCTION due_webhook_delivery_scopes(due_at timestamptz, max_scopes integer)
RETURNS TABLE (project_id uuid, environment text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT d.project_id, d.environment
    FROM webhook_deliveries d
    JOIN webhooks w ON w.id = d.webhook_id
   WHERE d.status = 'pending'
     AND w.status <> 'disabled'
     AND d.next_attempt_at IS NOT NULL
     AND d.next_attempt_at <= due_at
     AND (d.leased_until IS NULL OR d.leased_until <= due_at)
   ORDER BY d.project_id, d.environment
   LIMIT max_scopes
$$;

COMMENT ON FUNCTION due_webhook_delivery_scopes(timestamptz, integer) IS
  'The scopes with a delivery that is due and not leased. Unlike the outbox this set drains, '
  'so a fixed LIMIT starves nobody.';

-- The one function here that writes. It is housekeeping and not a decision: an
-- `idempotency_keys` row past its retention carries a stored response nobody may replay any
-- more, and the row belongs to no project in particular once it is dead. It returns a count,
-- never a row.
CREATE FUNCTION purge_expired_idempotency_keys(max_rows integer)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH doomed AS (
    SELECT id FROM idempotency_keys WHERE expires_at <= now() LIMIT max_rows
  ), gone AS (
    DELETE FROM idempotency_keys k USING doomed WHERE k.id = doomed.id RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;

COMMENT ON FUNCTION purge_expired_idempotency_keys(integer) IS
  'Deletes at most max_rows expired Idempotency-Key rows and returns how many went. The cap '
  'keeps a first run after a long outage from writing one enormous transaction.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'due_hold_expiry_scopes(integer)',
    'due_transition_scopes(timestamptz, integer)',
    'webhook_outbox_scopes(integer)',
    'due_webhook_delivery_scopes(timestamptz, integer)',
    'purge_expired_idempotency_keys(integer)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
