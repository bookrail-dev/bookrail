-- 0004 — Bookings, holds, occupancies and the money/entitlement rows attached to them.
-- Brief 001 creates the tables and their constraints; the engine that writes them lands
-- with briefs 002-003.

CREATE TABLE recurrences (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  service_id   uuid,
  customer_id  uuid,
  rrule        text NOT NULL,
  starts_at    timestamptz NOT NULL,
  until        timestamptz,
  count        integer CHECK (count > 0),
  exceptions   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exceptions) = 'array'),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (service_id, project_id, environment)
    REFERENCES services (id, project_id, environment) ON DELETE SET NULL (service_id),
  FOREIGN KEY (customer_id, project_id, environment)
    REFERENCES customers (id, project_id, environment) ON DELETE SET NULL (customer_id)
);
CREATE INDEX recurrences_scope_idx ON recurrences (project_id, environment);

CREATE TABLE holds (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  service_id   uuid NOT NULL,
  customer_id  uuid,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'converted', 'expired', 'released')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (service_id, project_id, environment)
    REFERENCES services (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, project_id, environment)
    REFERENCES customers (id, project_id, environment) ON DELETE SET NULL (customer_id)
);
CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'active';
CREATE INDEX holds_scope_idx ON holds (project_id, environment);

CREATE TABLE bookings (
  id                        uuid PRIMARY KEY,
  project_id                uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment               text NOT NULL CHECK (environment IN ('test', 'live')),
  tenant_id                 text,
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('held', 'pending', 'confirmed', 'in_progress',
                                              'completed', 'cancelled', 'no_show', 'rescheduled')),
  service_id                uuid NOT NULL,
  customer_id               uuid,
  hold_id                   uuid,
  recurrence_id             uuid,
  group_id                  uuid,
  rescheduled_to_booking_id uuid,
  starts_at                 timestamptz NOT NULL,
  ends_at                   timestamptz NOT NULL,
  timezone                  text NOT NULL,
  quantity                  integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_amount              integer CHECK (price_amount >= 0),
  currency                  text CHECK (currency ~ '^[A-Z]{3}$'),
  amount_paid               integer NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_due                integer NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  amount_refunded           integer NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  policy_snapshot           jsonb,
  source                    text NOT NULL DEFAULT 'api'
                            CHECK (source IN ('api', 'widget', 'portal', 'import')),
  cancelled_by              text CHECK (cancelled_by IN ('customer', 'provider', 'system')),
  cancellation_reason       text,
  notes                     text,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_transition_at        timestamptz,
  confirmed_at              timestamptz,
  checked_in_at             timestamptz,
  cancelled_at              timestamptz,
  completed_at              timestamptz,
  no_show_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (service_id, project_id, environment)
    REFERENCES services (id, project_id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, project_id, environment)
    REFERENCES customers (id, project_id, environment) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (hold_id, project_id, environment)
    REFERENCES holds (id, project_id, environment) ON DELETE SET NULL (hold_id),
  FOREIGN KEY (recurrence_id, project_id, environment)
    REFERENCES recurrences (id, project_id, environment) ON DELETE SET NULL (recurrence_id),
  FOREIGN KEY (rescheduled_to_booking_id, project_id, environment)
    REFERENCES bookings (id, project_id, environment) ON DELETE SET NULL (rescheduled_to_booking_id)
);
CREATE INDEX bookings_scope_status_idx ON bookings (project_id, environment, status);
CREATE INDEX bookings_customer_idx ON bookings (customer_id);
CREATE INDEX bookings_service_start_idx ON bookings (service_id, starts_at);
CREATE INDEX bookings_next_transition_idx ON bookings (next_transition_at)
  WHERE next_transition_at IS NOT NULL;

CREATE TABLE booking_allocations (
  id             uuid PRIMARY KEY,
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment    text NOT NULL CHECK (environment IN ('test', 'live')),
  booking_id     uuid NOT NULL,
  resource_id    uuid NOT NULL,
  role           text,
  capacity_used  integer NOT NULL DEFAULT 1 CHECK (capacity_used > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  UNIQUE (booking_id, resource_id, role),
  FOREIGN KEY (booking_id, project_id, environment)
    REFERENCES bookings (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, project_id, environment)
    REFERENCES resources (id, project_id, environment) ON DELETE RESTRICT
);
CREATE INDEX booking_allocations_resource_idx ON booking_allocations (resource_id);
CREATE INDEX booking_allocations_scope_idx ON booking_allocations (project_id, environment);

-- Occupancies: the single source of truth for capacity.
-- `single_capacity_resource` is denormalised from resources.capacity by trigger so that the
-- exclusion constraint below can be partial, and therefore cheap, without a subquery.
CREATE TABLE occupancies (
  id                        uuid PRIMARY KEY,
  project_id                uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment               text NOT NULL CHECK (environment IN ('test', 'live')),
  resource_id               uuid NOT NULL,
  period                    tstzrange NOT NULL
                            CHECK (NOT isempty(period)
                                   AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL),
  capacity_used             integer NOT NULL CHECK (capacity_used > 0),
  kind                      text NOT NULL CHECK (kind IN ('booking', 'hold', 'block')),
  ref_id                    uuid NOT NULL,
  expires_at                timestamptz,
  active                    boolean NOT NULL DEFAULT true,
  single_capacity_resource  boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'hold' OR expires_at IS NOT NULL),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (resource_id, project_id, environment)
    REFERENCES resources (id, project_id, environment) ON DELETE CASCADE
);

CREATE INDEX occ_resource_period ON occupancies USING gist (resource_id, period) WHERE active;
CREATE INDEX occupancies_ref_idx ON occupancies (ref_id);
CREATE INDEX occupancies_scope_idx ON occupancies (project_id, environment);

-- For capacity-1 resources the database itself refuses the double booking.
--
-- The predicate deliberately does NOT mention capacity_used: on a resource whose capacity is
-- 1, *any* active occupancy saturates it, whatever capacity_used claims. Gating on
-- `capacity_used = 1` left a hole: an occupancy written when the resource had capacity 4
-- carries capacity_used = 4, and lowering the resource to capacity 1 afterwards flipped
-- single_capacity_resource without touching capacity_used, so the row fell outside the
-- predicate and overlapping occupancies were accepted.
ALTER TABLE occupancies ADD CONSTRAINT occ_no_overlap_cap1
  EXCLUDE USING gist (project_id WITH =, resource_id WITH =, period WITH &&)
  WHERE (active AND single_capacity_resource);

CREATE TABLE waitlist_entries (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  customer_id  uuid NOT NULL,
  service_id   uuid NOT NULL,
  window_from  timestamptz NOT NULL,
  window_to    timestamptz NOT NULL,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  priority     integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'offered', 'converted', 'expired', 'cancelled')),
  hold_id      uuid,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to > window_from),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (customer_id, project_id, environment)
    REFERENCES customers (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (service_id, project_id, environment)
    REFERENCES services (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (hold_id, project_id, environment)
    REFERENCES holds (id, project_id, environment) ON DELETE SET NULL (hold_id)
);
CREATE INDEX waitlist_entries_service_idx
  ON waitlist_entries (service_id, priority DESC, created_at) WHERE status = 'active';
CREATE INDEX waitlist_entries_scope_idx ON waitlist_entries (project_id, environment);

CREATE TABLE entitlements (
  id                       uuid PRIMARY KEY,
  project_id               uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment              text NOT NULL CHECK (environment IN ('test', 'live')),
  customer_id              uuid NOT NULL,
  type                     text NOT NULL CHECK (type IN ('package', 'subscription', 'credit')),
  service_ids              uuid[] NOT NULL DEFAULT '{}'::uuid[],
  total                    integer CHECK (total >= 0),
  remaining                integer CHECK (remaining >= 0),
  currency                 text CHECK (currency ~ '^[A-Z]{3}$'),
  period                   text,
  valid_from               timestamptz,
  valid_until              timestamptz,
  max_concurrent_bookings  integer CHECK (max_concurrent_bookings > 0),
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (total IS NULL OR remaining IS NULL OR remaining <= total),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (customer_id, project_id, environment)
    REFERENCES customers (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX entitlements_customer_idx ON entitlements (customer_id);
CREATE INDEX entitlements_scope_idx ON entitlements (project_id, environment);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY,
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment          text NOT NULL CHECK (environment IN ('test', 'live')),
  booking_id           uuid,
  provider             text NOT NULL,
  provider_payment_id  text,
  type                 text NOT NULL
                       CHECK (type IN ('deposit', 'full', 'balance', 'no_show_fee', 'refund')),
  amount               integer NOT NULL,
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'cancelled')),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (booking_id, project_id, environment)
    REFERENCES bookings (id, project_id, environment) ON DELETE SET NULL (booking_id)
);
CREATE UNIQUE INDEX payments_provider_ref_key
  ON payments (project_id, environment, provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_scope_idx ON payments (project_id, environment);
