-- 0022: the three reads behind the daily usage digest (brief 023).
--
-- Every morning the worker sends one plain text message to the mailbox the founder reads: who
-- signed up, which keys were used, how many requests each project made. Two of those three
-- questions are about rows that belong to no project of the request, because there is no
-- request: the worker asks them on a schedule, on the RLS-bound application pool, and Row Level
-- Security makes them unanswerable to that role by construction. `accounts`, `projects` and
-- `api_keys` are visible only through `app.project_id` (migration 0013) and `signups` carries no
-- policy and no grant at all (migration 0021).
--
-- The answer is the same shape of answer as everywhere else here: not a second login role, not
-- an owner connection in the worker, but a named `SECURITY DEFINER` function per question, with
-- a fixed return type that cannot carry anything the digest does not print. The worker gains
-- exactly three new sentences it may say to the database, and not one row of access beyond them.
--
-- Three functions rather than one with three result sets, for the reason 0013 gives: a function
-- whose return type is the answer is the smallest thing that answers one question. One function
-- returning a union of three shapes would have to widen its type to the union of three row
-- shapes, and a widened type is exactly the kind of hole this pattern exists to close.
--
-- Each carries the same four properties as the fourteen definer functions before it (five from
-- 0013, two from 0015, two from 0014 and 0016, four from 0021, one trigger function):
--   * `SECURITY DEFINER`, owned by the migration role;
--   * `SET search_path = public, pg_temp`;
--   * `EXECUTE` revoked from `PUBLIC`, granted to the application role only;
--   * a fixed return type, `STABLE`, read only, and a **bounded** window (below).
--
-- ## The floor on p_since, and why the window is not the caller's business
--
-- The digest asks for 24 hours of sign ups and 7 days of keys, and it would be easy to read the
-- `WHERE created_at >= p_since` below as if those numbers lived here. They do not: `p_since` is
-- chosen by the caller, and the caller is the application role, which is also the role the
-- process exposed to the internet talks to the database with. `usage_digest_accounts('-infinity')`
-- would therefore hand that role the whole address book, and the shape of the result would be no
-- defence at all because the shape is exactly what a digest prints.
--
-- So every window is clamped here, in the function, with `GREATEST(p_since, now() - 31 days)`.
-- Thirty-one days is a month, which is comfortably more than any window the digest asks for and
-- leaves room for a report that one day wants "the last month"; past it the answer is empty
-- whatever the caller passes. The digest does not change by one row; what changes is that a
-- compromised application role can enumerate a month and not a history.
--
-- ## What is deliberately not in these result types
--
-- No `key_hash`, no `prefix`, no `token_hash`, no `poll_token_hash`, no `pending_secret`, no
-- `ip_hash`. A digest that carried any of them would put a credential, or a thing that
-- identifies a person by their address, into a message that then sits in a mailbox for years.
-- The addresses that do appear are the two a customer relationship is made of: the owner of an
-- account that exists, and the address of a sign up that became one.
--
-- ## The address of a sign up that did not conclude
--
-- `usage_digest_signups` returns `email` only when the row reached `claimed`. Everything else
-- (`pending`, `confirmed`, `email_taken`, `expired`) is somebody who typed an address into a
-- form and did not finish, or somebody whose address was typed by another person: no account
-- exists, no relationship exists, and the address has no business leaving the database. The
-- count of those attempts, their client and their status still do, because that is what says
-- whether the sign up page is working.
--
-- `confirmed` is inside that rule rather than outside it on purpose: a `cli` sign up sits in
-- `confirmed` only between the click on the link and the terminal collecting its key, minutes
-- at most, and the digest that runs in between has nothing to gain from the address that the
-- next morning's digest will not say once the row is `claimed`.

-- --- 1. sign ups ---------------------------------------------------------------------------

CREATE FUNCTION usage_digest_signups(p_since timestamptz)
RETURNS TABLE (
  created_at timestamptz,
  client text,
  status text,
  email text,
  account_name text,
  project_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.created_at,
         s.client,
         s.status,
         CASE WHEN s.status = 'claimed' THEN s.email END,
         s.account_name,
         s.project_name
    FROM signups s
   WHERE s.created_at >= GREATEST(p_since, now() - interval '31 days')
   ORDER BY s.created_at
$$;

COMMENT ON FUNCTION usage_digest_signups(timestamptz) IS
  'Every sign up attempt since an instant, and never further back than 31 days whatever the '
  'caller asks for. The address is returned only for a row that reached claimed: an attempt that '
  'did not conclude is not a customer and its address does not travel. No token hash, no poll '
  'token, no envelope, no ip_hash.';

-- --- 2. keys that were used -----------------------------------------------------------------
--
-- `last_used_at` is written by authentication, inside the project context of the request it has
-- just adopted, so the column is maintained without anything privileged. This function is the
-- only way to read it across projects.
--
-- **No `owner_email` here.** The first draft returned it and the digest never printed it: the
-- key section names the account and its origin, which is what answers "who is calling". A
-- definer that hands out an address nobody reads is privilege spent for nothing, so the column
-- is gone from the return type rather than from the template. The address of an account that
-- was created in the window is still in `usage_digest_accounts`, where it is read.

CREATE FUNCTION usage_digest_keys(p_since timestamptz)
RETURNS TABLE (
  account_name text,
  account_origin text,
  project_id uuid,
  project_name text,
  environment text,
  kind text,
  last_used_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.name,
         a.origin,
         p.id,
         p.name,
         k.environment,
         k.kind,
         k.last_used_at,
         k.created_at
    FROM api_keys k
    JOIN projects p ON p.id = k.project_id
    JOIN accounts a ON a.id = p.account_id
   WHERE k.last_used_at >= GREATEST(p_since, now() - interval '31 days')
     AND k.revoked_at IS NULL
   ORDER BY k.last_used_at DESC
$$;

COMMENT ON FUNCTION usage_digest_keys(timestamptz) IS
  'The live keys used since an instant, and never further back than 31 days whatever the caller '
  'asks for, with the account and project they belong to. Never the hash, never the prefix and '
  'never the owner address: what the digest prints is that a key was used, not which secret it '
  'was nor whose mailbox is behind it.';

-- --- 3. accounts created --------------------------------------------------------------------

CREATE FUNCTION usage_digest_accounts(p_since timestamptz)
RETURNS TABLE (
  name text,
  origin text,
  owner_email text,
  created_at timestamptz,
  projects integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.name,
         a.origin,
         a.owner_email,
         a.created_at,
         (SELECT count(*)::int FROM projects p WHERE p.account_id = a.id)
    FROM accounts a
   WHERE a.created_at >= GREATEST(p_since, now() - interval '31 days')
   ORDER BY a.created_at
$$;

COMMENT ON FUNCTION usage_digest_accounts(timestamptz) IS
  'The accounts created since an instant, and never further back than 31 days whatever the '
  'caller asks for, with how many projects each has. The owner address is returned as it is '
  'stored: an account that exists is a relationship, and it is NULL anyway for an account '
  'created by hand.';

-- --- privileges -----------------------------------------------------------------------------

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'usage_digest_signups(timestamptz)',
    'usage_digest_keys(timestamptz)',
    'usage_digest_accounts(timestamptz)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', f);
  END LOOP;
END
$$;
