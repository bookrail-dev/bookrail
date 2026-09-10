-- 0011 — State transitions of a booking: their consequences, and the clock that fires the
-- automatic ones (brief 004a).
--
-- ## What a transition has to record
--
-- `04-modello-dati.md § Booking` describes the life cycle; until now the table could store
-- the *states* (`status`, `cancelled_at`, `checked_in_at`, `no_show_at`, `completed_at`,
-- `cancelled_by`, `cancellation_reason`, `rescheduled_to_booking_id`) but none of the numbers
-- a transition computes from the frozen `policy_snapshot`. The columns added here are exactly
-- those numbers, and they are **expectations**, never movements of money: brief 004a computes
-- what is owed, the payments brief will be the one to execute it.
--
--   * `refund_percent` / `refund_amount_expected` — written by `cancel`, from
--     `policy_snapshot.cancellation` (or from `override_refund_percent`, or 100 for a
--     provider cancellation). The amount is a percentage of `amount_paid`, which is what
--     `07-pagamenti-e-policy.md § Cancellazione` says the refund is computed on.
--   * `no_show_charge_expected` — written by `no_show`, from `policy_snapshot.no_show
--     .charge_percent` applied to `price_amount`.
--   * `reschedule_fee_expected` and `reschedule_count` — written on the **new** booking of a
--     reschedule. The fee lives with the booking that survives, because that is the booking a
--     payment will be attached to; the old one closes as `rescheduled` with no money on it.
--   * `rescheduled_from_booking_id` — the other half of `rescheduled_to_booking_id`, so the
--     chain can be walked in both directions without a scan.
--
-- ## The clock
--
-- `next_transition_at` has existed since 0004 but nothing said *which* transition was due.
-- `next_transition` names it, and the pair is what the 30 second job of
-- `10-architettura-tecnica.md § Job e scheduler` reads. The partial index is rebuilt on the
-- new column: a booking with no automatic transition pending is not in the index at all, and
-- that is the overwhelming majority of them.
--
-- `start` is deliberately not `check_in`. A booking that starts by itself because the policy
-- says so has **not** been checked in, and `checked_in_at` has to keep meaning "somebody
-- turned up", or `no_show.auto_mark` would never fire again after the first automatic start.
--
-- ## The policy fields that drive it
--
-- `auto_start`, `auto_complete` and `max_reschedules` become real columns, so they travel
-- inside `policy_snapshot` — which is `to_jsonb(policies) - project_id - environment -
-- created_at - updated_at` and therefore picks them up with no further change. `auto_mark`
-- lives inside the existing `no_show` jsonb, next to `grace_minutes` and `charge_percent`,
-- because it is a property of the no-show rule and not of the policy at large.
--
-- A booking created before this migration carries a snapshot without these keys; every reader
-- treats a missing key as `false` / "no limit", which is the behaviour those bookings had.
--
-- ## Events
--
-- `GET /v1/events` filters by the identifier of the object an event is about, which lives in
-- `data->>'id'` (the prefixed form, `bk_…`). Without an expression index that filter is a
-- sequential scan of the project's whole history, so the index is created here rather than
-- discovered in production.
--
-- Nothing here creates a table, so there is no RLS or grant to add: `bookings`, `policies` and
-- `events` already carry the policy and the privileges 0007 gave them, and a column inherits
-- the privileges of its table.

-- --- bookings -------------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN next_transition text
    CHECK (next_transition IN ('start', 'complete', 'no_show')),
  ADD COLUMN rescheduled_from_booking_id uuid,
  ADD COLUMN reschedule_count integer NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  ADD COLUMN refund_percent numeric(5, 2)
    CHECK (refund_percent >= 0 AND refund_percent <= 100),
  ADD COLUMN refund_amount_expected integer CHECK (refund_amount_expected >= 0),
  ADD COLUMN no_show_charge_expected integer CHECK (no_show_charge_expected >= 0),
  ADD COLUMN reschedule_fee_expected integer CHECK (reschedule_fee_expected >= 0),
  ADD COLUMN rescheduled_at timestamptz;

-- The two halves of the reschedule link are both composite foreign keys, like every other
-- reference between project tables: a booking cannot point at one of another project or of
-- the other environment even through an application bug (`04 § Isolamento`).
ALTER TABLE bookings
  ADD CONSTRAINT bookings_rescheduled_from_fkey
  FOREIGN KEY (rescheduled_from_booking_id, project_id, environment)
  REFERENCES bookings (id, project_id, environment)
  ON DELETE SET NULL (rescheduled_from_booking_id);

-- The pair is meaningful only together: a booking that says which transition is due must say
-- when, and one that says when must say which.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_next_transition_complete
  CHECK ((next_transition IS NULL) = (next_transition_at IS NULL));

-- Rebuilt on the new column. 0004 indexed `next_transition_at IS NOT NULL`, which is the same
-- set only because of the CHECK above; naming the column the job actually reads keeps the two
-- from drifting if that CHECK is ever relaxed.
DROP INDEX bookings_next_transition_idx;
CREATE INDEX bookings_next_transition_idx
  ON bookings (next_transition_at)
  WHERE next_transition IS NOT NULL;

CREATE INDEX bookings_rescheduled_from_idx ON bookings (rescheduled_from_booking_id)
  WHERE rescheduled_from_booking_id IS NOT NULL;

COMMENT ON COLUMN bookings.next_transition IS
  'Which automatic transition is due at next_transition_at: start, complete or no_show. '
  '10-architettura-tecnica.md, § Job e scheduler.';
COMMENT ON COLUMN bookings.refund_amount_expected IS
  'What the cancellation policy says should be refunded, in the minor unit. An expectation: '
  'the refund itself is executed by the payments brief.';

-- --- policies -------------------------------------------------------------------------------

ALTER TABLE policies
  ADD COLUMN auto_start boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN max_reschedules integer CHECK (max_reschedules >= 0);

COMMENT ON COLUMN policies.auto_start IS
  'Move a confirmed booking to in_progress at its start, without a check-in.';
COMMENT ON COLUMN policies.auto_complete IS
  'Move a booking to completed at its end.';
COMMENT ON COLUMN policies.max_reschedules IS
  'How many times one booking may be rescheduled. NULL means no limit. 07 § Riprogrammazione.';

-- --- events ---------------------------------------------------------------------------------
--
-- ## Why `seq` alone cannot be a cursor
--
-- `seq` is a `bigserial`: the number is handed out at the `INSERT`, not at the `COMMIT`. Two
-- transactions that insert an event each and commit in the opposite order leave a hole that a
-- `WHERE seq > cursor` reader steps over and never comes back to — the row appears in the
-- table a moment later, below a cursor that has already moved past it. With one request at a
-- time nobody sees it; with an API and a worker writing at once, which is the only shape
-- production has, it is a lost event (revisione indipendente, I1).
--
-- ## `txid`, and the horizon it makes possible
--
-- Every event records the full transaction id that wrote it. `pg_current_xact_id()` is
-- assigned in transaction order and never reused, so `(txid, seq)` is a **total order that is
-- fixed the moment a row is written** and never rearranges itself afterwards.
--
-- A reader then returns only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`. Every
-- transaction below that bound has finished — that is what a snapshot's xmin means — so its
-- rows are either visible now or never will be. Every transaction at or above it is still in
-- flight or has not started, and when it commits its rows carry a **higher** `txid`, so they
-- sort after everything already returned and a cursor picks them up on the next page. Nothing
-- can ever appear below a cursor that has passed it.
--
-- The cost is a latency equal to the longest write transaction currently open, and it is
-- written down in `05-api-reference.md § Eventi e webhook` rather than discovered.
--
-- Rows written before this migration are stamped `'2'::xid8` — FrozenTransactionId, "older
-- than everything" — because they are, by construction, settled: the migration cannot run
-- while the transaction that wrote them is still open.

ALTER TABLE events ADD COLUMN txid xid8;
UPDATE events SET txid = '2'::xid8 WHERE txid IS NULL;
ALTER TABLE events ALTER COLUMN txid SET DEFAULT pg_current_xact_id();
ALTER TABLE events ALTER COLUMN txid SET NOT NULL;

COMMENT ON COLUMN events.txid IS
  'Full transaction id of the INSERT. With seq it is the cursor order of GET /v1/events, and '
  'the horizon that makes the cursor gap free. 05-api-reference.md, § Eventi e webhook.';

CREATE INDEX events_object_idx
  ON events (project_id, environment, (data ->> 'id'), txid, seq);

CREATE INDEX events_scope_cursor_idx
  ON events (project_id, environment, txid, seq);
