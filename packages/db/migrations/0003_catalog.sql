-- 0003 — Catalogue: what can be booked and under which rules.
--
-- Every project table carries (project_id, environment) and a redundant
-- UNIQUE (id, project_id, environment) so that every foreign key between project tables
-- can be composite. A row can therefore never point at a row of another project or of the
-- other environment: the invariant of `04-modello-dati.md § Invarianti` #7 is enforced by
-- the database, not by the application.
--
-- Composite keys force the column-list form of ON DELETE SET NULL: the bare
-- `ON DELETE SET NULL` nulls *every* referencing column, and project_id/environment are
-- NOT NULL, so the cascade could never succeed. `ON DELETE SET NULL (location_id)` nulls only
-- the reference and keeps the scope. Requires PostgreSQL 15 or newer.

CREATE TABLE locations (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  tenant_id    text,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone     text NOT NULL,
  address      jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX locations_scope_idx ON locations (project_id, environment);

CREATE TABLE schedules (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- NULL means: inherit the timezone of the location the resource belongs to.
  timezone     text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX schedules_scope_idx ON schedules (project_id, environment);

CREATE TABLE schedule_rules (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment   text NOT NULL CHECK (environment IN ('test', 'live')),
  schedule_id   uuid NOT NULL,
  days_of_week  smallint[] NOT NULL
                CHECK (array_length(days_of_week, 1) BETWEEN 1 AND 7
                       AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  valid_from    date,
  valid_until   date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (schedule_id, project_id, environment)
    REFERENCES schedules (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX schedule_rules_schedule_idx ON schedule_rules (schedule_id);
CREATE INDEX schedule_rules_scope_idx ON schedule_rules (project_id, environment);

CREATE TABLE schedule_exceptions (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment   text NOT NULL CHECK (environment IN ('test', 'live')),
  schedule_id   uuid NOT NULL,
  date          date NOT NULL,
  type          text NOT NULL CHECK (type IN ('closed', 'open')),
  start_time    time,
  end_time      time,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- An `open` exception must say when; a `closed` one closes the whole day unless it
  -- carries an interval, in which case the interval must be well formed.
  CHECK (type <> 'open' OR (start_time IS NOT NULL AND end_time IS NOT NULL)),
  CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (schedule_id, project_id, environment)
    REFERENCES schedules (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX schedule_exceptions_schedule_date_idx ON schedule_exceptions (schedule_id, date);
CREATE INDEX schedule_exceptions_scope_idx ON schedule_exceptions (project_id, environment);

CREATE TABLE resources (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  tenant_id    text,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type         text NOT NULL DEFAULT 'staff',
  location_id  uuid,
  schedule_id  uuid,
  capacity     integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (location_id, project_id, environment)
    REFERENCES locations (id, project_id, environment) ON DELETE SET NULL (location_id),
  FOREIGN KEY (schedule_id, project_id, environment)
    REFERENCES schedules (id, project_id, environment) ON DELETE SET NULL (schedule_id)
);
CREATE INDEX resources_scope_idx ON resources (project_id, environment) WHERE deleted_at IS NULL;
CREATE INDEX resources_location_idx ON resources (location_id);
CREATE INDEX resources_attributes_idx ON resources USING gin (attributes jsonb_path_ops);

CREATE TABLE resource_groups (
  id                   uuid PRIMARY KEY,
  project_id           uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment          text NOT NULL CHECK (environment IN ('test', 'live')),
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Dynamic membership filter on resources.attributes; NULL means: use the member table.
  selector             jsonb,
  allocation_strategy  text NOT NULL DEFAULT 'first_available'
                       CHECK (allocation_strategy IN
                              ('least_busy', 'round_robin', 'first_available', 'priority')),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX resource_groups_scope_idx ON resource_groups (project_id, environment);

CREATE TABLE resource_group_members (
  id                 uuid PRIMARY KEY,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment        text NOT NULL CHECK (environment IN ('test', 'live')),
  resource_group_id  uuid NOT NULL,
  resource_id        uuid NOT NULL,
  priority           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  UNIQUE (resource_group_id, resource_id),
  FOREIGN KEY (resource_group_id, project_id, environment)
    REFERENCES resource_groups (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, project_id, environment)
    REFERENCES resources (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX resource_group_members_resource_idx ON resource_group_members (resource_id);
CREATE INDEX resource_group_members_scope_idx ON resource_group_members (project_id, environment);

CREATE TABLE resource_blocks (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  resource_id  uuid NOT NULL,
  period       tstzrange NOT NULL
               CHECK (NOT isempty(period)
                      AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL),
  reason       text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (resource_id, project_id, environment)
    REFERENCES resources (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX resource_blocks_resource_period_idx
  ON resource_blocks USING gist (resource_id, period);
CREATE INDEX resource_blocks_scope_idx ON resource_blocks (project_id, environment);

CREATE TABLE policies (
  id                                uuid PRIMARY KEY,
  project_id                        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment                       text NOT NULL CHECK (environment IN ('test', 'live')),
  name                              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  cancellation                      jsonb NOT NULL DEFAULT '[]'::jsonb
                                    CHECK (jsonb_typeof(cancellation) = 'array'),
  reschedule                        jsonb NOT NULL DEFAULT '[]'::jsonb
                                    CHECK (jsonb_typeof(reschedule) = 'array'),
  deposit                           jsonb,
  payment_timing                    text NOT NULL DEFAULT 'none'
                                    CHECK (payment_timing IN
                                      ('at_booking', 'before_start', 'after_service', 'none')),
  payment_deadline                  text,
  no_show                           jsonb,
  hold_duration_seconds             integer NOT NULL DEFAULT 600
                                    CHECK (hold_duration_seconds BETWEEN 30 AND 86400),
  max_active_bookings_per_customer  integer CHECK (max_active_bookings_per_customer > 0),
  require_customer_confirmation     boolean NOT NULL DEFAULT false,
  require_provider_confirmation     boolean NOT NULL DEFAULT false,
  metadata                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX policies_scope_idx ON policies (project_id, environment);

CREATE TABLE services (
  id                     uuid PRIMARY KEY,
  project_id             uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment            text NOT NULL CHECK (environment IN ('test', 'live')),
  tenant_id              text,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description            text,
  duration_minutes       integer CHECK (duration_minutes > 0),
  duration_options       integer[],
  duration_min_minutes   integer CHECK (duration_min_minutes > 0),
  duration_max_minutes   integer CHECK (duration_max_minutes > 0),
  capacity_per_booking   integer NOT NULL DEFAULT 1 CHECK (capacity_per_booking > 0),
  buffer_before_minutes  integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes   integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  slot_interval_minutes  integer CHECK (slot_interval_minutes > 0),
  align_to               text CHECK (align_to IN ('hour', 'half_hour', 'schedule_start')),
  price_amount           integer CHECK (price_amount >= 0),
  price_currency         text CHECK (price_currency ~ '^[A-Z]{3}$'),
  pricing_rules          jsonb NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(pricing_rules) = 'array'),
  policy_id              uuid,
  booking_window         jsonb,
  allow_recurring        boolean NOT NULL DEFAULT false,
  allow_multi_day        boolean NOT NULL DEFAULT false,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- A service must state its duration in exactly one of the three supported ways.
  CHECK (
    (duration_minutes IS NOT NULL)::int
    + (duration_options IS NOT NULL AND array_length(duration_options, 1) > 0)::int
    + (duration_min_minutes IS NOT NULL AND duration_max_minutes IS NOT NULL)::int = 1
  ),
  CHECK (duration_max_minutes IS NULL OR duration_min_minutes IS NULL
         OR duration_max_minutes >= duration_min_minutes),
  CHECK ((price_amount IS NULL) = (price_currency IS NULL)),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (policy_id, project_id, environment)
    REFERENCES policies (id, project_id, environment) ON DELETE SET NULL (policy_id)
);
CREATE INDEX services_scope_idx ON services (project_id, environment) WHERE deleted_at IS NULL;
CREATE INDEX services_policy_idx ON services (policy_id);

CREATE TABLE service_requirements (
  id                 uuid PRIMARY KEY,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment        text NOT NULL CHECK (environment IN ('test', 'live')),
  service_id         uuid NOT NULL,
  resource_id        uuid,
  resource_group_id  uuid,
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  role               text,
  position           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((resource_id IS NOT NULL) <> (resource_group_id IS NOT NULL)),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (service_id, project_id, environment)
    REFERENCES services (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, project_id, environment)
    REFERENCES resources (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (resource_group_id, project_id, environment)
    REFERENCES resource_groups (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX service_requirements_service_idx ON service_requirements (service_id, position);
CREATE INDEX service_requirements_scope_idx ON service_requirements (project_id, environment);

CREATE TABLE customers (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  tenant_id    text,
  external_id  text,
  email        text,
  phone        text,
  name         text,
  timezone     text,
  locale       text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
-- external_id is the upsert key inside a project environment when it is present.
CREATE UNIQUE INDEX customers_external_id_key
  ON customers (project_id, environment, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX customers_scope_idx ON customers (project_id, environment);
CREATE INDEX customers_email_idx ON customers (project_id, environment, lower(email));
