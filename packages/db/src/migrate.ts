import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  assertSafeIdentifier,
  databaseNameFromUrl,
  DEFAULT_APP_ROLE,
  DEFAULT_JOBS_ROLE,
  withDatabaseName,
} from './config.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATIONS_TABLE = '_bookrail_migrations';

/**
 * Shape of a migration ledger, whatever it is called.
 *
 * The product was renamed in September 2026 and the ledger was named after it, so a database
 * created before that carries the same table under the old name. The ledger cannot be renamed
 * by a migration: it is the table that says which migrations are applied, so a runner that
 * created an empty new one would replay 0001 against a full database. It is therefore adopted
 * by shape rather than by the old name (the question is "the ledger this database already
 * has", not "the ledger of one particular former brand") and by an
 * **explicit command** and never as a side effect of reading: `pnpm db:adopt`.
 */
const LEDGER_NAME_RE = '^_[a-z0-9]+_migrations$';
const LEDGER_COLUMNS = ['name', 'checksum', 'applied_at'];

/**
 * How long a migration waits for a lock before giving up, applied as `SET LOCAL lock_timeout`
 * inside every migration transaction.
 *
 * Migration 0018 took an `ACCESS EXCLUSIVE` lock on every table of a live job queue while the
 * old worker was still polling it every second. A request for that lock queues **in front of**
 * every later request, so from that instant the queue's own reads pile up behind it: the bad
 * case is a release that hangs for as long as nobody notices, inside a transaction that holds
 * an advisory lock. Five seconds is long enough for any lock this schema actually needs and
 * short enough that the failure is a failure and not a hang.
 *
 * Set with BOOKRAIL_MIGRATION_LOCK_TIMEOUT (any value Postgres accepts for `lock_timeout`).
 */
const DEFAULT_MIGRATION_LOCK_TIMEOUT = '5s';

/** `lock_timeout` in Postgres: the statement waited for a lock and gave up. */
const LOCK_TIMEOUT_CODE = '55P03';

/**
 * Advisory lock key that serialises migration runs.
 *
 * Migration 0001 touches pg_authid (CREATE ROLE / ALTER ROLE), which is cluster-global, not
 * per-database. Two setups migrating two *different* databases at the same time, which is what
 * turbo does when it runs the test task of two packages in parallel, collide on the same
 * catalogue tuple and one of them dies with `tuple concurrently updated` (XX000).
 *
 * Advisory locks are NOT cluster-wide: their lock tag includes the database OID, so
 * `pg_advisory_lock(k)` held on database A does not block the same key on database B
 * (verified on this Postgres 17: pg_locks shows `locktype = advisory` with a `database`
 * column, and pg_try_advisory_lock succeeds from the other database). Serialising two runs
 * against two databases therefore needs a lock taken on a database they share.
 *
 * The result is two layers:
 *  - a session lock on the maintenance database (`postgres`), held for the whole run, which
 *    is what actually serialises concurrent setups of different databases;
 *  - a transaction lock on the target database inside every migration, which serialises two
 *    runs against the same database and is released by COMMIT or ROLLBACK.
 */
const MIGRATION_LOCK_KEY = 0x5107ba5e;

/** Database every runner can reach, used only to hold the cross-database migration lock. */
const MAINTENANCE_DATABASE = 'postgres';

/** Errors worth retrying when two runners still manage to overlap on a global catalogue. */
const CONCURRENCY_CODES = new Set([
  'XX000', // internal_error: "tuple concurrently updated" on pg_authid
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '23505', // unique_violation on a catalogue index
  '42710', // duplicate_object: a concurrent CREATE ROLE won the race
]);

interface ClusterLock {
  release(): Promise<void>;
}

/**
 * Holds a session advisory lock on the maintenance database for the duration of the run.
 * Best effort: if that database cannot be reached the migration still proceeds, protected by
 * the per-transaction lock and by the retry below.
 */
async function acquireClusterLock(adminUrl: string): Promise<ClusterLock | null> {
  let client: Client;
  try {
    client = new Client({
      connectionString: withDatabaseName(adminUrl, MAINTENANCE_DATABASE),
    });
    await client.connect();
  } catch {
    return null;
  }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
  return {
    async release(): Promise<void> {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch {
        // The session is about to end, which releases the lock anyway.
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

function isConcurrencyError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && CONCURRENCY_CODES.has(code);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assigns the password of a role when the matching variable is set. It cannot live in a
 * migration file: those are checksummed and would then carry a secret. The statement is built
 * by Postgres itself with `format(%I, %L)`, because utility statements do not take bind
 * parameters and hand-rolled quoting of a password is exactly the wrong place to improvise.
 */
async function applyRolePassword(client: Client, appRole: string, password: string): Promise<void> {
  const { rows } = await client.query<{ statement: string }>(
    'SELECT format($$ALTER ROLE %I PASSWORD %L$$, $1::text, $2::text) AS statement',
    [appRole, password],
  );
  const statement = rows[0]?.statement;
  if (!statement) throw new Error('Could not build the ALTER ROLE statement.');
  await client.query(statement);
}

export interface MigrateOptions {
  adminUrl: string;
  appRole?: string;
  /** The role pg-boss owns its schema with. Created by migration 0018. */
  jobsRole?: string;
  migrationsDir?: string;
  onApplied?: (name: string) => void;
  /** When set, the application role is given this password after the migrations run. */
  appPassword?: string | undefined;
  /** When set, the job queue role is given this password after the migrations run. */
  jobsPassword?: string | undefined;
  /**
   * `SET LOCAL lock_timeout` for every migration transaction. Defaults to
   * BOOKRAIL_MIGRATION_LOCK_TIMEOUT and then to 5s.
   */
  lockTimeout?: string | undefined;
}

/**
 * The `lock_timeout` a migration runs under. Validated as a bare Postgres interval-ish literal
 * before it reaches `SET LOCAL`: the value comes from the environment, and `SET` takes no bind
 * parameters, so the quoting is done by Postgres itself (`format(%L)`) over a string this
 * function has already refused to let be anything but digits and a unit.
 */
function resolveLockTimeout(options: MigrateOptions): string {
  const value = (
    options.lockTimeout ??
    process.env.BOOKRAIL_MIGRATION_LOCK_TIMEOUT ??
    DEFAULT_MIGRATION_LOCK_TIMEOUT
  ).trim();
  if (!/^\d+\s*(ms|s|min|h|d)?$/.test(value)) {
    throw new Error(
      `Invalid lock timeout ${JSON.stringify(value)}: expected something like "5s", "500ms" or "0".`,
    );
  }
  return value;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sqlText = await readFile(`${dir}/${name}`, 'utf8');
    files.push({
      name,
      sql: sqlText,
      checksum: createHash('sha256').update(sqlText).digest('hex'),
    });
  }
  return files;
}

function substitute(sqlText: string, vars: Record<string, string>): string {
  return sqlText.replace(/\$\{([A-Z_]+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Migration references unknown variable \${${key}}`);
    return value;
  });
}

/**
 * What ledger, if any, this database has. **A read, and nothing but a read.**
 *
 *   current    the ledger is called `_bookrail_migrations`; the normal case.
 *   legacy     there is exactly one ledger-shaped table under some other name, and it carries
 *              the three columns a ledger has. `pnpm db:adopt` renames it.
 *   foreign    there is exactly one candidate by name, but its columns are not a ledger's.
 *   missing    no candidate at all: an empty database.
 *   ambiguous  more than one candidate and none is the current name. Not a case to guess at.
 *
 * The rename used to live inside `ensureMigrationsTable`, which is called by
 * `migrationStatus`, which is what `pnpm db:status` and the `--post` half of the release gate
 * run: two commands that present themselves as read-only wrote to the catalogue.
 * The adoption has done its work on every database
 * that exists, so it is now an explicit command and this function is what everything else
 * uses.
 */
export type LedgerState =
  | { kind: 'current'; table: string }
  | { kind: 'legacy'; table: string }
  | { kind: 'foreign'; table: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; tables: string[] };

async function inspectLedger(client: Client): Promise<LedgerState> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname ~ $1
      ORDER BY c.relname`,
    [LEDGER_NAME_RE],
  );
  if (rows.length === 0) return { kind: 'missing' };
  if (rows.some((r) => r.relname === MIGRATIONS_TABLE)) {
    return { kind: 'current', table: MIGRATIONS_TABLE };
  }
  if (rows.length > 1) return { kind: 'ambiguous', tables: rows.map((r) => r.relname) };

  const candidate = rows[0]!.relname;
  const { rows: columns } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [candidate, LEDGER_COLUMNS],
  );
  return Number(columns[0]?.n) === LEDGER_COLUMNS.length
    ? { kind: 'legacy', table: candidate }
    : { kind: 'foreign', table: candidate };
}

/** Reads the ledger state of a database and closes the connection. */
export async function ledgerState(adminUrl: string): Promise<LedgerState> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await inspectLedger(client);
  } finally {
    await client.end();
  }
}

export interface AdoptOptions {
  adminUrl: string;
  /** Say what would happen and change nothing. */
  dryRun?: boolean;
}

export interface AdoptResult {
  /** What the command did, or would have done with `dryRun`. */
  action: 'renamed' | 'already-current' | 'no-ledger';
  /** The name the ledger had, when there was one to rename. */
  from?: string;
  to: string;
  dryRun: boolean;
}

/**
 * Adopts a migration ledger left under a former name of the product. Explicit, once, by hand:
 * `pnpm db:adopt`, never the release.
 *
 * Everything happens inside one transaction that holds the same advisory lock a migration
 * takes, so two of these cannot race each other, and inside the cluster lock, so it cannot
 * race a `pnpm db:migrate` on another database either. With `dryRun` the transaction is rolled
 * back, which is also how the dry run proves the rename would succeed rather than predicting it.
 */
export async function adoptLedger(options: AdoptOptions): Promise<AdoptResult> {
  const dryRun = options.dryRun === true;
  const clusterLock = await acquireClusterLock(options.adminUrl);
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const state = await inspectLedger(client);
      switch (state.kind) {
        case 'current':
          await client.query('ROLLBACK');
          return { action: 'already-current', to: MIGRATIONS_TABLE, dryRun };
        case 'missing':
          await client.query('ROLLBACK');
          return { action: 'no-ledger', to: MIGRATIONS_TABLE, dryRun };
        case 'ambiguous':
          throw new Error(
            `Several migration ledgers in schema public (${state.tables.join(', ')}) and none ` +
              `is ${MIGRATIONS_TABLE}. Rename the right one by hand.`,
          );
        case 'foreign':
          throw new Error(
            `Table public.${state.table} looks like a migration ledger by name but not by ` +
              'columns; refusing to rename it.',
          );
        case 'legacy':
          break;
      }
      const { rows: rename } = await client.query<{ sql: string }>(
        'SELECT format($$ALTER TABLE public.%I RENAME TO %I$$, $1::text, $2::text) AS sql',
        [state.table, MIGRATIONS_TABLE],
      );
      await client.query(rename[0]!.sql);
      // Renaming a table does not rename its indexes, and an index named after a name the
      // product no longer has is the kind of leftover only ever found by someone reading a dump.
      const { rows: index } = await client.query<{ sql: string }>(
        `SELECT format($$ALTER INDEX public.%I RENAME TO %I$$, i.relname, $2::text) AS sql
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = $1::regclass AND x.indisprimary AND i.relname <> $2`,
        [`public.${MIGRATIONS_TABLE}`, `${MIGRATIONS_TABLE}_pkey`],
      );
      if (index[0]) await client.query(index[0].sql);
      await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      return { action: 'renamed', from: state.table, to: MIGRATIONS_TABLE, dryRun };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
    await clusterLock?.release();
  }
}

/**
 * Creates the ledger if this database has none. Called by `migrate` and by nothing that reads.
 *
 * A database whose ledger is still under a former name is **refused** here rather than given a
 * fresh empty one: an empty ledger on a full database replays 0001. The way out is the explicit
 * command, which is named in the message.
 */
async function ensureMigrationsTable(client: Client): Promise<void> {
  const state = await inspectLedger(client);
  if (state.kind === 'legacy') {
    throw new Error(
      `This database's migration ledger is public.${state.table}, not ${MIGRATIONS_TABLE}. ` +
        'Run `pnpm db:adopt` (or `pnpm db:adopt --dry-run` first) to rename it. Migrating now ' +
        'would start an empty ledger and replay 0001 against a database that already has a schema.',
    );
  }
  if (state.kind === 'ambiguous') {
    throw new Error(
      `Several migration ledgers in schema public (${state.tables.join(', ')}) and none is ` +
        `${MIGRATIONS_TABLE}. Rename the right one by hand.`,
    );
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Applies every pending migration, each in its own transaction, in file-name order. */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const appRole = assertSafeIdentifier(options.appRole ?? DEFAULT_APP_ROLE, 'APP_DB_ROLE');
  const jobsRole = assertSafeIdentifier(options.jobsRole ?? DEFAULT_JOBS_ROLE, 'JOBS_DB_ROLE');
  if (jobsRole === appRole) {
    throw new Error('JOBS_DB_ROLE and APP_DB_ROLE must be different roles.');
  }
  // Interpolated into GRANT CONNECT ON DATABASE in migration 0001: validate, never trust.
  const databaseName = assertSafeIdentifier(databaseNameFromUrl(options.adminUrl), 'database name');

  const lockTimeout = resolveLockTimeout(options);

  const clusterLock = await acquireClusterLock(options.adminUrl);
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const files = await loadMigrations(options.migrationsDir);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${MIGRATIONS_TABLE}`,
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      const previous = applied.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(
            `Migration ${file.name} changed after it was applied (checksum mismatch). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        result.alreadyApplied.push(file.name);
        continue;
      }
      const statement = substitute(file.sql, {
        APP_ROLE: appRole,
        JOBS_ROLE: jobsRole,
        DATABASE_NAME: databaseName,
      });
      const outcome = await applyMigration(client, file, statement, lockTimeout);
      if (outcome === 'applied') {
        result.applied.push(file.name);
        options.onApplied?.(file.name);
      } else {
        result.alreadyApplied.push(file.name);
      }
    }

    const password = options.appPassword ?? process.env.APP_DB_PASSWORD;
    if (password) {
      await applyRolePassword(client, appRole, password);
    }
    const jobsPassword = options.jobsPassword ?? process.env.JOBS_DB_PASSWORD;
    if (jobsPassword) {
      await applyRolePassword(client, jobsRole, jobsPassword);
    }

    return result;
  } finally {
    await client.end();
    await clusterLock?.release();
  }
}

/**
 * Applies one migration in its own transaction, retrying the handful of errors that only two
 * concurrent runners can produce. Returns 'skipped' when another runner got there first.
 */
async function applyMigration(
  client: Client,
  file: MigrationFile,
  statement: string,
  lockTimeout: string,
  attempts = 10,
): Promise<'applied' | 'skipped'> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await client.query('BEGIN');
    // The advisory lock is taken **before** the timeout is set, and deliberately. It is the
    // lock two runners of this same runner queue on, and waiting for it is normal; a
    // `lock_timeout` covering it would turn a healthy wait into a failure. What the timeout is
    // for is the locks the migration's own DDL asks the rest of the system for.
    let guarded = false;
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      // Another runner may have applied this file while we were waiting for the lock.
      const { rows: recheck } = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
        [file.name],
      );
      if (recheck[0]) {
        await client.query('COMMIT');
        return 'skipped';
      }
      const { rows: setting } = await client.query<{ sql: string }>(
        'SELECT format($$SET LOCAL lock_timeout = %L$$, $1::text) AS sql',
        [lockTimeout],
      );
      await client.query(setting[0]!.sql);
      guarded = true;
      await client.query(statement);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
        file.name,
        file.checksum,
      ]);
      await client.query('COMMIT');
      return 'applied';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Past the advisory lock, a lock timeout is not two runners overlapping: it is something
      // else on this database holding a table this migration needs. Retrying nine more times
      // would spend a minute to reach the same answer, so it is reported now, by its name.
      if (guarded && (error as { code?: string } | null)?.code === LOCK_TIMEOUT_CODE) {
        throw new Error(
          `Migration ${file.name} gave up waiting for a lock after ${lockTimeout}: ` +
            `${(error as Error).message}. Something else on this database is holding a table ` +
            'this migration needs. Retry when it lets go, or raise ' +
            'BOOKRAIL_MIGRATION_LOCK_TIMEOUT for this run.',
          { cause: error },
        );
      }
      if (isConcurrencyError(error)) {
        lastError = error;
        await delay(100 * (attempt + 1));
        continue;
      }
      throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  throw new Error(
    `Migration ${file.name} failed after ${attempts} attempts: ${(lastError as Error).message}`,
    { cause: lastError },
  );
}

/**
 * Drops and recreates the schemas the application owns, then re-applies every migration.
 *
 * `pgboss` is dropped here and **not** by a migration. A migration that dropped it would run
 * on production databases too, where the job queue may be alive: it would block behind the
 * worker's connections waiting for an `ACCESS EXCLUSIVE` lock and then delete the queue.
 * Throwing the queue away is a property of a
 * *reset*, not of a schema change, so it belongs to the reset.
 */
export async function resetSchema(options: MigrateOptions): Promise<MigrateResult> {
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  return migrate(options);
}

export interface MigrationStatus {
  name: string;
  applied: boolean;
  drifted: boolean;
}

export interface MigrationReport {
  /** What ledger this database has, if any. Nothing here creates or renames one. */
  ledger: LedgerState;
  statuses: MigrationStatus[];
}

/**
 * The state of every migration file against this database, and the state of the ledger itself.
 *
 * **Read-only, with no exception.** A database with no ledger, or with one still under a
 * former name, reports every migration as pending and says which of the two it is: creating a
 * ledger or renaming one is `pnpm db:migrate` and `pnpm db:adopt`, two commands somebody asked
 * for on purpose.
 */
export async function migrationReport(options: MigrateOptions): Promise<MigrationReport> {
  const client = new Client({ connectionString: options.adminUrl });
  await client.connect();
  try {
    const ledger = await inspectLedger(client);
    const files = await loadMigrations(options.migrationsDir);
    const applied = new Map<string, string>();
    if (ledger.kind === 'current') {
      const { rows } = await client.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM ${MIGRATIONS_TABLE}`,
      );
      for (const row of rows) applied.set(row.name, row.checksum);
    }
    return {
      ledger,
      statuses: files.map((f) => ({
        name: f.name,
        applied: applied.has(f.name),
        drifted: applied.has(f.name) && applied.get(f.name) !== f.checksum,
      })),
    };
  } finally {
    await client.end();
  }
}

/** The statuses alone, for callers that already know the ledger is where it should be. */
export async function migrationStatus(options: MigrateOptions): Promise<MigrationStatus[]> {
  return (await migrationReport(options)).statuses;
}
