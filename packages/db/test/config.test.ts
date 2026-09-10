/**
 * The shape of a connection string, tested against the shape production actually uses.
 *
 * This file exists because of a real failure: the deployment scripts used to write every
 * connection string of the production host as
 * `postgres://role:password@/bookrail?host=/var/run/postgresql`, which is **not a URL**. An
 * authority with credentials and an empty host is rejected by the WHATWG parser, and
 * `new URL()` is what every function in `config.ts` uses. `resolveDatabaseUrls()` is on the
 * start-up path of the API, the worker, every `pnpm db:*` command, `bookrail-bootstrap` and
 * `bookrail-restore`: with that form none of them started, and no test in the repository used a
 * Unix socket string, so nothing caught it.
 *
 * The form that works puts the socket directory where a URL puts a host, percent-encoded, and
 * `pg-connection-string` decodes it back. These tests are the guard: they use the production
 * form, so rewriting it fails here instead of on the machine.
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  databaseNameFromUrl,
  deriveAppUrl,
  redactUrl,
  resolveDatabaseUrls,
  withDatabaseName,
} from '../src/config.js';

/** The shape an installer prints when it puts the cluster on a Unix socket. */
const SOCKET_URL = 'postgres://bookrail_owner:s3cret@%2Fvar%2Frun%2Fpostgresql/bookrail';
const SOCKET_APP_URL = 'postgres://bookrail_app:other@%2Fvar%2Frun%2Fpostgresql/bookrail';

describe('connection strings over a unix socket', () => {
  it('is a URL at all', () => {
    expect(() => new URL(SOCKET_URL)).not.toThrow();
  });

  it('is rejected in the shape this repository used to write', () => {
    // Kept as an executable statement of why the other shape is the one in the script.
    expect(
      () => new URL('postgres://bookrail_owner:s3cret@/bookrail?host=/var/run/postgresql'),
    ).toThrow(/Invalid URL/);
  });

  it('yields the database name, not the socket path', () => {
    expect(databaseNameFromUrl(SOCKET_URL)).toBe('bookrail');
  });

  it('survives every transformation config.ts applies to it', () => {
    const swapped = withDatabaseName(SOCKET_URL, 'bookrail_restore_20260908');
    expect(databaseNameFromUrl(swapped)).toBe('bookrail_restore_20260908');
    // The host survives the round trip untouched: this is what pg-connection-string decodes
    // back into the socket directory.
    expect(new URL(swapped).host).toBe('%2Fvar%2Frun%2Fpostgresql');

    const app = deriveAppUrl(SOCKET_URL, 'bookrail_app', 'pw');
    expect(new URL(app).username).toBe('bookrail_app');
    expect(databaseNameFromUrl(app)).toBe('bookrail');

    expect(redactUrl(SOCKET_URL)).toContain('***');
    expect(redactUrl(SOCKET_URL)).not.toContain('s3cret');
  });

  it('resolves the way the API, the worker and the runner will read it', () => {
    const urls = resolveDatabaseUrls({
      env: {
        DATABASE_URL: SOCKET_URL,
        DATABASE_APP_URL: SOCKET_APP_URL,
        APP_DB_ROLE: 'bookrail_app',
        JOBS_DB_ROLE: 'bookrail_jobs',
      },
    });
    expect(urls.databaseName).toBe('bookrail');
    expect(urls.admin).toBe(SOCKET_URL);
    expect(urls.app).toBe(SOCKET_APP_URL);
  });

  /**
   * The parser is only half the question: node-postgres has to turn the encoded host back into
   * a path and open the socket. Run against the local cluster, whose socket directory is
   * discovered rather than assumed, because Homebrew puts it in /tmp and Debian in
   * /var/run/postgresql.
   */
  it('actually connects over the socket', async () => {
    const probe = new Client({ connectionString: process.env.DATABASE_URL });
    await probe.connect();
    let directory: string;
    let database: string;
    let role: string;
    try {
      const { rows } = await probe.query<{ dir: string; db: string; who: string }>(
        "SELECT current_setting('unix_socket_directories') AS dir, current_database() AS db, current_user AS who",
      );
      directory = rows[0]!.dir.split(',')[0]!.trim();
      database = rows[0]!.db;
      role = rows[0]!.who;
    } finally {
      await probe.end();
    }

    const url = `postgres://${role}@${encodeURIComponent(directory)}/${database}`;
    expect(() => new URL(url)).not.toThrow();
    expect(url).toContain('%2F');

    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
      expect(rows[0]?.db).toBe(database);
    } finally {
      await client.end();
    }
  });
});
