-- 0010 — `Idempotency-Key` storage, and the schema the job queue owns (brief 003b).
--
-- ## idempotency_keys
--
-- `05-api-reference.md § Principi` point 3 promises that the same `Idempotency-Key` within
-- 24 hours yields the same response and no second effect. That promise cannot be kept by a
-- read-then-write: twenty requests carrying one key arrive together, all twenty read "no such
-- key", and all twenty book. It is kept by this table's UNIQUE constraint instead — the first
-- request to insert the row owns the key, every other one loses the insert and is told so.
--
-- The row therefore has three states, and the columns exist to tell them apart:
--
--   * **claimed** — `completed_at IS NULL`, `locked_at` recent. A request is running. A second
--     request with the same key gets `409 idempotency_key_in_progress`.
--   * **stale** — `completed_at IS NULL`, `locked_at` older than the lease. The process that
--     claimed it died before answering. The next request takes the claim over, so a crash
--     cannot wedge a key for the whole 24 hours.
--   * **completed** — `response_status` and `response_body` are the answer that was actually
--     sent, and every later request with the same key and the same `request_hash` receives it
--     verbatim. Error answers are stored too (a 409 `slot_unavailable` must not become a 201
--     on a retry); 5xx answers are **not**, and the API deletes the row instead, because a
--     server fault is exactly the case a client should be able to retry.
--
-- `request_hash` is a SHA-256 of the method, the path and the raw body. Same key + different
-- hash is a client bug and is refused with `400 idempotency_key_reused`, never silently
-- served the first response.
--
-- `expires_at` is `created_at + 24 hours`; the hourly job of `10 § Job e scheduler` deletes
-- what is past it. Nothing else reads that column: a key is honoured until it is deleted.
--
-- RLS, the isolation policy and the grants are exactly the ones every other project table
-- gets from 0007 — the loop there ran before this table existed, so they are repeated here
-- verbatim rather than reworded.
--
-- ## The pgboss schema
--
-- The hold expiry job runs on pg-boss (`10 § Job e scheduler`), which keeps its queue in its
-- own schema and runs its own DDL migrations at start-up. Two decisions, made here so they
-- are reviewable and not a side effect of whichever process boots first:
--
--  1. **pg-boss connects as the migration/admin role**, which owns this schema. It needs
--     CREATE on the schema and ownership of its tables, and 0007 deliberately took CREATE
--     away from the application role; handing it back for a queue would widen the role that
--     serves HTTP for no benefit.
--  2. **the application role is granted nothing here.** No USAGE, no privileges. The API
--     process cannot read or write the queue at all, and there is nothing tenant-scoped in it
--     to read: the jobs carry no payload.
--
-- The schema is created **if it does not exist** and never dropped here. pg-boss itself runs
-- `CREATE SCHEMA IF NOT EXISTS pgboss` at start-up, so on a deployment where the worker booted
-- before the migration the schema is already there, with a live queue in it: a `DROP … CASCADE`
-- in a migration would wait for an ACCESS EXCLUSIVE lock behind the worker's polling
-- connections — hanging the deploy — and then delete that queue (revisione indipendente, I1).
-- Throwing the queue away is a property of a *reset*, not of a schema change, and lives in
-- `resetSchema()` (`pnpm db:reset`).
--
-- Creating it here rather than leaving it to pg-boss is still worth a statement: it makes the
-- ownership and the (absent) privileges of the application role reviewable in the schema
-- history instead of being a side effect of whichever process booted first.

CREATE SCHEMA IF NOT EXISTS pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment     text NOT NULL CHECK (environment IN ('test', 'live')),
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash    text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body   jsonb,
  locked_at       timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A completed row is the response it stored: both halves, or neither.
  CHECK ((completed_at IS NULL) = (response_status IS NULL)),
  UNIQUE (id, project_id, environment),
  -- The whole mechanism. Scoped to the project and the environment, so a test key and a live
  -- key of the same project never collide, and two projects may use the same key text.
  UNIQUE (project_id, environment, key)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

COMMENT ON TABLE idempotency_keys IS
  'One row per Idempotency-Key seen, per project and environment. '
  '05-api-reference.md, § Principi punto 3.';

-- The same `updated_at` trigger every other table got from 0006.
CREATE TRIGGER idempotency_keys_set_updated_at
  BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_project_isolation ON idempotency_keys
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

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO ${APP_ROLE};
