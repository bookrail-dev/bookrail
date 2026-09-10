-- 0005 — Transactional outbox and webhook delivery log.

CREATE TABLE events (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  type         text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        jsonb,
  data         jsonb NOT NULL,
  previous     jsonb,
  api_version  text NOT NULL DEFAULT '2026-09-01',
  seq          bigserial NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX events_scope_seq_idx ON events (project_id, environment, seq);
CREATE INDEX events_type_idx ON events (project_id, environment, type, occurred_at);

CREATE TABLE webhooks (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment  text NOT NULL CHECK (environment IN ('test', 'live')),
  url          text NOT NULL CHECK (url ~ '^https?://'),
  event_types  text[] NOT NULL DEFAULT '{}'::text[],
  secret       text NOT NULL,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'disabled', 'failing')),
  description  text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment)
);
CREATE INDEX webhooks_scope_idx ON webhooks (project_id, environment) WHERE status = 'active';

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment      text NOT NULL CHECK (environment IN ('test', 'live')),
  webhook_id       uuid NOT NULL,
  event_id         uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempt          integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  response_status  integer,
  response_body    text,
  error            text,
  scheduled_at     timestamptz NOT NULL DEFAULT now(),
  next_attempt_at  timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, environment),
  FOREIGN KEY (webhook_id, project_id, environment)
    REFERENCES webhooks (id, project_id, environment) ON DELETE CASCADE,
  FOREIGN KEY (event_id, project_id, environment)
    REFERENCES events (id, project_id, environment) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at);
CREATE INDEX webhook_deliveries_scope_idx ON webhook_deliveries (project_id, environment);
