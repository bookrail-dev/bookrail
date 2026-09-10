-- 0002 — Control plane: accounts, projects, API keys.
--
-- accounts and projects are NOT project-scoped data: they are the rows that define the
-- scope itself. They carry no RLS; the application role can only read them and every
-- write goes through the admin connection (POST /internal/bootstrap).

CREATE TABLE accounts (
  id           uuid PRIMARY KEY,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  plan         text NOT NULL DEFAULT 'free',
  api_version  text NOT NULL DEFAULT '2026-09-01',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                uuid PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  default_timezone  text NOT NULL DEFAULT 'UTC',
  default_currency  text NOT NULL DEFAULT 'EUR' CHECK (default_currency ~ '^[A-Z]{3}$'),
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_account_id_idx ON projects (account_id);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment   text NOT NULL CHECK (environment IN ('test', 'live')),
  kind          text NOT NULL DEFAULT 'secret' CHECK (kind IN ('secret', 'publishable')),
  name          text,
  -- First 8 characters of the random body of the key (the literal `sk_test_` head is
  -- constant and therefore useless as a selector). Shown in the dashboard, indexed for lookup.
  prefix        text NOT NULL CHECK (length(prefix) = 8),
  -- SHA-256 of the full key, hex encoded. The plaintext key is never stored.
  key_hash      text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes        text[] NOT NULL DEFAULT '{}'::text[],
  tenant_id     text,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_prefix_idx ON api_keys (prefix);
CREATE INDEX api_keys_project_env_idx ON api_keys (project_id, environment);

CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER api_keys_set_updated_at BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
