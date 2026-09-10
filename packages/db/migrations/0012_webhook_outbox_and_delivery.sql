-- 0012 — Webhook delivery: the outbox cursor, one delivery per (webhook, event), and what an
-- attempt records (brief 004b).
--
-- ## The problem this cursor has to solve
--
-- `events` is the transactional outbox (`10-architettura-tecnica.md § Eventi`): the row that
-- describes a change is written by the transaction that made it, so no event survives a
-- rollback and none is missing from a commit. What did not exist until now is the consumer, and
-- a consumer of an append-only log needs one guarantee above all others: **a row it has already
-- stepped over can never appear behind it later.**
--
-- `seq` alone does not give that. It is a `bigserial`, handed out at the `INSERT` and not at the
-- `COMMIT`, so two transactions that insert an event each and commit in the opposite order
-- leave a hole below a cursor that has already passed it (revisione indipendente del 004a, I1).
-- A worker advancing `last_seq` blindly would skip that event **for ever**: not a late webhook,
-- a lost one.
--
-- So the cursor is the pair `(last_txid, last_seq)` and the scan carries the same horizon
-- `GET /v1/events` uses (migration 0011):
--
--   * `txid` is `pg_current_xact_id()` at the `INSERT`. It is handed out in transaction order
--     and never reused, so `(txid, seq)` is a total order fixed the moment a row is written;
--   * the outbox only ever converts rows with
--     `txid < pg_snapshot_xmin(pg_current_snapshot())`. Every transaction below that bound has
--     **finished** — that is what a snapshot's xmin means — so its rows are visible now or
--     never. Everything at or above it is still in flight and, when it commits, carries a
--     *higher* `txid` and therefore sorts after everything already dispatched.
--
-- The price is a delivery latency equal to the longest write transaction open anywhere in the
-- database, exactly as for `GET /v1/events`, and it is written down in
-- `05-api-reference.md § Webhook` rather than discovered.
--
-- ## Why a cursor and not a second outbox table
--
-- The alternative the brief offers is a table of rows to take with `FOR UPDATE SKIP LOCKED`.
-- That means writing a **second** row inside the booking transaction — the critical section
-- that already holds an advisory lock on every candidate resource (`06 § Isolamento`) — to say
-- something the first row already says. The cursor costs nothing on the write path, and the
-- taking still happens: on **this** row, with `FOR UPDATE`, which is what serialises two
-- workers over the same project; and then on `webhook_deliveries`, with
-- `FOR UPDATE SKIP LOCKED`, which is what serialises two workers over the same delivery.
--
-- The cursor is only ever *advanced by* the transaction that inserted the deliveries, so the
-- two cannot come apart. And even if they did — a restore, an operator rewinding the cursor by
-- hand — `webhook_deliveries_event_uniq` below makes a second dispatch of the same event to the
-- same endpoint impossible rather than unlikely.
--
-- The row is created by `POST /v1/webhooks`, **in the same transaction as the first endpoint of
-- the project**, positioned at the horizon of that moment. That is deliberate and it is not the
-- same as creating it lazily on the first tick: a cursor invented five seconds later would sit
-- *above* everything written in between, and those events would never be delivered to anybody.
-- The job keeps a lazy creation only as a fallback for a scope whose row is missing anyway (one
-- deleted by hand, a webhook restored without it).
--
-- The second guard is per endpoint and belongs to the job: `events.occurred_at >=
-- webhooks.created_at`. It is what stops the *second* endpoint of a project whose outbox is
-- momentarily behind from receiving the first one's backlog. The two overlap on purpose.
--
-- `updated_at` is bumped on **every** tick that looks at a scope, whether or not it converted
-- anything, because it is also the rotation key of the discovery query: the outbox takes the
-- least recently visited scopes, so a project can never be starved by the ones that sort before
-- it (revisione indipendente, I5).

CREATE TABLE outbox_cursor (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  -- Same type as events.txid. Compared only in SQL, where the ordering is the transaction
  -- ordering and not a lexicographic accident.
  last_txid    xid8 NOT NULL,
  last_seq     bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  -- One cursor per scope. This is what makes `INSERT ... ON CONFLICT DO NOTHING` the way the
  -- row is created and `SELECT ... FOR UPDATE` the way it is leased.
  CONSTRAINT outbox_cursor_scope_uniq UNIQUE (project_id, environment)
);

COMMENT ON TABLE outbox_cursor IS
  'How far the webhook outbox has converted the event log of one project and environment, as '
  'the (txid, seq) pair of 05-api-reference.md § Webhook. Never advanced past the visibility '
  'horizon pg_snapshot_xmin(pg_current_snapshot()).';

CREATE TRIGGER outbox_cursor_set_updated_at
  BEFORE UPDATE ON outbox_cursor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS, the isolation policy and the grants are the ones every project table gets from 0007;
-- the loop there ran before this table existed, so they are repeated verbatim.
ALTER TABLE outbox_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_cursor FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_cursor_project_isolation ON outbox_cursor
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

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_cursor TO ${APP_ROLE};

-- --- webhook_deliveries ----------------------------------------------------------------------
--
-- ## One delivery per (webhook, event), enforced by the database
--
-- The outbox is idempotent by construction — it advances its cursor in the same transaction
-- that inserts the deliveries — but "by construction" is an argument about code, and this is a
-- promise to a customer whose integration will create a booking twice if it is broken. The
-- unique constraint is the mechanism: the insert is written `ON CONFLICT DO NOTHING`, so a job
-- that runs twice over the same window produces one delivery and not two, whatever the reason
-- it ran twice.
--
-- ## What an attempt records
--
-- `05 § Webhook` promises a log of every attempt. The row keeps the outcome of the **last**
-- one plus the counter, which is what a support question ("why is my endpoint failing?") is
-- actually answered with: the status code, the truncated body, the error and now how long it
-- took. A full per-attempt history would be a second table; it is not in this brief and it is
-- in the report as an open item.
--
-- `duration_ms` is the wall clock of the HTTP call, DNS resolution included, because that is
-- what a ten second timeout is measured against.

ALTER TABLE webhook_deliveries
  ADD COLUMN duration_ms integer CHECK (duration_ms >= 0),
  ADD COLUMN last_attempt_at timestamptz,
  -- While an attempt is in flight this row is invisible to the other workers. It is a **separate**
  -- column from `next_attempt_at` on purpose: pushing the lease into `next_attempt_at` would make
  -- the column a customer reads in `GET /v1/webhooks/{id}/deliveries` show `now + 120s` — a value
  -- that belongs to no rung of the documented ladder — for the duration of every attempt
  -- (revisione indipendente, M4).
  ADD COLUMN leased_until timestamptz;

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_event_uniq UNIQUE (webhook_id, event_id);

COMMENT ON COLUMN webhook_deliveries.attempt IS
  'How many attempts have been started. Incremented when the delivery is claimed, so a worker '
  'that dies mid-flight consumes one rather than looping for ever.';
COMMENT ON COLUMN webhook_deliveries.next_attempt_at IS
  'When this delivery becomes due. The retry ladder of 05 § Webhook lives here and not in the '
  'job queue: a queue that is purged loses a schedule, a column does not. Never holds a lease.';
COMMENT ON COLUMN webhook_deliveries.leased_until IS
  'Set while an attempt is in flight; the row is invisible to other workers until it passes. '
  'A worker that dies mid-attempt therefore frees the row when the lease expires.';
COMMENT ON COLUMN webhook_deliveries.duration_ms IS 'Wall clock of the last attempt, in milliseconds.';

-- --- webhooks ---------------------------------------------------------------------------------
--
-- `webhooks.secret` holds the **encrypted** signing secret from this migration on, in the
-- envelope `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM under `WEBHOOK_SECRET_KEY`,
-- `12-sicurezza-e-compliance.md § Cifratura`). It cannot be a hash: the signature has to be
-- *produced* at every delivery, so the plaintext has to come back. No CHECK enforces the
-- envelope — the decrypt does, and a CHECK would only move a configuration error from a clear
-- message to a constraint violation.
--
-- The dispatch index covers what the outbox actually asks for: which projects have an endpoint
-- that could receive something. A `failing` endpoint still queues new events (only `disabled`
-- stops), so the predicate is `<> 'disabled'` and not `= 'active'` like the 0005 index.

-- No predicate on `status`: the outbox has to visit a scope whose endpoints are **all**
-- `disabled` too, or its cursor would freeze and re-enabling an endpoint a month later would
-- fire a month of deliveries at it (revisione indipendente, I4). Which endpoints actually
-- receive is decided per row, inside the scope.
CREATE INDEX webhooks_dispatch_idx ON webhooks (project_id, environment);

COMMENT ON COLUMN webhooks.secret IS
  'Signing secret, encrypted with WEBHOOK_SECRET_KEY (AES-256-GCM), envelope v1.<iv>.<tag>.<ct>. '
  'Shown to the customer once, at creation, and never again.';
